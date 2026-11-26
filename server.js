'use strict';
const { execFile, spawn, spawnSync } = require('child_process');
/*
 * JekInteract — server lokal
 *
 *  - Menyajikan dashboard (/) dan overlay (/overlay/...)
 *  - Hub real-time via WebSocket (status online/offline overlay, state, perintah play)
 *  - Antrean 20 screen overlay + tombol hapus cache
 *  - Upload media (gambar / video / audio) ke folder data/uploads
 *  - Integrasi TikTok Live via tiktok-live-connector
 *
 * Jalankan:  npm start      (port lain: PORT=4000 npm start)
 */
const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket: NodeWebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
/* tiktok-live-connector v2.x adalah ESM murni ("type": "module").
 * Build lama (Electron 31 / Node 20) belum mendukung require() pada modul ESM,
 * jadi di .exe require() selalu gagal dan pengguna melihat pesan
 * "Library tiktok-live-connector tidak tersedia". Gunakan import() dinamis
 * dan simpan detail errornya supaya UI bisa menampilkan penyebab sebenarnya. */
let TikTokLiveConnection = null;
let tikTokImportError = '';
let tikTokImportPromise = null;
function loadTikTokConnector() {
  if (!tikTokImportPromise) {
    tikTokImportPromise = import('tiktok-live-connector')
      .then((mod) => {
        const Ctor = mod.TikTokLiveConnection ||
          (mod.default && mod.default.TikTokLiveConnection) ||
          mod.default;
        if (typeof Ctor !== 'function') {
          throw new Error('Export TikTokLiveConnection tidak ditemukan pada modul.');
        }
        TikTokLiveConnection = Ctor;
        tikTokImportError = '';
        return Ctor;
      })
      .catch((e) => {
        tikTokImportError = (e && e.message) ? String(e.message) : String(e);
        TikTokLiveConnection = null;
        console.warn('[tiktok] gagal memuat tiktok-live-connector: ' + tikTokImportError);
        return null;
      });
  }
  return tikTokImportPromise;
}

/* @nut-tree/nut-js — opsional, hanya aktif di Windows (npm install @nut-tree/nut-js) */
let nutKeyboard = null;
let nutKey = null;
try {
  const nut = require('@nut-tree/nut-js');
  nutKeyboard = nut.keyboard;
  nutKey = nut.Key;
  console.log('[keystroke] @nut-tree/nut-js tersedia — keystroke aktif via nut.js');
} catch (_) {
  console.log('[keystroke] @nut-tree/nut-js tidak tersedia — memakai helper bawaan (Windows asli) bila memungkinkan');
}

const VERSION = '0.1.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.JEK_DATA_DIR ? path.resolve(process.env.JEK_DATA_DIR) : path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const STATE_FILE = path.join(DATA, 'state.json');
const HOST = process.env.HOST || '0.0.0.0';
const BASE_PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_JSON = 1024 * 1024; // 1 MB
const MAX_UPLOAD = 300 * 1024 * 1024; // 300 MB
const SCREEN_COUNT = 20;

/* Deteksi Wine (Winlator/BoxedWine, dsb). Di Wine tidak ada PowerShell asli,
   jadi mesin keystroke Windows tidak dipakai. */
const IS_WINE = process.env.JEK_IS_WINE === '1' || (() => {
  if (process.platform !== 'win32') return false;
  try { return fs.existsSync(path.join(process.env.WINDIR || 'C:\\windows', 'system32', 'wineboot.exe')); }
  catch (_) { return false; }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};
const UPLOAD_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac',
  '.mp4', '.webm', '.mov', '.mkv'
]);

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 - Tidak ditemukan');
}

function httpError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > limit) {
        reject(httpError(413, 'Payload terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    throw httpError(400, 'JSON tidak valid');
  }
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function safeName(name) {
  const base = path
    .basename(String(name || 'file'))
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return (base || 'file').slice(-80);
}

function safeUrl(u) {
  return typeof u === 'string' && /^(\/uploads\/|\/api\/sounds\/proxy\?|https?:\/\/)/.test(u) ? u : null;
}

/* ------------------------------------------------------------------ */
/* State (disimpan ke data/state.json)                                 */
/* ------------------------------------------------------------------ */
let state = {};
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
} catch (_) {
  state = {};
}

/* Konfigurasi keystroke: fokus otomatis itu OPSIONAL (kosong = kirim ke jendela
   depan apa adanya, supaya tombol bisa dipakai di aplikasi apa pun). */
const DEFAULT_KEYSTROKE_CFG = { target: '', autoFocus: false, focusDelayMs: 250 };
state.keystrokeCfg = Object.assign({}, DEFAULT_KEYSTROKE_CFG, state.keystrokeCfg || {});

// Join Alert: durasi tampil (detik) dan jeda join ulang (menit) punya nilai awal.
state.joinAlertCfg = Object.assign(
  { enabled: false, who: 'all', soundOn: true, sound: null, volume: 100, duration: 5, rejoinMinutes: 2 },
  state.joinAlertCfg || {}
);
// Migrasi sekali: build sebelumnya menulis enabled:true sebagai bawaan otomatis.
// Sekarang default mati; setelah ini, status mengikuti pilihan pengguna sendiri.
if (state.joinAlertEnableMigrated !== true) {
  state.joinAlertCfg.enabled = false;
  state.joinAlertEnableMigrated = true;
}
if (!Array.isArray(state.joinAlertHistory)) state.joinAlertHistory = [];

// Follow Alert: pengaturan alert follow (default mati, seperti Join Alert).
state.followAlertCfg = Object.assign(
  { enabled: false, soundOn: true, sound: null, volume: 100, duration: 5 },
  state.followAlertCfg || {}
);
// Build sebelumnya punya "jeda follow ulang"; key lama dibuang supaya tidak
// terbawa saat export config.
delete state.followAlertCfg.refollowMinutes;
if (!Array.isArray(state.followAlertHistory)) state.followAlertHistory = [];

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (e) {
      console.warn('[state] gagal menyimpan:', e.message);
    }
  }, 300);
}

/* ------------------------------------------------------------------ */
/* Statistik live & riwayat sesi (data/live-history.json)               */
/* ------------------------------------------------------------------ */
const LIVE_HISTORY_FILE = path.join(DATA, 'live-history.json');
const LIVE_ACTIVE_FILE = path.join(DATA, 'live-active.json');
const LIVE_HISTORY_DAYS = 30;
const LIVE_HISTORY_MAX = 500;

let liveHistory = [];
try {
  const saved = JSON.parse(fs.readFileSync(LIVE_HISTORY_FILE, 'utf8'));
  if (Array.isArray(saved)) liveHistory = saved;
} catch (_) {
  liveHistory = [];
}

let liveSession = null; // sesi live yang sedang berjalan
let liveSeq = 0;
let liveStatsTimer = null;
let liveTickTimer = null;

function sessionTime(s) {
  return Number((s && (s.startedAt || s.ts)) || 0);
}

function pruneLiveHistory() {
  const cutoff = Date.now() - LIVE_HISTORY_DAYS * 864e5;
  const before = liveHistory.length;
  liveHistory = liveHistory
    .filter((s) => sessionTime(s) >= cutoff)
    .sort((a, b) => sessionTime(b) - sessionTime(a))
    .slice(0, LIVE_HISTORY_MAX);
  return before !== liveHistory.length;
}

function saveLiveHistory() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(LIVE_HISTORY_FILE, JSON.stringify(liveHistory));
  } catch (e) {
    console.warn('[live] gagal menyimpan riwayat:', e.message);
  }
}

/* Sesi yang sedang berjalan disimpan terpisah agar tidak hilang saat server mati. */
let activeSaveTimer = null;

function saveActiveSession() {
  if (!liveSession) return;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const snap = publicLiveSession(liveSession);
    snap.connectedAt = liveSession.connectedAt;
    snap.savedAt = Date.now();
    fs.writeFileSync(LIVE_ACTIVE_FILE, JSON.stringify(snap));
  } catch (e) {
    console.warn('[live] gagal menyimpan sesi aktif:', e.message);
  }
}

function scheduleActiveSave() {
  if (activeSaveTimer) return;
  activeSaveTimer = setTimeout(() => {
    activeSaveTimer = null;
    saveActiveSession();
  }, 2000);
}

function removeActiveSession() {
  if (activeSaveTimer) {
    clearTimeout(activeSaveTimer);
    activeSaveTimer = null;
  }
  try { fs.unlinkSync(LIVE_ACTIVE_FILE); } catch (_) { /* belum ada */ }
}

/* Saat server start, tutup sesi yang tertinggal dari crash sebelumnya. */
(function recoverActiveSession() {
  let active = null;
  try {
    active = JSON.parse(fs.readFileSync(LIVE_ACTIVE_FILE, 'utf8'));
  } catch (_) {
    return;
  }
  if (!active || !active.username) {
    removeActiveSession();
    return;
  }
  const endedAt = Math.min(Date.now(), Number(active.savedAt) || Date.now());
  const connectedAt = Number(active.connectedAt) || Number(active.startedAt) || endedAt;
  const entry = Object.assign({}, active, {
    endedAt,
    durationSec: Math.max(0, Math.round((endedAt - connectedAt) / 1000)),
    live: false
  });
  delete entry.savedAt;
  delete entry.connectedAt;
  const duplicate = liveHistory.some((s) =>
    (entry.id && s.id === entry.id) ||
    (s.username === entry.username && Number(s.startedAt) === Number(entry.startedAt))
  );
  if (!duplicate) liveHistory.unshift(entry);
  pruneLiveHistory();
  saveLiveHistory();
  removeActiveSession();
  console.log('[live] sesi tertinggal dipulihkan ke riwayat: @' + entry.username);
})();

/** Terima Map (sesi aktif) atau Array (riwayat tersimpan). */
function giftersArray(g) {
  if (!g) return [];
  const list = Array.isArray(g) ? g.slice() : Array.from(g.values());
  return list
    .filter((x) => x && Number(x.coins) > 0)
    .sort((a, b) => Number(b.coins) - Number(a.coins))
    .slice(0, 20)
    .map((x) => ({
      id: x.id || null,
      user: x.user || x.nickname || 'Anonim',
      nickname: x.nickname || x.user || 'Anonim',
      avatarUrl: x.avatarUrl || null,
      coins: Number(x.coins) || 0
    }));
}

function publicLiveSession(s) {
  if (!s) return null;
  const endedAt = s.endedAt || null;
  const durationSec = endedAt
    ? Math.max(0, Number(s.durationSec) || 0)
    : Math.max(0, Math.round((Date.now() - (s.connectedAt || Date.now())) / 1000));
  const gifters = giftersArray(s.gifters);
  return {
    id: s.id || ('ls_' + sessionTime(s)),
    username: s.username || s.account || '',
    nickname: s.nickname || s.username || s.account || '',
    title: s.title || ('Live @' + (s.username || s.account || '')),
    startedAt: sessionTime(s),
    endedAt,
    durationSec,
    followers: Number(s.followers) || 0,
    followerCount: Number(s.followerCount) || 0,
    likes: Number(s.likes) || 0,
    comments: Number(s.comments) || 0,
    shares: Number(s.shares) || 0,
    coins: Number(s.coins) || 0,
    viewers: Number(s.viewers) || 0,
    peakViewers: Number(s.peakViewers) || 0,
    topGifter: gifters.length ? gifters[0] : null,
    gifters,
    live: !endedAt
  };
}

function liveStatsPayload() {
  if (pruneLiveHistory()) saveLiveHistory();
  return {
    current: liveSession ? publicLiveSession(liveSession) : null,
    sessions: liveHistory.map(publicLiveSession),
    updatedAt: Date.now()
  };
}

function broadcastLiveStats() {
  clearTimeout(liveStatsTimer);
  liveStatsTimer = setTimeout(() => {
    broadcast('livestats', liveStatsPayload(), (c) => c.role === 'dashboard');
  }, 180);
}

/** Update durasi & simpan sesi aktif secara berkala walau tidak ada event TikTok. */
function startLiveTick() {
  if (liveTickTimer) return;
  liveTickTimer = setInterval(() => {
    if (!liveSession) {
      stopLiveTick();
      return;
    }
    saveActiveSession();
    broadcastLiveStats();
  }, 20000);
}

function stopLiveTick() {
  if (liveTickTimer) {
    clearInterval(liveTickTimer);
    liveTickTimer = null;
  }
}

function startLiveSession(username) {
  liveSession = {
    id: 'ls_' + Date.now().toString(36) + '_' + (++liveSeq),
    username,
    nickname: username,
    title: 'Live @' + username,
    startedAt: Date.now(),
    connectedAt: Date.now(),
    endedAt: null,
    durationSec: 0,
    followers: 0,
    followerCount: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    coins: 0,
    viewers: 0,
    peakViewers: 0,
    gifters: new Map(),
    demo: false
  };
  saveActiveSession();
  startLiveTick();
  broadcastLiveStats();
  return liveSession;
}

function finishLiveSession(save) {
  const s = liveSession;
  if (!s) return null;
  stopLiveTick();
  const now = Date.now();
  s.endedAt = now;
  s.durationSec = Math.max(0, Math.round((now - (s.connectedAt || now)) / 1000));
  const pub = publicLiveSession(s);
  liveSession = null;
  if (save !== false && pub.username) {
    liveHistory.unshift(Object.assign({}, pub, { live: false }));
    pruneLiveHistory();
    saveLiveHistory();
  }
  removeActiveSession();
  broadcastLiveStats();
  return pub;
}

function abortLiveSession() {
  if (!liveSession) return;
  stopLiveTick();
  liveSession = null;
  removeActiveSession();
  broadcastLiveStats();
}

function isGiftFinal(data) {
  return !data || data.repeatEnd === 0 || data.repeatEnd == null;
}

function giftCoinsOf(data) {
  const giftObj = (data && data.gift) || {};
  const diamondCount = Number(giftObj.diamondCount || (data && data.diamondCount)) || 0;
  const repeatCount = Math.max(1, Number(data && (data.repeatCount || data.groupCount)) || 1);
  return diamondCount * repeatCount;
}

/** Catat event TikTok ke sesi live yang sedang berjalan. */
function trackLiveEvent(ev, data) {
  const s = liveSession;
  if (!s) return false;
  let changed = false;

  if (ev === 'like') {
    s.likes += Number(data.count || data.likeCount || 1) || 1;
    changed = true;
  } else if (ev === 'chat') {
    s.comments += 1;
    changed = true;
  } else if (ev === 'share') {
    s.shares += 1;
    changed = true;
  } else if (ev === 'follow') {
    s.followers += 1;
    changed = true;
  } else if (ev === 'roomUser') {
    const viewers = Number(data.total || data.totalUser || data.viewerCount || data.viewers) || 0;
    if (viewers > 0) {
      s.viewers = viewers;
      s.peakViewers = Math.max(s.peakViewers, viewers);
      changed = true;
    }
  } else if (ev === 'gift' && isGiftFinal(data)) {
    const coins = giftCoinsOf(data);
    if (coins > 0) {
      const u = data.user || data;
      const id = String(u.id || u.uniqueId || u.userId || '').trim();
      const nickname = String(u.nickname || id || 'Anonim').trim();
      const user = String(u.uniqueId || u.displayId || nickname).trim();
      const avatarUrl = (u.avatarThumb && Array.isArray(u.avatarThumb.urlList) && u.avatarThumb.urlList[0]) || u.avatarUrl || null;
      const prev = (id && s.gifters.get(id)) || { id, user, nickname, avatarUrl, coins: 0 };
      prev.coins += coins;
      prev.user = user || prev.user;
      prev.nickname = nickname || prev.nickname;
      prev.avatarUrl = avatarUrl || prev.avatarUrl;
      if (id) s.gifters.set(id, prev);
      s.coins += coins;
      changed = true;
    }
  }

  if (changed) {
    scheduleActiveSave();
    broadcastLiveStats();
  }
  return changed;
}

/** Cari node info room dari berbagai bentuk respons tiktok-live-connector. */
function findRoomNode(roomInfo) {
  if (!roomInfo || typeof roomInfo !== 'object') return null;
  const seen = new Set();
  const queue = [{ node: roomInfo, depth: 0 }];
  const candidates = [];
  while (queue.length) {
    const { node, depth } = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 5) continue;
    seen.add(node);
    if (typeof node.title === 'string' && node.title.trim()) candidates.push(node);
    Object.keys(node).forEach((k) => {
      const v = node[k];
      if (v && typeof v === 'object') queue.push({ node: v, depth: depth + 1 });
    });
  }
  return candidates[0] || null;
}

/** Lengkapi sesi dengan judul live, jumlah follower akun, dan penonton. */
function applyRoomMeta(roomInfo) {
  const s = liveSession;
  if (!s || !roomInfo) return;
  const node = findRoomNode(roomInfo);
  const level = roomInfo.data && typeof roomInfo.data === 'object' ? roomInfo.data : roomInfo;
  const owner = (node && (node.owner || node.user)) || level.user || level.owner || null;

  if (node && node.title) s.title = String(node.title).slice(0, 200);

  const startRaw = Number((node && (node.start_time || node.startTime)) ||
    (level.room_info && (level.room_info.start_time || level.room_info.startTime)) || 0);
  if (startRaw > 0) s.startedAt = startRaw > 1e12 ? startRaw : startRaw * 1000;

  if (owner) {
    if (owner.nickname) s.nickname = String(owner.nickname).slice(0, 80);
    const followers = Number(owner.followers ||
      (owner.follow_info && owner.follow_info.follower_count) || 0);
    if (followers > 0) s.followerCount = followers;
    const avatarUrl = owner.avatar_url || owner.avatarUrl ||
      (owner.avatarThumb && Array.isArray(owner.avatarThumb.urlList) && owner.avatarThumb.urlList[0]) || null;
    if (avatarUrl) s.avatarUrl = avatarUrl;
  }

  const viewers = Number((node && (node.current_viewers || node.currentViewers || node.user_count)) || 0);
  if (viewers > 0) {
    s.viewers = viewers;
    s.peakViewers = Math.max(s.peakViewers, viewers);
  }
  scheduleActiveSave();
  broadcastLiveStats();
}

/* ------------------------------------------------------------------ */
/* Antrean screen overlay 1..20                                        */
/* ------------------------------------------------------------------ */
const screens = new Map();
let uidSeq = 0;

function screenOf(n) {
  if (!screens.has(n)) screens.set(n, { queue: [], playing: null, timer: null });
  return screens.get(n);
}

function queueMap() {
  const m = {};
  for (let n = 1; n <= SCREEN_COUNT; n++) {
    const s = screens.get(n);
    m[n] = s ? s.queue.length + (s.playing ? 1 : 0) : 0;
  }
  return m;
}

const FADE_MS = 1200; // harus sama dengan transition duration di overlay.css

function enqueue(n, raw) {
  const s = screenOf(n);
  const media = raw.media || {};
  const item = {
    uid: Date.now().toString(36) + (++uidSeq),
    id: String(raw.id || ''),
    name: String(raw.name || 'Interaksi').slice(0, 120),
    duration: clamp(Number(raw.duration) || 1, 1, 600),
    delay: clamp(Number(raw.delay) || 0, 0, 60),
    volume: clamp(raw.volume == null ? 100 : Number(raw.volume), 0, 100),
    fade: !!raw.fade,
    test: !!raw.test,
    media: { image: safeUrl(media.image), video: safeUrl(media.video), audio: safeUrl(media.audio) }
  };
  s.queue.push(item);
  playNext(n);
  pushStatus();
  return item;
}

function playNext(n) {
  const s = screenOf(n);
  if (s.playing || !s.queue.length) return;
  const item = (s.playing = s.queue.shift());
  // kirim ke overlay screen ini + semua dashboard client
  const mine = (c) => (c.role === 'overlay' && c.id === 'screen-' + n) || c.role === 'dashboard';

  const delayMs  = (item.delay || 0) * 1000;
  const fadeIn   = item.fade ? FADE_MS : 0;
  const fadeOut  = item.fade ? FADE_MS : 0;
  const visibleMs = item.duration * 1000;
  const stopAfter = delayMs + fadeIn + visibleMs;    // kapan server kirim stop
  const killAfter = fadeOut + 200;                   // jeda setelah stop sebelum play berikutnya

  // tunda broadcast 'play' sesuai delay, agar overlay baru tampil setelah delay
  s.timer = setTimeout(() => {
    broadcast('play', { screen: n, item }, mine);

    s.timer = setTimeout(() => {
      broadcast('stop', { screen: n, uid: item.uid }, mine);
      s.playing = null;
      s.timer = setTimeout(() => {
        s.timer = null;
        playNext(n);
        pushStatus();
      }, killAfter);
      pushStatus();
    }, fadeIn + visibleMs);
  }, delayMs);
}

