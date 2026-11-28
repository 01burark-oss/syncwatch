// Cihazdan cihaza dosya aktarımı (WebRTC veri kanalı).
// Dosya sunucuya hiç uğramaz; sunucu yalnızca bağlantı kurulurken gereken
// küçük "sinyal" mesajlarını iki taraf arasında taşır.
//
// app.js'teki şu genel değişken/fonksiyonları kullanır:
//   myId, members, myFile, myFileObj, send, loadFile, toast, $
"use strict";

// Bağlantı sunucuları sunucudan alınır (TURN tanımlıysa onu da içerir).
const ICE_FALLBACK = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
let iceServersCache = null;
let iceFetchedAt = 0;
function loadIceServers() {
  if (iceServersCache && Date.now() - iceFetchedAt < 12 * 3600 * 1000) return Promise.resolve(iceServersCache);
  return fetch("/api/ice")
    .then((r) => r.json())
    .then((d) => { iceServersCache = d.iceServers || ICE_FALLBACK; iceFetchedAt = Date.now(); return iceServersCache; })
    .catch(() => ICE_FALLBACK);
}
loadIceServers();
const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;   // gönderim tamponu bu kadar dolunca bekle
const LOW_WATER = 1 * 1024 * 1024;

// ---------- Ortak ----------
const peers = new Map(); // peerId -> { pc, role, ... }

function sendSignal(to, data) {
  send({ type: "signal", to, data });
}

