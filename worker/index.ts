// SyncWatch sunucusu (Cloudflare Workers).
//
//  /ws?room=..&name=..        -> odanın Durable Object'ine WebSocket
//  /api/upload/*              -> R2'ye parça parça (multipart) yükleme
//  /api/files/<key>           -> R2'den indirme (Range destekli, kaldığı yerden devam)
//  /api/subsync?room=..       -> altyazı eşitleme: kısa ses parçasını Workers AI
//                                (Whisper) ile çözümler, konuşma zamanlarını döndürür
//  diğer her şey              -> web/ klasöründeki arayüz dosyaları
import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  FILES?: R2Bucket;
  // Cloudflare Realtime TURN (isteğe bağlı). Panelden "secret" olarak eklenir.
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  // Workers AI (altyazı eşitleme). Ücretsiz günlük kota içinde kullanılır.
  AI?: Ai;
}

const MAX_NAME = 32;
const MAX_ROOM = 64;
const MAX_CHAT = 1000;
const MAX_MSG = 64 * 1024;
const MAX_SUB = 900 * 1024;          // altyazı (JSON) en fazla ~900 KB
const MAX_SYNC_AUDIO = 4 * 1024 * 1024; // eşitleme için ses parçası
const SYNC_PER_DAY = 30;             // oda başına günlük yapay zekâ eşitleme hakkı
const REACTIONS = ["❤️", "😂", "😮", "😢", "😡", "👍", "🔥", "🍿"];
const MAX_FILE = 5 * 1024 ** 3; // 5 GB
const PART_SIZE = 10 * 1024 * 1024; // 10 MB; son parça hariç hepsi bu boyutta

function cleanText(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return [...s.trim()].slice(0, max).join("");
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const room = cleanText(url.searchParams.get("room"), MAX_ROOM);
      const name = cleanText(url.searchParams.get("name"), MAX_NAME);
      if (!room || !name) return new Response("room ve name gerekli", { status: 400 });
      if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket bekleniyor", { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      const fwd = new URL(req.url);
      fwd.searchParams.set("room", room);
      fwd.searchParams.set("name", name);
      return stub.fetch(new Request(fwd, req));
    }

    if (url.pathname === "/healthz") return new Response("ok");

    if (url.pathname === "/api/ice") return iceServers(env);

    if (url.pathname === "/api/subsync" && req.method === "POST") {
      try {
        return await subSync(req, url, env);
      } catch (err) {
        console.error("subsync", err);
        return json({ error: "Eşitleme şu an yapılamadı" }, 500);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      if (!env.FILES) return json({ error: "Depolama ayarlı değil" }, 503);
      try {
        return await api(req, url, env, env.FILES);
      } catch (err) {
        console.error(err);
        return json({ error: "Sunucu hatası" }, 500);
      }
    }

    return new Response("Bulunamadı", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------- ICE / TURN ----------
// Telefon şebekeleri gibi doğrudan bağlantıya izin vermeyen ağlarda ses ve
// dosya aktarımı TURN sunucusu üzerinden geçer. Anahtar tanımlı değilse
// yalnızca STUN döner.
const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

async function iceServers(env: Env): Promise<Response> {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      });
      if (res.ok) {
        const data = (await res.json()) as { iceServers: unknown };
        const list = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
        return json({ iceServers: list, turn: true });
      }
      console.error("TURN", res.status, await res.text());
    } catch (err) {
      console.error("TURN", err);
    }
  }
  return json({ iceServers: STUN, turn: false });
}

// ---------- Altyazı eşitleme (Workers AI) ----------
// Tarayıcı videodan ~45 sn'lik ses parçası (16 kHz mono WAV) gönderir; Whisper
// konuşmanın zamanlarını çıkarır. Hizalamayı tarayıcı yapar. Video sunucuya
// gelmez, ses parçası saklanmaz.
type Span = { start: number; end: number };

