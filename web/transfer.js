// Cihazdan cihaza dosya aktarımı (WebRTC veri kanalı).
// Dosya sunucuya hiç uğramaz; sunucu yalnızca bağlantı kurulurken gereken
// küçük "sinyal" mesajlarını iki taraf arasında taşır.
//
// app.js'teki şu genel değişken/fonksiyonları kullanır:
//   myId, members, myFile, myFileObj, send, loadFile, toast, $
"use strict";

const ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;   // gönderim tamponu bu kadar dolunca bekle
const LOW_WATER = 1 * 1024 * 1024;

// ---------- Ortak ----------
const peers = new Map(); // peerId -> { pc, role, ... }

function sendSignal(to, data) {
  send({ type: "signal", to, data });
}

function newPc(peerId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { kind: "ice", candidate: e.candidate });
  };
  return pc;
}

function closePeer(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  peers.delete(peerId);
  try { p.channel && p.channel.close(); } catch {}
  try { p.pc.close(); } catch {}
}

async function handleSignal(m) {
  const from = m.fromId;
  const d = m.data || {};
  try {
    if (d.kind === "offer") await onOffer(from, m.from, d);
    else if (d.kind === "answer") {
      const p = peers.get(from);
      if (p) await p.pc.setRemoteDescription({ type: "answer", sdp: d.sdp });
    } else if (d.kind === "ice") {
      const p = peers.get(from);
      if (p && d.candidate) await p.pc.addIceCandidate(d.candidate).catch(() => {});
    } else if (d.kind === "reject") {
      if (download && download.peerId === from) failDownload(d.reason || "Karşı taraf dosyayı gönderemedi.");
    }
  } catch (err) {
    console.warn("signal", err);
  }
}

// ---------- Gönderen taraf ----------
const uploads = new Map(); // peerId -> { name, sent, size }

async function onOffer(peerId, peerName, d) {
  const f = myFileObj;
  if (!f || f.name !== d.file.name || f.size !== d.file.size) {
    sendSignal(peerId, { kind: "reject", reason: "Karşı taraf dosyayı değiştirmiş ya da kapatmış." });
    return;
  }
  closePeer(peerId);
  const pc = newPc(peerId);
  const p = { pc, role: "send" };
  peers.set(peerId, p);

  pc.ondatachannel = (e) => {
    const ch = e.channel;
    p.channel = ch;
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = LOW_WATER;
    ch.onopen = () => streamFile(peerId, peerName, ch, f, Math.max(0, Math.min(d.offset || 0, f.size)));
    ch.onclose = () => { uploads.delete(peerId); renderUploads(); closePeer(peerId); };
  };

  await pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal(peerId, { kind: "answer", sdp: answer.sdp });
}

async function streamFile(peerId, peerName, ch, file, offset) {
  const up = { name: peerName, sent: offset, size: file.size };
  uploads.set(peerId, up);
  renderUploads();
  let pos = offset;
  const waitDrain = () => new Promise((res) => {
    ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; res(); };
  });
  try {
    while (pos < file.size) {
      if (ch.readyState !== "open") return;
      // Dosyayı 4 MB'lık bloklar halinde oku, 64 KB'lık parçalarla gönder.
      const blockEnd = Math.min(pos + HIGH_WATER, file.size);
      const buf = await file.slice(pos, blockEnd).arrayBuffer();
      for (let i = 0; i < buf.byteLength; i += CHUNK) {
        if (ch.readyState !== "open") return;
        if (ch.bufferedAmount > HIGH_WATER) await waitDrain();
        ch.send(buf.slice(i, Math.min(i + CHUNK, buf.byteLength)));
      }
      pos = blockEnd;
      up.sent = pos;
      renderUploads();
    }
    ch.send(JSON.stringify({ done: true }));
  } catch (err) {
    console.warn("upload", err);
  }
}

let uploadsTimer = 0;
function renderUploads() {
  clearTimeout(uploadsTimer);
  uploadsTimer = setTimeout(() => {
    const el = $("uploadInfo");
    const list = [...uploads.values()].filter((u) => u.sent < u.size);
    if (!list.length) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = list.map((u) => `${u.name} indiriyor · %${Math.floor((u.sent / u.size) * 100)}`).join(", ");
  }, 100);
}

// ---------- İndiren taraf ----------
let download = null;
// { peerId, peerName, file:{name,size}, received, sink, startedAt, lastBytes, lastT, speed, state }

