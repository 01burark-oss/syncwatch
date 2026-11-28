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
// Odalara kısa bir kodla girilir (ör. K7P4QX). Karışmasın diye 0/O, 1/I/L yok.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newRoomCode() {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return [...a].map((n) => CODE_CHARS[n % CODE_CHARS.length]).join("");
}
// Yazılan kodu düzelt: boşluk/tire at, büyük harfe çevir. Eski davet
// linklerindeki oda adları (ör. film-gecesi-23) olduğu gibi kalır.
function normalizeCode(v) {
  const raw = String(v || "").trim();
  const c = raw.replace(/[\s-]+/g, "").toLocaleUpperCase("en");
  return /^[A-Z0-9]{4,10}$/.test(c) ? c : raw;
}

(function initJoin() {
  const invited = normalizeCode(new URLSearchParams(location.search).get("oda"));
  $("nameInput").value = safeGet("sw-name") || "";
  if (invited) {
    $("createBlock").hidden = true;
    $("inviteJoin").hidden = false;
    $("joinLead").textContent = `${invited} kodlu odaya davet edildin.`;
  } else {
    const last = safeGet("sw-room");
    if (last && /^[A-Z0-9]{4,10}$/.test(last)) $("codeInput").placeholder = `Oda kodu (son: ${last})`;
  }
  if ($("nameInput").value) $("nameInput").select();

  const err = (t) => { $("joinErr").textContent = t; $("joinErr").hidden = !t; };
  $("codeInput").addEventListener("input", () => err(""));

  $("createBtn").addEventListener("click", () => {
    if (!$("joinForm").reportValidity()) return;
    enterRoom(newRoomCode());
  });
  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (invited) { enterRoom(invited); return; }
    let code = normalizeCode($("codeInput").value);
    if (!code && $("codeInput").placeholder.includes("son:")) code = safeGet("sw-room");
    if (!code) { err("Katılmak için oda kodunu yaz ya da yeni oda oluştur."); $("codeInput").focus(); return; }
    enterRoom(code);
  });
})();

function enterRoom(code) {
  myName = $("nameInput").value.trim();
  roomId = code;
  if (!myName || !roomId) return;
  safeSet("sw-name", myName);
  safeSet("sw-room", roomId);
  history.replaceState(null, "", "?oda=" + encodeURIComponent(roomId));
  $("join").hidden = true;
  $("app").hidden = false;
  $("roomLabel").textContent = roomId;
  $("roomLabel").classList.toggle("code", /^[A-Z0-9]{4,10}$/.test(roomId));
  document.title = roomId + " · SyncWatch";
  renderPeople();
  connect();
  // Sesli sohbet odaya girince açılır (varsayılan bas-konuş).
  if (typeof joinVoice === "function" && safeGet("sw-voice-auto") !== "0") joinVoice();
}

// Odadan çık: sesli sohbeti kapat, bağlantıyı kes, giriş ekranına dön.
// Sayfa baştan yüklenir ki video, aktarım ve bağlantılar temizce kapansın.
$("leaveBtn").addEventListener("click", () => {
  if (typeof voiceOn !== "undefined" && voiceOn) leaveVoice();
  if (ws) { ws.onclose = null; try { ws.close(1000, "leave"); } catch {} }
  location.replace(location.pathname);
});

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

