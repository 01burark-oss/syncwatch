// Oynatıcı: kendiliğinden gizlenen kontroller, ortada büyük oynat, ±10 sn,
// önizlemeli ilerleme çubuğu, ses, altyazı menüsü, emoji tepkileri,
// 3-2-1 geri sayım ve senkron kayması uyarısı.
//
// app.js'teki genel değişken/fonksiyonları kullanır:
//   $, video, send, state, members, myId, myName, fileLoaded, unlocked,
//   expectedPosition, serverNow, applyState, fmtTime, myFile, toast
"use strict";

const pWrap = $("videoWrap");
const coarse = matchMedia("(pointer: coarse)").matches;

// ---------- Oynat / durdur ----------
let pausedAt = Date.now();
video.addEventListener("pause", () => { pausedAt = Date.now(); });

function othersWithFile() { return members.filter((m) => m.id !== myId && m.file); }

// Uzun süredir durmuşsa ve odada başkası varsa 3-2-1 ile birlikte başlat.
function requestPlay() {
  if (!fileLoaded) return;
  if (othersWithFile().length && Date.now() - pausedAt > 10000) {
    send({ type: "countdown", position: video.currentTime });
    return;
  }
  video.play().catch(() => {});
}
function togglePlay() {
  if (video.paused) requestPlay(); else video.pause();
  showCtrls();
}
function skip(d) {
  if (!fileLoaded) return;
  const dur = video.duration || 0;
  video.currentTime = Math.max(0, Math.min(dur ? dur - 0.5 : Infinity, video.currentTime + d));
  showCtrls();
}

$("cBig").addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
$("cPlay").addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
for (const [id, d] of [["cBack", -10], ["cBack2", -10], ["cFwd", 10], ["cFwd2", 10]]) {
  $(id).addEventListener("click", (e) => { e.stopPropagation(); skip(d); tapFx(d < 0 ? "left" : "right", d < 0 ? "−10" : "+10"); });
}

function renderPlayState() {
  pWrap.classList.toggle("paused", video.paused);
  const label = video.paused ? "Oynat" : "Durdur";
  $("cBig").setAttribute("aria-label", label);
  $("cPlay").setAttribute("aria-label", label);
}
video.addEventListener("play", () => { renderPlayState(); scheduleHide(); });
video.addEventListener("pause", () => { renderPlayState(); showCtrls(); });
renderPlayState();

// ---------- Kontrolleri göster / gizle ----------
let hideTimer = 0;
let dragging = false;
function menusOpen() { return !$("subMenu").hidden || !$("reactPick").hidden; }
function showCtrls() {
  pWrap.classList.remove("cHidden");
  scheduleHide();
}
function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!video.paused && !dragging && !menusOpen()) pWrap.classList.add("cHidden");
  }, coarse ? 3200 : 2600);
}
function hideCtrls() {
  if (video.paused || menusOpen()) return;
  clearTimeout(hideTimer);
  pWrap.classList.add("cHidden");
}

pWrap.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") showCtrls(); });
pWrap.addEventListener("mouseleave", () => { if (!video.paused && !menusOpen()) { clearTimeout(hideTimer); hideTimer = setTimeout(hideCtrls, 600); } });

// Videonun boş alanına dokunma/tıklama.
// Fare: tek tık oynat/durdur, çift tık tam ekran.
// Dokunmatik: tek dokunuş kontrolleri aç/kapa, sağ/sol kenara çift dokunuş ±10 sn.
let lastTap = 0, tapTimer = 0;
$("ctrls").addEventListener("click", (e) => {
  if (e.target !== $("ctrls") && !e.target.classList.contains("cCenter")) return;
  if (!fileLoaded) return;
  const rect = pWrap.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const now = Date.now();
  if (coarse) {
    if (now - lastTap < 300 && (x < 0.35 || x > 0.65)) {
      clearTimeout(tapTimer);
      lastTap = 0;
      skip(x < 0.5 ? -10 : 10);
      tapFx(x < 0.5 ? "left" : "right", x < 0.5 ? "−10" : "+10");
      return;
    }
    lastTap = now;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      if (pWrap.classList.contains("cHidden")) showCtrls(); else hideCtrls();
    }, 220);
  } else {
    if (now - lastTap < 280) {
      clearTimeout(tapTimer);
      lastTap = 0;
      $("fsBtn").click();
      return;
    }
    lastTap = now;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(togglePlay, 200);
  }
});

