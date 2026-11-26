// SyncWatch istemcisi. Video yerel dosyadan oynar; sunucuya yalnızca
// oynat/durdur/konum ve sohbet mesajları gider.
"use strict";

const $ = (id) => document.getElementById(id);
const video = $("video");

// Senkron ayarları
const HARD_SYNC = 1.0;   // bu kadar saniyeden fazla fark varsa direkt atla
const SOFT_SYNC = 0.15;  // bunun üstündeki küçük farkları hızla kapat
const RATE_NUDGE = 0.05; // küçük farklar için hız değişimi (%5)
const RATE_NUDGE_BIG = 0.1; // 0.5 sn üstü farklar için (%10)
const LOCAL_GRACE_MS = 1500; // kendi eylemimizden sonra düzeltme yapma süresi

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
let members = [];

const serverNow = () => Date.now() + clockOffset;

// ---------- Giriş ----------
(function initJoin() {
  const params = new URLSearchParams(location.search);
  $("nameInput").value = safeGet("sw-name") || "";
  $("roomInput").value = params.get("oda") || safeGet("sw-room") || "";
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
    $("roomLabel").textContent = "Oda: " + roomId;
    connect();
  });
})();

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

$("copyLink").addEventListener("click", async () => {
  const link = location.origin + location.pathname + "?oda=" + encodeURIComponent(roomId);
  try {
    await navigator.clipboard.writeText(link);
    addSystem("Davet linki kopyalandı");
  } catch {
    addSystem("Davet linki: " + link);
  }
});

// ---------- Bağlantı ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(myName)}`;
  ws = new WebSocket(url);
  setConn("bağlanıyor", "");

  ws.onopen = () => {
    setConn("bağlı", "ok");
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
    setConn("bağlantı koptu, tekrar deneniyor", "bad");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

function send(m) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function setConn(text, cls) {
  const el = $("conn");
  el.textContent = text;
  el.className = "pill " + cls;
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
      state = { playing: !!m.playing, position: m.position || 0, serverTime: m.serverTime };
      if (m.by && m.by !== myName) {
        const verb = { play: "oynattı", pause: "durdurdu", seek: "sardı" }[m.text] || "değiştirdi";
        addSystem(`${m.by} ${verb} (${fmtTime(m.position || 0)})`);
      }
      applyState(true);
      break;
    case "chat":
      addChat(m.from, m.text, m.from === myName);
      break;
    case "system":
      addSystem(m.text);
      break;
    case "presence":
      members = m.members || [];
      renderMembers();
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
  $("syncInfo").textContent = state.playing ? `fark: ${(diff * 1000).toFixed(0)} ms` : "";
}
setInterval(() => applyState(false), 500);

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
$("fileInput").addEventListener("change", () => {
  const f = $("fileInput").files[0];
  if (!f) return;
  fileLoaded = false;
  unlocked = false;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(f);
  $("placeholder").hidden = true;
  video.addEventListener("loadedmetadata", () => {
    fileLoaded = true;
    myFile = { name: f.name, size: f.size, duration: video.duration || 0 };
    send({ type: "file", file: myFile });
    $("readyOverlay").hidden = false;
  }, { once: true });
  video.addEventListener("error", () => {
    addSystem("Bu dosya tarayıcıda oynatılamıyor. MP4 (H.264 + AAC) olarak dönüştürmeyi dene.");
  }, { once: true });
});

$("subInput").addEventListener("change", async () => {
  const f = $("subInput").files[0];
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
  addSystem("Altyazı yüklendi: " + f.name);
});

function srtToVtt(srt) {
  return "WEBVTT\n\n" + srt
    .replace(/^\uFEFF/, "")
    .replace(/\r+/g, "")
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
}

function renderMembers() {
  const box = $("members");
  box.textContent = "";
  for (const m of members) {
    const s = document.createElement("span");
    s.textContent = m.name + (m.file ? ` · ${m.file.name} (${fmtTime(m.file.duration)})` : " · dosya seçmedi");
    box.appendChild(s);
  }
  // Dosya karşılaştırma: süre 1 sn'den fazla farklıysa ya da boyut farklıysa uyar.
  const files = members.filter((m) => m.file).map((m) => m.file);
  const warn = $("fileWarn");
  if (files.length >= 2) {
    const a = files[0];
    const durDiff = files.some((f) => Math.abs(f.duration - a.duration) > 1);
    const sizeDiff = files.some((f) => f.size !== a.size);
    if (durDiff) {
      warn.textContent = "Dosyaların süreleri farklı. Farklı sürümler olabilir, senkron kayabilir.";
      warn.hidden = false;
    } else if (sizeDiff) {
      warn.textContent = "Süreler aynı ama dosya boyutları farklı. Büyük ihtimalle sorun olmaz.";
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
  } else {
    warn.hidden = true;
  }
}

// ---------- Sohbet ----------
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  send({ type: "chat", text });
  $("chatInput").value = "";
});

function addChat(from, text, mine) {
  const div = document.createElement("div");
  div.className = "msg" + (mine ? " mine" : "");
  const b = document.createElement("b");
  b.textContent = from;
  div.appendChild(b);
  div.appendChild(document.createTextNode(text));
  appendMsg(div);
}

function addSystem(text) {
  const div = document.createElement("div");
  div.className = "msg sys";
  div.textContent = text;
  appendMsg(div);
}

function appendMsg(el) {
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
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
