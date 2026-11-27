// Altyazı: odaya paylaşılır, herkeste aynı anda görünür.
// - .srt / .vtt okunur (Türkçe karakterler için UTF-8 değilse Windows-1254).
// - Kaydırma (±0,5 sn) odadaki herkese uygulanır.
// - Otomatik eşitleme: videonun kısa bir ses parçası tarayıcıda çıkarılır,
//   sunucuda Whisper ile konuşma zamanları bulunur, altyazı satırlarıyla
//   hizalanır. Dil fark etmez (İngilizce ses + Türkçe altyazı da olur), çünkü
//   kelimelere değil konuşmanın ne zaman olduğuna bakılır.
//
// app.js'teki genel değişken/fonksiyonları kullanır:
//   $, video, send, toast, roomId, myName, myFileObj, fmtTime
"use strict";

let subCues = [];        // [{ start, end, html }] (kaydırmasız, sıralı)
let subName = "";
let subOffset = 0;       // sn; artı = altyazı daha geç görünür
let subOn = true;        // bu cihazda göster/gizle
let aiAvailable = false; // sunucu söyler (welcome)
let syncBusy = false;

const subLayer = $("subLayer");

// ---------- Dosyadan okuma ----------
$("subInput").addEventListener("change", (e) => { loadSubtitle(e.target.files[0]); e.target.value = ""; });

async function loadSubtitle(f) {
  if (!f) return;
  if (f.size > 3 * 1024 * 1024) { toast("Altyazı dosyası çok büyük"); return; }
  const buf = await f.arrayBuffer();
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { text = new TextDecoder("windows-1254").decode(buf); }
  const cues = parseSubs(text);
  if (!cues.length) { toast("Bu dosyada altyazı satırı bulunamadı"); return; }
  const data = JSON.stringify(cues.map((c) => [round2(c.start), round2(c.end), c.text]));
  if (data.length > 900 * 1024) { toast("Altyazı dosyası çok büyük"); return; }
  setSubs(f.name, cues, 0);
  // Odaya paylaş ("type" ilk alan olmalı, sunucu büyük mesajı buna göre kabul eder).
  send({ type: "subtitle", name: f.name, data });
  toast("Altyazı eklendi · odadaki herkeste görünür");
}

const round2 = (x) => Math.round(x * 100) / 100;

function parseTime(s) {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, "0")) / 1000;
}

function parseSubs(text) {
  const out = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r/g, "").split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() !== "");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, z] = lines[i].split("-->");
    const start = parseTime(a), end = parseTime(z);
    if (!(end > start)) continue;
    const text = cleanCueText(lines.slice(i + 1).join("\n"));
    if (!text) continue;
    out.push({ start, end, text });
  }
  out.sort((x, y) => x.start - y.start);
  return out;
}

function cleanCueText(t) {
  return String(t)
    .replace(/\{\\[^}]*\}/g, "")           // {\an8} gibi SSA etiketleri
    .replace(/<(?!\/?(i|b|u)>)[^>]*>/gi, "")  // i/b/u dışındaki etiketler
    .trim();
}

// Metni güvenli HTML'e çevir: yalnızca <i>, <b>, <u> ve satır sonu kalır.
function safeHtml(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/&lt;(\/?)(i|b|u)&gt;/gi, "<$1$2>")
    .replace(/\n/g, "<br>");
}

// ---------- Odadan gelenler ----------
function onSubMessage(m) {
  if (m.type === "subtitle") {
    let cues = [];
    try {
      cues = JSON.parse(m.data)
        .map(([start, end, text]) => ({ start: +start, end: +end, text: cleanCueText(text) }))
        .filter((c) => c.end > c.start && c.text);
    } catch { return; }
    setSubs(m.name, cues, Number(m.offset) || 0);
    if (!m.quiet && m.by !== myName) toast(`${m.by} altyazı ekledi`);
  } else if (m.type === "subOffset") {
    subOffset = Number(m.offset) || 0;
    renderSubMenu();
    renderSubNow(true);
    if (m.by !== myName) toast(`${m.by} altyazıyı ${fmtOffset(subOffset)} olarak ayarladı${m.auto ? " (otomatik)" : ""}`);
  } else if (m.type === "subClear") {
    setSubs("", [], 0);
    if (m.by !== myName) toast(`${m.by} altyazıyı kaldırdı`);
  }
}

