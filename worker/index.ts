// SyncWatch sunucusu (Cloudflare Workers).
//
//  /ws?room=..&name=..        -> odanın Durable Object'ine WebSocket
//  /api/upload/*              -> R2'ye parça parça (multipart) yükleme
//  /api/files/<key>           -> R2'den indirme (Range destekli, kaldığı yerden devam)
//  diğer her şey              -> web/ klasöründeki arayüz dosyaları
import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  FILES?: R2Bucket;
  // Cloudflare Realtime TURN (isteğe bağlı). Panelden "secret" olarak eklenir.
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const MAX_NAME = 32;
const MAX_ROOM = 64;
const MAX_CHAT = 1000;
const MAX_MSG = 64 * 1024;
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

// ---------- Oda ----------
type FileInfo = { name: string; size: number; duration: number };
type Shared = { key: string; name: string; size: number; by: string };
type Attachment = { id: string; name: string; file: FileInfo | null; voice?: boolean };
type PlayState = { playing: boolean; position: number; serverTime: number; touched: boolean };

export class Room extends DurableObject<Env> {
  private play: PlayState = { playing: false, position: 0, serverTime: Date.now(), touched: false };
  private shared: Shared | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Oda uykuya geçip uyanınca durumu kalıcı depodan geri yükle.
    ctx.blockConcurrencyWhile(async () => {
      this.play = (await ctx.storage.get<PlayState>("play")) ?? this.play;
      this.shared = (await ctx.storage.get<Shared>("shared")) ?? null;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const name = url.searchParams.get("name") || "?";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const me: Attachment = { id: randomId(), name, file: null };
    server.serializeAttachment(me);

    this.sendTo(server, { type: "welcome", id: me.id, storage: !!this.env.FILES, shared: this.shared });
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

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
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
        return { id: a.id, name: a.name, file: a.file, voice: !!a.voice };
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
