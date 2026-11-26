/* Baca Komentar (TTS) — mesin suara persisten.
 *
 * Listener komentar TikTok dipasang sekali di level aplikasi (lihat initTTS()),
 * jadi suara tetap berbunyi walaupun pengguna pindah menu atau pindah aplikasi.
 *
 * Jalur utama: server membuat audio MP3 (Edge TTS) lalu browser memutarnya
 * lewat <audio> — sama seperti audio trigger, sehingga tetap berbunyi saat
 * tab/app lain aktif. Bila server tidak mendukung, otomatis kembali ke
 * speechSynthesis bawaan browser.
 */
import { clamp } from './dom.js';
import { Store, DEFAULTS } from './store.js';
import { Sync } from './sync.js';
import { toast } from './ui.js';

/** Batas antrian komentar. Kalau penuh, komentar terlama dilepas agar tidak menumpuk. */
const MAX_QUEUE = 20;

/** Jangan menunggu server selamanya saat internet/server TTS bermasalah. */
const TTS_FETCH_TIMEOUT_MS = 20000;
const PROBE_RETRY_MS = 30000;
const FAIL_COOLDOWN_MS = 60000;

/** Konfigurasi TTS terbaru dari penyimpanan lokal. */
export function ttsConfig() {
  return Object.assign({}, DEFAULTS.tts, Store.get('tts', {}));
}

const canSynth = () => 'speechSynthesis' in window;

let serverTTS = false;   // server bisa membuat audio TTS
let lastProbeAt = 0;
let probePromise = null;
let serverFailures = 0;
let serverFailUntil = 0;
let audioEl = null;

/* ---- Status antrian ---- */
const queue = [];        // [{ text, cfg, voice, audioUrl? }] menunggu dibacakan
let speaking = false;    // ada item yang sedang dibacakan
let playSeq = 0;         // dinaikkan saat stop agar callback lama diabaikan
let synthCurrent = null; // utterance speechSynthesis yang aktif
let synthWatchdog = null;

/** Cek apakah server punya mesin TTS (msedge-tts). Dicoba ulang berkala. */
async function probeServerTTS(force) {
  if (probePromise) return probePromise;
  const now = Date.now();
  if (!force && lastProbeAt && now - lastProbeAt < PROBE_RETRY_MS) return serverTTS;

  probePromise = (async () => {
    lastProbeAt = Date.now();
    let timer = null;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch('/api/tts/status', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      const d = r.ok ? await r.json() : null;
      serverTTS = !!(d && d.available);
      if (serverTTS) {
        serverFailures = 0;
        serverFailUntil = 0;
      }
    } catch (_) {
      serverTTS = false;
    } finally {
      if (timer) clearTimeout(timer);
      probePromise = null;
    }
    return serverTTS;
  })();
  return probePromise;
}

/** Server TTS siap dipakai (tersedia dan tidak sedang cooldown). */
function serverReady() {
  return serverTTS && Date.now() >= serverFailUntil;
}

/** Catat kegagalan server; setelah beberapa kali gagal, pakai suara browser sementara. */
function noteServerFailure() {
  serverFailures += 1;
  if (serverFailures >= 2) serverFailUntil = Date.now() + FAIL_COOLDOWN_MS;
}

/* ------------------------------------------------------------------ */
/* Suara: pilihan bahasa/gender + utterance browser                    */
/* ------------------------------------------------------------------ */
function chooseVoice(cfg) {
  let lang = cfg.lang === 'en' ? 'en' : 'id';
  let gender = cfg.gender === 'male' ? 'male' : 'female';
  if (cfg.random) {
    lang = Math.random() < 0.5 ? 'id' : 'en';
    gender = Math.random() < 0.5 ? 'male' : 'female';
  }
  return { lang, gender };
}

function makeUtterance(text, cfg) {
  const choice = chooseVoice(cfg);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = choice.lang === 'id' ? 'id-ID' : 'en-US';
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(choice.lang));
  if (voices.length) u.voice = cfg.random ? voices[Math.floor(Math.random() * voices.length)] : voices[0];
  u.rate = 0.6 + (clamp(Number(cfg.speed) || 50, 1, 100) / 100) * 0.8; // 50 => 1,0x
  u.pitch = choice.gender === 'male' ? 0.78 : 1.15;
  const vol = Number(cfg.volume);
  u.volume = clamp(Number.isFinite(vol) ? vol : 80, 0, 100) / 100;
  return u;
}

/** Perkiraan durasi baca (ms) + cadangan, untuk pengaman bila onend macet. */
function estimateMs(text, rate) {
  const chars = Math.max(1, String(text).length);
  const charsPerSec = Math.max(4, 13 * (Number(rate) || 1));
  return Math.round((chars / charsPerSec) * 1000) + 5000;
}

/* ------------------------------------------------------------------ */
/* Audio dari server (jalur background)                                */
/* ------------------------------------------------------------------ */
function ttsUrl(item) {
  const voice = item.voice || chooseVoice(item.cfg);
  const q = new URLSearchParams();
  q.set('text', item.text);
  q.set('lang', voice.lang);
  q.set('gender', voice.gender);
  q.set('speed', String(item.cfg.speed || 50));
  return '/api/tts?' + q.toString();
}

