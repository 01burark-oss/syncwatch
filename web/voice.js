// Sesli sohbet (WebRTC, yalnızca ses).
// Zayıf bağlantı için: Opus, mono, en fazla 24 kbps, sessizken veri
// göndermez (DTX), paket kaybına karşı FEC açık. Biri konuşurken video sesi
// otomatik kısılır.
//
// app.js ve transfer.js'teki genel değişken/fonksiyonları kullanır:
//   myId, members, send, sendSignal, toast, $, iceServersCache, ICE_FALLBACK,
//   loadIceServers, video
"use strict";

const VOICE_BITRATE = 24000;
const SPEAK_LEVEL = 0.025;   // bu seviyenin üstü "konuşuyor" sayılır
const DUCK_TO = 0.3;         // konuşma sırasında video sesi bu orana iner
const DUCK_RELEASE_MS = 900;

let voiceOn = false;
let micStream = null;
let audioCtx = null;
const vpeers = new Map(); // peerId -> { pc, audio, analyser, buf, pendingIce, speaking }
let seenVoice = new Set();  // önceki presence'ta sesli sohbette olanlar

// ---------- Aç / kapat ----------
$("voiceBtn").addEventListener("click", () => (voiceOn ? leaveVoice() : joinVoice()));

async function joinVoice() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Bu tarayıcı mikrofonu desteklemiyor");
    return;
  }
  setVoiceBtn("busy");
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    setVoiceBtn("off");
    toast("Mikrofon izni verilmedi");
    return;
  }
  await loadIceServers();
  ensureAudioCtx();
  voiceOn = true;
  send({ type: "voice", on: true });
  setVoiceBtn("on");
  toast("Sesli sohbettesin");
  syncVoicePeers();
}

function leaveVoice() {
  voiceOn = false;
  send({ type: "voice", on: false });
  for (const id of [...vpeers.keys()]) closeVoicePeer(id, true);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  setVoiceBtn("off");
  unduck();
}

function setVoiceBtn(state) {
  const b = $("voiceBtn");
  b.classList.toggle("on", state === "on");
  b.classList.toggle("busy", state === "busy");
  b.setAttribute("aria-pressed", state === "on" ? "true" : "false");
  b.title = state === "on" ? "Sesli sohbetten çık" : "Sesli sohbete katıl";
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
  for (const t of micStream.getAudioTracks()) pc.addTrack(t, micStream);
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
  const extra = { usedtx: "1", useinbandfec: "1", stereo: "0", maxaveragebitrate: String(VOICE_BITRATE) };
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
    p.encodings[0].maxBitrate = VOICE_BITRATE;
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