$("copyLink").addEventListener("click", async () => {
  const link = location.origin + location.pathname + "?oda=" + encodeURIComponent(roomId);
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: "SyncWatch", text: `Birlikte izleyelim mi? Oda kodu: ${roomId}`, url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    toast(`Davet linki kopyalandı · oda kodu ${roomId}`);
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
let connected = false;
function setConn(ok) {
  connected = ok;
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
      if (typeof aiAvailable !== "undefined") aiAvailable = !!m.ai;
      // Sesli sohbet bağlantıdan önce açıldıysa (ya da yeniden bağlandıysak) bildir.
      if (typeof voiceOn !== "undefined" && voiceOn) send({ type: "voice", on: true });
      shared = m.shared || null;
      if (typeof renderOffer === "function") { renderOffer(); renderUploadUi(); }
      break;
    case "shared":
      shared = m.shared || null;
      if (typeof renderOffer === "function") { renderOffer(); renderUploadUi(); }
      break;
    case "signal":
      if (m.data && typeof m.data.kind === "string" && m.data.kind.startsWith("v-")) {
        if (typeof handleVoiceSignal === "function") handleVoiceSignal(m);
      } else if (typeof handleSignal === "function") handleSignal(m);
      break;
    case "subtitle":
    case "subOffset":
    case "subClear":
      if (typeof onSubMessage === "function") onSubMessage(m);
      break;
    case "react":
      if (typeof onReact === "function") onReact(m);
      break;
    case "pos":
      if (typeof onPos === "function") onPos(m);
      break;
    case "presence":
      members = m.members || [];
      renderPeople();
      checkFiles();
      if (typeof onVoicePresence === "function") onVoicePresence();
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

  // Geri sayım sürüyor: başlangıç anına kadar durmuş bekle.
  if (state.playing && serverNow() < state.serverTime) {
    if (!video.paused) doPause();
    if (Math.abs(video.currentTime - state.position) > 0.05) doSeek(state.position);
    setTimeout(() => applyState(true), Math.max(0, state.serverTime - serverNow()) + 5);
    return;
  }

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
  const prev = myFileObj;
  if (prev) savePos(prev, video.currentTime);
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
    rememberFile(f);
    // Başka bir dosyadan geçildiyse ve bu dosyayı odada izleyen yoksa odayı
    // bu dosyanın kaldığı yere al (durmuş). Biri zaten izliyorsa ona katıl.
    const watched = members.some((m) => m.id !== myId && sameFile(m.file, myFile));
    if (prev && fileKey(prev) !== fileKey(f) && !watched) {
      const pos = loadPos(f);
      send({ type: "pause", position: pos });
      if (pos > 5) toast(`Kaldığın yerden: ${fmtTime(pos)}`);
    }
    if (typeof renderOffer === "function") { renderOffer(); renderUploadUi(); }
    send({ type: "file", file: myFile });
    if (typeof onMyFileChanged === "function") onMyFileChanged();
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
  $(id).addEventListener("change", (e) => { const f = e.target.files[0]; if (f) f._src = "input"; loadFile(f); e.target.value = ""; });
  // Masaüstü Chrome/Edge: dosyayı tutamaçla seç. Dosya diskte değişip eski
  // kopyası okunamazsa (ör. karşı taraf indirirken) yeniden seçmeye gerek kalmaz.
  if (window.showOpenFilePicker && !matchMedia("(pointer: coarse)").matches) {
    $(id).addEventListener("click", (e) => {
      e.preventDefault();
      window.showOpenFilePicker({
        types: [{ description: "Video", accept: { "video/*": [".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"] } }],
      }).then(async ([h]) => {
        const f = await h.getFile();
        f._handle = h;
        f._src = "picker";
        loadFile(f);
      }).catch((err) => { if (!err || err.name !== "AbortError") console.warn(err); });
    });
  }
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
  f._src = "drop";
  // Chrome: dosya tutamacını da al; dosya sonradan okunamazsa tazelenir.
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  if (item && item.getAsFileSystemHandle) item.getAsFileSystemHandle().then((h) => { if (h && h.kind === "file") f._handle = h; }).catch(() => {});
  if (/\.(srt|vtt)$/i.test(f.name)) loadSubtitle(f); else loadFile(f);
});

// ---------- Odadakiler ----------
// Odadakiler: üst çubukta baş harfli yuvarlak avatarlar.
const AVATAR_COLORS = ["#4fcf7f", "#6aa9ff", "#f2b84b", "#ff7d8a", "#b48cff", "#4fd1c5"];
function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0] ? [...parts[0]][0] : "?";
  const b = parts.length > 1 ? [...parts[parts.length - 1]][0] : "";
  return (a + b).toLocaleUpperCase("tr");
}

