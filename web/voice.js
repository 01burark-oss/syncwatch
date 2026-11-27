// Sesli sohbet (WebRTC, yalnızca ses).
// Varsayılan: tarayıcının kendi yankı/gürültü engellemesi, mikrofon sesi
// doğrudan gönderilir (en az gecikme ve bozulma). İsteyen "Güçlü gürültü
// engelleme"yi açabilir: o zaman tarayıcının engellemesi kapanır ve yerine
// RNNoise (yapay zekâ tabanlı) çalışır; ikisi üst üste binip konuşmayı kesmesin.
// Opus mono 64 kbps, paket kaybına karşı FEC açık; bağlantı zayıflarsa tarayıcı
// bit hızını kendisi düşürür. Biri konuşurken video sesi otomatik kısılır.
//
// app.js ve transfer.js'teki genel değişken/fonksiyonları kullanır:
//   myId, members, send, sendSignal, toast, $, iceServersCache, ICE_FALLBACK,
//   loadIceServers, video
"use strict";

const VOICE_BITRATE = 64000;  // Opus ortalama hedef (Discord ile aynı)
const VOICE_MAX_BITRATE = 64000;
const SPEAK_LEVEL = 0.025;   // bu seviyenin üstü "konuşuyor" sayılır
const DUCK_TO = 0.3;         // konuşma sırasında video sesi bu orana iner
const DUCK_RELEASE_MS = 900;
const NS_KEY = "sw-strong-ns";

let voiceOn = false;
let micStream = null;        // mikrofonun kendisi
let sendStream = null;       // karşıya giden ses (güçlü modda RNNoise çıkışı)
let micChain = null;         // { ctx, nodes, rn } yalnız güçlü modda
let audioCtx = null;         // konuşanı algılamak için
let strongNs = readStrongNs();
const vpeers = new Map(); // peerId -> { pc, audio, analyser, buf, pendingIce, speaking }
let seenVoice = new Set();  // önceki presence'ta sesli sohbette olanlar

function readStrongNs() {
  try { return localStorage.getItem(NS_KEY) === "1"; } catch { return false; }
}

// ---------- Aç / kapat ----------
$("voiceBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!voiceOn) joinVoice();
  else toggleVoiceMenu();
});
$("vmLeave").addEventListener("click", () => { closeVoiceMenu(); leaveVoice(); });
$("vmNs").addEventListener("click", () => setStrongNs(!strongNs));
document.addEventListener("click", (e) => {
  if (!$("voiceMenu").hidden && !e.target.closest("#voiceMenu")) closeVoiceMenu();
});

function toggleVoiceMenu() {
  const m = $("voiceMenu");
  $("peopleMenu").hidden = true;
  $("fileMenu").hidden = true;
  m.hidden = !m.hidden;
  renderVoiceMenu();
}
function closeVoiceMenu() { $("voiceMenu").hidden = true; }
function renderVoiceMenu() {
  $("vmNs").setAttribute("aria-checked", strongNs ? "true" : "false");
  $("vmNsSub").textContent = strongNs
    ? "Açık · fan, klavye, sokak sesini siler"
    : "Kapalı · tarayıcının normal engellemesi çalışıyor";
}

async function joinVoice() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Bu tarayıcı mikrofonu desteklemiyor");
    return;
  }
  setVoiceBtn("busy");
  ensureAudioCtx(); // dokunuş anında oluşsun (iOS)
  try {
    await openMic(strongNs);
  } catch {
    setVoiceBtn("off");
    toast("Mikrofon izni verilmedi");
    return;
  }
  await loadIceServers();
  voiceOn = true;
  send({ type: "voice", on: true });
  setVoiceBtn("on");
  toast(sameNetworkPeer() ? "Aynı ağdasınız: yankı olmaması için iki tarafta da kulaklık takın"
                          : "Sesli sohbettesin · en iyi ses için kulaklık tak");
  syncVoicePeers();
}

// Mikrofonu aç; güçlü modda RNNoise'tan geçir. micStream ve sendStream'i kurar.
async function openMic(strong) {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: !strong }, // güçlü modda RNNoise yapıyor
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
    },
  });
  let out = mic;
  let chain = null;
  if (strong) {
    chain = await buildRnnoiseChain(mic);
    if (chain) out = chain.stream;
    else {
      // Olmadıysa tarayıcının kendi engellemesiyle devam et.
      mic.getTracks().forEach((t) => t.stop());
      strongNs = false;
      toast("Bu cihazda güçlü gürültü engelleme çalışmıyor");
      return openMic(false);
    }
  }
  micStream = mic;
  sendStream = out;
  micChain = chain;
}