async function synthesizeToBlob(item) {
  let timer = null;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (ctrl) timer = setTimeout(() => ctrl.abort(), TTS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ttsUrl(item), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('TTS HTTP ' + res.status);
    const blob = await res.blob();
    if (!blob.size) throw new Error('Audio kosong');
    serverFailures = 0;
    serverFailUntil = 0;
    return URL.createObjectURL(blob);
  } catch (e) {
    noteServerFailure();
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Ambil audio item (pakai hasil prefetch bila sudah siap). */
function synthesizeItem(item) {
  if (item.audioUrl) return Promise.resolve(item.audioUrl);
  if (item.audioPromise) return item.audioPromise;
  item.audioPromise = synthesizeToBlob(item)
    .then((url) => {
      if (item.dropped) {
        URL.revokeObjectURL(url);
        throw new Error('Dibatalkan');
      }
      item.audioUrl = url;
      return url;
    })
    .finally(() => {
      item.audioPromise = null;
    });
  return item.audioPromise;
}

function releaseItem(item) {
  if (!item) return;
  item.dropped = true;
  if (item.audioUrl) {
    try { URL.revokeObjectURL(item.audioUrl); } catch (_) {}
    item.audioUrl = null;
  }
}

/** Siapkan audio komentar berikutnya selagi yang sekarang masih diputar. */
function prefetchNext() {
  if (!serverReady()) return;
  const next = queue[0];
  if (!next || next.dropped || next.audioUrl || next.audioPromise) return;
  synthesizeItem(next).catch(() => { /* fallback saat giliran tiba */ });
}

function ensureAudio() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.setAttribute('playsinline', '');
  }
  return audioEl;
}

/**
 * Putar audio MP3 lewat <audio>. Audio elemen tetap diputar browser saat tab
 * tidak aktif, sama seperti audio trigger.
 */
async function playAudio(item, seq, done) {
  let url = item.audioUrl;
  if (url) item.audioUrl = null;
  if (!url) {
    try {
      url = await synthesizeItem(item);
    } catch (_) {
      if (seq === playSeq) playSynth(item, seq, done);
      else done();
      return;
    }
  }

  if (seq !== playSeq) {
    try { URL.revokeObjectURL(url); } catch (_) {}
    done();
    return;
  }

  const a = ensureAudio();
  let settled = false;
  let guard = null;

  const cleanup = () => {
    a.onended = null;
    a.onerror = null;
    a.onloadedmetadata = null;
    if (guard) {
      clearTimeout(guard);
      guard = null;
    }
  };

  const finish = (ok) => {
    if (settled) return;
    settled = true;
    cleanup();
    try { URL.revokeObjectURL(url); } catch (_) {}
    if (seq !== playSeq) {
      done();
      return;
    }
    if (ok) {
      done();
      return;
    }
    // Gagal memutar audio (mis. autoplay diblokir) → pakai suara browser.
    try { a.pause(); } catch (_) {}
    playSynth(item, seq, done);
  };

  guard = setTimeout(() => finish(true), 60000);
  a.onloadedmetadata = () => {
    if (guard) clearTimeout(guard);
    const dur = isFinite(a.duration) && a.duration > 0 ? a.duration : 30;
    guard = setTimeout(() => finish(true), Math.round((dur + 8) * 1000));
  };
  a.onended = () => finish(true);
  a.onerror = () => finish(false);
  a.src = url;
  const vol = Number(item.cfg && item.cfg.volume);
  a.volume = clamp(Number.isFinite(vol) ? vol : 80, 0, 100) / 100;

  try {
    await a.play();
  } catch (_) {
    finish(false);
    return;
  }
  if (seq !== playSeq) {
    finish(true);
    return;
  }
  prefetchNext();
}

/* ------------------------------------------------------------------ */
/* Suara browser (fallback saat server TTS tidak tersedia)             */
/* ------------------------------------------------------------------ */
function playSynth(item, seq, done) {
  if (!canSynth()) {
    toast('Browser ini belum mendukung suara.', 'err');
    done();
    return;
  }
  const u = makeUtterance(item.text, item.cfg);
  const finish = () => {
    if (synthCurrent !== u) return;
    if (synthWatchdog) {
      clearTimeout(synthWatchdog);
      synthWatchdog = null;
    }
    synthCurrent = null;
    done();
  };
  u.onend = finish;
  u.onerror = finish;
  synthCurrent = u;
  synthWatchdog = setTimeout(finish, estimateMs(item.text, u.rate));
  window.speechSynthesis.speak(u);
}

/* ------------------------------------------------------------------ */
/* Antrian                                                             */
/* ------------------------------------------------------------------ */
function pump() {
  if (speaking || !queue.length) return;
  speaking = true;
  const item = queue.shift();
  const seq = playSeq;
  const done = () => {
    if (seq !== playSeq) return;
    speaking = false;
    prefetchNext();
    queueMicrotask(pump);
  };
  if (serverReady()) playAudio(item, seq, done);
  else playSynth(item, seq, done);
}