function clearAllQueues() {
  for (const s of screens.values()) {
    clearTimeout(s.timer);
    s.timer = null;
    s.queue = [];
    s.playing = null;
  }
  broadcast('clear', {});
  pushStatus();
}

/* ------------------------------------------------------------------ */
/* Hub WebSocket                                                       */
/* ------------------------------------------------------------------ */
const clients = new Set();

function wsSend(c, event, data) {
  try {
    if (c.ws.readyState === c.ws.OPEN) {
      c.ws.send(JSON.stringify({ event, data }));
    }
  } catch (_) {
    /* koneksi sudah putus */
  }
}

function broadcast(event, data, pick) {
  for (const c of clients) if (!pick || pick(c)) wsSend(c, event, data);
}

function presenceMap() {
  const m = {};
  for (const c of clients) if (c.presence && c.id) m[c.id] = (m[c.id] || 0) + 1;
  return m;
}

function statusPayload() {
  return { overlays: presenceMap(), queues: queueMap() };
}

let statusTimer = null;
function pushStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    broadcast('status', statusPayload(), (c) => c.role === 'dashboard');
  }, 60);
}

function overlayLabel(id) {
  const MAP = {
    'music':          'YouTube Music',
    'subathon':       'Subathon Timer',
    'winlose':        'Win Lose Bar',
    'likes':          'Like Leaderboard',
    'chat':           'Komen',
    'joinalert':      'Join Alert',
    'followalert':    'Follow Alert',
    'gifters':        'Top Gifter',
    'goal-like':      'Target Like',
    'goal-share':     'Target Share',
    'goal-follower':  'Target Follower',
    'goal-coin':      'Target Coin'
  };
  if (MAP[id]) return MAP[id];
  const m = /^screen-(\d+)$/.exec(id || '');
  if (m) return 'Screen ' + m[1];
  return id || '(tanpa id)';
}

function wsLog(role, id, action, ip) {
  const tty = process.stdout && process.stdout.isTTY;
  const c = (code, s) => (tty ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s);
  const ts = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (role === 'overlay') {
    const label = overlayLabel(id);
    const dot   = action === 'online' ? c('32', '●') : c('31', '○');
    const word  = action === 'online' ? c('1;32', 'ONLINE ') : c('1;31', 'OFFLINE');
    const ipStr = ip ? c('2', '  ' + ip) : '';
    console.log('  ' + dot + '  Overlay ' + word + '  ' + c('1', label) + '  ' + c('2', '[' + id + ']') + ipStr + '  ' + c('2', ts));
  } else {
    const word = action === 'online' ? c('32', 'konek') : c('33', 'putus');
    const ipStr = ip ? c('2', ' — ' + ip) : '';
    console.log('  ' + c('2', '[dashboard]') + ' ' + word + ipStr + '  ' + c('2', ts));
  }
}

function openStream(ws, q, remoteIp) {
  const role = q.get('role') === 'overlay' ? 'overlay' : 'dashboard';
  const id = (q.get('id') || '').replace(/[^\w-]/g, '').slice(0, 40);
  const presence = role === 'overlay' && !!id && q.get('presence') !== '0';
  const tiktokSt = tiktokStatus();
  wsLog(role, id, 'online', remoteIp);
  const c = { ws, role, id, presence };
  clients.add(c);
  wsSend(c, 'hello', { state, status: statusPayload(), tiktok: tiktokSt, likeLeaderboard: likeLeaderboardObj(), giftLeaderboard: giftLeaderboardObj(), liveStats: liveStatsPayload(), musicstate: musicStatePayload(), obsstate: obsStatusPayload(), tunnel: tunnelPayload(), serverTime: Date.now(), version: VERSION });

  // Ping tiap 25 detik — menjaga koneksi tetap aktif melewati proxy/Cloudflare (idle timeout ~60-90 detik).
  // Tidak ada terminate berdasarkan pong: Android Chrome freeze background tab sehingga pong terlambat,
  // tapi koneksi masih valid. Biarkan TCP/OS yang deteksi koneksi benar-benar mati.
  const ping = setInterval(() => {
    try {
      if (ws.readyState === ws.OPEN) ws.ping();
    } catch (_) {}
  }, 25000);

  ws.on('close', () => {
    clearInterval(ping);
    clients.delete(c);
    wsLog(role, id, 'offline', remoteIp);
    if (presence) pushStatus();
  });
  if (presence) pushStatus();
}

/* ------------------------------------------------------------------ */
/* Info jaringan                                                       */
/* ------------------------------------------------------------------ */
function lanAddresses() {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const i of ifs[name] || []) {
        const v4 = typeof i.family === 'string' ? i.family === 'IPv4' : i.family === 4;
        if (v4 && !i.internal) out.push(i.address);
      }
    }
  } catch (_) {
    /* Termux (Android) kadang menolak membaca interface — abaikan */
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */
/**
 * Pastikan file video punya audio track. Kalau tidak ada, tambah silent audio via ffmpeg.
 * Diperlukan agar Chrome Android tidak pause video (video-only background media policy).
 * Callback dipanggil setelah selesai (berhasil maupun gagal).
 */
function ensureVideoAudio(filePath, cb) {
  // Cek audio track dengan ffprobe
  execFile('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0',
    filePath
  ], (err, stdout) => {
    if (err || stdout.trim()) {
      // ffprobe error (ffmpeg tidak ada) atau sudah punya audio — skip
      return cb();
    }
    // Tidak ada audio track — tambah silent audio dengan ffmpeg
    const tmp = filePath + '.tmp.mp4';
    execFile('ffmpeg', [
      '-y', '-i', filePath,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '32k',
      '-shortest', tmp
    ], (ferr) => {
      if (ferr) {
        console.warn('[upload] ffmpeg gagal tambah audio:', ferr.message);
        fs.unlink(tmp, () => {});
        return cb();
      }
      fs.rename(tmp, filePath, (rerr) => {
        if (rerr) {
          console.warn('[upload] gagal rename:', rerr.message);
          fs.unlink(tmp, () => {});
        } else {
          console.log('[upload] silent audio ditambahkan ke', path.basename(filePath));
        }
        cb();
      });
    });
  });
}

function handleUpload(req, res, q) {
  const clean = safeName(q.get('name'));
  const ext = path.extname(clean).toLowerCase();
  if (!UPLOAD_EXT.has(ext)) return json(res, 415, { error: 'Tipe file tidak didukung' });
  const declared = parseInt(req.headers['content-length'], 10);
  if (declared > MAX_UPLOAD) return json(res, 413, { error: 'File terlalu besar (maks 300 MB)' });
  try {
    fs.mkdirSync(UPLOADS, { recursive: true });
  } catch (e) {
    return json(res, 500, { error: 'Folder upload tidak bisa dibuat: ' + e.message });
  }
  const file = Date.now().toString(36) + '-' + clean;
  const dest = path.join(UPLOADS, file);
  const out = fs.createWriteStream(dest);
  let size = 0;
  let failed = false;
  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.unlink(dest, () => {});
    if (!res.headersSent) json(res, code, { error: msg });
  };
  req.on('data', (ch) => {
    size += ch.length;
    if (size > MAX_UPLOAD) {
      fail(413, 'File terlalu besar (maks 300 MB)');
      req.destroy();
    }
  });
  req.on('error', () => fail(400, 'Upload terputus'));
  out.on('error', (e) => fail(500, e.message));
  out.on('finish', () => {
    if (failed) return;
    // Jika video, pastikan punya audio track agar Chrome tidak pause (video-only background media)
    const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv']);
    if (VIDEO_EXT.has(ext)) {
      ensureVideoAudio(dest, () => {
        const finalSize = (() => { try { return fs.statSync(dest).size; } catch (_) { return size; } })();
        json(res, 200, { url: '/uploads/' + encodeURIComponent(file), name: clean, size: finalSize });
      });
    } else {
      json(res, 200, { url: '/uploads/' + encodeURIComponent(file), name: clean, size });
    }
  });
  req.pipe(out);
}

/* ------------------------------------------------------------------ */
/* HMR — browser live-reload saat file public/ berubah                */
/* ------------------------------------------------------------------ */
const hmrClients = new Set();
let hmrDebounce = null;

function hmrNotify() {
  clearTimeout(hmrDebounce);
  hmrDebounce = setTimeout(() => {
    for (const ws of hmrClients) {
      try {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event: 'reload', data: 1 }));
      } catch (_) { /* diabaikan */ }
    }
  }, 150);
}

