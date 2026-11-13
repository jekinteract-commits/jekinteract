'use strict';
const { execFile } = require('child_process');
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
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
let TikTokLiveConnection;
try { ({ TikTokLiveConnection } = require('tiktok-live-connector')); } catch (_) { /* opsional */ }

/* @nut-tree/nut-js — opsional, hanya aktif di Windows (npm install @nut-tree/nut-js) */
let nutKeyboard = null;
let nutKey = null;
try {
  const nut = require('@nut-tree/nut-js');
  nutKeyboard = nut.keyboard;
  nutKey = nut.Key;
  console.log('[keystroke] @nut-tree/nut-js tersedia — keystroke aktif');
} catch (_) {
  console.log('[keystroke] @nut-tree/nut-js tidak tersedia — keystroke akan dikembalikan sebagai simulasi');
}

const VERSION = '0.1.0';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const STATE_FILE = path.join(DATA, 'state.json');
const HOST = process.env.HOST || '0.0.0.0';
const BASE_PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_JSON = 1024 * 1024; // 1 MB
const MAX_UPLOAD = 300 * 1024 * 1024; // 300 MB
const SCREEN_COUNT = 20;

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
  const tty = process.stdout.isTTY;
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
  wsSend(c, 'hello', { state, status: statusPayload(), tiktok: tiktokSt, likeLeaderboard: likeLeaderboardObj(), giftLeaderboard: giftLeaderboardObj(), liveStats: liveStatsPayload(), musicstate: musicStatePayload(), serverTime: Date.now(), version: VERSION });

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
    return json(res, 200, { name: 'JekInteract', version: VERSION, port: activePort, addresses: lanAddresses() });
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

  if (pathname === '/api/upload' && m === 'POST') return handleUpload(req, res, q);
  if (pathname === '/api/gifts' && m === 'GET') return serveGifts(res);
  if (pathname === '/api/tts/status' && m === 'GET') return json(res, 200, { available: !!MsEdgeTTS });
  if (pathname === '/api/tts' && m === 'GET') return serveTTS(res, q);
  if (pathname === '/api/sounds' && m === 'GET') return serveSounds(res, q);
  if (pathname === '/api/sounds/proxy' && m === 'GET') return serveSoundProxy(req, res, q);

  if (pathname === '/api/tiktok/connect' && m === 'POST') return tiktokConnect(req, res);
  if (pathname === '/api/tiktok/disconnect' && m === 'POST') return tiktokDisconnect(res);
  if (pathname === '/api/tiktok/status' && m === 'GET') return json(res, 200, tiktokStatus());
  if (pathname === '/api/live/stats' && m === 'GET') return json(res, 200, liveStatsPayload());

  if (pathname === '/api/keystroke' && m === 'POST') {
    const body = await readJSON(req);
    const lines = Array.isArray(body.lines) ? body.lines.map(String).filter(Boolean) : [];
    if (!lines.length) return json(res, 400, { ok: false, error: 'Field "lines" wajib berisi array keystroke.' });
    const intName   = String(body.name   || '').trim() || '—';
    const intScreen = String(body.screen || '').trim() || '—';
    const intId     = String(body.id     || '').trim();
    const keyLabel  = lines.join(', ');

    // Kumpulkan semua event dari aktivitas yang terhubung ke interaksi ini
    const linkedActs = (state.activities || []).filter((a) =>
      a.action && (a.action.id === intId || (a.action.ids || []).includes(intId))
    );
    const eventLabel = linkedActs.length
      ? [...new Set(linkedActs.map((a) => whenDetailLabel(a.when)))].join(', ')
      : '—';

    if (!nutKeyboard || !nutKey) {
      console.log('AKTIVITAS : Test Play - ' + intName + ' - ' + keyLabel + ' - ' + eventLabel + ' - Screen ' + intScreen + ' [simulasi, nut.js belum aktif]');
      return json(res, 200, { ok: true, simulated: true, message: 'nut.js tidak tersedia — simulasi saja (install @nut-tree/nut-js di Windows).' });
    }
    console.log('AKTIVITAS : Test Play - ' + intName + ' - ' + keyLabel + ' - ' + eventLabel + ' - Screen ' + intScreen);
    try {
      await fireKeystrokes(lines);
      return json(res, 200, { ok: true, fired: lines });
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
      winlose: {}
    };
    Object.keys(defaults).forEach((k) => {
      state[k] = defaults[k];
      broadcast('state', { key: k, value: state[k] });
    });
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
    musicTickStop();
    broadcastMusicState();
    return json(res, 200, { ok: true });
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
  return { state: tiktokState, username: tiktokUser, error: tiktokError, available: !!TikTokLiveConnection };
}

function broadcastTiktok(event, data) {
  broadcast('tiktok', Object.assign({ event }, data), (c) => c.role === 'dashboard');
}