async function subSync(req: Request, url: URL, env: Env): Promise<Response> {
  if (!env.AI) return json({ error: "Yapay zekâ ayarlı değil" }, 503);
  const room = cleanText(url.searchParams.get("room"), MAX_ROOM);
  if (!room) return json({ error: "Oda gerekli" }, 400);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_SYNC_AUDIO) return json({ error: "Ses parçası çok büyük" }, 413);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX_SYNC_AUDIO) return json({ error: "Ses parçası geçersiz" }, 400);

  const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
  if (!(await stub.takeSyncToken())) return json({ error: "Bugünlük otomatik eşitleme hakkı doldu", limit: true }, 429);

  const bytes = new Uint8Array(buf);
  let words: Span[] = [];
  let segments: Span[] = [];
  try {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const out: any = await env.AI.run("@cf/openai/whisper-large-v3-turbo" as any, { audio: btoa(bin), vad_filter: true } as any);
    for (const seg of out?.segments || []) {
      segments.push({ start: Number(seg.start), end: Number(seg.end) });
      for (const w of seg.words || []) words.push({ start: Number(w.start), end: Number(w.end) });
    }
  } catch (err) {
    console.error("whisper-turbo", err);
    try {
      const out: any = await env.AI.run("@cf/openai/whisper" as any, { audio: [...bytes] } as any);
      for (const w of out?.words || []) words.push({ start: Number(w.start), end: Number(w.end) });
    } catch (err2) {
      console.error("whisper", err2);
      const msg = String(err2);
      const quota = /quota|limit|exceed|429|neuron/i.test(msg);
      return json({ error: quota ? "Yapay zekâ günlük kotası doldu" : "Yapay zekâ şu an yanıt vermiyor", limit: quota }, quota ? 429 : 502);
    }
  }
  const ok = (x: Span) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end >= x.start;
  return json({ words: words.filter(ok), segments: segments.filter(ok) });
}