(function watchPublic() {
  try {
    fs.watch(PUBLIC, { recursive: true }, (type, filename) => {
      if (!filename) return;
      console.log('[hmr] berubah:', filename, '— kirim reload ke', hmrClients.size, 'browser');
      hmrNotify();
    });
  } catch (_) {
    /* fs.watch tidak tersedia di lingkungan ini — abaikan */
  }
})();

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
async function api(req, res, pathname, q) {
  const m = req.method;
  let mm;

  if (pathname === '/api/info' && m === 'GET') {
    return json(res, 200, { name: 'JekInteract', version: VERSION, port: activePort, addresses: lanAddresses(), tunnel: tunnelPayload() });
  }

  if (pathname === '/api/tunnel/status' && m === 'GET') {
    return json(res, 200, tunnelPayload());
  }

  if (pathname === '/api/log' && m === 'POST') {
    const buf = await readBody(req, MAX_JSON);
    try {
      const body = JSON.parse(buf.toString('utf8'));
      const prefix = '[overlay/' + (body.src || '?') + ']';
      if (body.warn) console.warn(prefix, body.msg);
      else console.log(prefix, body.msg);
    } catch (_) {}
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/status' && m === 'GET') return json(res, 200, statusPayload());
  if (pathname === '/api/state' && m === 'GET') return json(res, 200, state);

  if ((mm = /^\/api\/state\/([\w-]{1,40})$/.exec(pathname))) {
    const key = mm[1];
    if (m === 'GET') return json(res, 200, { key, value: state[key] === undefined ? null : state[key] });
    if (m === 'POST' || m === 'PUT') {
      const body = await readJSON(req);
      if (!Object.prototype.hasOwnProperty.call(body, 'value')) throw httpError(400, 'Field "value" wajib ada');
      state[key] = body.value;
      // Riwayat join bisa ikut ditulis lewat API state umum; bangun ulang cache
      // cooldown supaya jeda join ulang tetap konsisten.
      if (key === 'joinAlertHistory') {
        if (!Array.isArray(state[key])) state[key] = [];
        joinAlertSeen = null;
      }
      if (key === 'followAlertHistory' && !Array.isArray(state[key])) state[key] = [];
      saveState();
      broadcast('state', { key, value: body.value, src: body.src || null });
      return json(res, 200, { ok: true });
    }
  }

  if ((mm = /^\/api\/screen\/(\d{1,2})\/play$/.exec(pathname)) && m === 'POST') {
    const n = parseInt(mm[1], 10);
    if (n < 1 || n > SCREEN_COUNT) throw httpError(400, 'Screen harus 1-' + SCREEN_COUNT);
    const body = await readJSON(req);
    const item = enqueue(n, body || {});
    return json(res, 200, { ok: true, uid: item.uid, online: presenceMap()['screen-' + n] > 0 });
  }

  if ((mm = /^\/api\/screen\/(\d{1,2})\/current$/.exec(pathname)) && m === 'GET') {
    const n = parseInt(mm[1], 10);
    if (n < 1 || n > SCREEN_COUNT) throw httpError(400, 'Screen harus 1-' + SCREEN_COUNT);
    const s = screens.get(n);
    return json(res, 200, { playing: (s && s.playing) || null, queued: (s && s.queue.length) || 0 });
  }

  if (pathname === '/api/queue/clear' && m === 'POST') {
    clearAllQueues();
    return json(res, 200, { ok: true });
  }

  /* ---------- Join Alert ---------- */
  // Tes alert dikirim ke overlay yang sama dengan event join asli, jadi tampilan
  // dan animasinya identik. Sengaja mengabaikan filter agar tombol tes selalu
  // bisa dipakai walau TikTok belum terhubung.
  if (pathname === '/api/joinalert/test' && m === 'POST') {
    const body = await readJSON(req);
    const name = String((body && body.name) || 'viewer_contoh')
      .replace(/[<>\r\n\t]/g, '')
      .trim()
      .slice(0, 60) || 'viewer_contoh';
    const jaCfg = state.joinAlertCfg || {};
    broadcastJoinAlert({
      name,
      avatar: null,
      who: jaCfg.who || 'all',
      sound: jaCfg.soundOn === false ? null : joinSoundPayload(jaCfg),
      volume: joinVolume(jaCfg),
      durationMs: joinDurationMs(jaCfg),
      test: true,
      at: Date.now()
    });
    return json(res, 200, { ok: true, name });
  }

  // Bersihkan riwayat Join Alert. Tidak menyentuh konfigurasi/fitur lain.
  if (pathname === '/api/joinalert/history/clear' && m === 'POST') {
    state.joinAlertHistory = [];
    joinAlertSeen = null;
    saveState();
    broadcast('state', { key: 'joinAlertHistory', value: state.joinAlertHistory });
    return json(res, 200, { ok: true });
  }

  /* ---------- Follow Alert ---------- */
  // Tes alert memakai jalur broadcast yang sama dengan event follow asli, jadi
  // tampilan, animasi, dan suaranya identik. Sengaja mengabaikan toggle Enable
  // agar tombol tes tetap bisa dipakai walau TikTok belum terhubung.
  if (pathname === '/api/followalert/test' && m === 'POST') {
    const body = await readJSON(req);
    const name = String((body && body.name) || 'viewer_contoh')
      .replace(/[<>\r\n\t]/g, '')
      .trim()
      .slice(0, 60) || 'viewer_contoh';
    const faCfg = state.followAlertCfg || {};
    broadcastFollowAlert({
      name,
      avatar: null,
      sound: faCfg.soundOn === false ? null : followSoundPayload(faCfg),
      volume: followVolume(faCfg),
      durationMs: followDurationMs(faCfg),
      test: true,
      at: Date.now()
    });
    return json(res, 200, { ok: true, name });
  }

  // Bersihkan riwayat Follow Alert. Tidak menyentuh konfigurasi/fitur lain.
  if (pathname === '/api/followalert/history/clear' && m === 'POST') {
    state.followAlertHistory = [];
    saveState();
    broadcast('state', { key: 'followAlertHistory', value: state.followAlertHistory });
    return json(res, 200, { ok: true });
  }

  /* ---------- Config export / import ---------- */
  // Ekspor semua konfigurasi yang disimpan server (state.json) dalam satu payload.
  // Dipakai oleh dashboard untuk fitur "Ekspor Konfigurasi" (backup).
  if (pathname === '/api/config/export' && m === 'GET') {
    const keys = ['interactions', 'activities', 'music', 'subathonCfg', 'chatCfg',
                  'gifterCfg', 'likesCfg', 'winlose', 'goals', 'subathon',
                  'joinAlertCfg', 'joinAlertHistory', 'followAlertCfg', 'followAlertHistory'];
    const out = {};
    keys.forEach((k) => { out[k] = state[k]; });
    return json(res, 200, { ok: true, server: out });
  }

  // Impor konfigurasi dari payload ekspor. Hanya key yang diizinkan yang ditulis.
  // Sinkron ke client via broadcast supaya overlay/dashboard langsung terbaru.
  if (pathname === '/api/config/import' && m === 'POST') {
    const body = await readJSON(req);
    const src = (body && body.server) || {};
    const allowed = ['interactions', 'activities', 'music', 'subathonCfg', 'chatCfg',
                     'gifterCfg', 'likesCfg', 'winlose', 'goals', 'subathon',
                     'joinAlertCfg', 'joinAlertHistory', 'followAlertCfg', 'followAlertHistory'];
    let count = 0;
    allowed.forEach((k) => {
      if (src[k] !== undefined) {
        state[k] = src[k];
        broadcast('state', { key: k, value: state[k] });
        count++;
      }
    });
    if (src.goals !== undefined) resetGoalCounters();
    // Riwayat join menentukan status "pernah join" dan jeda join ulang, jadi
    // cache seen harus dibangun ulang setelah impor.
    if (src.joinAlertHistory !== undefined) {
      if (!Array.isArray(state.joinAlertHistory)) state.joinAlertHistory = [];
      joinAlertSeen = null;
    }
    if (src.followAlertHistory !== undefined && !Array.isArray(state.followAlertHistory)) {
      state.followAlertHistory = [];
    }
    if (state.followAlertCfg && typeof state.followAlertCfg === 'object') {
      delete state.followAlertCfg.refollowMinutes;
    }
    saveState();
    return json(res, 200, { ok: true, restored: count });
  }

  if (pathname === '/api/upload' && m === 'POST') return handleUpload(req, res, q);
  if (pathname === '/api/gifts' && m === 'GET') return serveGifts(res);
  if (pathname === '/api/tts/status' && m === 'GET') return json(res, 200, { available: !!MsEdgeTTS });
  if (pathname === '/api/tts' && m === 'GET') return serveTTS(res, q);
  if (pathname === '/api/sounds' && m === 'GET') return serveSounds(res, q);
  if (pathname === '/api/sounds/proxy' && m === 'GET') return serveSoundProxy(req, res, q);

  if (pathname === '/api/tiktok/connect' && m === 'POST') return tiktokConnect(req, res);
  if (pathname === '/api/tiktok/disconnect' && m === 'POST') return tiktokDisconnect(res);
  if (pathname === '/api/tiktok/status' && m === 'GET') {
    await loadTikTokConnector();
    return json(res, 200, tiktokStatus());
  }
  if (pathname === '/api/live/stats' && m === 'GET') return json(res, 200, liveStatsPayload());
  if (pathname === '/api/keystroke/status' && m === 'GET') return json(res, 200, keystrokeStatus());
  if (pathname === '/api/keystroke/config' && m === 'GET') return json(res, 200, keystrokeConfig());
  if (pathname === '/api/keystroke/config' && m === 'POST') {
    const body = await readJSON(req);
    const target = String(body.target == null ? '' : body.target).trim().slice(0, 120);
    const autoFocus = body.autoFocus === undefined ? true : !!body.autoFocus;
    const focusDelayMs = Math.max(0, Math.min(2000, Number(body.focusDelayMs) || 0));
    state.keystrokeCfg = { target, autoFocus, focusDelayMs };
    saveState();
    broadcast('state', { key: 'keystrokeCfg', value: state.keystrokeCfg });
    return json(res, 200, { ok: true, config: keystrokeConfig() });
  }

  /* ---- Kontrol aplikasi (khusus build Electron) ---- */
  if (pathname === '/api/app/quit' && m === 'POST') {
    json(res, 200, { ok: true, message: 'Menutup JekInteract...' });
    setTimeout(() => {
      if (typeof global.__JEK_QUIT === 'function') global.__JEK_QUIT();
      else process.exit(0); // fallback saat dijalankan lewat npm start
    }, 150);
    return;
  }
  if (pathname === '/api/app/restart-admin' && m === 'POST') {
    const can = typeof global.__JEK_RESTART_ADMIN === 'function';
    if (!can) {
      return json(res, 400, {
        ok: false,
        error: 'Fitur ini hanya tersedia di aplikasi JekInteract (.exe). Jalankan .exe lewat klik kanan → Run as administrator, atau buka terminal sebagai Administrator lalu jalankan npm start.'
      });
    }
    json(res, 200, { ok: true, message: 'Meminta izin Administrator...' });
    setTimeout(() => global.__JEK_RESTART_ADMIN(), 150);
    return;
  }

  if (pathname === '/api/keystroke' && m === 'POST') {
    const body = await readJSON(req);
    const lines = Array.isArray(body.lines) ? body.lines.map(String).filter(Boolean) : [];
    if (!lines.length) return json(res, 400, { ok: false, error: 'Field "lines" wajib berisi array keystroke.' });
    const intName   = String(body.name   || '').trim() || '—';
    const intScreen = String(body.screen || '').trim() || '—';
    const intId     = String(body.id     || '').trim();
    const keyLabel  = lines.join(', ');
    // Delay khusus keystroke — pakai nilai interaksi bila ada, fallback ke delay umum.
    const delayRaw  = body.keystrokeDelay === undefined ? body.delay : body.keystrokeDelay;
    const delaySec  = Math.max(0, Math.min(60, Number(delayRaw) || 0));

    // Kumpulkan semua event dari aktivitas yang terhubung ke interaksi ini
    const linkedActs = (state.activities || []).filter((a) =>
      a.action && (a.action.id === intId || (a.action.ids || []).includes(intId))
    );
    const eventLabel = linkedActs.length
      ? [...new Set(linkedActs.map((a) => whenDetailLabel(a.when)))].join(', ')
      : '—';
    const ks = keystrokeStatus();
    const warning = ks.elevatedTargetBlocked ? ks.hint : '';

    if (!keystrokeAvailable()) {
      console.log('AKTIVITAS : Test Play - ' + intName + ' - ' + keyLabel + ' - ' + eventLabel + ' - Screen ' + intScreen + ' [simulasi]');
      return json(res, 200, { ok: true, simulated: true, message: 'Mesin keystroke tidak tersedia di perangkat ini — simulasi saja.', warning });
    }
    const delayMs  = delaySec * 1000;
    const delayTag = delaySec > 0 ? ' [delay ' + delaySec + 's]' : '';
    console.log('AKTIVITAS : Test Play - ' + intName + ' - ' + keyLabel + ' - ' + eventLabel + ' - Screen ' + intScreen + delayTag);
    if (delayMs > 0) {
      // Tembak setelah delay, tapi jawab request segera (sama seperti realtime).
      setTimeout(() => {
        fireKeystrokes(lines).catch((e) => console.warn('[keystroke] gagal (delay):', e.message));
      }, delayMs);
      return json(res, 200, { ok: true, fired: lines, delayed: delaySec, warning });
    }
    try {
      const sent = await fireKeystrokes(lines);
      if (!sent) {
        const target = keystrokeConfig().target;
        return json(res, 200, {
          ok: false,
          error: 'Jendela "' + target + '" tidak ditemukan / tidak bisa difokuskan. Buka game dulu atau matikan fokus otomatis di Pengaturan.'
        });
      }
      return json(res, 200, { ok: true, fired: lines, warning });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/likes/leaderboard' && m === 'GET') return json(res, 200, likeLeaderboardObj());
  if (pathname === '/api/gifters/leaderboard' && m === 'GET') return json(res, 200, giftLeaderboardObj());

  if (pathname === '/api/likes/reset' && m === 'POST') {
    likeBoard.clear();
    broadcastLikeLeaderboard();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/gifters/reset' && m === 'POST') {
    giftBoard.clear();
    broadcastGiftLeaderboard();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/goals/reset' && m === 'POST') {
    const body = await readJSON(req);
    const goal = String(body.goal || body.key || '').trim();
    resetGoalCounters(goal ? [goal] : null);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/reset-data' && m === 'POST') {
    // Reset data fitur yang disimpan di server (bukan pengaturan koneksi/live).
    const defaults = {
      interactions: [],
      activities: [],
      music: { playOn: true, skipOn: true, playWho: 'all', skipWho: 'all' },
      subathonCfg: { per: { coin: 0, subscribe: 0, follow: 0, share: 0, like: 0, comment: 0 } },
      chatCfg: {},
      gifterCfg: {},
      likesCfg: {},
      winlose: {},
      joinAlertCfg: { enabled: false, who: 'all', soundOn: true, sound: null, volume: 100, duration: 5, rejoinMinutes: 2 },
      joinAlertHistory: [],
      followAlertCfg: { enabled: false, soundOn: true, sound: null, volume: 100, duration: 5 },
      followAlertHistory: []
    };
    Object.keys(defaults).forEach((k) => {
      state[k] = defaults[k];
      broadcast('state', { key: k, value: state[k] });
    });
    joinAlertSeen = null;
    state.goals = {};
    resetGoalCounters();
    saveState();
    return json(res, 200, { ok: true });
  }

  /* ---------- Music API ---------- */
  if (pathname === '/api/music/state' && m === 'GET') {
    return json(res, 200, musicStatePayload());
  }

  if (pathname === '/api/music/enqueue' && m === 'POST') {
    const body = await readJSON(req);
    const user  = String(body.user  || 'dashboard').trim().slice(0, 80);
    const title = String(body.title || '').trim().slice(0, 120);
    const ytId  = String(body.ytId  || '').trim().slice(0, 20);
    if (!title) return json(res, 400, { ok: false, error: 'title wajib' });
    const result = musicEnqueue(user, title, ytId);
    return json(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/music/skip' && m === 'POST') {
    const body = await readJSON(req);
    const result = musicSkip(String(body.by || 'dashboard'), false);
    return json(res, result.ok ? 200 : 400, result);
  }

  // Jeda/lanjutkan + volume. Berlaku untuk semua player yang terhubung (WS musicstate).
  if (pathname === '/api/music/control' && m === 'POST') {
    const body = await readJSON(req);
    if (typeof body.paused === 'boolean') musicPaused = body.paused;
    if (body.volume !== undefined && body.volume !== null) {
      musicVolume = clamp(Math.round(Number(body.volume) || 0), 0, 100);
      if (!state.music || typeof state.music !== 'object') state.music = {};
      state.music.volume = musicVolume;
      saveState();
    }
    broadcastMusicState();
    return json(res, 200, { ok: true, paused: musicPaused, volume: musicVolume });
  }

  if (pathname === '/api/music/revoke' && m === 'POST') {
    const body = await readJSON(req);
    const title = body.title ? String(body.title).trim() : null;
    const user  = String(body.user || 'dashboard').trim();
    const result = musicRevoke(user, title);
    return json(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/music/duration' && m === 'POST') {
    const body = await readJSON(req);
    musicSetDuration(String(body.uid || ''), Number(body.dur) || 0);
    return json(res, 200, { ok: true });
  }

  // Posisi video dari player dashboard → jadi satu-satunya sumber detik lagu.
  if (pathname === '/api/music/progress' && m === 'POST') {
    const body = await readJSON(req);
    musicSetProgress(
      String(body.uid || ''),
      Number(body.elapsed),
      Number(body.dur)
    );
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/music/title' && m === 'POST') {
    const body = await readJSON(req);
    musicSetTitle(String(body.uid || ''), String(body.title || '').trim().slice(0, 200));
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/music/ytid' && m === 'POST') {
    const body = await readJSON(req);
    const uid  = String(body.uid  || '').trim();
    const ytId = String(body.ytId || '').trim().slice(0, 20);
    if (!uid || !ytId) return json(res, 400, { ok: false, error: 'uid dan ytId wajib' });
    musicSetYtId(uid, ytId);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/music/search' && m === 'GET') {
    const qstr = (q.get('q') || '').trim().slice(0, 200);
    if (!qstr) return json(res, 400, { ok: false, error: 'query wajib' });
    try {
      const ytId = await ytSearch(qstr);
      if (!ytId) return json(res, 404, { ok: false, error: 'Tidak ditemukan' });
      return json(res, 200, { ok: true, ytId });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message || 'Gagal mencari' });
    }
  }

  if (pathname === '/api/music/clear' && m === 'POST') {
    musicQueue.length = 0;
    musicNowPlaying = null;
    musicElapsed = 0;
    musicProgressAt = 0;
    musicPaused = false;
    musicTickStop();
    broadcastMusicState();
    return json(res, 200, { ok: true });
  }

  /* ---------- OBS WebSocket API ---------- */
  if (pathname === '/api/obs/connect' && m === 'POST') {
    const body = await readJSON(req);
    const ip       = String(body.ip       || '127.0.0.1').trim();
    const port     = String(body.port     || '4455').trim();
    const password = String(body.password || '').trim();
    if (!ip || !port) return json(res, 400, { ok: false, error: 'ip dan port wajib diisi.' });
    obsConnect(ip, port, password);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/obs/disconnect' && m === 'POST') {
    obsDisconnect();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/obs/status' && m === 'GET') {
    return json(res, 200, obsStatusPayload());
  }

  if (pathname === '/api/obs/scenes' && m === 'GET') {
    return json(res, 200, { ok: true, scenes: obsState.scenes, currentScene: obsState.currentScene || '' });
  }

  if (pathname === '/api/obs/sources' && m === 'GET') {
    const scene = q.get('scene') || obsState.currentScene || '';
    const sources = obsState.sources[scene] || [];
    return json(res, 200, { ok: true, scene, sources });
  }

  if (pathname === '/api/obs/command' && m === 'POST') {
    const body = await readJSON(req);
    const type = String(body.type || '');
    if (obsState.status !== 'online') return json(res, 400, { ok: false, error: 'OBS tidak terhubung.' });
    if (type === 'scene') {
      const sceneName = String(body.scene || '');
      const mode = String(body.mode || 'revert');
      const duration = Number(body.duration) || 10;
      if (!sceneName) return json(res, 400, { ok: false, error: 'scene wajib diisi.' });
      obsSwitchScene(sceneName, mode, duration);
      return json(res, 200, { ok: true });
    }
    if (type === 'source') {
      const srcScene  = String(body.srcScene  || obsState.currentScene || '');
      const srcName   = String(body.source    || '');
      const srcOff    = body.srcOff !== false;
      const duration  = Number(body.duration) || 10;
      if (!srcName) return json(res, 400, { ok: false, error: 'source wajib diisi.' });
      obsSetSourceVisible(srcScene, srcName, true);
      if (srcOff) setTimeout(() => obsSetSourceVisible(srcScene, srcName, false), duration * 1000);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false, error: 'type tidak valid. Gunakan "scene" atau "source".' });
  }

  return json(res, 404, { error: 'Endpoint tidak ditemukan' });
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* TikTok Live — integrasi tiktok-live-connector                       */
/* ------------------------------------------------------------------ */
let tiktokClient = null;      // instance TikTokLiveConnection aktif
let tiktokUser = '';          // username yang sedang terhubung
let tiktokState = 'offline';  // 'offline' | 'connecting' | 'online' | 'error'
let tiktokError = '';         // pesan error terakhir
let tiktokConnectedAt = 0;    // waktu koneksi live berhasil dipakai filter komentar lama

/* ------------------------------------------------------------------ */
/* Like Leaderboard — akumulasi like per user selama sesi live         */
/* ------------------------------------------------------------------ */
const likeBoard = new Map(); // uniqueId → { nickname, avatarUrl, count }
let likeBroadcastTimer = null;

/* ------------------------------------------------------------------ */
/* Gift Leaderboard — akumulasi koin gift per user selama sesi live    */
/* ------------------------------------------------------------------ */
const giftBoard = new Map(); // uniqueId → { nickname, avatarUrl, coins }
let giftBroadcastTimer = null;

function giftLeaderboardObj() {
  return Array.from(giftBoard, ([id, v]) => ({ id, nickname: v.nickname, avatarUrl: v.avatarUrl || null, count: v.coins }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function broadcastGiftLeaderboard() {
  clearTimeout(giftBroadcastTimer);
  giftBroadcastTimer = setTimeout(() => {
    broadcast('giftleaderboard', giftLeaderboardObj());
  }, 80);
}

function processGiftEvent(data) {
  // Hanya proses saat gift selesai (repeatEnd = 0 atau undefined/null = non-combo)
  if (data.repeatEnd !== 0 && data.repeatEnd != null) return;
  const u = (data && data.user) ? data.user : data;
  if (!u) return;
  const id = String(u.id || u.uniqueId || u.userId || '').trim();
  if (!id) return;
  const nickname = String(u.nickname || id).trim();
  const avatarUrl = (u.avatarThumb && Array.isArray(u.avatarThumb.urlList) && u.avatarThumb.urlList[0])
    ? u.avatarThumb.urlList[0]
    : null;
  const giftObj = data.gift || {};
  const diamondCount = Number(giftObj.diamondCount || data.diamondCount) || 0;
  const repeatCount = Math.max(1, Number(data.repeatCount || data.groupCount) || 1);
  const coins = diamondCount * repeatCount;
  if (coins <= 0) return;
  const prev = giftBoard.get(id) || { nickname, avatarUrl, coins: 0 };
  giftBoard.set(id, { nickname, avatarUrl: avatarUrl || prev.avatarUrl, coins: prev.coins + coins });
  broadcastGiftLeaderboard();
}

/* ------------------------------------------------------------------ */
/* Goal Counters — akumulasi progres goal per sesi live                */
/* ------------------------------------------------------------------ */
const GOAL_KEYS = ['like', 'share', 'follower', 'coin'];
const goalCounters = { like: 0, share: 0, follower: 0, coin: 0 };

function goalsStateObj() {
  // Gabungkan target dari state dengan counter live
  const saved = (state.goals || {});
  const GOAL_DEF = { like: 5000, share: 100, follower: 100, coin: 1000 };
  const out = {};
  GOAL_KEYS.forEach((k) => {
    const s = saved[k] || {};
    const target = Math.max(1, Number(s.target) || GOAL_DEF[k]);
    out[k] = { target, current: Math.min(goalCounters[k], target) };
    // Pertahankan label custom overlay (mis. Goal Coin) saat state goals dibangun ulang.
    if (typeof s.label === 'string') out[k].label = s.label;
  });
  return out;
}

let goalsBroadcastTimer = null;
function broadcastGoals() {
  clearTimeout(goalsBroadcastTimer);
  goalsBroadcastTimer = setTimeout(() => {
    const g = goalsStateObj();
    // Update state.goals so overlays using Sync.state see it too
    state.goals = g;
    broadcast('state', { key: 'goals', value: g });
  }, 80);
}

function resetGoalCounters(keys) {
  const list = (Array.isArray(keys) && keys.length ? keys : GOAL_KEYS).filter((k) => GOAL_KEYS.includes(k));
  if (!list.length) return;
  list.forEach((k) => { goalCounters[k] = 0; });
  // target diambil dari state.goals; current dihitung ulang dari counter yang tersisa
  state.goals = goalsStateObj();
  saveState();
  broadcast('state', { key: 'goals', value: state.goals });
}

function processGoalLike(data) {
  const count = Number(data.count || data.likeCount || 1) || 1;
  goalCounters.like += count;
  broadcastGoals();
}

function processGoalShare() {
  goalCounters.share += 1;
  broadcastGoals();
}

function processGoalFollow() {
  goalCounters.follower += 1;
  broadcastGoals();
}

function processGoalCoin(data) {
  // Hanya proses saat gift selesai (repeatEnd = 0 atau undefined/null = non-combo)
  if (data.repeatEnd !== 0 && data.repeatEnd != null) return;
  const giftObj = data.gift || {};
  const diamondCount = Number(giftObj.diamondCount || data.diamondCount) || 0;
  const repeatCount = Math.max(1, Number(data.repeatCount || data.groupCount) || 1);
  const coins = diamondCount * repeatCount;
  if (coins <= 0) return;
  goalCounters.coin += coins;
  broadcastGoals();
}

/* ------------------------------------------------------------------ */
/* Subathon Live — tambah/kurangi waktu timer dari TikTok events       */
/* ------------------------------------------------------------------ */

/**
 * Ambil konfigurasi subathon dari state.subathonCfg.
 * Dashboard menyimpannya via Sync.set('subathonCfg', {...}).
 * per: { coin, subscribe, follow, share, like, comment } — detik per event
 */
function getSubathonCfg() {
  const cfg = state.subathonCfg || {};
  const per = cfg.per || {};
  return {
    coin:      Number(per.coin)      || 0,
    subscribe: Number(per.subscribe) || 0,
    follow:    Number(per.follow)    || 0,
    share:     Number(per.share)     || 0,
    like:      Number(per.like)      || 0,
    comment:   Number(per.comment)   || 0
  };
}

/**
 * Tambah `seconds` ke sisa waktu subathon yang sedang berjalan.
 * Hanya berjalan bila timer dalam status 'running'.
 */
function subathonAddTime(seconds) {
  if (!seconds || seconds === 0) return;
  const st = state.subathon;
  if (!st || st.status !== 'running') return;
  const addMs = Math.round(seconds * 1000);
  // Hitung sisa waktu saat ini berdasarkan startedAt agar akurat
  const now = Date.now();
  const startedAt = Number(st.startedAt) || now;
  const elapsed = Math.max(0, now - startedAt);
  const currentRemaining = Math.max(0, Number(st.remainingMs || 0) - elapsed);
  const newRemaining = Math.max(0, currentRemaining + addMs);
  // Reset startedAt ke sekarang dengan remaining yang sudah dihitung ulang
  state.subathon = Object.assign({}, st, { remainingMs: newRemaining, startedAt: now });
  saveState();
  broadcast('state', { key: 'subathon', value: state.subathon });
}

function processSubathonEvent(evKey, data) {
  const per = getSubathonCfg();
  let seconds = 0;
  if (evKey === 'like') {
    // like: data.count like per batch
    const count = Number((data || {}).count || (data || {}).likeCount || 1) || 1;
    seconds = per.like * count;
  } else if (evKey === 'coin') {
    // gift/coin: hanya saat repeatEnd = 0 (selesai)
    if ((data || {}).repeatEnd !== 0 && (data || {}).repeatEnd != null) return;
    const giftObj = (data || {}).gift || {};
    const diamondCount = Number(giftObj.diamondCount || (data || {}).diamondCount) || 0;
    const repeatCount = Math.max(1, Number((data || {}).repeatCount || (data || {}).groupCount) || 1);
    seconds = per.coin * (diamondCount * repeatCount);
  } else {
    seconds = per[evKey] || 0;
  }
  subathonAddTime(seconds);
}

function likeLeaderboardObj() {
  // Ubah Map menjadi array [{id, nickname, avatarUrl, count}] urut terbanyak
  return Array.from(likeBoard, ([id, v]) => ({ id, nickname: v.nickname, avatarUrl: v.avatarUrl || null, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function broadcastLikeLeaderboard() {
  clearTimeout(likeBroadcastTimer);
  likeBroadcastTimer = setTimeout(() => {
    broadcast('likeleaderboard', likeLeaderboardObj());
  }, 80);
}

function processLikeEvent(data) {
  // tiktok-live-connector v2.5: user ada di data.user
  // User.id adalah numeric string (userId), User.nickname adalah display name
  const u = (data && data.user) ? data.user : data;
  if (!u) return;
  // v2.5: field adalah u.id (bukan uniqueId/userId)
  const id = String(u.id || u.uniqueId || u.userId || '').trim();
  if (!id) return;
  const nickname = String(u.nickname || id).trim();
  // Ambil URL foto profil dari avatarThumb.urlList[0]
  const avatarUrl = (u.avatarThumb && Array.isArray(u.avatarThumb.urlList) && u.avatarThumb.urlList[0])
    ? u.avatarThumb.urlList[0]
    : null;
  const count = Number(data.count || data.likeCount || 1) || 1;
  const prev = likeBoard.get(id) || { nickname, avatarUrl, count: 0 };
  likeBoard.set(id, { nickname, avatarUrl: avatarUrl || prev.avatarUrl, count: prev.count + count });
  broadcastLikeLeaderboard();
}

function tiktokStatus() {
  return {
    state: tiktokState,
    username: tiktokUser,
    error: tiktokError,
    available: !!TikTokLiveConnection,
    importError: tikTokImportError,
    loading: !TikTokLiveConnection && !tikTokImportError
  };
}

function broadcastTiktok(event, data) {
  broadcast('tiktok', Object.assign({ event }, data), (c) => c.role === 'dashboard');
}

// Kirim event chat TikTok ke overlay chat agar menampilkan komentar live
function broadcastChatToOverlay(data) {
  broadcast('tiktok', Object.assign({ event: 'chat' }, data), (c) => c.role === 'overlay' && c.id === 'chat');
}

/**
 * TikTok kadang mengirim ulang komentar lama saat websocket baru tersambung.
 * TTS harus mengabaikannya: flag ini dihitung dari waktu connect berhasil dan
 * timestamp asli komentar (kalau tersedia). Event lain tidak terpengaruh.
 */
function chatAfterConnect(data) {
  if (tiktokState !== 'online' || !tiktokConnectedAt) return false;
  const d = data || {};
  // tiktok-live-connector v2.5 mengirim WebcastChatMessage mentah: waktu dibuat
  // ada di common.createTime (string detik), BUKAN di field top-level. Field
  // top-level tetap dicek untuk payload versi lama/format lain.
  const candidates = [
    d.common && d.common.createTime,
    d.createTime,
    d.create_time,
    d.msgCreateTime,
    d.timestamp
  ];
  for (const c of candidates) {
    const raw = Number(c);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return ms >= tiktokConnectedAt - 2000; // toleransi 2 detik beda jam
  }
  return true; // tanpa timestamp yang valid → dianggap komentar baru
}

// Join Alert — dikirim ke overlay OBS dan ke semua dashboard. Dashboard hanya
// menyuarakan alert bila overlay asli tidak online, jadi tidak ada suara dobel.
function broadcastJoinAlert(payload) {
  broadcast('joinalert', payload, (c) =>
    (c.role === 'overlay' && c.id === 'joinalert') || c.role === 'dashboard');
}

/**
 * Filter pemicu Join Alert. Dijalankan di server supaya overlay hanya menerima
 * event yang benar-benar lolos filter: semua orang / follower / fan club.
 */
function joinWhoMatches(who, data) {
  if (who !== 'follower' && who !== 'fanclub') return true;
  const u = getUser(data) || {};
  if (who === 'follower') {
    return !!(u.isFollower ||
      (data && data.userIdentity && data.userIdentity.isFollowerOfAnchor) ||
      (u.userIdentity && u.userIdentity.isFollowerOfAnchor));
  }
  // Fan Club: tiktok-live-proto menyimpan info klub di user.fansClubInfo /
  // user.fansClub.data (level, clubName, userFansClubStatus: 0 = belum join).
  if (u.isFanClub || u.isFansClubMember) return true;
  const fc = u.fansClubInfo || u.fansClub || u.fansClubData || (data && data.fansClubInfo);
  if (!fc) return false;
  const d = fc.data || fc;
  const status = d.userFansClubStatus;
  if (status !== undefined && status !== null && Number(status) === 0) return false;
  const level = Number(d.level != null ? d.level : d.fansLevel);
  if (Number.isFinite(level) && level > 0) return true;
  return Number(status) === 1 || !!(d.clubName || d.fansClubName);
}

/** Ambil foto profil asli dari payload user TikTok (ImageModel → urlList). */
function joinAvatarUrl(u) {
  if (!u) return null;
  const fromImage = (img) => {
    if (typeof img === 'string') return img.trim() || null;
    if (Array.isArray(img)) return img.find((x) => typeof x === 'string' && x.trim()) || null;
    if (img && Array.isArray(img.urlList)) return img.urlList.find((x) => typeof x === 'string' && x.trim()) || null;
    return null;
  };
  const url = fromImage(u.avatarLarge) || fromImage(u.avatarMedium) ||
              fromImage(u.avatarThumb) || fromImage(u.avatarLarger) ||
              u.avatarUrl || u.avatar || null;
  return safeUrl(url);
}

/** Suara soundboard yang dipilih di halaman Join Alert. */
function joinSoundPayload(cfg) {
  const s = cfg && cfg.sound;
  if (!s || !s.url) return null;
  const url = safeUrl(s.url);
  if (!url) return null;
  const name = String(s.name || 'Suara join').replace(/[<>\r\n\t]/g, '').trim().slice(0, 80) || 'Suara join';
  return { name, url, source: String(s.source || 'myinstants').slice(0, 40) };
}

function joinVolume(cfg) {
  const n = Number(cfg && cfg.volume);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100;
}

function joinDurationMs(cfg) {
  const n = Number(cfg && cfg.duration);
  const sec = Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 5;
  return Math.round(sec * 1000);
}

function joinRejoinMinutes(cfg) {
  const n = Number(cfg && cfg.rejoinMinutes);
  return Number.isFinite(n) ? Math.min(1440, Math.max(0, n)) : 2;
}

/* Riwayat join + jeda join ulang. seen menyimpan waktu alert terakhir per user
 * (bukan waktu join terakhir) supaya user yang bolak-balik join tidak membuat
 * cooldown-nya terus resets. */
const JOIN_HISTORY_LIMIT = 100;
let joinAlertSeen = null;

function joinAlertHistory() {
  return Array.isArray(state.joinAlertHistory) ? state.joinAlertHistory : [];
}

function joinSeen() {
  if (!joinAlertSeen) {
    joinAlertSeen = new Map();
    joinAlertHistory().forEach((e) => {
      if (e && e.alerted && e.key) {
        joinAlertSeen.set(e.key, Math.max(joinAlertSeen.get(e.key) || 0, Number(e.at) || 0));
      }
    });
  }
  return joinAlertSeen;
}

/* TikTok v2.5 mengirim u.id sebagai angka (userId), bukan @username. Handle asli
 * ada di uniqueId/displayId (legacy di-flat ke event). Jangan pernah pakai id
 * numerik sebagai username di history. */
function joinHandle(u, data) {
  const sources = [u, data, u && u.user, data && data.user];
  const keys = ['uniqueId', 'displayId', 'username', 'userName', 'handle', 'userHandle', 'customId', 'unique_id', 'display_id'];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of keys) {
      const raw = String(src[k] == null ? '' : src[k]).trim().replace(/^@+/, '').slice(0, 60);
      if (raw && !/^\d+$/.test(raw) && /^[A-Za-z0-9._]+$/.test(raw)) return raw;
    }
  }
  return '';
}

function joinIdentity(u, data) {
  const handle = joinHandle(u, data);
  const nickname = String(u.nickname || handle || 'viewer').trim().slice(0, 60) || 'viewer';
  const username = handle;
  const key = String(u.id || u.uniqueId || u.userId || handle || nickname).trim().toLowerCase();
  const isFollower = !!(u.isFollower ||
    (data && data.userIdentity && data.userIdentity.isFollowerOfAnchor) ||
    (u.userIdentity && u.userIdentity.isFollowerOfAnchor));
  return { nickname, username, key, isFollower };
}

function pushJoinHistory(entry) {
  const next = [entry].concat(joinAlertHistory()).slice(0, JOIN_HISTORY_LIMIT);
  state.joinAlertHistory = next;
  saveState();
  broadcast('state', { key: 'joinAlertHistory', value: next });
}

/** Event join TikTok (v2.5: 'member') → kartu alert di overlay. */
function processJoinAlert(data) {
  const cfg = state.joinAlertCfg || {};
  // Tombol Enable di dashboard: kalau mati, tidak ada alert dan tidak ada history.
  if (cfg.enabled === false) return;
  const who = cfg.who || 'all';

  const u = getUser(data) || {};
  const id = joinIdentity(u, data);
  const now = Date.now();
  const everJoined = joinAlertHistory().some((e) => e && e.key === id.key);
  const seen = joinSeen();
  const lastAlert = seen.get(id.key) || 0;
  const minutes = joinRejoinMinutes(cfg);
  // Riwayat tetap mencatat semua orang yang join, walaupun filter alert
  // (Semua/Follower/Fan Club) atau jeda join ulang membuat alertnya dilewati.
  const onCooldown = !!lastAlert && minutes > 0 && (now - lastAlert) < minutes * 60000;
  const skipped = onCooldown || !joinWhoMatches(who, data);

  const status = id.isFollower ? 'follower' : (everJoined ? 'repeat' : 'new');
  pushJoinHistory({
    key: id.key,
    nickname: id.nickname,
    username: id.username,
    status,
    isFollower: id.isFollower,
    joinedBefore: everJoined,
    alerted: !skipped,
    at: now
  });
  if (skipped) return;
  seen.set(id.key, now);

  broadcastJoinAlert({
    name: id.nickname,
    avatar: joinAvatarUrl(u),
    who,
    sound: cfg.soundOn === false ? null : joinSoundPayload(cfg),
    volume: joinVolume(cfg),
    durationMs: joinDurationMs(cfg),
    test: false,
    at: now
  });
}

/* ------------------------------------------------------------------ */
/* Follow Alert — kartu saat ada yang follow live yang terhubung       */
/* ------------------------------------------------------------------ */

// Follow Alert — dikirim ke overlay OBS dan ke semua dashboard (lihat Join Alert).
function broadcastFollowAlert(payload) {
  broadcast('followalert', payload, (c) =>
    (c.role === 'overlay' && c.id === 'followalert') || c.role === 'dashboard');
}

/** Suara soundboard yang dipilih di halaman Follow Alert. */
function followSoundPayload(cfg) {
  const s = cfg && cfg.sound;
  if (!s || !s.url) return null;
  const url = safeUrl(s.url);
  if (!url) return null;
  const name = String(s.name || 'Suara follow').replace(/[<>\r\n\t]/g, '').trim().slice(0, 80) || 'Suara follow';
  return { name, url, source: String(s.source || 'myinstants').slice(0, 40) };
}

function followVolume(cfg) {
  const n = Number(cfg && cfg.volume);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100;
}

function followDurationMs(cfg) {
  const n = Number(cfg && cfg.duration);
  const sec = Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 5;
  return Math.round(sec * 1000);
}

/* Riwayat follow (maksimal 100 entri terakhir). Setiap event follow langsung
 * memicu alert — tanpa jeda/cooldown. */
const FOLLOW_HISTORY_LIMIT = 100;

function followAlertHistory() {
  return Array.isArray(state.followAlertHistory) ? state.followAlertHistory : [];
}

/* Pakai parser handle yang sama dengan Join Alert: u.id dari TikTok v2.5
 * berupa angka, jangan pernah dipakai sebagai @username di history. */
function followIdentity(u, data) {
  const handle = joinHandle(u, data);
  const nickname = String(u.nickname || handle || 'viewer').trim().slice(0, 60) || 'viewer';
  const username = handle;
  const key = String(u.id || u.uniqueId || u.userId || handle || nickname).trim().toLowerCase();
  return { nickname, username, key };
}

function pushFollowHistory(entry) {
  const next = [entry].concat(followAlertHistory()).slice(0, FOLLOW_HISTORY_LIMIT);
  state.followAlertHistory = next;
  saveState();
  broadcast('state', { key: 'followAlertHistory', value: next });
}

/** Event follow TikTok → kartu alert di overlay. */
function processFollowAlert(data) {
  const cfg = state.followAlertCfg || {};
  // Tombol Enable di dashboard: kalau mati, tidak ada alert dan tidak ada history.
  if (cfg.enabled === false) return;

  const u = getUser(data) || {};
  const id = followIdentity(u, data);
  const now = Date.now();
  const everFollowed = followAlertHistory().some((e) => e && e.key === id.key);

  pushFollowHistory({
    key: id.key,
    nickname: id.nickname,
    username: id.username,
    status: everFollowed ? 'repeat' : 'new',
    followedBefore: everFollowed,
    alerted: true,
    at: now
  });

  broadcastFollowAlert({
    name: id.nickname,
    // Helper joinAvatarUrl dipakai bareng: ekstrak urlList dari ImageModel TikTok.
    avatar: joinAvatarUrl(u),
    sound: cfg.soundOn === false ? null : followSoundPayload(cfg),
    volume: followVolume(cfg),
    durationMs: followDurationMs(cfg),
    test: false,
    at: now
  });
}

// Kirim state tiktok (connected/disconnected) ke semua client termasuk overlay
// agar chat.js / board.js di overlay bisa tahu kapan harus switch ke data live
function broadcastTiktokState() {
  broadcast('tiktokstate', tiktokStatus()); // ke semua: dashboard + overlay
}

/* ------------------------------------------------------------------ */
/* Activity Engine — cocokkan TikTok event ke aktivitas & jalankan     */
/* ------------------------------------------------------------------ */

/**
 * Ekstrak objek user dari payload event (v2 pakai data.user, v1 flat).
 */
function getUser(data) {
  return (data && data.user) ? data.user : data;
}

/**
 * Periksa apakah pengguna TikTok memenuhi filter "who" dari aktivitas.
 * tiktok-live-connector v2: user ada di data.user
 * field: isFollower, userIdentity.isFollowerOfAnchor, userAttr.isAdmin
 */
function matchWho(who, eventData) {
  if (who === 'all') return true;
  const u = getUser(eventData);
  if (!u) return false;
  // follower: cek isFollower langsung atau userIdentity.isFollowerOfAnchor
  const isFollower = !!(u.isFollower || (eventData.userIdentity && eventData.userIdentity.isFollowerOfAnchor) || (u.userIdentity && u.userIdentity.isFollowerOfAnchor));
  // friend: isMutualFollowing
  const isFriend = !!(u.isFriend || (eventData.userIdentity && eventData.userIdentity.isMutualFollowingWithAnchor) || (u.userIdentity && u.userIdentity.isMutualFollowingWithAnchor));
  // subscriber / super fan
  const isSubscriber = !!(u.isSubscriber || (eventData.userIdentity && eventData.userIdentity.isSubscriberOfAnchor) || (u.userIdentity && u.userIdentity.isSubscriberOfAnchor));
  // moderator
  const isModerator = !!(u.isModerator || (u.userAttr && u.userAttr.isAdmin) || (u.userAttr && u.userAttr.isChannelAdmin));
  // team: Level Tim — pengguna yang punya peran tim di channel (moderator atau channel admin)
  const isTeam = isModerator || !!(u.userAttr && (u.userAttr.isStaff || u.userAttr.isTopFan));
  // topgifter: pengguna ada di giftBoard (sudah pernah mengirim gift)
  const uid = String(u.id || u.uniqueId || u.userId || '').trim();
  const isTopGifter = uid ? giftBoard.has(uid) : false;

  if (who === 'follower')   return isFollower;
  if (who === 'friend')     return isFriend;
  if (who === 'subscriber') return isSubscriber;
  if (who === 'moderator')  return isModerator;
  if (who === 'team')       return isTeam;
  if (who === 'topgifter')  return isTopGifter;
  return false;
}

/**
 * Periksa apakah event TikTok cocok dengan kondisi "when" aktivitas.
 * tiktok-live-connector v2: komentar di data.content, gift di data.gift.name/diamondCount
 * repeatEnd: nilainya 0 (selesai) atau angka lain / null saat masih combo
 */
function matchWhen(ev, data, when) {
  switch (when.type) {
    case 'join':
      // v2.5: event join masuk sebagai 'member' (WebcastMemberMessage)
      return ev === 'member' || ev === 'join';

    case 'comment':
      return ev === 'chat';

    case 'comment_exact':
      if (ev !== 'chat') return false;
      // v2: teks komentar di data.content
      return String(data.content || data.comment || '').trim().toLowerCase() === String(when.text || '').trim().toLowerCase();

    case 'gift_min': {
      if (ev !== 'gift') return false;
      // v2: repeatEnd = 0 saat gift selesai, bukan null/false saat streak masih jalan
      // Hanya proses saat repeatEnd = 0 (selesai) atau repeatEnd undefined (non-combo)
      if (data.repeatEnd !== 0 && data.repeatEnd != null) return false;
      const giftObj = data.gift || {};
      const diamondCount = Number(giftObj.diamondCount || data.diamondCount) || 0;
      const repeatCount  = Math.max(1, Number(data.repeatCount || data.groupCount) || 1);
      const coins = diamondCount * repeatCount;
      return coins >= Number(when.coins || 1);
    }

    case 'like_min':
      if (ev !== 'like') return false;
      // v2.5: jumlah like per batch ada di data.count (WebcastLikeMessage.count)
      // fallback ke likeCount untuk kompatibilitas versi lama
      return (Number(data.count || data.likeCount) || 0) >= Number(when.likes || 1);

    case 'gift_specific': {
      if (ev !== 'gift') return false;
      if (data.repeatEnd !== 0 && data.repeatEnd != null) return false;
      // v2: nama gift di data.gift.name
      const giftName = String((data.gift && data.gift.name) || data.giftName || data.gift_name || '').trim().toLowerCase();
      const target   = String(when.gift || '').trim().toLowerCase();
      return target && giftName === target;
    }

    case 'follow':
      return ev === 'follow';

    case 'share':
      return ev === 'share';

    default:
      return false;
  }
}

/**
 * Pilih ID interaksi dari aksi aktivitas (single atau random).
 */
function pickInteractionId(action) {
  if (action.mode === 'random') {
    const ids = action.ids || [];
    if (!ids.length) return null;
    return ids[Math.floor(Math.random() * ids.length)];
  }
  return action.id || null;
}

/**
 * Dipanggil setiap kali ada TikTok event — jalankan semua aktivitas yang cocok.
 */

const WHEN_LABEL_LOG = {
  join:           'Orang Join Live',
  comment:        'Kirim Komentar',
  comment_exact:  'Komentar Tertentu',
  gift_min:       'Kirim Gift Dengan Minimal Coin',
  like_min:       'Kirim Like/Tap Tap dengan Minimal',
  gift_specific:  'Kirim Gift Tertentu',
  follow:         'Orang Follow Kamu',
  share:          'Share Live'
};

/**
 * Label detail event untuk log — menyertakan nilai spesifik (nama gift, isi komentar, jumlah coin/like).
 */
function whenDetailLabel(when) {
  switch (when.type) {
    case 'comment_exact': return 'Komentar Tertentu ("' + (when.text || '') + '")';
    case 'gift_min':      return 'Kirim Gift Dengan Minimal Coin (' + (when.coins || 0) + ' Coin)';
    case 'like_min':      return 'Kirim Like/Tap Tap dengan Minimal (' + (when.likes || 0) + ' Like)';
    case 'gift_specific': return 'Kirim Gift Tertentu (' + (when.gift || '—') + ')';
    default:              return WHEN_LABEL_LOG[when.type] || when.type;
  }
}

function runActivities(ev, eventData) {
  const activities   = (state.activities   || []);
  const interactions = (state.interactions || []);

  if (!activities.length || !interactions.length) return;

  for (const act of activities) {
    if (!act.enabled) continue;

    const whoOk  = matchWho(act.who, eventData);
    const whenOk = matchWhen(ev, eventData, act.when);

    if (!whoOk || !whenOk) continue;

    const intId = pickInteractionId(act.action);
    if (!intId) continue;

    const interaction = interactions.find((i) => i.id === intId);
    if (!interaction) continue;

    const urlOf = (v) => v ? (typeof v === 'string' ? v : (v.url || null)) : null;
    const media = {
      image: interaction.triggers.image ? urlOf(interaction.media.image) : null,
      video: interaction.triggers.video ? urlOf(interaction.media.video) : null,
      audio: interaction.triggers.audio ? urlOf(interaction.media.audio) : null
    };

    const whenLabel = WHEN_LABEL_LOG[act.when.type] || act.when.type;
    console.log('AKTIVITAS : ' + whenLabel + ' - ' + interaction.name + ' - Screen ' + interaction.screen);

    enqueue(interaction.screen, {
      id:       interaction.id,
      name:     interaction.name,
      duration: interaction.duration,
      delay:    interaction.delay || 0,
      volume:   interaction.volume,
      fade:     interaction.fade,
      media
    });

    // Keystroke: jalankan jika trigger aktif dan ada daftar keystroke
    if (interaction.triggers.keystroke && Array.isArray(interaction.keystrokes) && interaction.keystrokes.length) {
      const keyLabel    = interaction.keystrokes.join(', ');
      const eventDetail = whenDetailLabel(act.when);
      console.log('AKTIVITAS : Realtime - ' + interaction.name + ' - ' + keyLabel + ' - ' + eventDetail + ' - Screen ' + interaction.screen);
      const ksDelay = interaction.keystrokeDelay === undefined ? (interaction.delay || 0) : interaction.keystrokeDelay;
      const delayMs = Math.max(0, Number(ksDelay) || 0) * 1000;
      setTimeout(() => {
        fireKeystrokes(interaction.keystrokes);
      }, delayMs);
    }

    // OBS Scene: pindah scene jika trigger aktif
    if (interaction.triggers.obsScene && interaction.obs && interaction.obs.scene) {
      const delayMs = (interaction.delay || 0) * 1000;
      setTimeout(() => {
        obsSwitchScene(interaction.obs.scene, interaction.obs.mode || 'revert', interaction.duration || 10);
      }, delayMs);
    }

    // OBS Source: aktifkan source jika trigger aktif
    if (interaction.triggers.obsSource && interaction.obs && interaction.obs.source) {
      const delayMs = (interaction.delay || 0) * 1000;
      setTimeout(() => {
        const srcScene = interaction.obs.srcScene || obsState.currentScene;
        obsSetSourceVisible(srcScene, interaction.obs.source, true);
        if (interaction.obs.srcOff) {
          setTimeout(() => {
            obsSetSourceVisible(srcScene, interaction.obs.source, false);
          }, (interaction.duration || 10) * 1000);
        }
      }, delayMs);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Keystroke Engine — eksekusi keystroke via @nut-tree/nut-js          */
/* ------------------------------------------------------------------ */

/**
 * Mapping token UI → nut.js Key enum.
 * Token berasal dari KEYSETS di interaksi.js (sudah uppercase, spasi = separator modifier).
 */
const NUT_KEY_MAP = {
  // Huruf A-Z
  A:'A', B:'B', C:'C', D:'D', E:'E', F:'F', G:'G', H:'H', I:'I', J:'J',
  K:'K', L:'L', M:'M', N:'N', O:'O', P:'P', Q:'Q', R:'R', S:'S', T:'T',
  U:'U', V:'V', W:'W', X:'X', Y:'Y', Z:'Z',
  // Angka & simbol
  '0':'Num0','1':'Num1','2':'Num2','3':'Num3','4':'Num4',
  '5':'Num5','6':'Num6','7':'Num7','8':'Num8','9':'Num9',
  '-':'Minus','=':'Equal','[':'LeftBracket',']':'RightBracket',
  '\\':'Backslash',';':'Semicolon',"'":'Quote',',':'Comma','.':'Period',
  '/':'Slash','`':'Grave',
  // Tombol khusus
  SPACE:'Space', ENTER:'Return', TAB:'Tab', ESC:'Escape', BACKSPACE:'Backspace',
  DELETE:'Delete', INSERT:'Insert', HOME:'Home', END:'End',
  PAGEUP:'PageUp', PAGEDOWN:'PageDown',
  UP:'Up', DOWN:'Down', LEFT:'Left', RIGHT:'Right',
  CAPSLOCK:'CapsLock', PAUSE:'Pause', PRINTSCREEN:'Print',
  // Fungsi
  F1:'F1',F2:'F2',F3:'F3',F4:'F4',F5:'F5',F6:'F6',
  F7:'F7',F8:'F8',F9:'F9',F10:'F10',F11:'F11',F12:'F12',
  // Numpad
  NUM0:'NumPad0',NUM1:'NumPad1',NUM2:'NumPad2',NUM3:'NumPad3',NUM4:'NumPad4',
  NUM5:'NumPad5',NUM6:'NumPad6',NUM7:'NumPad7',NUM8:'NumPad8',NUM9:'NumPad9',
  NUMADD:'Add',NUMSUB:'Subtract',NUMMUL:'Multiply',NUMDIV:'Divide',
  NUMDOT:'Decimal',NUMENTER:'Return',
  // Media
  VOLUMEUP:'AudioVolUp',VOLUMEDOWN:'AudioVolDown',MUTE:'AudioMute',
  PLAYPAUSE:'AudioPlay',NEXTTRACK:'AudioNext',PREVTRACK:'AudioPrev',
  // Modifiers (juga bisa menjadi bagian combo)
  CTRL:'LeftControl',SHIFT:'LeftShift',ALT:'LeftAlt',WIN:'LeftSuper'
};

const MOD_TOKENS = new Set(['CTRL','SHIFT','ALT','WIN']);

/* Berapa lama tombol ditahan sebelum dilepas. Game membaca input per-frame
   (~16 ms di 60 FPS), jadi tekanan 12 ms bisa kelewatan / gerakan nol. */
const KEY_HOLD_MS = 120;

/* Token UI → Virtual-Key code Windows. Dipakai oleh helper PowerShell
   (keybd_event) supaya keystroke bisa jalan tanpa native module. */
const VK_MAP = {
  A:0x41,B:0x42,C:0x43,D:0x44,E:0x45,F:0x46,G:0x47,H:0x48,I:0x49,J:0x4A,
  K:0x4B,L:0x4C,M:0x4D,N:0x4E,O:0x4F,P:0x50,Q:0x51,R:0x52,S:0x53,T:0x54,
  U:0x55,V:0x56,W:0x57,X:0x58,Y:0x59,Z:0x5A,
  '0':0x30,'1':0x31,'2':0x32,'3':0x33,'4':0x34,
  '5':0x35,'6':0x36,'7':0x37,'8':0x38,'9':0x39,
  '-':0xBD,'=':0xBB,'[':0xDB,']':0xDD,'\\':0xDC,';':0xBA,"'":0xDE,
  ',':0xBC,'.':0xBE,'/':0xBF,'`':0xC0,
  SPACE:0x20,ENTER:0x0D,TAB:0x09,ESC:0x1B,BACKSPACE:0x08,
  DELETE:0x2E,INSERT:0x2D,HOME:0x24,END:0x23,PAGEUP:0x21,PAGEDOWN:0x22,
  UP:0x26,DOWN:0x28,LEFT:0x25,RIGHT:0x27,
  CAPSLOCK:0x14,PAUSE:0x13,PRINTSCREEN:0x2C,
  F1:0x70,F2:0x71,F3:0x72,F4:0x73,F5:0x74,F6:0x75,
  F7:0x76,F8:0x77,F9:0x78,F10:0x79,F11:0x7A,F12:0x7B,
  NUM0:0x60,NUM1:0x61,NUM2:0x62,NUM3:0x63,NUM4:0x64,
  NUM5:0x65,NUM6:0x66,NUM7:0x67,NUM8:0x68,NUM9:0x69,
  NUMADD:0x6B,NUMSUB:0x6D,NUMMUL:0x6A,NUMDIV:0x6F,NUMDOT:0x6E,NUMENTER:0x0D,
  VOLUMEUP:0xAF,VOLUMEDOWN:0xAE,MUTE:0xAD,PLAYPAUSE:0xB3,NEXTTRACK:0xB0,PREVTRACK:0xB1,
  CTRL:0x11,SHIFT:0x10,ALT:0x12,WIN:0x5B
};

/* ---- Helper PowerShell (Windows asli, tanpa native module) -------------- */
/* Menjaga SATU proses PowerShell hidup dan mengirim perintah keystroke lewat
   stdin. Pakai keybd_event dari user32.dll. Tidak butuh node-gyp / prebuild. */
let psProc = null;        // child process PowerShell
let psFailed = false;     // true kalau helper tidak bisa dijalankan
let psOutBuf = '';        // buffer stdout
const psQueue = [];       // antrean promise per perintah

const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);' + [Environment]::NewLine + '[DllImport(\"user32.dll\")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);'",
  "Add-Type -MemberDefinition $sig -Name KB -Namespace Win32 | Out-Null",
  "$nativeSig = @'",
  "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
  "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);",
  "[DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr hWnd);",
  "[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
  "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
  "[DllImport(\"user32.dll\")] public static extern uint GetCurrentThreadId();",
  "[DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);",
  "[DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr hWnd);",
  "[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);",
  "'@",
  "Add-Type -MemberDefinition $nativeSig -Name Native -Namespace Win32 | Out-Null",
  "function Focus-Target([string]$names) {",
  "  foreach ($name in $names.Split(',')) {",
  "    $name = $name.Trim()",
  "    if (-not $name) { continue }",
  "    $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })",
  "    if ($procs.Count -eq 0) { continue }",
  "    $h = [IntPtr]$procs[0].MainWindowHandle",
  "    if ([Win32.Native]::IsIconic($h)) { [Win32.Native]::ShowWindow($h, 9) | Out-Null }",
  "    $fg = [Win32.Native]::GetForegroundWindow()",
  "    $dummy = [uint32]0",
  "    $fgTid = [Win32.Native]::GetWindowThreadProcessId($fg, [ref]$dummy)",
  "    $myTid = [Win32.Native]::GetCurrentThreadId()",
  "    $attached = $false",
  "    if ($fgTid -ne 0 -and $fgTid -ne $myTid) {",
  "      $attached = [Win32.Native]::AttachThreadInput($myTid, $fgTid, $true)",
  "    }",
  "    [Win32.Native]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, [uint32]3) | Out-Null",
  "    [Win32.Native]::BringWindowToTop($h) | Out-Null",
  "    [Win32.Native]::SetForegroundWindow($h) | Out-Null",
  "    if ($attached) { [Win32.Native]::AttachThreadInput($myTid, $fgTid, $false) | Out-Null }",
  "    Start-Sleep -Milliseconds 120",
  "    if ([Win32.Native]::GetForegroundWindow() -eq $h) { return $true }",
  "  }",
  "  return $false",
  "}",
  "[Console]::Out.WriteLine('READY')",
  "[Console]::Out.Flush()",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  if ($line -eq 'QUIT') { break }",
  "  if ($line.StartsWith('F:')) {",
  "    try {",
  "      if (Focus-Target ($line.Substring(2))) { [Console]::Out.WriteLine('OK') }",
  "      else { [Console]::Out.WriteLine('ERR jendela target tidak ditemukan') }",
  "    } catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message) }",
  "    [Console]::Out.Flush()",
  "    continue",
  "  }",
  "  try {",
  "    foreach ($tok in $line.Split(';')) {",
  "      if ($tok.Length -lt 2) { continue }",
  "      $op = $tok.Substring(0,1)",
  "      $vk = [Convert]::ToInt32($tok.Substring(1), 16)",
  "      $flag = if ($op -eq 'U') { 2 } else { 0 }",
  "      $scan = [Win32.KB]::MapVirtualKey([uint32]$vk, 0)",
  "      [Win32.KB]::keybd_event([byte]$vk, [byte]$scan, [uint32]$flag, [System.UIntPtr]::Zero)",
  "      if ($op -eq 'D') { Start-Sleep -Milliseconds " + KEY_HOLD_MS + " } else { Start-Sleep -Milliseconds 12 }",
  "    }",
  "    [Console]::Out.WriteLine('OK')",
  "  } catch {",
  "    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)",
  "  }",
  "  [Console]::Out.Flush()",
  "}"
].join("\n");

function ensurePsHelper() {
  if (psProc && !psProc.killed) return psProc;
  psFailed = false;
  const enc = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  let proc;
  try {
    proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    psFailed = true;
    console.warn('[keystroke] gagal spawn PowerShell: ' + e.message);
    return null;
  }
  psProc = proc;
  proc.stdout.on('data', (d) => {
    psOutBuf += d.toString();
    let idx;
    while ((idx = psOutBuf.indexOf('\n')) >= 0) {
      const line = psOutBuf.slice(0, idx).trim();
      psOutBuf = psOutBuf.slice(idx + 1);
      if (!line || line === 'READY') continue;
      const job = psQueue.shift();
      if (!job) continue;
      clearTimeout(job.timer);
      if (line.indexOf('ERR') === 0) job.reject(new Error(line.slice(3).trim()));
      else job.resolve();
    }
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.warn('[keystroke] ps: ' + s);
  });
  proc.on('error', (e) => {
    psFailed = true;
    psProc = null;
    console.warn('[keystroke] helper PowerShell error: ' + e.message);
    while (psQueue.length) { const j = psQueue.shift(); clearTimeout(j.timer); j.reject(e); }
  });
  proc.on('exit', (code) => {
    if (psProc === proc) psProc = null;
    if (code !== 0 && code !== null) psFailed = true;
    console.log('[keystroke] helper PowerShell berhenti (exit ' + code + ')');
    while (psQueue.length) { const j = psQueue.shift(); clearTimeout(j.timer); j.reject(new Error('helper PowerShell berhenti')); }
  });
  console.log('[keystroke] helper PowerShell dimulai');
  return proc;
}

function psFireLine(line) {
  return new Promise((resolve, reject) => {
    const parts = line.trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (!parts.length) return resolve();
    for (const p of parts) {
      if (VK_MAP[p] == null) return reject(new Error('Key tidak dikenal: ' + p));
    }
    const mods = parts.filter((p) => MOD_TOKENS.has(p));
    const keys = parts.filter((p) => !MOD_TOKENS.has(p));
    const seq = [];
    mods.forEach((m) => seq.push('D' + VK_MAP[m].toString(16)));
    keys.forEach((k) => seq.push('D' + VK_MAP[k].toString(16)));
    [...keys].reverse().forEach((k) => seq.push('U' + VK_MAP[k].toString(16)));
    [...mods].reverse().forEach((m) => seq.push('U' + VK_MAP[m].toString(16)));

    const proc = ensurePsHelper();
    if (!proc || !proc.stdin || !proc.stdin.writable) {
      return reject(new Error('helper PowerShell tidak tersedia'));
    }
    const job = { resolve, reject, timer: null };
    job.timer = setTimeout(() => {
      const i = psQueue.indexOf(job);
      if (i >= 0) psQueue.splice(i, 1);
      reject(new Error('timeout menunggu helper PowerShell'));
    }, 5000);
    psQueue.push(job);
    try { proc.stdin.write(seq.join(';') + '\n'); }
    catch (e) { clearTimeout(job.timer); reject(e); }
  });
}

/** Minta helper PowerShell menarik jendela target ke foreground. */
function psFocus(target) {
  return new Promise((resolve, reject) => {
    const name = String(target || '').replace(/[\r\n;]/g, '').trim();
    if (!name) return resolve(false);
    const proc = ensurePsHelper();
    if (!proc || !proc.stdin || !proc.stdin.writable) {
      return reject(new Error('helper PowerShell tidak tersedia'));
    }
    const job = {
      resolve: () => resolve(true),
      reject: (e) => reject(e),
      timer: null
    };
    job.timer = setTimeout(() => {
      const i = psQueue.indexOf(job);
      if (i >= 0) psQueue.splice(i, 1);
      reject(new Error('timeout menunggu helper PowerShell (focus)'));
    }, 5000);
    psQueue.push(job);
    try { proc.stdin.write('F:' + name + '\n'); }
    catch (e) { clearTimeout(job.timer); reject(e); }
  });
}

/**
 * Cek apakah proses JekInteract berjalan dengan hak Administrator.
 * `net session` hanya sukses (exit 0) bila token proses elevated.
 * Hasil di-cache karena tidak mungkin berubah selama proses hidup.
 */
let _isElevated = null;
function isRunningElevated() {
  if (_isElevated !== null) return _isElevated;
  if (process.platform !== 'win32') { _isElevated = false; return false; }
  try {
    const r = spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' });
    _isElevated = r.status === 0;
  } catch (_) {
    _isElevated = false;
  }
  return _isElevated;
}

/** Apakah mesin keystroke asli tersedia di platform ini? */
function keystrokeAvailable() {
  if (nutKeyboard && nutKey) return true;                       // nut.js
  if (process.platform === 'win32' && !IS_WINE && !psFailed) return true; // helper PS
  return false;
}

function keystrokeConfig() {
  return Object.assign({}, DEFAULT_KEYSTROKE_CFG, state.keystrokeCfg || {});
}

function keystrokeStatus() {
  const available = keystrokeAvailable();
  const elevated = isRunningElevated();
  const elevatedTargetBlocked = process.platform === 'win32' && !IS_WINE && available && !elevated;
  let hint = '';
  if (!available) {
    hint = 'Mesin keystroke tidak tersedia di perangkat ini. Test Play hanya berupa simulasi.';
  } else if (elevatedTargetBlocked) {
    hint = 'JekInteract berjalan TANPA hak Administrator. Windows memblokir keystroke ke aplikasi yang dijalankan sebagai Administrator (contoh: Roblox "Run as administrator"). Klik "Jalankan sebagai Administrator" di Pengaturan, atau jalankan Roblox tanpa administrator.';
  } else {
    const cfg = keystrokeConfig();
    hint = cfg.autoFocus && cfg.target
      ? 'Mesin keystroke aktif. Jendela "' + cfg.target + '" akan difokuskan otomatis sebelum tombol dikirim.'
      : 'Mesin keystroke aktif. Pastikan jendela target (Roblox/game) sedang fokus saat event TikTok masuk.';
  }
  return {
    available,
    platform: process.platform,
    wine: IS_WINE,
    elevated,
    nutjs: !!(nutKeyboard && nutKey),
    powershell: process.platform === 'win32' && !IS_WINE,
    driver: !!INTERCEPTION_DLL,
    elevatedTargetBlocked,
    config: keystrokeConfig(),
    hint
  };
}

let _warnedElevation = false;
function warnElevationOnce() {
  if (_warnedElevation) return;
  _warnedElevation = true;
  console.warn('[keystroke] ' + keystrokeStatus().hint);
}

/** Matikan helper PowerShell saat aplikasi ditutup supaya tidak ada proses yatim. */
function shutdownKeystrokeHelper() {
  try { if (psProc && psProc.stdin) psProc.stdin.write('QUIT\n'); } catch (_) {}
  try { if (psProc && !psProc.killed) psProc.kill(); } catch (_) {}
  psProc = null;
  psOutBuf = '';
}

/* ---- Backend driver keyboard (Interception) ------------------------------ */
/* Kalau interception.dll dan driver-nya tersedia, tombol dikirim lewat driver
   filter keyboard. Windows/app melihatnya seperti tombol keyboard fisik.
   Kalau tidak tersedia, kode tetap memakai jalur PowerShell lama. */
const INTERCEPTION_DLL = (() => {
  if (process.platform !== 'win32' || IS_WINE) return null;
  if (process.env.JEK_INTERCEPTION_DLL && fs.existsSync(process.env.JEK_INTERCEPTION_DLL)) {
    return process.env.JEK_INTERCEPTION_DLL;
  }
  const roots = [
    ROOT,
    path.join(ROOT, 'resources'),
    process.resourcesPath ? path.join(process.resourcesPath, 'interception') : '',
    process.resourcesPath || ''
  ].filter(Boolean);
  const walk = (dir, depth) => {
    if (depth > 5) return null;
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isFile() && ent.name.toLowerCase() === 'interception.dll') return p;
        if (ent.isDirectory()) {
          const hit = walk(p, depth + 1);
          if (hit) return hit;
        }
      }
    } catch (_) {}
    return null;
  };
  for (const root of roots) {
    const hit = walk(root, 0);
    if (hit) return hit;
  }
  return null;
})();

function driverScript() {
  const dll = INTERCEPTION_DLL.replace(/\\/g, '\\\\');
  return `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
namespace JekInterception {
  [StructLayout(LayoutKind.Sequential, Size=20)]
  public struct Stroke { public ushort code; public ushort state; public uint information; }
  public static class Lib {
    [DllImport("${dll}", CallingConvention=CallingConvention.Cdecl)] public static extern IntPtr interception_create_context();
    [DllImport("${dll}", CallingConvention=CallingConvention.Cdecl)] public static extern void interception_destroy_context(IntPtr ctx);
    [DllImport("${dll}", CallingConvention=CallingConvention.Cdecl)] public static extern int interception_send(IntPtr ctx, int device, ref Stroke stroke, uint nstroke);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  }
}
'@
Add-Type -TypeDefinition $src | Out-Null
$ctx = [JekInterception.Lib]::interception_create_context()
if ($ctx -eq [IntPtr]::Zero) { [Console]::Out.WriteLine('ERR context gagal'); exit 1 }
# Sengaja TIDAK memanggil interception_set_filter: filter menyuruh driver menahan
# semua ketukan keyboard fisik untuk dibaca lewat interception_receive(). Karena
# helper ini hanya menyuntik (interception_send) dan tidak pernah membaca, filter
# akan membuat keyboard fisik user mati. Tanpa filter, ketukan fisik lewat normal
# dan suntikan tetap masuk ke sistem sebagai input keyboard asli.
$extended = @(0x25,0x26,0x27,0x28,0x2C,0x2D,0x2E,0x2F,0x6B,0x6F,0x5B,0x5C,0x5D)
function Send-Stroke([int]$vk, [int]$state) {
  $scan = [JekInterception.Lib]::MapVirtualKey([uint32]$vk, 0)
  $s = New-Object JekInterception.Stroke
  $s.code = [uint16]$scan
  $s.state = [uint16]$state
  $s.information = 0
  if ($extended -contains $vk) { $s.state = $s.state -bor 2 }
  for ($d = 1; $d -le 10; $d++) {
    $n = [JekInterception.Lib]::interception_send($ctx, $d, [ref]$s, 1)
    if ($n -gt 0) { return $true }
  }
  return $false
}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'QUIT') { break }
  try {
    foreach ($tok in $line.Split(';')) {
      if ($tok.Length -lt 2) { continue }
      $op = $tok.Substring(0,1)
      $vk = [Convert]::ToInt32($tok.Substring(1), 16)
      $state = if ($op -eq 'U') { 1 } else { 0 }
      if (-not (Send-Stroke $vk $state)) { throw "gagal kirim VK $vk" }
      if ($op -eq 'D') { Start-Sleep -Milliseconds ${KEY_HOLD_MS} } else { Start-Sleep -Milliseconds 12 }
    }
    [Console]::Out.WriteLine('OK')
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
[JekInterception.Lib]::interception_destroy_context($ctx)
`;
}

let drvProc = null;
let drvFailed = false;
let drvOutBuf = '';
const drvQueue = [];

function canUseDriver() {
  return !!INTERCEPTION_DLL && process.platform === 'win32' && !IS_WINE && !drvFailed;
}

function ensureDriverHelper() {
  if (!canUseDriver()) return null;
  if (drvProc && !drvProc.killed) return drvProc;
  drvFailed = false;
  let proc;
  try {
    proc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(driverScript(), 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    drvFailed = true;
    console.warn('[keystroke-driver] gagal spawn PowerShell: ' + e.message);
    return null;
  }
  drvProc = proc;
  proc.stdout.on('data', (d) => {
    drvOutBuf += d.toString();
    let idx;
    while ((idx = drvOutBuf.indexOf('\n')) >= 0) {
      const line = drvOutBuf.slice(0, idx).trim();
      drvOutBuf = drvOutBuf.slice(idx + 1);
      if (!line || line === 'READY') continue;
      const job = drvQueue.shift();
      if (!job) continue;
      clearTimeout(job.timer);
      if (line.indexOf('ERR') === 0) job.reject(new Error(line.slice(3).trim()));
      else job.resolve();
    }
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.warn('[keystroke-driver] ps: ' + s);
  });
  proc.on('error', (e) => {
    drvFailed = true;
    drvProc = null;
    console.warn('[keystroke-driver] helper error: ' + e.message);
    while (drvQueue.length) { const j = drvQueue.shift(); clearTimeout(j.timer); j.reject(e); }
  });
  proc.on('exit', (code) => {
    if (drvProc === proc) drvProc = null;
    if (code !== 0 && code !== null) drvFailed = true;
    console.log('[keystroke-driver] helper berhenti (exit ' + code + ')');
    while (drvQueue.length) { const j = drvQueue.shift(); clearTimeout(j.timer); j.reject(new Error('helper driver berhenti')); }
  });
  console.log('[keystroke-driver] helper dimulai (' + INTERCEPTION_DLL + ')');
  return proc;
}

function driverFireSeq(seq) {
  return new Promise((resolve, reject) => {
    const proc = ensureDriverHelper();
    if (!proc || !proc.stdin || !proc.stdin.writable) {
      return reject(new Error('helper driver tidak tersedia'));
    }
    const job = { resolve, reject, timer: null };
    job.timer = setTimeout(() => {
      const i = drvQueue.indexOf(job);
      if (i >= 0) drvQueue.splice(i, 1);
      reject(new Error('timeout menunggu helper driver'));
    }, 5000);
    drvQueue.push(job);
    try { proc.stdin.write(seq.join(';') + '\n'); }
    catch (e) { clearTimeout(job.timer); reject(e); }
  });
}

async function driverFireLine(line) {
  const parts = line.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return;
  for (const p of parts) {
    if (VK_MAP[p] == null) throw new Error('Key tidak dikenal: ' + p);
  }
  const mods = parts.filter((p) => MOD_TOKENS.has(p));
  const keys = parts.filter((p) => !MOD_TOKENS.has(p));
  const seq = [];
  mods.forEach((m) => seq.push('D' + VK_MAP[m].toString(16)));
  keys.forEach((k) => seq.push('D' + VK_MAP[k].toString(16)));
  [...keys].reverse().forEach((k) => seq.push('U' + VK_MAP[k].toString(16)));
  [...mods].reverse().forEach((m) => seq.push('U' + VK_MAP[m].toString(16)));
  return driverFireSeq(seq);
}

function shutdownDriverHelper() {
  try { if (drvProc && drvProc.stdin) drvProc.stdin.write('QUIT\n'); } catch (_) {}
  try { if (drvProc && !drvProc.killed) drvProc.kill(); } catch (_) {}
  drvProc = null;
  drvOutBuf = '';
}

/**
 * Eksekusi satu baris keystroke. Format: "CTRL W" atau "SHIFT U" dll.
 * Mengembalikan Promise.
 */
async function execKeystrokeLine(line) {
  // Jalur 0: driver keyboard fisik (Interception) kalau tersedia
  if (canUseDriver()) {
    try {
      return await driverFireLine(line);
    } catch (e) {
      console.warn('[keystroke-driver] gagal, fallback ke helper lama: ' + e.message);
      drvFailed = true;
    }
  }

  // Jalur 1: nut.js (kalau terpasang)
  if (nutKeyboard && nutKey) {
    const parts = line.trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (!parts.length) return;

    const mods = parts.filter((p) => MOD_TOKENS.has(p));
    const keys = parts.filter((p) => !MOD_TOKENS.has(p));

    // Validasi semua key ada di map
    for (const p of parts) {
      if (!NUT_KEY_MAP[p]) throw new Error('Key tidak dikenal: ' + p);
    }

    // Tekan modifier dulu, lalu key utama, lalu lepas semua
    const modKeys  = mods.map((m) => nutKey[NUT_KEY_MAP[m]]);
    const mainKeys = keys.map((k) => nutKey[NUT_KEY_MAP[k]]);

    // nutKeyboard.pressKey(...keys) menekan sekaligus, releaseKey melepas
    const allKeys = [...modKeys, ...mainKeys];
    await nutKeyboard.pressKey(...allKeys);
    await new Promise((r) => setTimeout(r, KEY_HOLD_MS));
    await nutKeyboard.releaseKey(...allKeys.reverse());
    return;
  }

  // Jalur 2: Windows asli → helper PowerShell (keybd_event)
  if (process.platform === 'win32' && !IS_WINE) {
    return psFireLine(line);
  }

  throw new Error('Mesin keystroke tidak tersedia di platform ini');
}

/**
 * Eksekusi semua baris keystroke secara berurutan dengan jeda 50ms.
 * Dipanggil dari runActivities() saat interaction.triggers.keystroke aktif.
 */
async function fireKeystrokes(lines) {
  if (process.platform === 'win32' && !IS_WINE && !isRunningElevated()) warnElevationOnce();

  // Keystroke dikirim ke jendela depan. Pastikan jendela target sudah di depan
  // SEBELUM tombol ditekan — kalau tidak, tombol masuk ke browser/dashboard.
  const cfg = keystrokeConfig();
  if (process.platform === 'win32' && !IS_WINE && cfg.autoFocus && cfg.target) {
    try {
      await psFocus(cfg.target);
      if (cfg.focusDelayMs > 0) await new Promise((r) => setTimeout(r, cfg.focusDelayMs));
    } catch (e) {
      // Jangan kirim tombol ke jendela yang salah (mis. CTRL+W menutup tab browser).
      console.warn('[keystroke] jendela "' + cfg.target + '" tidak bisa difokuskan, keystroke dibatalkan: ' + e.message);
      return false;
    }
  }

  for (const line of lines) {
    try {
      await execKeystrokeLine(line);
      await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      console.warn('[keystroke] gagal eksekusi "' + line + '":', e.message);
    }
  }
  return true;
}

function tiktokCleanup() {
  tiktokConnectedAt = 0;
  if (liveSession) finishLiveSession(true);
  if (tiktokClient) {
    try { tiktokClient.disconnect(); } catch (_) {}
    tiktokClient = null;
  }
}

async function tiktokConnect(req, res) {
  const Connector = await loadTikTokConnector();
  if (!Connector) {
    return json(res, 501, {
      ok: false,
      error: 'Library tiktok-live-connector tidak tersedia.' + (tikTokImportError ? ' Detail: ' + tikTokImportError : ''),
      importError: tikTokImportError
    });
  }

  const body = await readJSON(req);
  const raw = String(body.username || '').trim().replace(/^@/, '');
  if (!raw) return json(res, 400, { ok: false, error: 'Username wajib diisi.' });
  if (!/^[A-Za-z0-9._]{2,30}$/.test(raw)) return json(res, 400, { ok: false, error: 'Username tidak valid.' });

  // Putus koneksi lama dulu
  tiktokCleanup();

  tiktokUser = raw;
  tiktokState = 'connecting';
  tiktokError = '';
  tiktokConnectedAt = 0;
  startLiveSession(raw);
  broadcastTiktok('connecting', { username: raw });
  json(res, 200, { ok: true, username: raw }); // jawab request segera, connect async

  const client = new Connector(raw, {});
  tiktokClient = client;

  // — Event dasar —
  // v2.5: 'join' berubah menjadi 'member' (WebcastMemberMessage)
  const TIKTOK_EVENTS = ['chat', 'gift', 'like', 'follow', 'share', 'member', 'join', 'subscribe', 'roomUser', 'disconnected', 'error'];
  TIKTOK_EVENTS.forEach((ev) => {
    client.on(ev, (data) => {
      if (ev === 'disconnected') {
        if (tiktokClient === client) {
          finishLiveSession(true);
          tiktokState = 'offline';
          tiktokConnectedAt = 0;
          tiktokUser = '';
          tiktokClient = null;
          resetLiveAccumulators();
        }
        broadcastTiktok('disconnected', { username: raw });
        broadcastTiktokState();
        return;
      }
      if (ev === 'error') {
        let msg = 'unknown error';
        if (data && data.message) msg = String(data.message);
        else if (data instanceof Error) msg = data.message;
        else if (typeof data === 'string') msg = data;
        else if (data) {
          try { msg = JSON.stringify(data); } catch (_) { msg = String(data); }
        }
        console.warn('[tiktok] error:', msg);
        if (tiktokClient === client) {
          if (tiktokState === 'online') finishLiveSession(true);
          tiktokError = msg;
          tiktokState = 'error';
          tiktokConnectedAt = 0;
        }
        broadcastTiktok('error', { username: raw, message: msg });
        broadcastTiktokState();
        return;
      }
      // Akumulasi statistik sesi live (dipakai Dashboard & Analytics)
      trackLiveEvent(ev, data || {});
      // Akumulasi leaderboard & goals
      if (ev === 'like') { processLikeEvent(data || {}); processGoalLike(data || {}); }
      if (ev === 'gift') { processGiftEvent(data || {}); processGoalCoin(data || {}); }
      if (ev === 'share') processGoalShare();
      if (ev === 'follow') processGoalFollow();
      // Komentar lama yang dikirim ulang TikTok saat connect bukan komentar baru.
      // Flag ini dipakai TTS, musik (!play/!skip), Subathon, dan aktivitas.
      const afterConnect = ev === 'chat' ? chatAfterConnect(data || {}) : true;
      // Subathon — tambah waktu timer dari TikTok events
      if (ev === 'like')      processSubathonEvent('like', data || {});
      if (ev === 'gift')      processSubathonEvent('coin', data || {});
      if (ev === 'follow')    processSubathonEvent('follow', data || {});
      if (ev === 'share')     processSubathonEvent('share', data || {});
      if (ev === 'chat' && afterConnect) processSubathonEvent('comment', data || {});
      if (ev === 'subscribe') processSubathonEvent('subscribe', data || {});
      if (ev === 'member')    processSubathonEvent('follow', data || {}); // v2.5 join as member
      // Join Alert — kartu overlay saat penonton join (sudah termasuk filter who)
      if (ev === 'member' || ev === 'join') processJoinAlert(data || {});
      // Follow Alert — kartu overlay saat ada yang follow live yang terhubung
      if (ev === 'follow') processFollowAlert(data || {});
      if (ev === 'chat' && afterConnect) processMusicCommand(data || {});
      // Jalankan aktivitas yang cocok
      if (ev !== 'chat' || afterConnect) runActivities(ev, data || {});
      // Kirim event ke semua dashboard client via SSE.
      broadcastTiktok(ev, {
        username: raw,
        data,
        afterConnect: ev === 'chat' ? afterConnect : undefined
      });
      // Kirim komentar live ke overlay chat
      if (ev === 'chat') broadcastChatToOverlay({ username: raw, data });
    });
  });

  try {
    const connState = await client.connect();
    if (tiktokClient !== client) return; // sudah di-disconnect saat proses
    applyRoomMeta((connState && connState.roomInfo) || client.roomInfo);
    tiktokState = 'online';
    tiktokConnectedAt = Date.now();
    tiktokError = '';
    broadcastTiktok('connected', { username: raw });
    broadcastTiktokState();
    console.log('[tiktok] terhubung ke @' + raw);
  } catch (e) {
    abortLiveSession();
    let msg = 'unknown error';
    if (e && e.message) msg = String(e.message);
    else if (typeof e === 'string') msg = e;
    else if (e) { try { msg = JSON.stringify(e); } catch (_) { msg = String(e); } }
    console.warn('[tiktok] gagal connect ke @' + raw + ':', msg);
    if (tiktokClient === client) {
      tiktokState = 'error';
      tiktokConnectedAt = 0;
      tiktokError = msg;
      tiktokClient = null;
    }
    broadcastTiktok('error', { username: raw, message: msg });
    broadcastTiktokState();
  }
}

/** Bersihkan data akumulasi live saat koneksi berakhir (manual maupun otomatis). */
function resetLiveAccumulators() {
  likeBoard.clear();
  broadcastLikeLeaderboard();
  giftBoard.clear();
  broadcastGiftLeaderboard();
  resetGoalCounters();
}

function tiktokDisconnect(res) {
  const u = tiktokUser;
  tiktokCleanup();
  tiktokState = 'offline';
  tiktokUser = '';
  tiktokError = '';
  resetLiveAccumulators();
  broadcastTiktok('disconnected', { username: u, manual: true });
  broadcastTiktokState();
  return json(res, 200, { ok: true });
}

/* ------------------------------------------------------------------ */
/* OBS WebSocket Client — integrasi OBS via WebSocket protocol v5      */
/* ------------------------------------------------------------------ */

/**
 * State koneksi OBS.
 * status: 'offline' | 'connecting' | 'online' | 'error'
 */
const obsState = {
  status: 'offline',
  ip: '127.0.0.1',
  port: '4455',
  password: '',
  error: '',
  scenes: [],         // ['Gameplay', 'Just Chatting', ...]
  sources: {},        // { 'Gameplay': ['Webcam', 'Alert'], ... }
  currentScene: ''
};

let obsWs = null;             // WebSocket aktif ke OBS
let obsReqId = 0;             // counter request-id OBS
const obsCallbacks = {};      // reqId → { resolve, reject }
let obsReconnTimer = null;
let obsManualDisconnect = false;

function obsStatusPayload() {
  return {
    status:       obsState.status,
    ip:           obsState.ip,
    port:         obsState.port,
    error:        obsState.error,
    scenes:       obsState.scenes,
    sources:      obsState.sources,
    currentScene: obsState.currentScene
  };
}

function broadcastObsState() {
  broadcast('obsstate', obsStatusPayload(), (c) => c.role === 'dashboard');
}

/** Kirim request OBS WebSocket v5 dan tunggu response-nya. */
function obsSend(requestType, requestData) {
  return new Promise((resolve, reject) => {
    if (!obsWs || obsWs.readyState !== NodeWebSocket.OPEN) {
      return reject(new Error('OBS tidak terhubung'));
    }
    const id = String(++obsReqId);
    obsCallbacks[id] = { resolve, reject };
    const msg = { op: 6, d: { requestType, requestId: id } };
    if (requestData) msg.d.requestData = requestData;
    obsWs.send(JSON.stringify(msg));
    // timeout 5 detik
    setTimeout(() => {
      if (obsCallbacks[id]) {
        delete obsCallbacks[id];
        reject(new Error('Request OBS timeout: ' + requestType));
      }
    }, 5000);
  });
}

/** Muat daftar scene dari OBS. */
async function obsLoadScenes() {
  try {
    const r = await obsSend('GetSceneList');
    if (r && r.responseData) {
      const scenes = (r.responseData.scenes || []).map((s) => s.sceneName || s.name || '').filter(Boolean);
      scenes.reverse(); // OBS mengirim dari bawah ke atas
      obsState.scenes = scenes;
      obsState.currentScene = r.responseData.currentProgramSceneName || scenes[0] || '';
    }
  } catch (e) {
    console.warn('[obs] gagal muat scenes:', e.message);
  }
}

/** Muat daftar source untuk satu scene. */
async function obsLoadSources(sceneName) {
  if (!sceneName) return;
  try {
    const r = await obsSend('GetSceneItemList', { sceneName });
    if (r && r.responseData) {
      const sources = (r.responseData.sceneItems || [])
        .map((si) => si.sourceName || (si.source && si.source.name) || '')
        .filter(Boolean);
      obsState.sources[sceneName] = sources;
    }
  } catch (e) {
    console.warn('[obs] gagal muat sources scene "' + sceneName + '":', e.message);
  }
}

/** Pindah scene OBS. Jika mode=revert, kembalikan ke scene sebelumnya setelah durasi detik. */
async function obsSwitchScene(sceneName, mode, durationSec) {
  if (obsState.status !== 'online') return;
  try {
    const prevScene = obsState.currentScene;
    await obsSend('SetCurrentProgramScene', { sceneName });
    obsState.currentScene = sceneName;
    console.log('[obs] pindah scene → ' + sceneName);
    if (mode === 'revert' && prevScene && prevScene !== sceneName && durationSec > 0) {
      setTimeout(async () => {
        try {
          if (obsState.status === 'online') {
            await obsSend('SetCurrentProgramScene', { sceneName: prevScene });
            obsState.currentScene = prevScene;
            console.log('[obs] revert scene → ' + prevScene);
          }
        } catch (e2) {
          console.warn('[obs] gagal revert scene:', e2.message);
        }
      }, durationSec * 1000);
    }
  } catch (e) {
    console.warn('[obs] gagal pindah scene:', e.message);
  }
}

/**
 * Aktifkan/matikan source di OBS.
 * @param {string} sceneName - Nama scene tempat source berada.
 * @param {string} sourceName - Nama source.
 * @param {boolean} visible - true = tampilkan, false = sembunyikan.
 */
async function obsSetSourceVisible(sceneName, sourceName, visible) {
  if (obsState.status !== 'online') return;
  try {
    // Cari sceneItemId dulu via GetSceneItemId
    const idRes = await obsSend('GetSceneItemId', { sceneName, sourceName });
    const sceneItemId = idRes && idRes.responseData ? idRes.responseData.sceneItemId : null;
    if (sceneItemId == null) throw new Error('sceneItemId tidak ditemukan untuk "' + sourceName + '"');
    await obsSend('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: visible });
    console.log('[obs] source "' + sourceName + '" di scene "' + sceneName + '" → ' + (visible ? 'tampil' : 'sembunyi'));
  } catch (e) {
    console.warn('[obs] gagal set source visible:', e.message);
  }
}

function obsDisconnect() {
  obsManualDisconnect = true;
  if (obsReconnTimer) { clearTimeout(obsReconnTimer); obsReconnTimer = null; }
  if (obsWs) {
    try { obsWs.close(); } catch (_) {}
    obsWs = null;
  }
  obsState.status = 'offline';
  obsState.error = '';
  broadcastObsState();
}

function obsConnect(ip, port, password) {
  // Simpan config
  obsState.ip       = ip;
  obsState.port     = port;
  obsState.password = password;
  obsManualDisconnect = false;

  // Putus koneksi lama
  if (obsReconnTimer) { clearTimeout(obsReconnTimer); obsReconnTimer = null; }
  if (obsWs) { try { obsWs.close(); } catch (_) {} obsWs = null; }

  obsState.status = 'connecting';
  obsState.error  = '';
  obsState.scenes = [];
  obsState.sources = {};
  obsState.currentScene = '';
  broadcastObsState();

  const url = 'ws://' + ip + ':' + port;
  let ws;
  try {
    ws = new NodeWebSocket(url);
  } catch (e) {
    obsState.status = 'error';
    obsState.error  = e.message;
    broadcastObsState();
    return;
  }
  obsWs = ws;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    const op = msg.op;
    const d  = msg.d;

    // op 0 = Hello (server kirim info autentikasi)
    if (op === 0) {
      if (d && d.authentication) {
        // Autentikasi diperlukan
        if (!password) {
          obsState.status = 'error';
          obsState.error  = 'OBS memerlukan password. Isi password di halaman Connection.';
          if (obsWs === ws) obsWs = null;
          ws.close();
          broadcastObsState();
          return;
        }
        // Hitung authentication string: base64(sha256(base64(sha256(password + salt)) + challenge))
        const crypto = require('crypto');
        const salt     = d.authentication.salt;
        const challenge = d.authentication.challenge;
        const secretBase = password + salt;
        const secretHash = crypto.createHash('sha256').update(secretBase).digest('base64');
        const authInput  = secretHash + challenge;
        const authHash   = crypto.createHash('sha256').update(authInput).digest('base64');
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication: authHash, eventSubscriptions: 1 | 4 } }));
      } else {
        // Tidak perlu autentikasi
        ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 1 | 4 } }));
      }
      return;
    }

    // op 2 = Identified (koneksi berhasil)
    if (op === 2) {
      obsState.status = 'online';
      obsState.error  = '';
      broadcastObsState();
      console.log('[obs] terhubung ke ws://' + ip + ':' + port);
      // Muat scenes dan sources secara async
      await obsLoadScenes();
      for (const sc of obsState.scenes) await obsLoadSources(sc);
      broadcastObsState(); // kirim ulang dengan data scenes/sources
      return;
    }

    // op 7 = RequestResponse
    if (op === 7) {
      const id = d && d.requestId;
      if (id && obsCallbacks[id]) {
        const cb = obsCallbacks[id];
        delete obsCallbacks[id];
        if (d.requestStatus && d.requestStatus.result === false) {
          cb.reject(new Error(d.requestStatus.comment || 'OBS request gagal'));
        } else {
          cb.resolve(d);
        }
      }
      return;
    }

    // op 5 = Event
    if (op === 5) {
      const evType = d && d.eventType;
      if (evType === 'CurrentProgramSceneChanged' && d.eventData) {
        obsState.currentScene = d.eventData.sceneName || '';
        broadcastObsState();
      }
      if (evType === 'SceneListChanged') {
        await obsLoadScenes();
        for (const sc of obsState.scenes) await obsLoadSources(sc);
        broadcastObsState();
      }
      if (evType === 'SceneItemCreated' || evType === 'SceneItemRemoved') {
        const sc = d.eventData && d.eventData.sceneName;
        if (sc) { await obsLoadSources(sc); broadcastObsState(); }
      }
    }
  });

  ws.on('close', () => {
    if (obsWs !== ws) return;
    obsWs = null;
    // Reject semua pending callbacks
    Object.keys(obsCallbacks).forEach((id) => {
      obsCallbacks[id].reject(new Error('OBS WebSocket ditutup'));
      delete obsCallbacks[id];
    });
    if (obsManualDisconnect) return;
    if (obsState.status === 'online') {
      obsState.status = 'error';
      obsState.error  = 'Koneksi ke OBS terputus. Mencoba kembali…';
      broadcastObsState();
    }
    // Auto-reconnect 5 detik
    obsReconnTimer = setTimeout(() => {
      obsReconnTimer = null;
      if (!obsManualDisconnect) obsConnect(obsState.ip, obsState.port, obsState.password);
    }, 5000);
  });

  ws.on('error', (e) => {
    if (obsWs !== ws) return;
    console.warn('[obs] error WebSocket:', e.message);
    if (obsState.status === 'connecting') {
      obsState.status = 'error';
      obsState.error  = 'Tidak bisa terhubung ke OBS: ' + e.message;
      broadcastObsState();
    }
  });
}

