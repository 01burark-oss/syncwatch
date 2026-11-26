// SyncWatch istemcisi. Video yerel dosyadan oynar; sunucuya yalnızca
// oynat/durdur/konum ve sohbet mesajları gider.
"use strict";

const $ = (id) => document.getElementById(id);
const video = $("video");

// Senkron ayarları
const HARD_SYNC = 1.0;        // bu kadar saniyeden fazla fark varsa direkt atla
const SOFT_SYNC = 0.15;       // bunun üstündeki küçük farkları hızla kapat
const RATE_NUDGE = 0.05;      // küçük farklar için hız değişimi (%5)
const RATE_NUDGE_BIG = 0.1;   // 0.5 sn üstü farklar için (%10)
const LOCAL_GRACE_MS = 1500;  // kendi eylemimizden sonra düzeltme yapma süresi

let ws = null;
let myName = "";
let roomId = "";
let reconnectDelay = 1000;

let clockOffset = 0;      // sunucu saati - yerel saat (ms)
let bestRtt = Infinity;

let state = null;         // { playing, position, serverTime }
let fileLoaded = false;
let unlocked = false;     // kullanıcı "Hazırım"a bastı mı / oynatma izinli mi
let expectPaused = true;  // programın beklediği durum; farklıysa kullanıcı yaptı
let ourSeek = false;
let localActionUntil = 0;
let myFile = null;
let myFileObj = null;     // seçilen File; karşı taraf indirmek isterse buradan gönderilir
let myId = "";
let storageAvailable = false; // sunucuda dosya depolama (R2) açık mı
let shared = null;            // odaya yüklenmiş dosya { key, name, size, by }
let members = [];

const serverNow = () => Date.now() + clockOffset;

// ---------- Giriş ----------
const ROOM_WORDS = ["film-gecesi", "patlamis-misir", "battaniye", "gece-seansi", "koltuk", "dizi-maratonu"];

(function initJoin() {
  const invited = new URLSearchParams(location.search).get("oda");
  $("nameInput").value = safeGet("sw-name") || "";
  if (invited) {
    $("roomInput").value = invited;
    $("roomField").hidden = true;
    $("joinLead").textContent = `“${invited}” odasına davet edildin.`;
  } else {
    $("roomInput").value = safeGet("sw-room") ||
      ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)] + "-" + Math.floor(10 + Math.random() * 90);
  }
  if ($("nameInput").value) $("nameInput").select();

  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    myName = $("nameInput").value.trim();
    roomId = $("roomInput").value.trim();
    if (!myName || !roomId) return;
    safeSet("sw-name", myName);
    safeSet("sw-room", roomId);
    history.replaceState(null, "", "?oda=" + encodeURIComponent(roomId));
    $("join").hidden = true;
    $("app").hidden = false;
    $("roomLabel").textContent = roomId;
    document.title = roomId + " · SyncWatch";
    renderPeople();
    connect();
  });
})();

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

$("copyLink").addEventListener("click", async () => {
  const link = location.origin + location.pathname + "?oda=" + encodeURIComponent(roomId);
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: "SyncWatch", text: "Birlikte izleyelim mi?", url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    toast("Davet linki kopyalandı");
  } catch (err) {
    if (err && err.name === "AbortError") return;
    window.prompt("Bu linki gönder:", link);
  }
});

// ---------- Bağlantı ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(myName)}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    setConn(true);
    reconnectDelay = 1000;
    bestRtt = Infinity;
    for (let i = 0; i < 5; i++) setTimeout(sendPing, i * 200);
    if (myFile) send({ type: "file", file: myFile });
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = () => {
    setConn(false);
    setTimeout(connect, reconnectDelay);
    // Ücretsiz sunucu uykudan uyanırken ilk denemeler başarısız olabilir;
    // bekleme süresini kısa tutuyoruz ki uyanır uyanmaz bağlanalım.
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };
}

function send(m) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

let wasConnected = false;
function setConn(ok) {
  const dot = $("connDot");
  dot.classList.toggle("ok", ok);
  dot.title = ok ? "Bağlı" : "Bağlantı bekleniyor";
  if (!ok && wasConnected) toast("Bağlantı koptu, yeniden bağlanıyor…");
  if (ok && wasConnected === "lost") toast("Yeniden bağlandı");
  wasConnected = ok ? true : (wasConnected ? "lost" : false);
  if (!ok) members = [];
  renderPeople();
}

function sendPing() { send({ type: "ping", t: Date.now() }); }
setInterval(sendPing, 10000);