function renderPeople() {
  const box = $("people");
  box.textContent = "";
  const others = members.filter((m) => m.id !== myId);
  const sub = $("roomSub");
  if (!connected) sub.textContent = "Bağlanıyor…";
  else if (!others.length) sub.textContent = "Karşı taraf bekleniyor";
  else if (others.length === 1) sub.textContent = `${others[0].name} burada`;
  else sub.textContent = `${others.length + 1} kişi burada`;

  for (const m of others.slice(0, 4)) {
    const s = document.createElement("span");
    s.className = "avatar" + (m.file ? " ready" : "") + (m.voice ? " inVoice" : "");
    s.dataset.id = m.id;
    s.style.setProperty("--c", avatarColor(m.name));
    s.textContent = initials(m.name);
    s.title = m.name + (m.file ? ` · ${m.file.name}` : " · henüz dosya seçmedi") + (m.voice ? " · sesli sohbette" : "");
    box.appendChild(s);
  }
  if (others.length > 4) {
    const s = document.createElement("span");
    s.className = "avatar more";
    s.textContent = "+" + (others.length - 4);
    box.appendChild(s);
  }
}

// ---------- Telefon: seçenekler paneli ----------
function openSheet() {
  const up = $("uploadBtn");
  $("sheetFile").textContent = myFileObj ? myFileObj.name : "";
  $("sUpload").hidden = up.hidden;
  $("sUploadTitle").textContent = up.textContent;
  $("sUploadSub").hidden = up.textContent !== "Odaya yükle";
  const save = $("saveLink");
  $("sSave").hidden = save.hidden;
  if (!save.hidden) { $("sSave").href = save.href; $("sSave").download = save.download; }
  const rec = $("sRecent");
  rec.textContent = "";
  if (recentFiles.length > 1) {
    const h = document.createElement("p");
    h.className = "menuHead";
    h.textContent = "Son açtıkların";
    rec.appendChild(h);
    rec.appendChild(recentRows("sheetRow recentRow", (f) => { closeSheet(); if (f !== myFileObj) loadFile(f); }));
  }
  $("sheet").hidden = false;
  requestAnimationFrame(() => $("sheet").classList.add("open"));
}
function closeSheet() {
  const sh = $("sheet");
  sh.classList.remove("open");
  setTimeout(() => { sh.hidden = true; }, 200);
}
$("moreBtn").addEventListener("click", openSheet);
$("sheet").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); });
$("sUpload").addEventListener("click", () => { closeSheet(); $("uploadBtn").click(); });
$("sSub").addEventListener("click", () => { closeSheet(); $("subInput").click(); });
$("sChange").addEventListener("click", () => { closeSheet(); $("fileInput2").click(); });
$("sSave").addEventListener("click", () => closeSheet());
$("sInvite").addEventListener("click", () => { closeSheet(); $("copyLink").click(); });

// Aynı dosya mı? Ad ya da süre tutuyorsa aynı bölüm sayılır.
function sameFile(a, b) {
  if (!a || !b) return false;
  if (a.name === b.name && a.size === b.size) return true;
  return a.duration > 0 && b.duration > 0 && Math.abs(a.duration - b.duration) <= 1;
}

// Dosya karşılaştırma: karşı taraf başka bir dosya açtıysa uyar; o dosya
// bizde de açılmışsa tek dokunuşla ona geçilebilsin.
function checkFiles() {
  renderPeopleMenu();
  if (typeof refileWarn !== "undefined" && refileWarn) { showNotice(refileWarn.text, refileWarn.action); return; }
  if (!myFile) { showNotice(""); return; }
  const others = members.filter((m) => m.id !== myId && m.file);
  const odd = others.find((m) => !sameFile(m.file, myFile));
  if (!odd) { showNotice(""); return; }
  const mine = recentFiles.find((f) => f.name === odd.file.name && f.size === odd.file.size);
  if (mine) {
    showNotice(`${odd.name} şu an “${odd.file.name}” izliyor, sen başka dosyadasın.`,
      { label: "Ona geç", onClick: () => loadFile(mine) });
  } else {
    showNotice(`${odd.name} başka bir dosya açtı: “${odd.file.name}” (${fmtTime(odd.file.duration)}). Senin açtığın: “${myFile.name}”. Aynı bölümü açın, yoksa sahneler kayar.`);
  }
}