function newPc(peerId) {
  const pc = new RTCPeerConnection({ iceServers: iceServersCache || ICE_FALLBACK });
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

// Sinyaller sırayla işlenmeli: ICE adayları uzak açıklama ayarlanmadan
// gelirse kaybolmasın diye kuyruğa alınır.
let signalChain = Promise.resolve();
function handleSignal(m) {
  signalChain = signalChain.then(() => handleSignalNow(m)).catch((err) => console.warn("[SyncWatch] sinyal", err));
  return signalChain;
}

async function addIce(p, candidate) {
  if (!p.pc.remoteDescription) { (p.pendingIce = p.pendingIce || []).push(candidate); return; }
  await p.pc.addIceCandidate(candidate).catch((err) => console.warn("[SyncWatch] ICE", err));
}

async function flushIce(p) {
  const list = p.pendingIce || [];
  p.pendingIce = [];
  for (const c of list) await p.pc.addIceCandidate(c).catch(() => {});
}

async function handleSignalNow(m) {
  const from = m.fromId;
  const d = m.data || {};
  try {
    if (d.kind === "offer") await onOffer(from, m.from, d);
    else if (d.kind === "answer") {
      const p = peers.get(from);
      if (p) { await p.pc.setRemoteDescription({ type: "answer", sdp: d.sdp }); await flushIce(p); }
    } else if (d.kind === "ice") {
      const p = peers.get(from);
      if (p && d.candidate) await addIce(p, d.candidate);
    } else if (d.kind === "refile") {
      // Gönderen dosyayı yeniden seçti: yarım kalan indirmeyi sürdür.
      const m = members.find((x) => x.id === from);
      if (m && download && download.peerId === from && download.state === "failed" && d.file &&
          d.file.name === download.file.name && d.file.size === download.file.size) {
        startDownload({ ...m, file: { ...(m.file || {}), name: d.file.name, size: d.file.size } }, true);
      }
    } else if (d.kind === "reject") {
      if (download && download.peerId === from) failDownload(d.reason || "Karşı taraf dosyayı gönderemedi.");
    }
  } catch (err) {
    console.warn("[SyncWatch] sinyal", err);
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
    const start = () => {
      if (p.started) return;
      p.started = true;
      streamFile(peerId, peerName, ch, f, Math.max(0, Math.min(d.offset || 0, f.size)));
    };
    // Bazı tarayıcılarda kanal "datachannel" olayında zaten açık gelir.
    if (ch.readyState === "open") start(); else ch.onopen = start;
    ch.onclose = () => { uploads.delete(peerId); renderUploads(); closePeer(peerId); };
  };

  await pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
  await flushIce(p);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal(peerId, { kind: "answer", sdp: answer.sdp });
}

// Chrome, seçildikten sonra diskte dokunulan dosyanın eski kopyasını okumaz
// (NotReadableError). Elimizde dosya tutamacı varsa taze kopyasını alırız,
// kullanıcının dosyayı yeniden seçmesine gerek kalmaz.
async function freshFile(file) {
  const h = file && file._handle;
  if (!h || !h.getFile) return null;
  try {
    const f = await h.getFile();
    if (f.size !== file.size || f.name !== file.name) return null;
    f._handle = h;
    const i = recentFiles.indexOf(file);
    if (i >= 0) recentFiles[i] = f;
    if (myFileObj === file) myFileObj = f;
    return f;
  } catch { return null; }
}

async function readBlock(ref, a, b) {
  for (let attempt = 0; ; attempt++) {
    try { return await ref.file.slice(a, b).arrayBuffer(); }
    catch (err) {
      if (attempt >= 2) throw err;
      const f = await freshFile(ref.file);
      if (f) ref.file = f;
      else await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// Dosya okunamadığı için indiremeyen kişiler; dosya yeniden seçilince
// onlara haber verilir ve indirme kendiliğinden kaldığı yerden sürer.
const needRefile = new Set();
let refileWarn = null;

function askRefile(peerName) {
  refileWarn = {
    text: `Dosyan okunamadı, ${peerName} indiremiyor. Aynı dosyayı yeniden seç, indirme kendiliğinden devam eder.`,
    action: { label: "Dosyayı tekrar seç", onClick: () => $("fileInput2").click() },
  };
  showNotice(refileWarn.text, refileWarn.action);
  toast("Dosyan okunamadı, yeniden seçmen gerekiyor");
}

function onMyFileChanged() {
  if (!needRefile.size) return;
  refileWarn = null;
  for (const id of needRefile) sendSignal(id, { kind: "refile", file: { name: myFileObj.name, size: myFileObj.size } });
  needRefile.clear();
  checkFiles();
}

async function streamFile(peerId, peerName, ch, file, offset) {
  const up = { name: peerName, sent: offset, size: file.size };
  uploads.set(peerId, up);
  renderUploads();
  const ref = { file };
  let pos = offset;
  const waitDrain = () => new Promise((res) => {
    ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; res(); };
  });
  try {
    while (pos < ref.file.size) {
      if (ch.readyState !== "open") return;
      // Dosyayı 4 MB'lık bloklar halinde oku, 64 KB'lık parçalarla gönder.
      const blockEnd = Math.min(pos + HIGH_WATER, ref.file.size);
      const buf = await readBlock(ref, pos, blockEnd);
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
    console.warn("[SyncWatch] gönderim", err);
    const unreadable = err && (err.name === "NotReadableError" || err.name === "NotFoundError");
    const reason = unreadable
      ? `${myName} tarafında dosya okunamadı. Ondan aynı dosyayı yeniden seçmesini iste, seçince indirme kendiliğinden devam eder.`
      : `${myName} tarafında gönderim durdu.`;
    try { ch.send(JSON.stringify({ error: reason, refile: unreadable })); } catch {}
    if (unreadable) { needRefile.add(peerId); askRefile(peerName); }
    uploads.delete(peerId);
    renderUploads();
  }
}

let uploadsTimer = 0;
function renderUploads() {
  clearTimeout(uploadsTimer);
  uploadsTimer = setTimeout(() => {
    const el = $("uploadInfo");
    const list = [...uploads.values()].filter((u) => u.sent < u.size);
    if (!list.length) { renderUploadUi(); return; }
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
  if (!myFile && storageAvailable && shared) {
    box.hidden = false;
    $("offerText").textContent = `${shared.by} “${shared.name}” dosyasını odaya yükledi (${fmtSize(shared.size)}).`;
    $("offerNote").textContent = "İnternetin koparsa indirme kaldığı yerden devam eder.";
    $("offerBtn").onclick = () => startCloudDownload(shared);
    return;
  }
  const m = offerFor();
  if (!m) { box.hidden = true; return; }
  box.hidden = false;
  $("offerText").textContent = `${m.name} “${m.file.name}” dosyasını açtı (${fmtSize(m.file.size)}).`;
  $("offerNote").textContent = "Dosya doğrudan onun cihazından gelir, indirme bitene kadar onun sayfası açık kalmalı.";
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
    source: "peer",
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
      else if (msg.error) { dl.waitRefile = !!msg.refile; failDownload(msg.error); }
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
  if (dl.peerId) closePeer(dl.peerId);
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
  if (dl.ctrl) dl.ctrl.abort();
  if (dl.peerId) closePeer(dl.peerId);
  dl.sink.pause().catch(() => {});
  renderDownload();
}

function cancelDownload() {
  const dl = download;
  if (!dl) return;
  if (dl.ctrl) dl.ctrl.abort();
  if (dl.peerId) closePeer(dl.peerId);
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
    flush() { return chain; },
    async pause() { await chain.catch(() => {}); if (writable) { await writable.close(); writable = null; } },
    async finish() { await chain; await writable.close(); writable = null; const f = await handle.getFile(); f._handle = handle; return f; },
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
  $("placeholder").classList.toggle("busy", !!dl);
  if (!dl) { box.hidden = true; renderOffer(); return; }
  box.hidden = false;
  $("offer").hidden = true;
  const pct = dl.file.size ? Math.min(100, (dl.received / dl.file.size) * 100) : 0;
  $("dlBar").style.width = pct.toFixed(1) + "%";
  $("dlTitle").textContent = dl.file.name;
  $("dlRetry").hidden = dl.state !== "failed";
  let line = "";
  if (dl.state === "connecting") line = dl.source === "cloud" ? "Başlıyor…" : `${dl.peerName} ile bağlantı kuruluyor…`;
  else if (dl.state === "receiving") {
    const left = dl.speed > 0 ? (dl.file.size - dl.received) / dl.speed : 0;
    line = `%${Math.floor(pct)} · ${fmtSize(dl.received)} / ${fmtSize(dl.file.size)}`;
    if (dl.speed > 0) line += ` · ${fmtSize(dl.speed)}/sn · ${fmtDuration(left)} kaldı`;
  } else if (dl.state === "saving") line = "Kaydediliyor…";
  else if (dl.state === "failed") line = dl.waitRefile
    ? `${dl.error} (%${Math.floor(pct)} indi)`
    : `${dl.error} %${Math.floor(pct)} indi, kaldığı yerden devam edebilirsin.`;
  $("dlLine").textContent = line;
}

setInterval(() => {
  const dl = download;
  if (!dl || dl.state !== "receiving") return;
  const now = performance.now();
  // 20 saniye hiç veri gelmezse takıldı say; "Devam et" kaldığı yerden sürer.
  if (dl.received !== dl.lastBytes) dl.lastProgress = now;
  else if (now - (dl.lastProgress || now) > 20000) {
    failDownload(dl.source === "peer"
      ? `${dl.peerName} tarafından veri gelmiyor. Onun SyncWatch sekmesi açık ve dosyası seçili olmalı.`
      : "İndirme durdu.");
    return;
  } else if (!dl.lastProgress) dl.lastProgress = now;
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
  if (dl.source === "cloud") { startCloudDownload(dl.shared, true); return; }
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

// ======================================================================
// Odaya yükleme (Cloudflare R2). Dosya 10 MB'lık parçalarla yüklenir;
// yarıda kalırsa tamamlanan parçalar hatırlanır ve kalandan devam edilir.
// ======================================================================
let upload = null; // { file, st, saveKey, sent, speed, lastBytes, lastT, state, xhr, error }

async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Sunucu hatası");
  return data;
}

function sharedMatchesMine() {
  return shared && myFileObj && shared.name === myFileObj.name && shared.size === myFileObj.size;
}

function renderUploadUi() {
  const btn = $("uploadBtn");
  const info = $("uploadInfo");
  const bar = $("upProgress");
  bar.hidden = !upload;
  if (upload) bar.firstElementChild.style.width = Math.min(100, (upload.sent / upload.file.size) * 100).toFixed(1) + "%";
  bar.classList.toggle("paused", !!upload && upload.state !== "uploading");
  if (upload) {
    btn.hidden = false;
    if (upload.state === "uploading") {
      btn.textContent = "Duraklat";
      const pct = Math.floor((upload.sent / upload.file.size) * 100);
      let t = `Odaya yükleniyor · %${pct}`;
      if (upload.speed > 0) t += ` · ${fmtDuration((upload.file.size - upload.sent) / upload.speed)} kaldı`;
      info.textContent = t;
    } else {
      btn.textContent = "Devam et";
      info.textContent = upload.error ? `${upload.error} (%${Math.floor((upload.sent / upload.file.size) * 100)})` : `Duraklatıldı · %${Math.floor((upload.sent / upload.file.size) * 100)}`;
    }
    info.hidden = false;
    return;
  }
  if (storageAvailable && sharedMatchesMine()) {
    btn.hidden = true;
    info.hidden = false;
    info.textContent = "Odaya yüklendi";
    return;
  }
  btn.hidden = !(storageAvailable && myFileObj);
  btn.textContent = "Odaya yükle";
  if (!uploads.size) info.hidden = true;
}

$("uploadBtn").addEventListener("click", () => {
  if (upload && upload.state === "uploading") {
    upload.state = "paused";
    if (upload.xhr) upload.xhr.abort();
    renderUploadUi();
    return;
  }
  startUpload();
});

async function startUpload() {
  const f = myFileObj;
  if (!f) return;
  const saveKey = `sw-up:${roomId}:${f.name}:${f.size}`;
  let st = null;
  try { st = JSON.parse(safeGet(saveKey) || "null"); } catch {}
  upload = { file: f, st, saveKey, sent: 0, speed: 0, lastBytes: 0, lastT: performance.now(), state: "uploading", xhr: null, error: "" };
  const up = upload;
  renderUploadUi();
  try {
    if (!st) {
      const r = await api("/api/upload/start", { room: roomId, name: f.name, size: f.size });
      st = up.st = { key: r.key, uploadId: r.uploadId, partSize: r.partSize, parts: [] };
      safeSet(saveKey, JSON.stringify(st));
    }
    const total = Math.ceil(f.size / st.partSize);
    const done = new Set(st.parts.map((p) => p.partNumber));
    up.sent = st.parts.reduce((s, p) => s + Math.min(st.partSize, f.size - (p.partNumber - 1) * st.partSize), 0);
    up.lastBytes = up.sent;

    for (let n = 1; n <= total; n++) {
      if (done.has(n)) continue;
      if (up.state !== "uploading") return;
      const start = (n - 1) * st.partSize;
      const blob = f.slice(start, Math.min(start + st.partSize, f.size));
      let part = null;
      for (let attempt = 0; attempt < 6 && !part; attempt++) {
        if (up.state !== "uploading") return;
        try {
          part = await putPart(up, st, n, blob, up.sent);
        } catch (err) {
          if (up.state !== "uploading") return;
          if (err.status === 404) throw Object.assign(new Error("expired"), { expired: true });
          await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
        }
      }
      if (!part) throw new Error("İnternet bağlantısı koptu.");
      st.parts.push(part);
      up.sent += blob.size;
      safeSet(saveKey, JSON.stringify(st));
    }

    await api("/api/upload/complete", { room: roomId, key: st.key, uploadId: st.uploadId, parts: st.parts, by: myName });
    try { localStorage.removeItem(saveKey); } catch {}
    upload = null;
    toast("Dosya odaya yüklendi");
    renderUploadUi();
  } catch (err) {
    if (err.expired) {
      // Yarım kalan yükleme sunucuda süresi dolmuş: baştan başla.
      try { localStorage.removeItem(saveKey); } catch {}
      upload = null;
      return startUpload();
    }
    if (upload !== up) return;
    up.state = "failed";
    up.error = err.message || "Yükleme durdu.";
    renderUploadUi();
  }
}

// Bir parçayı XHR ile yükle (fetch yükleme ilerlemesini göstermiyor).
function putPart(up, st, n, blob, base) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    up.xhr = xhr;
    const q = new URLSearchParams({ key: st.key, uploadId: st.uploadId, n: String(n) });
    xhr.open("PUT", "/api/upload/part?" + q);
    xhr.upload.onprogress = (e) => renderUploadProgress(up, base + e.loaded);
    xhr.onload = () => {
      up.xhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("bad")); }
      } else reject(Object.assign(new Error("http"), { status: xhr.status }));
    };
    xhr.onerror = () => { up.xhr = null; reject(new Error("net")); };
    xhr.onabort = () => { up.xhr = null; reject(new Error("abort")); };
    xhr.send(blob);
  }).finally(() => { up.sent = base; });
}

function renderUploadProgress(up, bytes) {
  const now = performance.now();
  if (now - up.lastT >= 1000) {
    const inst = ((bytes - up.lastBytes) * 1000) / (now - up.lastT);
    up.speed = up.speed ? up.speed * 0.7 + inst * 0.3 : inst;
    up.lastBytes = bytes;
    up.lastT = now;
  }
  const keep = up.sent;
  up.sent = bytes;
  renderUploadUi();
  up.sent = keep;
}

// Odadaki dosyayı R2'den indir; kesilirse Range ile kaldığı yerden devam et.
async function startCloudDownload(sh, resume) {
  const fileInfo = { name: sh.name, size: sh.size };
  let sink;
  if (resume && download && download.sink && download.shared && download.shared.key === sh.key) {
    sink = download.sink;
  } else {
    try {
      sink = await makeSink(fileInfo);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      sink = memorySink();
    }
  }
  const offset = await sink.reopen();
  const ctrl = new AbortController();
  const dl = {
    source: "cloud", shared: sh, ctrl, file: fileInfo, received: offset, sink,
    lastBytes: offset, lastT: performance.now(), speed: 0, state: "connecting",
  };
  download = dl;
  renderDownload();

  try {
    const url = "/api/files/" + sh.key.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(url, { headers: offset > 0 ? { Range: `bytes=${offset}-` } : {}, signal: ctrl.signal });
    if (res.status === 404) throw new Error("Dosya artık odada değil.");
    if (!res.ok) throw new Error("İndirme başlamadı.");
    if (offset > 0 && res.status !== 206) throw new Error("Sunucu devam etmeye izin vermedi.");
    dl.state = "receiving";
    renderDownload();
    const reader = res.body.getReader();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (download !== dl) return;
      sink.write(value);
      dl.received += value.byteLength;
      // Diske yazma ağdan yavaşsa bellek dolmasın.
      if (sink.flush && ++n % 64 === 0) await sink.flush();
    }
    if (dl.received < dl.file.size) throw new Error("Bağlantı koptu.");
    finishDownload(dl);
  } catch (err) {
    if (download !== dl || dl.state === "failed") return;
    failDownload(err.name === "AbortError" ? "Durduruldu." : (err.message === "Failed to fetch" || err.name === "TypeError" ? "Bağlantı koptu." : err.message));
  }
}