function onMessage(m) {
  switch (m.type) {
    case "pong": {
      const now = Date.now();
      const rtt = now - m.t;
      // En düşük gecikmeli ölçüm en güvenilir olanıdır; ama zamanla saat
      // kayabileceği için eski en iyiyi yavaşça "eskitiyoruz".
      bestRtt = bestRtt * 1.05;
      if (rtt <= bestRtt) {
        bestRtt = rtt;
        clockOffset = m.serverTime - (m.t + rtt / 2);
      }
      break;
    }
    case "state":
      // Sunucu yeniden başladıysa oda boş açılır (konum 0, durmuş). Bizde
      // izlenen bir şey varsa sıfıra atlamak yerine kendi konumumuzu
      // sunucuya geri yükleriz.
      if (m.fresh && fileLoaded && state && (state.playing || state.position > 0)) {
        const pos = expectedPosition();
        send({ type: state.playing ? "play" : "pause", position: pos });
        break;
      }
      state = { playing: !!m.playing, position: m.position || 0, serverTime: m.serverTime };
      if (m.by && m.by !== myName) {
        const verb = { play: "oynattı", pause: "durdurdu", seek: "sardı" }[m.text];
        if (verb) toast(`${m.by} ${verb} · ${fmtTime(m.position || 0)}`);
      }
      applyState(true);
      break;
    case "chat":
      addChat(m.from, m.text, m.from === myName);
      break;
    case "system":
      addSystem(m.text);
      break;
    case "welcome":
      myId = m.id;
      storageAvailable = !!m.storage;
      shared = m.shared || null;
      if (typeof renderOffer === "function") { renderOffer(); renderUploadUi(); }
      break;
    case "shared":
      shared = m.shared || null;
      if (typeof renderOffer === "function") { renderOffer(); renderUploadUi(); }
      break;
    case "signal":
      if (typeof handleSignal === "function") handleSignal(m);
      break;
    case "presence":
      members = m.members || [];
      renderPeople();
      checkFiles();
      if (typeof renderOffer === "function") renderOffer();
      break;
  }
}

// ---------- Oynatma senkronu ----------
function expectedPosition() {
  if (!state) return 0;
  if (!state.playing) return state.position;
  return state.position + (serverNow() - state.serverTime) / 1000;
}

function doPlay() {
  expectPaused = false;
  const p = video.play();
  if (p && p.catch) {
    p.catch(() => {
      // Tarayıcı izin vermedi (özellikle iPhone): kullanıcıdan dokunuş iste.
      expectPaused = true;
      unlocked = false;
      $("readyOverlay").hidden = false;
    });
  }
}

function doPause() {
  expectPaused = true;
  video.pause();
}

function doSeek(t) {
  ourSeek = true;
  video.currentTime = Math.max(0, t);
}

function applyState(force) {
  if (!fileLoaded || !state || !unlocked) return;
  if (!force && Date.now() < localActionUntil) return;
  if (video.seeking) return;

  const target = expectedPosition();
  const dur = video.duration || Infinity;

  if (state.playing && target >= dur) {
    if (!video.paused) doPause();
    return;
  }

  if (state.playing && video.paused) doPlay();
  if (!state.playing && !video.paused) doPause();

  const diff = video.currentTime - target;
  if (Math.abs(diff) > HARD_SYNC || (!state.playing && Math.abs(diff) > 0.05)) {
    doSeek(target);
    video.playbackRate = 1;
  } else if (state.playing && Math.abs(diff) > SOFT_SYNC) {
    const nudge = Math.abs(diff) > 0.5 ? RATE_NUDGE_BIG : RATE_NUDGE;
    video.playbackRate = diff > 0 ? 1 - nudge : 1 + nudge;
  } else {
    video.playbackRate = 1;
  }
  setSync(Math.abs(diff) <= 0.5);
}
setInterval(() => applyState(false), 500);

function setSync(ok) {
  const el = $("syncState");
  const others = members.filter((m) => m.id !== myId).length;
  if (!others) {
    el.className = "syncState";
    el.textContent = "Yalnız izliyorsun";
    return;
  }
  el.className = "syncState " + (ok ? "ok" : "wait");
  el.textContent = ok ? "Senkron" : "Eşitleniyor…";
}

// Kullanıcının kendi eylemi: sunucuya bildir ve yerel durumu hemen güncelle.
function localAction(type) {
  const position = video.currentTime;
  const playing = type === "play" ? true : type === "pause" ? false : (state ? state.playing : false);
  state = { playing, position, serverTime: serverNow() };
  localActionUntil = Date.now() + LOCAL_GRACE_MS;
  send({ type, position });
}

video.addEventListener("play", () => {
  if (!fileLoaded) return;
  if (expectPaused) { expectPaused = false; localAction("play"); }
});
video.addEventListener("pause", () => {
  if (!fileLoaded) return;
  if (!expectPaused) { expectPaused = true; localAction("pause"); }
});
video.addEventListener("seeked", () => {
  if (!fileLoaded) return;
  if (ourSeek) { ourSeek = false; return; }
  localAction("seek");
});

$("readyBtn").addEventListener("click", () => {
  unlocked = true;
  $("readyOverlay").hidden = true;
  // Dokunuş anında bir kez oynatıp hemen durdurmak iOS'ta kilidi açar.
  expectPaused = false;
  const p = video.play();
  const finish = () => {
    if (!state || !state.playing) doPause();
    applyState(true);
  };
  if (p && p.then) p.then(finish, finish); else finish();
});