function showNotice(text, action) {
  const el = $("fileWarn");
  el.textContent = text;
  if (text && action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "noticeBtn";
    b.textContent = action.label;
    b.addEventListener("click", action.onClick);
    el.appendChild(b);
  }
  el.hidden = !text;
}

// ---------- Son açılan dosyalar ve kaldığın yer ----------
// Dosyanın kendisi yalnızca bu sekmede tutulur (tarayıcı dosyayı yeniden
// açmadan okuyamaz); kaldığın yer ise cihazda saklanır.
const recentFiles = [];
const fileKey = (f) => f.name + "|" + f.size;

function rememberFile(f) {
  const i = recentFiles.findIndex((x) => fileKey(x) === fileKey(f));
  if (i >= 0) recentFiles.splice(i, 1);
  recentFiles.unshift(f);
  if (recentFiles.length > 6) recentFiles.pop();
}
function savePos(f, t) {
  if (!f || !(t >= 0)) return;
  safeSet("sw-pos:" + fileKey(f), String(Math.floor(t)));
}
function loadPos(f) {
  const v = Number(safeGet("sw-pos:" + fileKey(f)));
  return v > 0 ? v : 0;
}
let lastPosSave = 0;
video.addEventListener("timeupdate", () => {
  const now = Date.now();
  if (!myFileObj || now - lastPosSave < 5000) return;
  lastPosSave = now;
  savePos(myFileObj, video.currentTime);
});

function recentRows(rowClass, onPick) {
  const frag = document.createDocumentFragment();
  for (const f of recentFiles) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = rowClass + (myFileObj && fileKey(f) === fileKey(myFileObj) ? " current" : "");
    const span = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = f.name;
    span.appendChild(strong);
    const pos = loadPos(f);
    if (pos > 5) {
      const small = document.createElement("small");
      small.className = "pos";
      small.textContent = "Kaldığın yer " + fmtTime(pos);
      span.appendChild(small);
    }
    b.appendChild(span);
    b.addEventListener("click", () => onPick(f));
    frag.appendChild(b);
  }
  return frag;
}

function openFileMenu() {
  const others = recentFiles.filter((f) => !myFileObj || fileKey(f) !== fileKey(myFileObj));
  if (!others.length) { $("fileInput2").click(); return; }
  const list = $("recentList");
  list.textContent = "";
  list.appendChild(recentRows("vmRow", (f) => { closeMenus(); if (f !== myFileObj) loadFile(f); }));
  $("fileMenu").hidden = false;
}
$("changeBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!$("fileMenu").hidden) closeMenus(); else { closeMenus(); openFileMenu(); }
});
$("fmPick").addEventListener("click", () => { closeMenus(); $("fileInput2").click(); });

// ---------- Odadakiler ----------
function renderPeopleMenu() {
  const list = $("peopleList");
  if (!list) return;
  list.textContent = "";
  const sorted = [...members].sort((a, b) => (a.id === myId ? -1 : b.id === myId ? 1 : 0));
  for (const m of sorted) {
    const me = m.id === myId;
    const row = document.createElement("div");
    row.className = "pRow";
    const av = document.createElement("span");
    av.className = "avatar" + (m.file ? " ready" : "") + (m.voice ? " inVoice" : "");
    av.dataset.id = m.id;
    av.style.setProperty("--c", avatarColor(m.name));
    av.textContent = initials(m.name);
    const info = document.createElement("span");
    info.className = "pInfo";
    const name = document.createElement("strong");
    name.textContent = m.name;
    if (me) { const em = document.createElement("em"); em.textContent = " (sen)"; name.appendChild(em); }
    const sub = document.createElement("small");
    if (!m.file) sub.textContent = "Henüz dosya seçmedi";
    else {
      sub.textContent = m.file.name;
      if (!me && myFile) sub.className = sameFile(m.file, myFile) ? "same" : "diff";
    }
    sub.title = sub.textContent;
    info.append(name, sub);
    row.append(av, info);
    if (m.voice) {
      const mic = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      mic.setAttribute("viewBox", "0 0 24 24");
      mic.setAttribute("class", "pMic");
      mic.innerHTML = '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>';
      const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      t.textContent = "Sesli sohbette";
      mic.appendChild(t);
      row.appendChild(mic);
    }
    list.appendChild(row);
  }
}
function togglePeopleMenu(e) {
  e.stopPropagation();
  const open = $("peopleMenu").hidden;
  closeMenus();
  if (open) { renderPeopleMenu(); $("peopleMenu").hidden = false; }
}
$("people").addEventListener("click", togglePeopleMenu);
document.querySelector(".roomInfo").addEventListener("click", togglePeopleMenu);