// Kirim event chat TikTok ke overlay chat agar menampilkan komentar live
function broadcastChatToOverlay(data) {
  broadcast('tiktok', Object.assign({ event: 'chat' }, data), (c) => c.role === 'overlay' && c.id === 'chat');
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
      const delayMs = (interaction.delay || 0) * 1000;
      setTimeout(() => {
        fireKeystrokes(interaction.keystrokes);
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

/**
 * Eksekusi satu baris keystroke. Format: "CTRL W" atau "SHIFT U" dll.
 * Mengembalikan Promise.
 */
async function execKeystrokeLine(line) {
  if (!nutKeyboard || !nutKey) throw new Error('nut.js tidak tersedia');
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
  await nutKeyboard.releaseKey(...allKeys.reverse());
}

/**
 * Eksekusi semua baris keystroke secara berurutan dengan jeda 50ms.
 * Dipanggil dari runActivities() saat interaction.triggers.keystroke aktif.
 */
async function fireKeystrokes(lines) {
  for (const line of lines) {
    try {
      await execKeystrokeLine(line);
      await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      console.warn('[keystroke] gagal eksekusi "' + line + '":', e.message);
    }
  }
}

function tiktokCleanup() {
  if (liveSession) finishLiveSession(true);
  if (tiktokClient) {
    try { tiktokClient.disconnect(); } catch (_) {}
    tiktokClient = null;
  }
}

async function tiktokConnect(req, res) {
  if (!TikTokLiveConnection) return json(res, 501, { ok: false, error: 'Library tiktok-live-connector tidak tersedia.' });

  const body = await readJSON(req);
  const raw = String(body.username || '').trim().replace(/^@/, '');
  if (!raw) return json(res, 400, { ok: false, error: 'Username wajib diisi.' });
  if (!/^[A-Za-z0-9._]{2,30}$/.test(raw)) return json(res, 400, { ok: false, error: 'Username tidak valid.' });

  // Putus koneksi lama dulu
  tiktokCleanup();

  tiktokUser = raw;
  tiktokState = 'connecting';
  tiktokError = '';
  startLiveSession(raw);
  broadcastTiktok('connecting', { username: raw });
  json(res, 200, { ok: true, username: raw }); // jawab request segera, connect async

  const client = new TikTokLiveConnection(raw, {});
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
      // Subathon — tambah waktu timer dari TikTok events
      if (ev === 'like')      processSubathonEvent('like', data || {});
      if (ev === 'gift')      processSubathonEvent('coin', data || {});
      if (ev === 'follow')    processSubathonEvent('follow', data || {});
      if (ev === 'share')     processSubathonEvent('share', data || {});
      if (ev === 'chat')      processSubathonEvent('comment', data || {});
      if (ev === 'subscribe') processSubathonEvent('subscribe', data || {});
      if (ev === 'member')    processSubathonEvent('follow', data || {}); // v2.5 join as member
      // Proses command musik dari komentar
      if (ev === 'chat') processMusicCommand(data || {});
      // Jalankan aktivitas yang cocok
      runActivities(ev, data || {});
      // Kirim event ke semua dashboard client via SSE
      broadcastTiktok(ev, { username: raw, data });
      // Kirim komentar live ke overlay chat
      if (ev === 'chat') broadcastChatToOverlay({ username: raw, data });
    });
  });

  try {
    const connState = await client.connect();
    if (tiktokClient !== client) return; // sudah di-disconnect saat proses
    applyRoomMeta((connState && connState.roomInfo) || client.roomInfo);
    tiktokState = 'online';
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
let musicSeqId = 0;
let musicTickTimer = null;

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

function musicStatePayload() {
  return {
    nowPlaying: musicNowPlaying,
    elapsed:    musicElapsed,
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

/** Update durasi lagu yang sedang diputar (dikirim dari iframe YouTube di overlay/dashboard). */
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

/** Update judul lagu yang sedang diputar dengan judul asli dari YouTube (dikirim dari iframe YouTube di overlay). */
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
/* Start                                                               */
/* ------------------------------------------------------------------ */
function banner(port) {
  const tty = process.stdout.isTTY;
  const c = (code, s) => (tty ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s);
  const lan = lanAddresses();
  console.log('');
  console.log('  ' + c('1;36', 'JEKINTERACT') + c('2', '  v' + VERSION));
  console.log('  ' + c('2', '─────────────────────────────────────────'));
  console.log('  Dashboard: ' + c('1;32', 'http://localhost:' + port));
  lan.forEach((ip) => console.log('  Jaringan : ' + c('32', 'http://' + ip + ':' + port)));
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
    banner(port);
  });
}

process.on('SIGINT', () => {
  console.log('\n  Server dihentikan. Sampai jumpa!');
  process.exit(0);
});

startMainServer(BASE_PORT, 10);