/* ------------------------------------------------------------------ */
/* YouTube Music — antrian request lagu dari komentar TikTok           */
/* ------------------------------------------------------------------ */

/**
 * Antrian lagu: [{ uid, user, title, ytId, dur, addedAt }]
 * dur = durasi detik (diisi oleh client saat lagu selesai load di iframe, awalnya 0)
 * nowPlaying = item yang sedang diputar atau null
 * elapsed = detik yang sudah berjalan pada lagu saat ini
 */
const musicQueue = [];
let musicNowPlaying = null; // { uid, user, title, ytId, dur, addedAt, startedAt }
let musicElapsed = 0;
let musicPaused = false;
let musicVolume = 100; // 0-100, dipakai semua player YouTube (dashboard + overlay)
let musicSeqId = 0;
let musicTickTimer = null;
let musicProgressAt = 0; // laporan terakhir dari player dashboard (sumber audio)

/** Konfigurasi musik — diambil dari state.music (disimpan dashboard). */
function getMusicCfg() {
  const s = state.music || {};
  return {
    playOn:   s.playOn  !== false,
    skipOn:   s.skipOn  !== false,
    playWho:  s.playWho  || 'all',
    skipWho:  s.skipWho  || 'all'
  };
}

/** Volume default diambil dari state.music.volume bila tersedia. */
(function initMusicVolume() {
  const v = (state.music && state.music.volume);
  if (typeof v === 'number') {
    musicVolume = clamp(Math.round(v), 0, 100);
  } else if (typeof v === 'string' && v.trim() !== '') {
    musicVolume = clamp(Math.round(Number(v) || 0), 0, 100);
  }
})();