function closeMic() {
  if (micChain) {
    for (const n of micChain.nodes) { try { n.disconnect(); } catch {} }
    try { micChain.rn.port.postMessage("destroy"); } catch {}
    try { micChain.ctx.close(); } catch {}
    micChain = null;
  }
  if (sendStream && sendStream !== micStream) sendStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  sendStream = null;
}

// Görüşmeyi kesmeden modu değiştir: yeni mikrofon sesini mevcut bağlantılara tak.
let nsSwitching = false;
async function setStrongNs(on) {
  if (nsSwitching) return;
  strongNs = on;
  try { localStorage.setItem(NS_KEY, on ? "1" : "0"); } catch {}
  renderVoiceMenu();
  if (!voiceOn) return;
  nsSwitching = true;
  const old = { micStream, sendStream, micChain };
  micChain = null;
  try {
    await openMic(on);
  } catch {
    micStream = old.micStream; sendStream = old.sendStream; micChain = old.micChain;
    nsSwitching = false;
    toast("Mikrofon değiştirilemedi");
    return;
  }
  const track = sendStream.getAudioTracks()[0];
  for (const vp of vpeers.values()) {
    for (const s of vp.pc.getSenders()) {
      if (s.track && s.track.kind === "audio") await s.replaceTrack(track).catch(() => {});
    }
  }
  // Eskisini kapat.
  const cur = { micStream, sendStream, micChain };
  micStream = old.micStream; sendStream = old.sendStream; micChain = old.micChain;
  closeMic();
  micStream = cur.micStream; sendStream = cur.sendStream; micChain = cur.micChain;
  nsSwitching = false;
  renderVoiceMenu();
}

// mic -> RNNoise -> karşı taraf. Kendi AudioContext'i, cihazın doğal hızında
// (RNNoise 48 kHz ister; cihaz farklıysa yeniden örnekleme sesi titretmesin
// diye hiç açılmaz).
let rnnoiseWasm = null;
async function buildRnnoiseChain(mic) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !window.AudioWorkletNode) return null;
  let ctx = null;
  try {
    ctx = new AC({ latencyHint: "interactive" });
    if (ctx.sampleRate !== 48000 || !ctx.audioWorklet) { ctx.close(); return null; }
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    await ctx.audioWorklet.addModule("vendor/rnnoise/worklet.js");
    if (!rnnoiseWasm) {
      const simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
      const r = await fetch(simd ? "vendor/rnnoise/rnnoise_simd.wasm" : "vendor/rnnoise/rnnoise.wasm");
      if (!r.ok) throw new Error("wasm " + r.status);
      rnnoiseWasm = await r.arrayBuffer();
    }
    const src = ctx.createMediaStreamSource(mic);
    const rn = new AudioWorkletNode(ctx, "@sapphi-red/web-noise-suppressor/rnnoise", {
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { maxChannels: 1, wasmBinary: rnnoiseWasm.slice(0) },
    });
    const dst = ctx.createMediaStreamDestination();
    dst.channelCount = 1;
    src.connect(rn);
    rn.connect(dst);
    return { ctx, nodes: [src, rn, dst], rn, stream: dst.stream };
  } catch (err) {
    console.warn("[SyncWatch] gürültü engelleme açılamadı", err);
    try { ctx && ctx.close(); } catch {}
    return null;
  }
}

// Aynı internet bağlantısından biri sesli sohbette mi (aynı ev/oda olabilir)?
function sameNetworkPeer() {
  const me = members.find((m) => m.id === myId);
  return !!(me && me.net && members.some((m) => m.id !== myId && m.net === me.net));
}

function leaveVoice() {
  voiceOn = false;
  closeVoiceMenu();
  send({ type: "voice", on: false });
  for (const id of [...vpeers.keys()]) closeVoicePeer(id, true);
  closeMic();
  setVoiceBtn("off");
  unduck();
}

function setVoiceBtn(state) {
  const b = $("voiceBtn");
  b.classList.toggle("on", state === "on");
  b.classList.toggle("busy", state === "busy");
  b.setAttribute("aria-pressed", state === "on" ? "true" : "false");
  b.title = state === "on" ? "Ses ayarları" : "Sesli sohbete katıl";
  renderVoiceHint();
}