/**
 * Ucapkan teks sekarang juga (dipakai tombol tester).
 * Antrian komentar yang menunggu akan dihapus agar tester tidak menunggu lama.
 */
export function speak(text, cfg) {
  cfg = cfg || ttsConfig();
  stopSpeaking();
  queue.push({ text, cfg, voice: chooseVoice(cfg) });
  pump();
}

/** Tambahkan komentar ke antrian baca (dipakai listener live). */
export function queueSpeech(text, cfg) {
  cfg = cfg || ttsConfig();
  if (!serverTTS) probeServerTTS();
  while (queue.length >= MAX_QUEUE) releaseItem(queue.shift());
  queue.push({ text, cfg, voice: chooseVoice(cfg) });
  if (speaking) prefetchNext();
  else pump();
}

/** Hentikan suara yang sedang berjalan dan kosongkan antrian. */
export function stopSpeaking() {
  playSeq += 1;
  while (queue.length) releaseItem(queue.shift());
  if (synthWatchdog) {
    clearTimeout(synthWatchdog);
    synthWatchdog = null;
  }
  synthCurrent = null;
  if (canSynth()) window.speechSynthesis.cancel();

  const a = audioEl;
  if (a) {
    try {
      a.onended = null;
      a.onerror = null;
      a.onloadedmetadata = null;
      a.pause();
    } catch (_) {}
    try {
      const src = a.currentSrc || a.src;
      if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
      a.removeAttribute('src');
      a.load();
    } catch (_) {}
  }
  speaking = false;
}

/**
 * Periksa apakah user TikTok memenuhi filter "who".
 * Data user dari tiktok-live-connector v2: ada di eventData.user
 */
export function matchWho(who, eventData) {
  if (who === 'all') return true;
  const u = (eventData && eventData.user) ? eventData.user : eventData;
  if (!u) return false;
  const isFollower   = !!(u.isFollower   || (eventData.userIdentity && eventData.userIdentity.isFollowerOfAnchor)       || (u.userIdentity && u.userIdentity.isFollowerOfAnchor));
  const isFriend     = !!(u.isFriend     || (eventData.userIdentity && eventData.userIdentity.isMutualFollowingWithAnchor) || (u.userIdentity && u.userIdentity.isMutualFollowingWithAnchor));
  const isSubscriber = !!(u.isSubscriber || (eventData.userIdentity && eventData.userIdentity.isSubscriberOfAnchor)      || (u.userIdentity && u.userIdentity.isSubscriberOfAnchor));
  const isModerator  = !!(u.isModerator  || (u.userAttr && u.userAttr.isAdmin) || (u.userAttr && u.userAttr.isChannelAdmin));
  const isTeam       = isModerator || !!(u.userAttr && (u.userAttr.isStaff || u.userAttr.isTopFan));
  if (who === 'follower')   return isFollower;
  if (who === 'friend')     return isFriend;
  if (who === 'subscriber') return isSubscriber;
  if (who === 'moderator')  return isModerator;
  if (who === 'team')       return isTeam;
  return false;
}

/**
 * Periksa apakah teks komentar mengandung salah satu kata/emote/simbol dari daftar filter.
 * Pencocokan case-insensitive; tiap entri dicocokkan sebagai substring.
 */
export function isFiltered(text, filterWords) {
  if (!filterWords.length) return false;
  const lower = text.toLowerCase();
  return filterWords.some((w) => lower.includes(w.toLowerCase()));
}

/** Apakah user komentar lolos filter "who". */
function passesWho(who, data, u) {
  if (!who || who === 'all') return true;
  if (who === 'topgifter') {
    const uid = String(u.id || u.uniqueId || u.userId || '').trim();
    return uid ? (Sync.giftLeaderboard || []).some((g) => String(g.id) === uid) : false;
  }
  return matchWho(who, data);
}

const onChat = (ev) => {
  if (!ev || ev.event !== 'chat') return;
  // Server menandai komentar yang dikirim ulang TikTok saat proses connect.
  // Komentar lama itu bukan komentar baru di live ini — jangan dibacakan.
  if (ev.afterConnect === false) return;

  // Ambil konfigurasi TTS terbaru dari store setiap kali ada komentar.
  const cfg = ttsConfig();
  if (!cfg.enabled) return;

  const data = ev.data || {};
  const u = data.user || {};

  // Cek filter "who" — siapa yang boleh dibaca.
  if (!passesWho(cfg.who || 'all', data, u)) return;

  // Ambil teks komentar.
  const text = String(data.content || data.comment || '').trim();
  if (!text) return;

  // Jangan baca kalau komentar mengandung kata/emote/simbol yang difilter.
  const filterWords = String(cfg.filter || '').split(/[\n,]+/).map((w) => w.trim()).filter(Boolean);
  if (isFiltered(text, filterWords)) return;

  queueSpeech(text, cfg);
};

let started = false;

/**
 * Pasang listener komentar TikTok sekali saja, di level aplikasi.
 * Aman dipanggil berulang kali (tidak menggandakan suara).
 */
export function initTTS() {
  if (started) return;
  started = true;
  probeServerTTS(true);
  Sync.on('tiktok', onChat);
}