function musicStatePayload() {
  return {
    nowPlaying: musicNowPlaying,
    elapsed:    musicElapsed,
    paused:     musicPaused,
    volume:     musicVolume,
    queue:      musicQueue.slice()
  };
}

function broadcastMusicState() {
  broadcast('musicstate', musicStatePayload());
}

/** Mulai tick setiap detik untuk update elapsed saat lagu diputar. */
function musicTickStart() {
  if (musicTickTimer) return;
  musicTickTimer = setInterval(() => {
    if (!musicNowPlaying) { musicTickStop(); return; }
    // Jeda: elapsed dibekukan supaya tidak auto-skip saat lagu dipause.
    // Status pause sudah disiarkan sekali oleh /api/music/control.
    if (musicPaused) return;
    // Player dashboard mengirim getCurrentTime() tiap detik. Sebelum laporan
    // pertama (player belum PLAYING) detik TIDAK boleh jalan, dan selama
    // laporan masih segar tick cadangan tidak boleh menimpa posisi asli video.
    if (!musicProgressAt || Date.now() - musicProgressAt < 3000) return;
    musicElapsed += 1;
    // Jika durasi diketahui dan sudah habis, skip otomatis
    if (musicNowPlaying.dur > 0 && musicElapsed >= musicNowPlaying.dur) {
      musicSkip(null, true); // auto-skip
    } else {
      broadcastMusicState();
    }
  }, 1000);
}