// Başkası sesli sohbetteyse ve ben değilsem butonda küçük bir işaret.
function renderVoiceHint() {
  const others = members.some((m) => m.id !== myId && m.voice);
  $("voiceBtn").classList.toggle("invite", !voiceOn && others);
}

// Her presence mesajında çağrılır (app.js).
function onVoicePresence() {
  const now = new Set(members.filter((m) => m.voice).map((m) => m.id));
  for (const m of members) {
    if (m.id !== myId && m.voice && !seenVoice.has(m.id) && !voiceOn) {
      toast(`${m.name} sesli sohbete katıldı · mikrofona dokun`);
    }
  }
  seenVoice = now;
  renderVoiceHint();
  syncVoicePeers();
}

// Sesli sohbetteki herkesle bağlantı olsun; çakışmasın diye küçük kimlikli
// taraf aramayı başlatır.
function syncVoicePeers() {
  const inVoice = members.filter((m) => m.id !== myId && m.voice);
  for (const id of [...vpeers.keys()]) {
    if (!voiceOn || !inVoice.some((m) => m.id === id)) closeVoicePeer(id, false);
  }
  if (!voiceOn || !myId) return;
  for (const m of inVoice) {
    if (!vpeers.has(m.id) && myId < m.id) callVoicePeer(m.id);
  }
}

// ---------- Bağlantı ----------
function newVoicePeer(peerId) {
  const pc = new RTCPeerConnection({ iceServers: iceServersCache || ICE_FALLBACK });
  const vp = { pc, audio: null, analyser: null, buf: null, pendingIce: [], speaking: false };
  vpeers.set(peerId, vp);
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal(peerId, { kind: "v-ice", candidate: e.candidate }); };
  pc.ontrack = (e) => attachRemoteAudio(peerId, vp, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      closeVoicePeer(peerId, false);
      // Biraz bekleyip yeniden dene (arayan taraf).
      setTimeout(() => syncVoicePeers(), 2000);
    }
  };
  const out = sendStream || micStream;
  for (const t of out.getAudioTracks()) pc.addTrack(t, out);
  return vp;
}

async function callVoicePeer(peerId) {
  const vp = newVoicePeer(peerId);
  const offer = await vp.pc.createOffer();
  await vp.pc.setLocalDescription({ type: "offer", sdp: tuneOpus(offer.sdp) });
  limitBitrate(vp.pc);
  sendSignal(peerId, { kind: "v-offer", sdp: vp.pc.localDescription.sdp });
}

let voiceChain = Promise.resolve();
function handleVoiceSignal(m) {
  voiceChain = voiceChain.then(() => onVoiceSignal(m)).catch((err) => console.warn("[SyncWatch] ses", err));
}

async function onVoiceSignal(m) {
  const from = m.fromId;
  const d = m.data;
  if (d.kind === "v-offer") {
    if (!voiceOn) { sendSignal(from, { kind: "v-bye" }); return; }
    closeVoicePeer(from, false);
    const vp = newVoicePeer(from);
    await vp.pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
    await flushVoiceIce(vp);
    const answer = await vp.pc.createAnswer();
    await vp.pc.setLocalDescription({ type: "answer", sdp: tuneOpus(answer.sdp) });
    limitBitrate(vp.pc);
    sendSignal(from, { kind: "v-answer", sdp: vp.pc.localDescription.sdp });
  } else if (d.kind === "v-answer") {
    const vp = vpeers.get(from);
    if (vp) { await vp.pc.setRemoteDescription({ type: "answer", sdp: d.sdp }); await flushVoiceIce(vp); }
  } else if (d.kind === "v-ice") {
    const vp = vpeers.get(from);
    if (!vp || !d.candidate) return;
    if (!vp.pc.remoteDescription) vp.pendingIce.push(d.candidate);
    else await vp.pc.addIceCandidate(d.candidate).catch(() => {});
  } else if (d.kind === "v-bye") {
    closeVoicePeer(from, false);
  }
}

async function flushVoiceIce(vp) {
  const list = vp.pendingIce;
  vp.pendingIce = [];
  for (const c of list) await vp.pc.addIceCandidate(c).catch(() => {});
}