function offerFor() {
  // İndirilebilecek dosya: bizde dosya yokken başkasının seçtiği dosya.
  if (myFile) return null;
  return members.find((m) => m.id !== myId && m.file && m.file.size > 0) || null;
}

function renderOffer() {
  const box = $("offer");
  if (download && download.state !== "idle") { box.hidden = true; return; }
  const m = offerFor();
  if (!m) { box.hidden = true; return; }
  box.hidden = false;
  $("offerText").textContent = `${m.name} “${m.file.name}” dosyasını açtı (${fmtSize(m.file.size)}).`;
  $("offerBtn").onclick = () => startDownload(m);
}

async function startDownload(m, resume) {
  const fileInfo = { name: m.file.name, size: m.file.size };
  let sink;
  if (resume && download && download.sink && download.file.name === fileInfo.name && download.file.size === fileInfo.size) {
    sink = download.sink;
  } else {
    try {
      sink = await makeSink(fileInfo);
    } catch (err) {
      if (err && err.name === "AbortError") return; // kullanıcı kaydetme penceresini kapattı
      sink = memorySink();
    }
  }

  const offset = await sink.reopen();
  download = {
    peerId: m.id, peerName: m.name, file: fileInfo, received: offset, sink,
    lastBytes: offset, lastT: performance.now(), speed: 0, state: "connecting",
  };
  renderDownload();

  closePeer(m.id);
  const pc = newPc(m.id);
  const ch = pc.createDataChannel("file", { ordered: true });
  ch.binaryType = "arraybuffer";
  const p = { pc, channel: ch, role: "recv" };
  peers.set(m.id, p);

  const dl = download;
  ch.onopen = () => { dl.state = "receiving"; renderDownload(); };
  ch.onmessage = (e) => {
    if (download !== dl) return;
    if (typeof e.data === "string") {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.done) finishDownload(dl);
      return;
    }
    dl.sink.write(e.data);
    dl.received += e.data.byteLength;
  };
  ch.onclose = () => {
    if (download === dl && dl.state !== "done") failDownload("Bağlantı koptu.");
  };
  pc.onconnectionstatechange = () => {
    if (download !== dl) return;
    if (pc.connectionState === "failed") {
      failDownload(dl.state === "connecting"
        ? "Doğrudan bağlantı kurulamadı. İkinizden biri başka bir ağa (ör. telefonun interneti) geçip tekrar deneyebilir."
        : "Bağlantı koptu.");
    }
  };
  // Bağlantı 25 saniyede kurulamazsa vazgeç.
  setTimeout(() => {
    if (download === dl && dl.state === "connecting") {
      failDownload("Doğrudan bağlantı kurulamadı. İkinizden biri başka bir ağa (ör. telefonun interneti) geçip tekrar deneyebilir.");
    }
  }, 25000);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal(m.id, { kind: "offer", sdp: offer.sdp, file: fileInfo, offset });
}

async function finishDownload(dl) {
  dl.state = "saving";
  renderDownload();
  closePeer(dl.peerId);
  try {
    const file = await dl.sink.finish(dl.file);
    dl.state = "done";
    download = null;
    renderDownload();
    toast("İndirme bitti");
    loadFile(file);
    if (dl.sink.kind === "memory") offerSave(file);
  } catch (err) {
    console.warn(err);
    failDownload("Dosya kaydedilemedi.");
  }
}

function failDownload(reason) {
  const dl = download;
  if (!dl || dl.state === "failed") return;
  dl.state = "failed";
  dl.error = reason;
  closePeer(dl.peerId);
  dl.sink.pause().catch(() => {});
  renderDownload();
}

function cancelDownload() {
  const dl = download;
  if (!dl) return;
  closePeer(dl.peerId);
  dl.sink.abort().catch(() => {});
  download = null;
  renderDownload();
  renderOffer();
}

// Diske yaz (Chrome/Edge masaüstü) ya da belleğe topla (diğerleri).
async function makeSink(fileInfo) {
  if (window.showSaveFilePicker) {
    const ext = (fileInfo.name.match(/\.[a-z0-9]+$/i) || [""])[0];
    const handle = await window.showSaveFilePicker({
      suggestedName: fileInfo.name,
      types: ext ? [{ description: "Video", accept: { "video/*": [ext] } }] : undefined,
    });
    return diskSink(handle);
  }
  return memorySink();
}