function musicTickStop() {
  if (musicTickTimer) { clearInterval(musicTickTimer); musicTickTimer = null; }
}

/** Mulai memutar lagu berikutnya di antrian (jika ada). */
function musicPlayNext() {
  if (musicNowPlaying) return; // sudah ada yang diputar
  if (!musicQueue.length) {
    broadcastMusicState();
    return;
  }
  const item = musicQueue.shift();
  musicNowPlaying = Object.assign({}, item, { startedAt: Date.now() });
  musicElapsed = 0;
  musicProgressAt = 0;
  musicPaused = false; // lagu baru selalu mulai diputar (tidak ikut status jeda sebelumnya)
  broadcastMusicState();
  musicTickStart();
  console.log('[music] sekarang memutar: "' + item.title + '" req @' + item.user);

  // Jika belum punya ytId, cari otomatis di YouTube
  if (!musicNowPlaying.ytId) {
    const uid = musicNowPlaying.uid;
    console.log('[music] mencari ytId untuk: "' + item.title + '"');
    ytSearch(item.title).then((ytId) => {
      if (ytId) {
        musicSetYtId(uid, ytId);
        console.log('[music] ytId ditemukan: ' + ytId + ' untuk "' + item.title + '"');
      } else {
        console.warn('[music] ytId tidak ditemukan untuk: "' + item.title + '"');
      }
    }).catch((e) => {
      console.warn('[music] gagal cari YouTube:', e.message);
    });
  }
}