function setSubs(name, cues, offset) {
  subName = name;
  // HTML her zaman burada, güvenli biçimde üretilir.
  for (const c of cues) c.html = safeHtml(c.text);
  subCues = cues;
  subOffset = offset;
  renderSubMenu();
  renderSubNow(true);
}

// ---------- Ekrana çizme ----------
let lastSubHtml = null;
function activeCues(t) {
  // İkili arama: başlangıcı t'den küçük son satır; geriye doğru çakışanları topla.
  let lo = 0, hi = subCues.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (subCues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const res = [];
  for (let i = idx; i >= 0 && i > idx - 6; i--) if (subCues[i].end > t) res.unshift(subCues[i]);
  return res;
}
function renderSubNow(force) {
  const t = video.currentTime - subOffset;
  const html = subOn && subCues.length ? activeCues(t).map((c) => `<span>${c.html}</span>`).join("<br>") : "";
  if (!force && html === lastSubHtml) return;
  lastSubHtml = html;
  subLayer.innerHTML = html;
  subLayer.hidden = !html;
}
(function loop() {
  if (subCues.length) renderSubNow(false);
  requestAnimationFrame(loop);
})();

// ---------- Kaydırma ----------
function fmtOffset(o) {
  if (Math.abs(o) < 0.05) return "0 sn";
  return (o > 0 ? "+" : "−") + Math.abs(o).toFixed(1).replace(".", ",") + " sn";
}
function setOffset(o, auto) {
  subOffset = round2(Math.max(-3600, Math.min(3600, o)));
  renderSubMenu();
  renderSubNow(true);
  send({ type: "subOffset", offset: subOffset, auto: !!auto });
}

// ---------- Menü (oynatıcıdaki altyazı butonu) ----------
function renderSubMenu() {
  const has = subCues.length > 0;
  $("smEmpty").hidden = has;
  $("smHas").hidden = !has;
  $("cSubs").classList.toggle("on", has && subOn);
  if (!has) return;
  $("smName").textContent = subName;
  $("smShow").setAttribute("aria-checked", subOn ? "true" : "false");
  $("smOffset").textContent = fmtOffset(subOffset);
  $("smAuto").disabled = syncBusy || !aiAvailable;
  if (!syncBusy) $("smAutoSub").textContent = aiAvailable
    ? "Yapay zekâ ~45 sn sesi dinleyip altyazıyı konuşmaya oturtur"
    : "Şu an kullanılamıyor, ±0,5 ile ayarla";
}
$("smAdd").addEventListener("click", () => $("subInput").click());
$("smReplace").addEventListener("click", () => $("subInput").click());
$("smShow").addEventListener("click", () => { subOn = !subOn; renderSubMenu(); renderSubNow(true); });
$("smMinus").addEventListener("click", () => setOffset(subOffset - 0.5));
$("smPlus").addEventListener("click", () => setOffset(subOffset + 0.5));
$("smReset").addEventListener("click", () => setOffset(0));
$("smClear").addEventListener("click", () => { send({ type: "subClear" }); setSubs("", [], 0); });
$("smAuto").addEventListener("click", () => autoSync());

// Klavye: g / h ile 0,5 sn kaydır (yaygın oynatıcı kısayolu), c ile aç/kapa.
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea") || e.ctrlKey || e.metaKey || e.altKey || !subCues.length) return;
  if (e.key === "g") setOffset(subOffset - 0.5);
  else if (e.key === "h") setOffset(subOffset + 0.5);
  else if (e.key === "c") { subOn = !subOn; renderSubMenu(); renderSubNow(true); }
});

// ---------- Otomatik eşitleme ----------
const SYNC_WINDOW = 45;   // sn ses
const SYNC_SEARCH = 120;  // ±sn arama aralığı
const BIN = 0.1;          // sn

function syncStatus(text) { $("smAutoSub").textContent = text; }