// ---------- Dosyalar ----------
function loadFile(f) {
  if (!f) return;
  fileLoaded = false;
  unlocked = false;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f);
  $("videoWrap").classList.remove("empty");
  $("placeholder").hidden = true;
  $("fileBar").hidden = false;
  $("fileName").textContent = f.name;
  $("fileName").title = f.name;

  const onMeta = () => {
    video.removeEventListener("error", onError);
    fileLoaded = true;
    myFile = { name: f.name, size: f.size, duration: video.duration || 0 };
    myFileObj = f;
    if (typeof renderOffer === "function") { renderOffer(); renderUploadUi(); }
    send({ type: "file", file: myFile });
    $("readyOverlay").hidden = false;
    checkFiles();
  };
  const onError = () => {
    video.removeEventListener("loadedmetadata", onMeta);
    $("videoWrap").classList.add("empty");
    $("placeholder").hidden = false;
    $("fileBar").hidden = true;
    showNotice("Bu dosya tarayıcıda açılamadı. Dosyayı MP4'e çevirip tekrar dene.");
  };
  video.addEventListener("loadedmetadata", onMeta, { once: true });
  video.addEventListener("error", onError, { once: true });
}

for (const id of ["fileInput", "fileInput2"]) {
  $(id).addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
}

// Sürükle-bırak
const wrap = $("videoWrap");
wrap.addEventListener("dragover", (e) => { e.preventDefault(); wrap.classList.add("dragging"); });
wrap.addEventListener("dragleave", () => wrap.classList.remove("dragging"));
wrap.addEventListener("drop", (e) => {
  e.preventDefault();
  wrap.classList.remove("dragging");
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (/\.(srt|vtt)$/i.test(f.name)) loadSubtitle(f); else loadFile(f);
});

$("subInput").addEventListener("change", (e) => { loadSubtitle(e.target.files[0]); e.target.value = ""; });

async function loadSubtitle(f) {
  if (!f) return;
  let text = await f.text();
  if (!/\.vtt$/i.test(f.name)) text = srtToVtt(text);
  for (const t of video.querySelectorAll("track")) {
    URL.revokeObjectURL(t.src);
    t.remove();
  }
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.label = "Altyazı";
  track.srclang = "tr";
  track.src = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
  track.default = true;
  video.appendChild(track);
  track.track.mode = "showing";
  toast("Altyazı eklendi");
}

function srtToVtt(srt) {
  return "WEBVTT\n\n" + srt
    .replace(/^\uFEFF/, "")
    .replace(/\r+/g, "")
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
}

// ---------- Odadakiler ----------
function renderPeople() {
  const box = $("people");
  box.textContent = "";
  const others = members.filter((m) => m.id !== myId);
  if (!others.length) {
    const s = document.createElement("span");
    s.className = "person";
    s.textContent = "Karşı taraf bekleniyor";
    box.appendChild(s);
    return;
  }
  for (const m of others) {
    const s = document.createElement("span");
    s.className = "person";
    const d = document.createElement("span");
    d.className = "dot" + (m.file ? " ok" : "");
    s.appendChild(d);
    s.appendChild(document.createTextNode(m.name));
    s.title = m.file ? `${m.file.name} seçti` : "Henüz dosya seçmedi";
    box.appendChild(s);
  }
}

// Dosya karşılaştırma: süreler 1 sn'den fazla farklıysa uyar.
function checkFiles() {
  if (!myFile) { showNotice(""); return; }
  const others = members.filter((m) => m.id !== myId && m.file);
  const odd = others.find((m) => Math.abs(m.file.duration - myFile.duration) > 1);
  if (odd) {
    showNotice(`${odd.name} farklı uzunlukta bir dosya seçmiş (${fmtTime(odd.file.duration)}, seninki ${fmtTime(myFile.duration)}). Aynı bölüm olduğundan emin olun, yoksa sahneler kayar.`);
  } else {
    showNotice("");
  }
}

function showNotice(text) {
  const el = $("fileWarn");
  el.textContent = text;
  el.hidden = !text;
}

// ---------- Bildirim ----------
let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  el.hidden = true;
  void el.offsetWidth; // animasyonu baştan başlat
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

// ---------- Sohbet ----------
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  send({ type: "chat", text });
  $("chatInput").value = "";
});

let lastSender = null;
function addChat(from, text, mine) {
  if (from !== lastSender) {
    const who = document.createElement("div");
    who.className = "who" + (mine ? " mine" : "");
    who.textContent = mine ? "Sen" : from;
    appendMsg(who);
    lastSender = from;
  }
  const div = document.createElement("div");
  div.className = "msg" + (mine ? " mine" : "");
  div.textContent = text;
  appendMsg(div);
}

function addSystem(text) {
  lastSender = null;
  const div = document.createElement("div");
  div.className = "sys";
  div.textContent = text;
  appendMsg(div);
}

function appendMsg(el) {
  $("chatEmpty").hidden = true;
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.appendChild(el);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