/** Tambah lagu ke antrian. Mengembalikan { ok, item } atau { ok: false, error }. */
function musicEnqueue(user, title, ytId) {
  const cfg = getMusicCfg();
  if (!cfg.playOn) return { ok: false, error: 'request lagu sedang dinonaktifkan' };
  // Batas antrian 50 lagu
  if (musicQueue.length >= 50) return { ok: false, error: 'antrian penuh' };
  const uid = 'mu_' + Date.now().toString(36) + '_' + (++musicSeqId);
  const item = { uid, user, title, ytId: ytId || '', dur: 0, addedAt: Date.now() };
  musicQueue.push(item);
  if (!musicNowPlaying) musicPlayNext();
  else broadcastMusicState();
  return { ok: true, item };
}

/** Skip lagu yang sedang diputar. autoSkip = true bila terpicu dari tick. */
function musicSkip(user, autoSkip) {
  if (!autoSkip) {
    const cfg = getMusicCfg();
    if (!cfg.skipOn) return { ok: false, error: '!skip sedang dinonaktifkan' };
  }
  if (!musicNowPlaying) return { ok: false, error: 'tidak ada lagu yang sedang diputar' };
  const prev = musicNowPlaying;
  musicNowPlaying = null;
  musicElapsed = 0;
  musicProgressAt = 0;
  musicTickStop();
  broadcast('musicskip', { skippedUid: prev.uid, by: user || null, auto: !!autoSkip });
  // Tunda sedikit agar overlay sempat menerima stop sebelum lagu berikutnya
  setTimeout(() => { musicPlayNext(); }, 600);
  return { ok: true };
}

/** Batalkan request (revoke). uid opsional — bila null, batalkan terakhir. */
function musicRevoke(user, titleOrNull) {
  if (!musicQueue.length) return { ok: false, error: 'antrian kosong' };
  let idx = -1;
  if (titleOrNull) {
    const q = titleOrNull.toLowerCase();
    idx = musicQueue.findIndex((s) => s.title.toLowerCase().includes(q));
    if (idx < 0) return { ok: false, error: 'judul tidak ditemukan di antrian' };
  } else {
    // Batalkan request terakhir milik user ini
    for (let i = musicQueue.length - 1; i >= 0; i--) {
      if (musicQueue[i].user === user) { idx = i; break; }
    }
    if (idx < 0) {
      // Tidak ada request milik user ini — batalkan paling akhir
      idx = musicQueue.length - 1;
    }
  }
  const removed = musicQueue.splice(idx, 1)[0];
  broadcastMusicState();
  return { ok: true, removed };
}

/**
 * Ekstrak YouTube video ID dari URL / string.
 * Mendukung: youtu.be/ID, youtube.com/watch?v=ID, youtube.com/shorts/ID, ID polos 11 karakter.
 */
function extractYtId(str) {
  if (!str) return '';
  // youtube.com/watch?v=
  let m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(str);
  if (m) return m[1];
  // youtu.be/
  m = /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(str);
  if (m) return m[1];
  // youtube.com/shorts/ atau /embed/
  m = /(?:shorts|embed)\/([A-Za-z0-9_-]{11})/.exec(str);
  if (m) return m[1];
  // ID polos 11 karakter
  if (/^[A-Za-z0-9_-]{11}$/.test(str.trim())) return str.trim();
  return '';
}

/**
 * Proses komentar TikTok untuk command musik.
 * Command: !play / !req / !skip / !revoke / !remove / !cancel / ;remove / ;cancel
 */
function processMusicCommand(data) {
  const cfg = getMusicCfg();
  const u = (data && data.user) ? data.user : data;
  if (!u) return;
  const text = String(data.content || data.comment || '').trim();
  if (!text) return;

  const uid = String(u.id || u.uniqueId || u.userId || '').trim();
  const username = String(u.nickname || uid || 'user').trim();
  const low = text.toLowerCase();

  // --- !play / !req ---
  if (cfg.playOn && (low.startsWith('!play ') || low.startsWith('!req '))) {
    if (!matchWho(cfg.playWho, data)) return;
    const arg = text.replace(/^!(?:play|req)\s+/i, '').trim();
    if (!arg) return;
    // Coba ekstrak ytId jika argumen mengandung URL YouTube
    const ytId = extractYtId(arg);
    // Title = arg aslinya (mungkin "Judul - Artist" atau URL)
    const title = ytId ? arg.replace(/https?:\/\/\S+/g, '').trim() || arg : arg;
    const result = musicEnqueue(username, title.slice(0, 120), ytId);
    if (result.ok) {
      console.log('[music] @' + username + ' request: "' + title + '"' + (ytId ? ' [' + ytId + ']' : ''));
    }
    return;
  }

  // --- !skip ---
  if (low === '!skip') {
    if (!cfg.skipOn) return;
    if (!matchWho(cfg.skipWho, data)) return;
    const r = musicSkip(username, false);
    if (r.ok) console.log('[music] @' + username + ' skip lagu');
    return;
  }

  // --- !revoke / !remove / !cancel / ;remove / ;cancel ---
  const isRevoke = /^[!;](revoke|remove|cancel)(\s|$)/i.test(text);
  if (isRevoke) {
    const arg = text.replace(/^[!;](?:revoke|remove|cancel)\s*/i, '').trim() || null;
    const r = musicRevoke(username, arg);
    if (r.ok) console.log('[music] @' + username + ' revoke: "' + (r.removed && r.removed.title) + '"');
    return;
  }
}

/** Update durasi lagu (kompatibilitas lama; sekarang durasi ikut /api/music/progress). */
function musicSetDuration(uid, dur) {
  if (musicNowPlaying && musicNowPlaying.uid === uid) {
    const wasFirstReport = musicNowPlaying.dur === 0;
    musicNowPlaying.dur = dur;
    // Pertama kali durasi dilaporkan = player YouTube baru mulai.
    // Reset elapsed ke 0 agar elapsed server selaras dengan posisi video yang sebenarnya.
    if (wasFirstReport) {
      musicElapsed = 0;
      broadcastMusicState();
    }
  }
}

/**
 * Terima posisi putar dari player dashboard (satu-satunya sumber audio).
 * Overlay tidak memutar YouTube; ia hanya menampilkan elapsed dari server,
 * jadi angka detik di dashboard dan overlay selalu sama.
 */
function musicSetProgress(uid, elapsed, dur) {
  if (!musicNowPlaying || String(uid || '') !== musicNowPlaying.uid) return;
  musicProgressAt = Date.now();
  const sec = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const d = Number.isFinite(dur) && dur > 0 ? dur : musicNowPlaying.dur;
  if (d > 0 && d !== musicNowPlaying.dur) musicNowPlaying.dur = d;
  musicElapsed = d > 0 ? Math.min(sec, d) : sec;
  if (d > 0 && musicElapsed >= d - 0.25) {
    musicSkip(null, true); // video selesai — lanjut ke antrean berikutnya
    return;
  }
  broadcastMusicState();
}

/** Update judul lagu yang sedang diputar dengan judul asli dari YouTube (dikirim dari player dashboard). */
function musicSetTitle(uid, title) {
  if (musicNowPlaying && musicNowPlaying.uid === uid && title) {
    musicNowPlaying.title = title;
    broadcastMusicState();
  }
}

/** Update ytId lagu yang sedang diputar (dikirim dari client setelah proses pencarian). */
function musicSetYtId(uid, ytId) {
  if (musicNowPlaying && musicNowPlaying.uid === uid && ytId) {
    musicNowPlaying.ytId = ytId;
    broadcastMusicState();
    console.log('[music] ytId di-set untuk uid=' + uid + ': ' + ytId);
    return;
  }
  // Cek juga di antrian
  const item = musicQueue.find((i) => i.uid === uid);
  if (item && ytId) {
    item.ytId = ytId;
    broadcastMusicState();
  }
}

/* ------------------------------------------------------------------ */
/* YouTube Search — cari video ID dari teks query tanpa API key        */
/* Menggunakan halaman hasil pencarian YouTube + parse ytInitialData   */
/* ------------------------------------------------------------------ */

/**
 * Cari video YouTube berdasarkan query teks.
 * Mengembalikan video ID (string 11 karakter) atau null.
 * Tidak memerlukan API key — scrape dari ytInitialData.
 */
function ytSearch(query) {
  return new Promise((resolve, reject) => {
    const path = '/results?search_query=' + encodeURIComponent(query) + '&sp=EgIQAQ%3D%3D'; // filter: video saja
    const options = {
      hostname: 'www.youtube.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        reject(new Error('YouTube redirect: ' + res.headers.location));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (raw.length < 1500000) raw += c; });
      res.on('end', () => {
        // Cari var ytInitialData = {...}; di HTML
        const m = /var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*(?:var |<\/script>)/.exec(raw);
        if (!m) {
          // Fallback: cari pola "videoId":"XXXXXXXXXXX" dari HTML mentah
          const vm = /"videoId":"([A-Za-z0-9_-]{11})"/.exec(raw);
          if (vm) { resolve(vm[1]); return; }
          reject(new Error('Tidak bisa parse hasil pencarian YouTube'));
          return;
        }
        try {
          const data = JSON.parse(m[1]);
          // Navigasi: contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents
          const items = data
            && data.contents
            && data.contents.twoColumnSearchResultsRenderer
            && data.contents.twoColumnSearchResultsRenderer.primaryContents
            && data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer
            && data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
          if (!items) {
            const vm = /"videoId":"([A-Za-z0-9_-]{11})"/.exec(raw);
            if (vm) { resolve(vm[1]); return; }
            resolve(null); return;
          }
          for (const section of items) {
            const contents = section && section.itemSectionRenderer && section.itemSectionRenderer.contents;
            if (!contents) continue;
            for (const item of contents) {
              const vr = item && item.videoRenderer;
              if (vr && vr.videoId && /^[A-Za-z0-9_-]{11}$/.test(vr.videoId)) {
                resolve(vr.videoId);
                return;
              }
            }
          }
          // Fallback ke regex
          const vm = /"videoId":"([A-Za-z0-9_-]{11})"/.exec(raw);
          resolve(vm ? vm[1] : null);
        } catch (_) {
          // JSON parse gagal — fallback regex
          const vm = /"videoId":"([A-Za-z0-9_-]{11})"/.exec(raw);
          resolve(vm ? vm[1] : null);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* Gifts TikTok — proxy + cache 1 jam dari streamtoearn.io             */
/* ------------------------------------------------------------------ */
let giftsCache = null;      // { ts, data }
const GIFTS_TTL = 3600000;  // 1 jam

function fetchGiftsRemote() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'streamtoearn.io', path: '/gifts?region=ID', method: 'GET',
        headers: { 'User-Agent': 'JekInteract/1 (Node.js)', Accept: 'text/html' }, timeout: 15000 },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve(parseGiftsHTML(raw)); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function parseGiftsHTML(html) {
  const gifts = [];
  // Struktur streamtoearn.io:
  //   <div class="gift" data-price="...">
  //     <img src="https://..." alt="Rose TikTok gift" ...>
  //     <p class="gift-name">Rose</p>
  //     <p class="gift-price">1 <img ...>
  //   </div>
  // Cari setiap blok yang diawali <div class="gift"
  const reBlock = /<div[^>]+class="gift"[^>]*>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = reBlock.exec(html)) !== null) {
    const block = m[1];
    // nama gift
    const nameM = /<p[^>]+class="gift-name"[^>]*>\s*([^<]+?)\s*<\/p>/i.exec(block);
    if (!nameM) continue;
    const name = nameM[1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
                         .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    // harga (angka pertama di dalam gift-price, sebelum tag <img)
    const priceM = /<p[^>]+class="gift-price"[^>]*>\s*(\d[\d,]*)/i.exec(block);
    const coins = priceM ? parseInt(priceM[1].replace(/,/g, ''), 10) : 0;
    // gambar (src pertama dalam blok, skip logo-coin.png)
    const imgRe = /src="([^"]+)"/gi;
    let image = null;
    let imgM;
    while ((imgM = imgRe.exec(block)) !== null) {
      if (!imgM[1].includes('logo-coin')) { image = imgM[1]; break; }
    }
    gifts.push({ name: name.trim(), coins, image });
  }
  if (gifts.length) return gifts;

  throw new Error('Tidak ada data gift yang berhasil di-parse dari halaman streamtoearn.io');
}

/* ------------------------------------------------------------------ */
/* Text-to-Speech (Microsoft Edge Read Aloud)                          */
/* GET /api/tts?text=...&lang=id&gender=female&speed=50                */
/* MP3 dibuat di server agar browser memutar lewat <audio> — audio     */
/* tetap berbunyi saat tab/app lain aktif, sama seperti audio trigger. */
/* ------------------------------------------------------------------ */
let MsEdgeTTS = null;
let EDGE_TTS_OUTPUT = null;
try {
  const edgeTts = require('msedge-tts');
  MsEdgeTTS = edgeTts.MsEdgeTTS;
  EDGE_TTS_OUTPUT = edgeTts.OUTPUT_FORMAT;
} catch (_) { /* paket belum terpasang — TTS memakai suara browser */ }

const TTS_VOICE_MAP = {
  id: { female: 'id-ID-GadisNeural', male: 'id-ID-ArdiNeural' },
  en: { female: 'en-US-AriaNeural', male: 'en-US-GuyNeural' }
};
const TTS_MAX_CHARS = 500;
const TTS_CACHE_MAX = 60;
const ttsCache = new Map();

function ttsVoiceOf(lang, gender) {
  const l = lang === 'en' ? 'en' : 'id';
  const g = gender === 'male' ? 'male' : 'female';
  return TTS_VOICE_MAP[l][g];
}

function ttsRateOf(speed) {
  const s = Math.max(1, Math.min(100, Number(speed) || 50));
  return Math.max(0.5, Math.min(2, 0.6 + (s / 100) * 0.8));
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  }[c]));
}