function closeMenus() {
  $("peopleMenu").hidden = true;
  $("fileMenu").hidden = true;
  if (typeof closeVoiceMenu === "function") closeVoiceMenu();
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("#peopleMenu, #fileMenu")) { $("peopleMenu").hidden = true; $("fileMenu").hidden = true; }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

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
  if (!mine && typeof noteIncomingChat === "function") noteIncomingChat(from, text);
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

// ---------- Tam ekran ve yan ekran ----------
// Telefon yan çevrilince (ya da tam ekran butonuyla) video ekranı kaplar;
// sohbet sağdan açılıp kapanan bir panele taşınır.
const chatEl = document.querySelector(".chat");
const chatHome = { parent: chatEl.parentNode, next: chatEl.nextSibling };
const landscapeMq = matchMedia("(orientation: landscape) and (max-height: 520px)");
let immersive = false;
let pseudoFs = false; // Fullscreen API olmayan cihazlar (iPhone) için
let unread = 0;

function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }

function updateImmersive() {
  const wrapEl = $("videoWrap");
  const hasVideo = !wrapEl.classList.contains("empty");
  const on = hasVideo && (fsElement() === wrapEl || pseudoFs || landscapeMq.matches);
  $("chatToggle").hidden = !on;
  if (on === immersive) return;
  immersive = on;
  document.body.classList.toggle("immersive", on);
  if (on) {
    $("chatDock").appendChild(chatEl);
  } else {
    chatHome.parent.insertBefore(chatEl, chatHome.next);
    setDock(false);
    if (screen.orientation && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch {} }
  }
}

function setDock(open) {
  $("videoWrap").classList.toggle("dockOpen", open);
  if (open) { unread = 0; renderBadge(); const m = $("messages"); m.scrollTop = m.scrollHeight; }
}
function renderBadge() {
  $("chatBadge").hidden = !unread;
  $("chatBadge").textContent = unread > 9 ? "9+" : String(unread);
}
// Panel kapalıyken gelen mesajı say ve kısaca göster.
function noteIncomingChat(from, text) {
  if (!immersive || $("videoWrap").classList.contains("dockOpen")) return;
  unread++;
  renderBadge();
  toast(`${from}: ${text.length > 80 ? text.slice(0, 80) + "…" : text}`);
}

$("chatToggle").addEventListener("click", () => setDock(!$("videoWrap").classList.contains("dockOpen")));

$("fsBtn").addEventListener("click", async () => {
  const wrapEl = $("videoWrap");
  if (immersive) {
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    pseudoFs = false;
    if (landscapeMq.matches) toast("Telefonu dik çevirince normal görünüme döner");
    updateImmersive();
    return;
  }
  const req = wrapEl.requestFullscreen || wrapEl.webkitRequestFullscreen;
  if (req) {
    try {
      await req.call(wrapEl);
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock("landscape").catch(() => {});
    } catch { pseudoFs = true; }
  } else {
    pseudoFs = true;
  }
  updateImmersive();
});

document.addEventListener("fullscreenchange", updateImmersive);
document.addEventListener("webkitfullscreenchange", updateImmersive);
landscapeMq.addEventListener ? landscapeMq.addEventListener("change", updateImmersive) : landscapeMq.addListener(updateImmersive);
video.addEventListener("loadedmetadata", updateImmersive);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && pseudoFs) { pseudoFs = false; updateImmersive(); }
});