// ---------- R2 ----------
async function api(req: Request, url: URL, env: Env, bucket: R2Bucket): Promise<Response> {
  const p = url.pathname;

  // Yeni yükleme başlat
  if (p === "/api/upload/start" && req.method === "POST") {
    const body = (await req.json()) as { room?: string; name?: string; size?: number };
    const room = cleanText(body.room, MAX_ROOM);
    const name = cleanText(body.name, 200).replace(/[\/\\]/g, "_");
    const size = Number(body.size);
    if (!room || !name || !(size > 0)) return json({ error: "Eksik bilgi" }, 400);
    if (size > MAX_FILE) return json({ error: "Dosya 5 GB'tan büyük olamaz" }, 413);
    const key = `${encodeURIComponent(room)}/${crypto.randomUUID()}/${name}`;
    const up = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: guessType(name) } });
    return json({ key, uploadId: up.uploadId, partSize: PART_SIZE });
  }

  // Bir parçayı yükle
  if (p === "/api/upload/part" && req.method === "PUT") {
    const key = url.searchParams.get("key") || "";
    const uploadId = url.searchParams.get("uploadId") || "";
    const n = Number(url.searchParams.get("n"));
    if (!key || !uploadId || !(n >= 1 && n <= 10000) || !req.body) return json({ error: "Eksik bilgi" }, 400);
    const up = bucket.resumeMultipartUpload(key, uploadId);
    const part = await up.uploadPart(n, req.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }

  // Yüklemeyi bitir ve odaya duyur
  if (p === "/api/upload/complete" && req.method === "POST") {
    const body = (await req.json()) as {
      room?: string; key?: string; uploadId?: string; by?: string;
      parts?: { partNumber: number; etag: string }[];
    };
    const room = cleanText(body.room, MAX_ROOM);
    const key = body.key || "";
    if (!room || !key.startsWith(encodeURIComponent(room) + "/") || !body.uploadId || !Array.isArray(body.parts)) {
      return json({ error: "Eksik bilgi" }, 400);
    }
    const parts = [...body.parts].sort((a, b) => a.partNumber - b.partNumber);
    const obj = await bucket.resumeMultipartUpload(key, body.uploadId).complete(parts);
    const name = key.split("/").slice(2).join("/");
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    const old = await stub.setShared({ key, name, size: obj.size, by: cleanText(body.by, MAX_NAME) });
    if (old && old !== key) await bucket.delete(old).catch(() => {});
    return json({ ok: true, size: obj.size });
  }

  if (p === "/api/upload/abort" && req.method === "POST") {
    const body = (await req.json()) as { key?: string; uploadId?: string };
    if (body.key && body.uploadId) await bucket.resumeMultipartUpload(body.key, body.uploadId).abort().catch(() => {});
    return json({ ok: true });
  }

  // Dosyayı indir (Range destekli)
  if (p.startsWith("/api/files/") && (req.method === "GET" || req.method === "HEAD")) {
    const key = decodeURIComponent(p.slice("/api/files/".length));
    const obj = await bucket.get(key, { range: req.headers });
    if (!obj) return new Response("Dosya bulunamadı", { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "private, max-age=0");
    let status = 200;
    const r = obj.range as { offset?: number; length?: number } | undefined;
    if (req.headers.has("range") && r && r.offset !== undefined) {
      const len = r.length ?? obj.size - r.offset;
      headers.set("content-range", `bytes ${r.offset}-${r.offset + len - 1}/${obj.size}`);
      headers.set("content-length", String(len));
      status = 206;
    } else {
      headers.set("content-length", String(obj.size));
    }
    return new Response(req.method === "HEAD" ? null : (obj as R2ObjectBody).body, { status, headers });
  }

  return json({ error: "Bulunamadı" }, 404);
}

function guessType(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return (
    { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", srt: "text/plain", vtt: "text/vtt" } as Record<string, string>
  )[ext] || "application/octet-stream";
}

async function netTag(req: Request, salt: string): Promise<string> {
  const ip = req.headers.get("CF-Connecting-IP");
  if (!ip) return "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|" + ip));
  return [...new Uint8Array(buf).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Oda ----------
type FileInfo = { name: string; size: number; duration: number };
type Shared = { key: string; name: string; size: number; by: string };
// net: aynı ağdan bağlananları (ör. aynı odada iki cihaz) fark etmek için IP'nin
// odaya özel kısa özeti. IP'nin kendisi saklanmaz ve paylaşılmaz.
type Attachment = { id: string; name: string; file: FileInfo | null; voice?: boolean; net?: string };
type PlayState = { playing: boolean; position: number; serverTime: number; touched: boolean };
type SubState = { name: string; data: string; by: string; offset: number };

export class Room extends DurableObject<Env> {
  private play: PlayState = { playing: false, position: 0, serverTime: Date.now(), touched: false };
  private shared: Shared | null = null;
  private sub: SubState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Oda uykuya geçip uyanınca durumu kalıcı depodan geri yükle.
    ctx.blockConcurrencyWhile(async () => {
      this.play = (await ctx.storage.get<PlayState>("play")) ?? this.play;
      this.shared = (await ctx.storage.get<Shared>("shared")) ?? null;
      this.sub = (await ctx.storage.get<SubState>("sub")) ?? null;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const name = url.searchParams.get("name") || "?";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const me: Attachment = { id: randomId(), name, file: null, net: await netTag(req, this.ctx.id.toString()) };
    server.serializeAttachment(me);

    this.sendTo(server, { type: "welcome", id: me.id, storage: !!this.env.FILES, shared: this.shared, ai: !!this.env.AI });
    if (this.sub) this.sendTo(server, { type: "subtitle", ...this.sub, quiet: true });
    this.sendTo(server, this.stateMsg(""));
    this.broadcast({ type: "system", text: `${name} odaya katıldı`, time: Date.now() });
    this.broadcast(this.presence());
    return new Response(null, { status: 101, webSocket: client });
  }

  // R2 yüklemesi bitince Worker çağırır. Eski dosyanın anahtarını döndürür.
  async setShared(s: Shared): Promise<string | null> {
    const old = this.shared?.key ?? null;
    this.shared = s;
    await this.ctx.storage.put("shared", s);
    this.broadcast({ type: "shared", shared: s });
    this.broadcast({ type: "system", text: `${s.by} “${s.name}” dosyasını odaya yükledi`, time: Date.now() });
    return old;
  }

  // Günlük yapay zekâ eşitleme hakkından bir tane kullan.
  async takeSyncToken(): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const q = (await this.ctx.storage.get<{ day: string; n: number }>("syncQuota")) ?? { day, n: 0 };
    if (q.day !== day) { q.day = day; q.n = 0; }
    if (q.n >= SYNC_PER_DAY) return false;
    q.n++;
    await this.ctx.storage.put("syncQuota", q);
    return true;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > MAX_SUB + 4096) return;
    if (raw.length > MAX_MSG && !raw.startsWith('{"type":"subtitle"')) return;
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment() as Attachment;
    const now = Date.now();

    switch (m.type) {
      case "ping":
        this.sendTo(ws, { type: "pong", t: m.t, serverTime: now });
        break;

      case "play":
      case "pause":
      case "seek": {
        const pos = Number(m.position);
        if (!(pos >= 0 && pos <= 24 * 3600)) return;
        if (m.type === "play") this.play.playing = true;
        if (m.type === "pause") this.play.playing = false;
        this.play.position = pos;
        this.play.serverTime = now;
        this.play.touched = true;
        await this.ctx.storage.put("play", this.play);
        this.broadcast({ ...this.stateMsg(me.name), text: m.type });
        break;
      }

      case "countdown": {
        // Herkes 3-2-1 sayar; oynatma 3 sn sonra aynı anda başlar.
        const pos = Number(m.position);
        if (!(pos >= 0 && pos <= 24 * 3600)) return;
        this.play = { playing: true, position: pos, serverTime: now + 3000, touched: true };
        await this.ctx.storage.put("play", this.play);
        this.broadcast({ ...this.stateMsg(me.name), text: "countdown" });
        break;
      }

      case "resync":
        // Geride kalan herkes odanın konumuna atlasın.
        this.broadcast({ type: "resync", by: me.name });
        break;

      case "pos": {
        // Herkesin gerçek konumu: kayma uyarısı için diğerlerine iletilir.
        const t = Number(m.t);
        if (!(t >= 0 && t <= 24 * 3600)) return;
        this.broadcast({ type: "pos", id: me.id, name: me.name, t, at: now, buffering: !!m.buffering },
          this.openSockets().filter((w) => w !== ws));
        break;
      }

      case "react": {
        if (!REACTIONS.includes(m.emoji)) return;
        this.broadcast({ type: "react", emoji: m.emoji, from: me.name, fromId: me.id });
        break;
      }

      case "subtitle": {
        if (typeof m.data !== "string" || !m.data || m.data.length > MAX_SUB) return;
        this.sub = { name: cleanText(m.name, 200) || "Altyazı", data: m.data, by: me.name, offset: 0 };
        await this.ctx.storage.put("sub", this.sub);
        this.broadcast({ type: "subtitle", ...this.sub });
        break;
      }

      case "subOffset": {
        const off = Number(m.offset);
        if (!this.sub || !(Math.abs(off) <= 3600)) return;
        this.sub.offset = Math.round(off * 100) / 100;
        await this.ctx.storage.put("sub", this.sub);
        this.broadcast({ type: "subOffset", offset: this.sub.offset, by: me.name, auto: !!m.auto });
        break;
      }

      case "subClear":
        this.sub = null;
        await this.ctx.storage.delete("sub");
        this.broadcast({ type: "subClear", by: me.name });
        break;

      case "chat": {
        const text = cleanText(m.text, MAX_CHAT);
        if (text) this.broadcast({ type: "chat", from: me.name, text, time: now });
        break;
      }

      case "file": {
        const f = m.file;
        if (!f || typeof f !== "object") return;
        me.file = { name: cleanText(f.name, 200), size: Number(f.size) || 0, duration: Number(f.duration) || 0 };
        ws.serializeAttachment(me);
        this.broadcast(this.presence());
        break;
      }

      case "voice": {
        // Sesli sohbete katıldı / ayrıldı
        me.voice = !!m.on;
        ws.serializeAttachment(me);
        this.broadcast(this.presence());
        break;
      }

      case "signal": {
        // Cihazdan cihaza aktarım için WebRTC mesajlarını yalnızca hedefe ilet.
        if (typeof m.to !== "string" || m.data === undefined) return;
        for (const other of this.ctx.getWebSockets()) {
          const a = other.deserializeAttachment() as Attachment;
          if (a.id === m.to) {
            this.sendTo(other, { type: "signal", fromId: me.id, from: me.name, data: m.data });
            break;
          }
        }
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.leave(ws);
  }

  private async leave(ws: WebSocket) {
    const me = ws.deserializeAttachment() as Attachment | null;
    try { ws.close(1000, ""); } catch {}
    if (!me) return;
    const rest = this.ctx.getWebSockets().filter((w) => w !== ws && w.readyState === WebSocket.OPEN);
    // Biri çıkınca diğerinin videosu yalnız oynamaya devam etmesin.
    if (this.play.playing) {
      const now = Date.now();
      this.play.position += (now - this.play.serverTime) / 1000;
      this.play.playing = false;
      this.play.serverTime = now;
      await this.ctx.storage.put("play", this.play);
      this.broadcast(this.stateMsg(""), rest);
    }
    this.broadcast({ type: "system", text: `${me.name} odadan ayrıldı`, time: Date.now() }, rest);
    this.broadcast(this.presence(rest), rest);
  }

  private stateMsg(by: string) {
    const p = this.play;
    return { type: "state", playing: p.playing, position: p.position, serverTime: p.serverTime, by, fresh: !p.touched };
  }

  private presence(sockets = this.openSockets()) {
    return {
      type: "presence",
      members: sockets.map((w) => {
        const a = w.deserializeAttachment() as Attachment;
        return { id: a.id, name: a.name, file: a.file, voice: !!a.voice, net: a.net || "" };
      }),
    };
  }

  private openSockets() {
    return this.ctx.getWebSockets().filter((w) => w.readyState === WebSocket.OPEN);
  }

  private sendTo(ws: WebSocket, m: unknown) {
    try { ws.send(JSON.stringify(m)); } catch {}
  }

  private broadcast(m: unknown, sockets = this.openSockets()) {
    const s = JSON.stringify(m);
    for (const w of sockets) {
      try { w.send(s); } catch {}
    }
  }
}

function randomId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