function tapFx(side, text) {
  const el = $("tapFx");
  el.className = "tapFx " + side;
  el.textContent = text;
  void el.offsetWidth;
  el.classList.add("show");
}

// ---------- İlerleme çubuğu ----------
const seekEl = $("seek");
let previewT = null;

function renderTime() {
  const dur = video.duration || 0;
  const t = previewT != null ? previewT : video.currentTime;
  const pct = dur ? (t / dur) * 100 : 0;
  $("seekFill").style.width = pct + "%";
  $("seekThumb").style.left = pct + "%";
  let buf = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 1) buf = Math.max(buf, video.buffered.end(i));
  }
  $("seekBuf").style.width = (dur ? (buf / dur) * 100 : 0) + "%";
  $("cTime").textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur)}`;
  seekEl.setAttribute("aria-valuenow", String(Math.floor(video.currentTime)));
}
video.addEventListener("timeupdate", renderTime);
video.addEventListener("durationchange", renderTime);
video.addEventListener("progress", renderTime);
video.addEventListener("loadedmetadata", () => {
  renderTime();
  $("cTitle").textContent = myFile ? myFile.name.replace(/\.[^.]+$/, "") : "";
  prevVideo.src = video.src;
  seekEl.setAttribute("aria-valuemax", String(Math.floor(video.duration || 0)));
});

function timeAt(clientX) {
  const r = seekEl.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  return x * (video.duration || 0);
}
function showPreview(clientX, t) {
  const r = seekEl.getBoundingClientRect();
  const box = $("seekPrev");
  box.hidden = false;
  const half = box.offsetWidth / 2 || 96;
  const x = Math.max(half, Math.min(r.width - half, clientX - r.left));
  box.style.left = x + "px";
  $("seekTime").textContent = fmtTime(t);
  wantThumb(t);
}

seekEl.addEventListener("pointermove", (e) => {
  if (!fileLoaded) return;
  if (dragging) { previewT = timeAt(e.clientX); renderTime(); }
  showPreview(e.clientX, timeAt(e.clientX));
});
seekEl.addEventListener("pointerleave", () => { if (!dragging) $("seekPrev").hidden = true; });
seekEl.addEventListener("pointerdown", (e) => {
  if (!fileLoaded) return;
  e.stopPropagation();
  dragging = true;
  seekEl.setPointerCapture(e.pointerId);
  seekEl.classList.add("drag");
  previewT = timeAt(e.clientX);
  renderTime();
  showPreview(e.clientX, previewT);
  showCtrls();
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  seekEl.classList.remove("drag");
  const t = previewT;
  previewT = null;
  $("seekPrev").hidden = true;
  if (t != null && Math.abs(t - video.currentTime) > 0.3) video.currentTime = t;
  renderTime();
  scheduleHide();
};
seekEl.addEventListener("pointerup", endDrag);
seekEl.addEventListener("pointercancel", endDrag);
seekEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { skip(-5); e.preventDefault(); e.stopPropagation(); }
  if (e.key === "ArrowRight") { skip(5); e.preventDefault(); e.stopPropagation(); }
});

// Önizleme karesi: aynı dosyayı sessiz ikinci bir oynatıcıda istenen ana
// sararak çizer. Çok sık sarmasın diye son istenen zamanı bekletir.
const prevVideo = document.createElement("video");
prevVideo.muted = true;
prevVideo.preload = "metadata";
prevVideo.playsInline = true;
let thumbBusy = false, thumbWant = null, thumbHave = null;
function wantThumb(t) {
  thumbWant = Math.floor(t / 2) * 2; // 2 sn'lik adımlar
  if (!thumbBusy && thumbWant !== thumbHave && prevVideo.src) {
    thumbBusy = true;
    prevVideo.currentTime = thumbWant;
  }
}
prevVideo.addEventListener("seeked", () => {
  const c = $("seekCanvas");
  try {
    c.getContext("2d").drawImage(prevVideo, 0, 0, c.width, c.height);
    $("seekPrev").classList.add("hasThumb");
  } catch {}
  thumbHave = prevVideo.currentTime;
  thumbBusy = false;
  if (thumbWant !== null && Math.abs(thumbWant - thumbHave) > 1) wantThumb(thumbWant);
});
prevVideo.addEventListener("error", () => { thumbBusy = false; });

// ---------- Ses ----------
(function initVolume() {
  const v = Number(safeGet("sw-vol"));
  if (v >= 0 && v <= 1 && safeGet("sw-vol") !== null) video.volume = v;
  renderVolume();
})();
function renderVolume() {
  const muted = video.muted || video.volume === 0;
  pWrap.classList.toggle("muted", muted);
  $("cVol").value = String(video.muted ? 0 : video.volume);
  $("cVol").style.setProperty("--v", (video.muted ? 0 : video.volume) * 100 + "%");
  $("cMute").setAttribute("aria-label", muted ? "Sesi aç" : "Sesi kapat");
}
video.addEventListener("volumechange", renderVolume);
$("cVol").addEventListener("input", (e) => {
  video.muted = false;
  video.volume = Number(e.target.value);
  safeSet("sw-vol", String(video.volume));
});
$("cMute").addEventListener("click", (e) => {
  e.stopPropagation();
  if (video.muted || video.volume === 0) { video.muted = false; if (video.volume === 0) video.volume = 0.6; }
  else video.muted = true;
});

// ---------- Menüler ----------
function closePlayerMenus() { $("subMenu").hidden = true; $("reactPick").hidden = true; pWrap.classList.remove("menuOpen"); }
$("cSubs").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("subMenu").hidden;
  closePlayerMenus();
  if (open) { renderSubMenu(); $("subMenu").hidden = false; pWrap.classList.add("menuOpen"); showCtrls(); }
});
$("cReact").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("reactPick").hidden;
  closePlayerMenus();
  if (open) { $("reactPick").hidden = false; showCtrls(); }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#subMenu, #reactPick, #cSubs, #cReact")) closePlayerMenus();
});

// ---------- Emoji tepkileri ----------
const REACTIONS = ["❤️", "😂", "😮", "😢", "😡", "👍", "🔥", "🍿"];
for (const em of REACTIONS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = em;
  b.setAttribute("aria-label", "Tepki " + em);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ type: "react", emoji: em });
    scheduleHide();
  });
  $("reactPick").appendChild(b);
}
function onReact(m) {
  const el = document.createElement("div");
  el.className = "flyEmoji";
  el.style.left = 62 + Math.random() * 30 + "%";
  el.style.setProperty("--drift", (Math.random() * 60 - 30) + "px");
  const e = document.createElement("span");
  e.className = "e";
  e.textContent = m.emoji;
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = m.fromId === myId ? "Sen" : m.from;
  el.append(e, n);
  $("reactLayer").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- Geri sayım ----------
(function cdLoop() {
  const el = $("countdown");
  if (state && state.playing && fileLoaded && serverNow() < state.serverTime) {
    const n = Math.ceil((state.serverTime - serverNow()) / 1000);
    el.hidden = false;
    if ($("cdNum").textContent !== String(n)) {
      $("cdNum").textContent = String(n);
      el.classList.remove("tick");
      void el.offsetWidth;
      el.classList.add("tick");
    }
  } else if (!el.hidden) {
    el.hidden = true;
  }
  requestAnimationFrame(cdLoop);
})();

// ---------- Senkron kayması uyarısı ----------
// Herkes birkaç saniyede bir gerçek konumunu bildirir. Biri (ya da sen)
// odanın konumundan 3 sn'den fazla uzaklaşırsa uyarı çıkar; "Eşitle" herkesi
// geride kalanın olduğu yere alıp 3-2-1 ile birlikte yeniden başlatır.
const peerPos = new Map(); // id -> { name, t, at, buffering, ready }
setInterval(() => {
  if (!fileLoaded) return;
  send({ type: "pos", t: video.currentTime, buffering: !video.paused && video.readyState < 3, ready: unlocked });
}, 4000);

function onPos(m) { peerPos.set(m.id, { name: m.name, t: m.t, at: m.at, buffering: m.buffering }); }

function expectedAt(at) {
  if (!state) return 0;
  if (!state.playing || at < state.serverTime) return state.position;
  return state.position + (at - state.serverTime) / 1000;
}

let driftStrikes = 0;
let driftTarget = null;
let driftHiddenUntil = 0;
setInterval(() => {
  const bar = $("driftBar");
  if (!fileLoaded || !state || !state.playing || serverNow() < state.serverTime) { driftStrikes = 0; bar.hidden = true; return; }
  let worst = null;
  const mine = video.currentTime - expectedPosition();
  if (unlocked && Math.abs(mine) > 3) worst = { me: true, name: "Sen", d: mine, t: video.currentTime };
  const now = serverNow();
  for (const [id, p] of peerPos) {
    if (!members.some((m) => m.id === id) || now - p.at > 10000) continue;
    const d = p.t - expectedAt(p.at);
    if (Math.abs(d) > 3 && (!worst || Math.abs(d) > Math.abs(worst.d))) worst = { me: false, name: p.name, d, t: p.t + (state.playing ? (now - p.at) / 1000 : 0) };
  }
  driftStrikes = worst ? driftStrikes + 1 : 0;
  if (driftStrikes >= 2 && Date.now() > driftHiddenUntil) {
    const sec = Math.round(Math.abs(worst.d));
    $("driftText").textContent = worst.me
      ? `Sen ${sec} sn ${worst.d < 0 ? "geridesin" : "öndesin"}`
      : `${worst.name} ${sec} sn ${worst.d < 0 ? "geride" : "önde"}`;
    driftTarget = worst;
    bar.hidden = false;
  } else if (!worst) {
    bar.hidden = true;
  }
}, 2000);

$("driftFix").addEventListener("click", () => {
  const w = driftTarget;
  $("driftBar").hidden = true;
  driftHiddenUntil = Date.now() + 8000;
  driftStrikes = 0;
  if (!w) return;
  // Geride kalan varsa herkes onun olduğu yere döner; öndeyse oda konumunda kalınır.
  const pos = w.d < 0 ? Math.max(0, w.t) : expectedPosition();
  send({ type: "countdown", position: pos });
});

// ---------- Klavye ----------
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, [contenteditable]") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!fileLoaded || !$("readyOverlay").hidden) return;
  const k = e.key;
  if (k === " " || k === "k") { togglePlay(); e.preventDefault(); }
  else if (k === "ArrowLeft" || k === "j") { skip(-10); e.preventDefault(); }
  else if (k === "ArrowRight" || k === "l") { skip(10); e.preventDefault(); }
  else if (k === "ArrowUp") { video.muted = false; video.volume = Math.min(1, video.volume + 0.1); safeSet("sw-vol", String(video.volume)); showCtrls(); e.preventDefault(); }
  else if (k === "ArrowDown") { video.volume = Math.max(0, video.volume - 0.1); safeSet("sw-vol", String(video.volume)); showCtrls(); e.preventDefault(); }
  else if (k === "f") $("fsBtn").click();
  else if (k === "m") $("cMute").click();
});