function closeVoicePeer(peerId, sayBye) {
  const vp = vpeers.get(peerId);
  if (!vp) return;
  vpeers.delete(peerId);
  if (sayBye) sendSignal(peerId, { kind: "v-bye" });
  try { vp.pc.close(); } catch {}
  if (vp.audio) { vp.audio.srcObject = null; vp.audio.remove(); }
  setSpeaking(peerId, false);
}

// Opus'u konuşma için ayarla: mono, düşük bit hızı, DTX ve FEC.
function tuneOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!m) return sdp;
  const pt = m[1];
  // DTX kapalı: sessizlikte paket kesmek, gürültü engellemeyle birlikte
  // kelime başlarını yutup sesi kesik kesik yapabiliyor.
  const extra = { usedtx: "0", useinbandfec: "1", stereo: "0", "sprop-stereo": "0", maxplaybackrate: "48000", maxaveragebitrate: String(VOICE_BITRATE) };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) {
    return sdp.replace(re, (_, params) => {
      const map = new Map(params.split(";").map((kv) => kv.split("=")));
      for (const [k, v] of Object.entries(extra)) map.set(k, v);
      return `a=fmtp:${pt} ` + [...map].map(([k, v]) => `${k}=${v}`).join(";");
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ` + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(";"));
}

function limitBitrate(pc) {
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== "audio") continue;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = VOICE_MAX_BITRATE;
    p.encodings[0].priority = "high";
    p.encodings[0].networkPriority = "high";
    s.setParameters(p).catch(() => {});
  }
}

// ---------- Karşı tarafın sesi ----------
function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

function attachRemoteAudio(peerId, vp, stream) {
  if (!vp.audio) {
    const a = document.createElement("audio");
    a.autoplay = true;
    a.setAttribute("playsinline", "");
    a.hidden = true;
    document.body.appendChild(a);
    vp.audio = a;
  }
  vp.audio.srcObject = stream;
  vp.audio.play().catch(() => toast("Sesi duymak için ekrana bir kez dokun"));
  // Konuşmayı algılamak için ses seviyesini ölç.
  if (audioCtx && !vp.analyser) {
    try {
      const src = audioCtx.createMediaStreamSource(stream);
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      vp.analyser = an;
      vp.buf = new Float32Array(an.fftSize);
    } catch {}
  }
}

// iOS/Safari ses bağlamını ilk dokunuşta açar.
document.addEventListener("pointerdown", () => {
  ensureAudioCtx();
  for (const vp of vpeers.values()) if (vp.audio && vp.audio.paused) vp.audio.play().catch(() => {});
}, { passive: true });

// ---------- Konuşanı göster, video sesini kıs ----------
let userVolume = 1;
let ducked = false;
let lastSpeech = 0;
let duckSetting = false;

video.addEventListener("volumechange", () => {
  if (!duckSetting) userVolume = ducked ? video.volume / DUCK_TO : video.volume;
});

function setVideoVolume(v) {
  duckSetting = true;
  video.volume = Math.max(0, Math.min(1, v));
  setTimeout(() => { duckSetting = false; }, 0);
}

function duck() {
  if (ducked) return;
  ducked = true;
  setVideoVolume(userVolume * DUCK_TO);
}

function unduck() {
  if (!ducked) return;
  ducked = false;
  setVideoVolume(userVolume);
}

function setSpeaking(peerId, on) {
  const el = document.querySelector(`.avatar[data-id="${peerId}"]`);
  if (el) el.classList.toggle("speaking", on);
}

setInterval(() => {
  if (!vpeers.size) { unduck(); return; }
  let anyone = false;
  for (const [id, vp] of vpeers) {
    if (!vp.analyser) continue;
    vp.analyser.getFloatTimeDomainData(vp.buf);
    let sum = 0;
    for (let i = 0; i < vp.buf.length; i++) sum += vp.buf[i] * vp.buf[i];
    const level = Math.sqrt(sum / vp.buf.length);
    const speaking = level > SPEAK_LEVEL;
    vp.speaking = speaking;
    setSpeaking(id, speaking); // avatarlar yeniden çizilebildiği için her seferinde
    if (speaking) anyone = true;
  }
  const now = Date.now();
  if (anyone) { lastSpeech = now; duck(); }
  else if (ducked && now - lastSpeech > DUCK_RELEASE_MS) unduck();
}, 120);