async function synthesizeSpeech(text, voice, rate) {
  const key = voice + '|' + rate.toFixed(2) + '|' + text;
  const cached = ttsCache.get(key);
  if (cached) return cached;

  const tts = new MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 15000 });
  try {
    await tts.setMetadata(voice, EDGE_TTS_OUTPUT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = await tts.toStream(escapeXml(text), { rate, pitch: '+0Hz' });
    const chunks = [];

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => done(new Error('timeout')), 15000);
      function done(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      }
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', () => done());
      audioStream.on('close', () => done());
      audioStream.on('error', (e) => done(e));
    });

    if (!chunks.length) throw new Error('audio kosong');
    const buf = Buffer.concat(chunks);
    ttsCache.set(key, buf);
    while (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
    return buf;
  } finally {
    try { tts.close(); } catch (_) {}
  }
}

async function serveTTS(res, q) {
  if (!MsEdgeTTS) {
    return json(res, 503, { ok: false, error: 'Mesin TTS server tidak tersedia.' });
  }
  const text = String(q.get('text') || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TTS_MAX_CHARS);
  if (!text) return json(res, 400, { ok: false, error: 'Teks kosong.' });

  const voice = ttsVoiceOf(q.get('lang'), q.get('gender'));
  const rate = ttsRateOf(q.get('speed'));
  try {
    const buf = await synthesizeSpeech(text, voice, rate);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store, max-age=0'
    });
    res.end(buf);
  } catch (e) {
    console.warn('[tts] gagal membuat suara:', e.message);
    return json(res, 502, { ok: false, error: 'Gagal membuat suara: ' + e.message });
  }
}

async function serveGifts(res) {
  const now = Date.now();
  if (giftsCache && now - giftsCache.ts < GIFTS_TTL) {
    return json(res, 200, { ok: true, source: 'cache', gifts: giftsCache.data });
  }
  try {
    const gifts = await fetchGiftsRemote();
    giftsCache = { ts: now, data: gifts };
    return json(res, 200, { ok: true, source: 'live', gifts });
  } catch (e) {
    console.warn('[gifts] gagal fetch streamtoearn.io:', e.message);
    // Kembalikan cache lama jika ada, supaya UI tidak kosong
    if (giftsCache) return json(res, 200, { ok: true, source: 'stale', gifts: giftsCache.data });
    return json(res, 502, { ok: false, error: 'Gagal mengambil data gift: ' + e.message });
  }
}

/* ------------------------------------------------------------------ */
/* Sounds — proxy + cache 5 menit dari myinstants.com official API     */
/* GET /api/v1/instants/?name=...&format=json&page=N                   */
/* Audio proxy: /api/sounds/proxy?url=https://...mp3                   */
/* ------------------------------------------------------------------ */
const SOUNDS_CACHE = new Map(); // key → { ts, data }
const SOUNDS_TTL   = 5 * 60 * 1000; // 5 menit
const MYINSTANTS_HOST = 'www.myinstants.com';

function fetchSoundsRemote(search, page) {
  return new Promise((resolve, reject) => {
    // Parameter yang benar adalah "name", bukan "search"
    const qs = '?format=json&page=' + page + (search ? '&name=' + encodeURIComponent(search) : '');
    const req = https.request(
      {
        hostname: MYINSTANTS_HOST,
        path: '/api/v1/instants/' + qs,
        method: 'GET',
        headers: { 'User-Agent': 'JekInteract/1 (Node.js)', Accept: 'application/json' },
        timeout: 8000
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error('Respons API tidak valid: ' + e.message)); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function normalizeSounds(remote, page) {
  const results = Array.isArray(remote.results) ? remote.results : [];
  const PAGE_SIZE = 20;
  const totalPages = remote.count ? Math.ceil(remote.count / PAGE_SIZE) : null;
  return {
    page,
    total_pages: totalPages,
    has_next: !!remote.next,
    // mp3 disimpan sebagai URL proxy lokal agar tidak kena CORS di browser/overlay
    sounds: results.map((r) => ({
      id: r.slug || '',
      title: r.name || r.slug || '',
      mp3: r.sound ? '/api/sounds/proxy?url=' + encodeURIComponent(r.sound) : ''
    }))
  };
}

async function serveSounds(res, q) {
  const query    = (q.get('q') || '').trim().slice(0, 100);
  const page     = Math.max(1, parseInt(q.get('page'), 10) || 1);
  const cacheKey = (query || '__all') + ':' + page;
  const now = Date.now();

  const hit = SOUNDS_CACHE.get(cacheKey);
  if (hit && now - hit.ts < SOUNDS_TTL) {
    const d = hit.data;
    return json(res, 200, { ok: true, source: 'cache', page: d.page, total_pages: d.total_pages, has_next: d.has_next, sounds: d.sounds });
  }

  try {
    const remote = await fetchSoundsRemote(query, page);
    const data = normalizeSounds(remote, page);
    SOUNDS_CACHE.set(cacheKey, { ts: now, data });
    return json(res, 200, { ok: true, source: 'live', page: data.page, total_pages: data.total_pages, has_next: data.has_next, sounds: data.sounds });
  } catch (e) {
    console.warn('[sounds] gagal fetch myinstants.com:', e.message);
    const stale = SOUNDS_CACHE.get(cacheKey);
    if (stale) {
      const d = stale.data;
      return json(res, 200, { ok: true, source: 'stale', page: d.page, total_pages: d.total_pages, has_next: d.has_next, sounds: d.sounds });
    }
    return json(res, 502, { ok: false, error: 'Gagal mengambil data suara: ' + e.message });
  }
}

/* Audio proxy — stream mp3 dari myinstants.com lewat server lokal     */
/* agar tidak kena CORS saat diplay di browser / overlay OBS           */
function serveSoundProxy(req, res, q) {
  const raw = q.get('url') || '';
  // Validasi: hanya izinkan URL dari myinstants.com
  let parsed;
  try { parsed = new URL(raw); } catch (_) { return json(res, 400, { error: 'URL tidak valid' }); }
  if (parsed.hostname !== MYINSTANTS_HOST) return json(res, 403, { error: 'Host tidak diizinkan' });

  const proxyReq = https.request(
    {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'JekInteract/1 (Node.js)', 'Accept': 'audio/*,*/*' },
      timeout: 20000
    },
    (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || 'audio/mpeg';
      const cl = proxyRes.headers['content-length'];
      const hdrs = {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      };
      if (cl) hdrs['Content-Length'] = cl;
      res.writeHead(proxyRes.statusCode || 200, hdrs);
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
    }
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) json(res, 502, { error: 'Gagal mengambil audio' });
    else res.destroy();
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) json(res, 504, { error: 'Timeout' });
    else res.destroy();
  });
  proxyReq.end();
}

/* ------------------------------------------------------------------ */
/* File statis (dengan dukungan Range untuk audio / video)             */
/* ------------------------------------------------------------------ */
function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const etag = '"' + st.mtimeMs.toString(36) + '-' + st.size.toString(36) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': cache || 'no-cache' });
      return res.end();
    }
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache || 'no-cache', 'ETag': etag };
    const pipe = (stream) => {
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    };

    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start = m[1] === '' ? NaN : parseInt(m[1], 10);
      let end = m[2] === '' ? NaN : parseInt(m[2], 10);
      if (Number.isNaN(start)) {
        start = Math.max(0, st.size - end);
        end = st.size - 1;
      } else if (Number.isNaN(end) || end >= st.size) {
        end = st.size - 1;
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      res.writeHead(206, Object.assign({}, headers, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
        'Content-Length': end - start + 1
      }));
      if (req.method === 'HEAD') return res.end();
      return pipe(fs.createReadStream(file, { start, end }));
    }

    res.writeHead(200, Object.assign({}, headers, { 'Content-Length': st.size }));
    if (req.method === 'HEAD') return res.end();
    pipe(fs.createReadStream(file));
  });
}

async function route(req, res) {
  // Tambahkan header CORS agar overlay di port SSE bisa fetch ke port utama
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    throw httpError(400, 'URL tidak valid');
  }

  if (pathname.startsWith('/api/')) return api(req, res, pathname, url.searchParams);

  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method tidak diizinkan');

  if (pathname.startsWith('/uploads/')) {
    const f = safeJoin(UPLOADS, pathname.slice('/uploads/'.length));
    return f ? serveFile(req, res, f, 'public, max-age=3600') : notFound(res);
  }
  if (pathname === '/overlay' || pathname.startsWith('/overlay/')) {
    return serveFile(req, res, path.join(PUBLIC, 'overlay.html'));
  }
  const f = safeJoin(PUBLIC, pathname === '/' ? '/index.html' : pathname);
  return f ? serveFile(req, res, f) : notFound(res);
}

/* ------------------------------------------------------------------ */
/* Handler request                                                     */
/* ------------------------------------------------------------------ */
function handleRequest(req, res) {
  route(req, res).catch((e) => {
    const code = e && e.code >= 400 && e.code < 600 ? e.code : 500;
    if (!res.headersSent) json(res, code, { error: (e && e.message) || 'Kesalahan server' });
    else res.end();
  });
}

let activePort = BASE_PORT;

/* ------------------------------------------------------------------ */
/* Cloudflare Tunnel — auto-start saat server siap                     */
/* ------------------------------------------------------------------ */
let tunnelUrl    = '';   // URL tunnel aktif, misal https://xyz.trycloudflare.com
let tunnelStatus = 'off'; // 'off' | 'starting' | 'online' | 'error'
let tunnelError  = '';
let tunnelProc   = null;

function tunnelPayload() {
  return { url: tunnelUrl, status: tunnelStatus, error: tunnelError };
}

function broadcastTunnel() {
  broadcast('tunnelstate', tunnelPayload(), (c) => c.role === 'dashboard');
}

/* Cari binary cloudflared TANPA nge-block event loop (penting di Wine/Winlator,
   di mana binary Go besar bisa lambat/nyangkut saat pertama dijalankan). */
function findCloudflared(cb) {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const probe = (bin, done) => {
    execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      done((!err || !!(stdout && stdout.length) || !!(stderr && stderr.length)) ? bin : null);
    });
  };
  const viaPath = () => {
    execFile(which, ['cloudflared'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      cb(!err && stdout && stdout.trim() ? 'cloudflared' : null);
    });
  };
  // 1) env CLOUDFLARED_PATH (dari Electron bundled), 2) PATH sistem
  if (process.env.CLOUDFLARED_PATH) {
    probe(process.env.CLOUDFLARED_PATH, (ok) => (ok ? cb(ok) : viaPath()));
  } else {
    viaPath();
  }
}

function startTunnel(port) {
  if (tunnelProc) return; // sudah berjalan
  findCloudflared((cfBin) => {
    if (!cfBin) {
      tunnelStatus = 'error';
      tunnelError  = 'cloudflared tidak ditemukan. Install cloudflared agar tunnel bisa aktif.';
      console.warn('[tunnel] cloudflared tidak ditemukan — lewati.');
      broadcastTunnel();
      return;
    }
    runTunnel(cfBin, port);
  });
}

function runTunnel(cfBin, port) {
  if (tunnelProc) return;
  tunnelStatus = 'starting';
  tunnelUrl    = '';
  tunnelError  = '';
  broadcastTunnel();
  console.log('[tunnel] memulai Cloudflare tunnel ke port ' + port + '...');

  const proc = spawn(cfBin, ['tunnel', '--url', 'http://localhost:' + port], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  tunnelProc = proc;

  const onLine = (line) => {
    // URL ada di stderr, format: "https://xxx.trycloudflare.com"
    const m = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (m) {
      tunnelUrl    = m[0];
      tunnelStatus = 'online';
      tunnelError  = '';
      broadcastTunnel();
      console.log('[tunnel] aktif: ' + tunnelUrl);
      // Print di banner setelah URL dapat
      const tty = process.stdout && process.stdout.isTTY;
      const col = (code, s) => (tty ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s);
      console.log('  Tunnel   : ' + col('1;35', tunnelUrl));
      console.log('');
    }
  };

  let stderrBuf = '';
  proc.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    lines.forEach(onLine);
  });

  let stdoutBuf = '';
  proc.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    lines.forEach(onLine);
  });

  proc.on('exit', (code) => {
    if (tunnelProc !== proc) return;
    tunnelProc = null;
    if (tunnelStatus === 'online') {
      tunnelStatus = 'error';
      tunnelError  = 'Tunnel terputus (kode ' + code + '). Restart server untuk mencoba lagi.';
      tunnelUrl    = '';
      broadcastTunnel();
      console.warn('[tunnel] terputus, kode=' + code);
    } else if (tunnelStatus === 'starting') {
      tunnelStatus = 'error';
      tunnelError  = 'Tunnel gagal dimulai (kode ' + code + ').';
      broadcastTunnel();
    }
  });

  proc.on('error', (e) => {
    tunnelStatus = 'error';
    tunnelError  = 'cloudflared error: ' + e.message;
    tunnelProc   = null;
    broadcastTunnel();
    console.warn('[tunnel] error:', e.message);
  });
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
function banner(port) {
  const tty = process.stdout && process.stdout.isTTY;
  const c = (code, s) => (tty ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s);
  const lan = lanAddresses();
  console.log('');
  console.log('  ' + c('1;36', 'JEKINTERACT') + c('2', '  v' + VERSION));
  console.log('  ' + c('2', '─────────────────────────────────────────'));
  console.log('  Dashboard: ' + c('1;32', 'http://localhost:' + port));
  lan.forEach((ip) => console.log('  Jaringan : ' + c('32', 'http://' + ip + ':' + port)));
  if (tunnelUrl) console.log('  Tunnel   : ' + c('1;35', tunnelUrl));
  console.log('');
  console.log('  ' + c('2', 'Tekan Ctrl+C untuk berhenti.'));
  console.log('');
}

function startMainServer(port, retries) {
  const server = http.createServer(handleRequest);

  /* WebSocket — hub utama (/api/ws) */
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const remoteIp = req.headers['x-forwarded-for']
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : (req.socket && req.socket.remoteAddress) || '';
    openStream(ws, url.searchParams, remoteIp);
  });

  /* WebSocket — HMR (/api/hmr) */
  const wssHmr = new WebSocketServer({ noServer: true });
  wssHmr.on('connection', (ws, req) => {
    const host = (req.headers['host'] || '');
    const isLocal = host.startsWith('localhost') || host.startsWith('127.') ||
      host.startsWith('0.0.0.0') || /^192\.168\./.test(host) || /^10\./.test(host);
    if (!isLocal) { ws.close(); return; }
    hmrClients.add(ws);
    ws.on('close', () => hmrClients.delete(ws));
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else if (pathname === '/api/hmr') {
      wssHmr.handleUpgrade(req, socket, head, (ws) => wssHmr.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  const onError = (e) => {
    if (e.code === 'EADDRINUSE' && retries > 0) {
      console.log('  Port ' + port + ' sedang dipakai, mencoba ' + (port + 1) + '...');
      startMainServer(port + 1, retries - 1);
    } else {
      console.error('Gagal menjalankan server: ' + e.message);
      process.exit(1);
    }
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    server.removeListener('error', onError);
    activePort = port;
    // Beri tahu host (Electron main process) bahwa server benar-benar sudah
    // listen — tanpa perlu polling HTTP loopback. Ini membuat startup Electron
    // tidak bergantung pada koneksi 127.0.0.1 yang bisa diblokir firewall.
    if (typeof global.__JEK_ON_SERVER_READY === 'function') {
      try { global.__JEK_ON_SERVER_READY(port); } catch (_) { /* abaikan */ }
    }
    banner(port);
    global.__JEK_SERVER = server;
    // Muat library TikTok sedini mungkin supaya halaman Connection langsung
    // tahu apakah library tersedia (dan menampilkan detail error bila tidak).
    loadTikTokConnector();
    // Auto-start Cloudflare tunnel setelah server siap (defer agar load halaman
    // pertama tidak diblokir oleh probe cloudflared).
    setTimeout(() => startTunnel(port), 1500);
    // Pemanasan helper keystroke PowerShell (Windows asli) agar trigger pertama
    // tidak ikut menanggung waktu kompilasi Add-Type (~1-2 detik).
    if (process.platform === 'win32' && !IS_WINE) {
      setTimeout(() => {
        try { if (canUseDriver()) ensureDriverHelper(); else ensurePsHelper(); } catch (_) {}
      }, 6000);
    }
  });
}

/**
 * Bersihkan semua resource sebelum proses keluar. Dipakai oleh:
 *  - Electron main process lewat global.__JEK_SHUTDOWN()
 *  - endpoint /api/app/quit
 *  - SIGINT / SIGTERM saat dijalankan lewat npm start
 * Tanpa ini, helper PowerShell/cloudflared bisa hidup sendiri dan membuat
 * file .exe tetap terkunci di Explorer.
 */
function shutdownAll() {
  try { shutdownKeystrokeHelper(); } catch (_) {}
  try { shutdownDriverHelper(); } catch (_) {}
  try { if (tunnelProc && !tunnelProc.killed) tunnelProc.kill(); } catch (_) {}
  try { tiktokCleanup(); } catch (_) {}
  try { if (global.__JEK_SERVER) global.__JEK_SERVER.close(); } catch (_) {}
}
global.__JEK_SHUTDOWN = shutdownAll;

process.on('SIGINT', () => {
  console.log('\n  Server dihentikan. Sampai jumpa!');
  shutdownAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdownAll();
  process.exit(0);
});

startMainServer(BASE_PORT, 10);