function diskSink(handle) {
  let writable = null;
  let chain = Promise.resolve();
  let written = 0;
  return {
    kind: "disk",
    async reopen() {
      // Daha önce yarım kaldıysa, yazılmış kısmı koru ve sonuna ekle.
      await chain;
      if (writable) { try { await writable.close(); } catch {} }
      const existing = (await handle.getFile()).size;
      written = existing;
      writable = await handle.createWritable({ keepExistingData: existing > 0 });
      if (existing > 0) await writable.seek(existing);
      return existing;
    },
    write(buf) {
      chain = chain.then(() => writable.write(buf)).then(() => { written += buf.byteLength; });
    },
    async pause() { await chain.catch(() => {}); if (writable) { await writable.close(); writable = null; } },
    async finish() { await chain; await writable.close(); writable = null; return handle.getFile(); },
    async abort() { if (writable) { await writable.abort(); writable = null; } },
  };
}

function memorySink() {
  let parts = [];
  let size = 0;
  return {
    kind: "memory",
    async reopen() { return size; },
    write(buf) { parts.push(buf); size += buf.byteLength; },
    async pause() {},
    async finish(info) {
      const f = new File(parts, info.name, { type: guessType(info.name) });
      parts = [];
      return f;
    },
    async abort() { parts = []; size = 0; },
  };
}

function guessType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime" }[ext] || "";
}

// Bellekteki dosyayı istenirse cihaza kaydetmek için link.
function offerSave(file) {
  const a = $("saveLink");
  if (a.href) URL.revokeObjectURL(a.href);
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.hidden = false;
}

// İlerleme göstergesi
function renderDownload() {
  const box = $("download");
  const dl = download;
  if (!dl) { box.hidden = true; renderOffer(); return; }
  box.hidden = false;
  $("offer").hidden = true;
  const pct = dl.file.size ? Math.min(100, (dl.received / dl.file.size) * 100) : 0;
  $("dlBar").style.width = pct.toFixed(1) + "%";
  $("dlTitle").textContent = dl.file.name;
  $("dlRetry").hidden = dl.state !== "failed";
  let line = "";
  if (dl.state === "connecting") line = `${dl.peerName} ile bağlantı kuruluyor…`;
  else if (dl.state === "receiving") {
    const left = dl.speed > 0 ? (dl.file.size - dl.received) / dl.speed : 0;
    line = `%${Math.floor(pct)} · ${fmtSize(dl.received)} / ${fmtSize(dl.file.size)}`;
    if (dl.speed > 0) line += ` · ${fmtSize(dl.speed)}/sn · ${fmtDuration(left)} kaldı`;
  } else if (dl.state === "saving") line = "Kaydediliyor…";
  else if (dl.state === "failed") line = `${dl.error} %${Math.floor(pct)} indi, kaldığı yerden devam edebilirsin.`;
  $("dlLine").textContent = line;
}

setInterval(() => {
  const dl = download;
  if (!dl || dl.state !== "receiving") return;
  const now = performance.now();
  const inst = ((dl.received - dl.lastBytes) * 1000) / (now - dl.lastT);
  dl.speed = dl.speed ? dl.speed * 0.7 + inst * 0.3 : inst;
  dl.lastBytes = dl.received;
  dl.lastT = now;
  renderDownload();
}, 1000);

$("dlCancel").addEventListener("click", cancelDownload);
$("dlRetry").addEventListener("click", () => {
  const dl = download;
  if (!dl) return;
  const m = members.find((x) => x.id === dl.peerId) ||
    members.find((x) => x.id !== myId && x.file && x.file.name === dl.file.name && x.file.size === dl.file.size);
  if (!m) { dl.error = "Dosyayı paylaşan kişi şu an odada değil."; renderDownload(); return; }
  startDownload(m, true);
});

// ---------- Biçimlendirme ----------
function fmtSize(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2).replace(".", ",") + " GB";
  if (b >= 1e6) return (b / 1e6).toFixed(1).replace(".", ",") + " MB";
  return Math.max(1, Math.round(b / 1e3)) + " KB";
}

function fmtDuration(s) {
  s = Math.round(s);
  if (s < 60) return `${s} sn`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} dk`;
  return `${Math.floor(m / 60)} sa ${m % 60} dk`;
}