async function autoSync() {
  if (syncBusy || !subCues.length) return;
  if (!myFileObj) { toast("Önce video dosyasını seç"); return; }
  syncBusy = true;
  renderSubMenu();
  try {
    const start = pickWindow();
    syncStatus("Ses dinleniyor… (izlemeye devam edebilirsin)");
    const { wav, t0 } = await captureAudio(myFileObj, start, SYNC_WINDOW, (s) => syncStatus(`Ses dinleniyor… ${Math.round(s)}/${SYNC_WINDOW} sn`));
    syncStatus("Yapay zekâ konuşmayı çözümlüyor…");
    const res = await fetch(`/api/subsync?room=${encodeURIComponent(roomId)}`, { method: "POST", body: wav, headers: { "content-type": "audio/wav" } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Eşitleme yapılamadı");
    const spans = (data.words && data.words.length ? data.words : data.segments || [])
      .map((w) => ({ start: w.start + t0, end: w.end + t0 }));
    const r = alignOffset(spans, t0, t0 + SYNC_WINDOW);
    if (!r) throw new Error("Bu kısımda yeterli konuşma bulunamadı, başka bir sahnede tekrar dene");
    if (r.confidence < 1.25) throw new Error("Emin olamadım. Konuşmalı bir sahnede tekrar dene ya da ±0,5 ile ayarla");
    setOffset(r.offset, true);
    toast(`Altyazı eşitlendi: ${fmtOffset(r.offset)}`);
  } catch (err) {
    toast(String(err && err.message || err));
  } finally {
    syncBusy = false;
    renderSubMenu();
  }
}

// Altyazının yoğun olduğu, şu anki konuma yakın bir 45 sn'lik bölüm seç.
function pickWindow() {
  const dur = video.duration || 0;
  const coverage = (a) => {
    let s = 0;
    for (const c of subCues) {
      const x = Math.max(a, c.start), y = Math.min(a + SYNC_WINDOW, c.end);
      if (y > x) s += y - x;
    }
    return s / SYNC_WINDOW;
  };
  const now = Math.max(0, video.currentTime - subOffset);
  for (let a = now; a < Math.min(dur, now + 600) - SYNC_WINDOW; a += 15) {
    if (coverage(a) >= 0.45) return Math.max(0, a + subOffset);
  }
  let best = now, bestCov = -1;
  for (let a = 0; a < dur - SYNC_WINDOW; a += 30) {
    const c = coverage(a);
    if (c > bestCov) { bestCov = c; best = a; }
  }
  return Math.max(0, Math.min(best, Math.max(0, dur - SYNC_WINDOW)));
}

// Konuşma zamanları ile altyazı satırlarını üst üste en iyi oturtan kaymayı bul.
// Dönen confidence: en iyi skorun, ondan uzak ikinci en iyi skora oranı.
function alignOffset(spans, w0, w1) {
  const n = Math.round((w1 - w0) / BIN);
  const speech = new Uint8Array(n);
  for (const s of spans) {
    for (let i = Math.max(0, Math.floor((s.start - w0) / BIN)); i < Math.min(n, Math.ceil((s.end - w0) / BIN)); i++) speech[i] = 1;
  }
  const sTotal = speech.reduce((a, b) => a + b, 0);
  if (sTotal < 30) return null; // 3 sn'den az konuşma
  const near = subCues.filter((c) => c.end > w0 - SYNC_SEARCH && c.start < w1 + SYNC_SEARCH);
  const scores = [];
  for (let k = -SYNC_SEARCH / BIN; k <= SYNC_SEARCH / BIN; k++) {
    const d = k * BIN;
    // Pencereye düşen satırlar (d kadar kaydırılmış)
    const sub = new Uint8Array(n);
    for (const c of near) {
      const a = c.start + d, b = c.end + d;
      if (b <= w0 || a >= w1) continue;
      for (let i = Math.max(0, Math.floor((a - w0) / BIN)); i < Math.min(n, Math.ceil((b - w0) / BIN)); i++) sub[i] = 1;
    }
    let both = 0, cTotal = 0;
    for (let i = 0; i < n; i++) { cTotal += sub[i]; both += sub[i] & speech[i]; }
    scores.push({ d, score: cTotal ? both / Math.sqrt(sTotal * cTotal) : 0 });
  }
  let bi = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i].score > scores[bi].score) bi = i;
  // Altyazı satırları genelde konuşmayla başlar, biraz sonra biter. Skorun
  // düz olduğu aralıkta satır başını konuşma başına oturtan (en büyük) kaymayı seç.
  let bj = bi;
  while (bj + 1 < scores.length && scores[bj + 1].score >= scores[bi].score * 0.995) bj++;
  const best = scores[bj];
  let second = 0;
  for (const s of scores) if (Math.abs(s.d - best.d) > 2 && s.score > second) second = s.score;
  if (best.score < 0.3) return null;
  return { offset: round2(best.d), score: best.score, confidence: second ? best.score / second : 9 };
}

// Videonun [start, start+dur] aralığındaki sesini gizli bir oynatıcıyla
// gerçek zamanlı çal (kullanıcı duymaz), 16 kHz mono WAV olarak topla.
function captureAudio(file, start, dur, onProgress) {
  return new Promise((resolve, reject) => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { reject(new Error("Bu tarayıcı ses işlemeyi desteklemiyor")); return; }
    const ctx = new AC();
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    v.src = url;
    v.preload = "auto";
    v.playsInline = true;
    const chunks = [];
    let t0 = null;
    let done = false;
    let proc = null;
    const cleanup = () => {
      done = true;
      try { v.pause(); } catch {}
      try { proc && proc.disconnect(); } catch {}
      v.removeAttribute("src"); v.load();
      URL.revokeObjectURL(url);
      ctx.close().catch(() => {});
    };
    const fail = (msg) => { if (!done) { cleanup(); reject(new Error(msg)); } };
    const timer = setTimeout(() => fail("Ses alınamadı (zaman aşımı)"), (dur + 40) * 1000);

    v.addEventListener("error", () => fail("Video sesi okunamadı"), { once: true });
    v.addEventListener("loadedmetadata", () => { v.currentTime = Math.min(start, Math.max(0, (v.duration || start) - dur)); }, { once: true });
    v.addEventListener("seeked", async () => {
      try {
        const src = ctx.createMediaElementSource(v);
        proc = ctx.createScriptProcessor(4096, 2, 1);
        const mute = ctx.createGain();
        mute.gain.value = 0; // kullanıcı bu sesi duymasın
        src.connect(proc);
        proc.connect(mute);
        mute.connect(ctx.destination);
        proc.onaudioprocess = (e) => {
          if (done || v.paused) return;
          if (t0 === null) t0 = v.currentTime;
          const ib = e.inputBuffer;
          const a = ib.getChannelData(0);
          const b = ib.numberOfChannels > 1 ? ib.getChannelData(1) : a;
          const mono = new Float32Array(a.length);
          for (let i = 0; i < a.length; i++) mono[i] = (a[i] + b[i]) / 2;
          chunks.push(mono);
          const got = chunks.length * 4096 / ctx.sampleRate;
          onProgress && onProgress(got);
          if (got >= dur || v.ended) finish();
        };
        if (ctx.state === "suspended") await ctx.resume();
        await v.play();
      } catch (err) {
        fail("Ses çalınamadı: ekrana bir kez dokunup tekrar dene");
      }
    }, { once: true });
    v.addEventListener("ended", () => finish());

    function finish() {
      if (done) return;
      clearTimeout(timer);
      const rate = ctx.sampleRate;
      const startT = t0 == null ? start : t0;
      cleanup();
      if (!chunks.length) { reject(new Error("Ses alınamadı")); return; }
      resolve({ wav: toWav16k(chunks, rate), t0: startT });
    }
  });
}

function toWav16k(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / 16000;
  const outLen = Math.floor(total / ratio);
  const pcm = new Int16Array(outLen);
  // Basit ortalama ile 16 kHz'e indir.
  let ci = 0, off = 0;
  const flat = new Float32Array(total);
  for (const c of chunks) { flat.set(c, off); off += c.length; }
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += flat[j];
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}
