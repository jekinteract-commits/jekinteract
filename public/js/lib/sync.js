/* Sinkronisasi real-time dengan server (WebSocket) + helper API. */
import { setTunnelUrl, initElectronTunnel } from './store.js';

// Inisialisasi IPC tunnel URL dari Electron (no-op jika bukan di Electron)
initElectronTunnel();

const listeners = {};
const cid = Math.random().toString(36).slice(2, 10);

export const Sync = {
  cid,
  state: {}, // state terakhir dari server per key
  recv: {}, // timestamp (ms) saat state tiap key diterima dari server
  status: { overlays: {}, queues: {} },
  tiktok: { state: 'offline', username: '', error: '', available: false },
  obs: { status: 'offline', ip: '127.0.0.1', port: '4455', error: '', scenes: [], sources: {}, currentScene: '' },
  tunnel: { url: '', status: 'off', error: '' },
  likeLeaderboard: [], // [{id, nickname, avatarUrl, count}] realtime dari server
  giftLeaderboard: [], // [{id, nickname, avatarUrl, count}] realtime dari server
  liveStats: { current: null, sessions: [] }, // statistik sesi live asli dari server
  music: { nowPlaying: null, elapsed: 0, paused: false, volume: 100, queue: [] }, // state musik realtime
  online: false,
  _hello: null, // data hello terakhir, untuk re-emit setelah mount()

  on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
    return () => {
      listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn);
    };
  },

  emit(evt, data) {
    (listeners[evt] || []).slice().forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    });
  },

  /**
   * Buka koneksi WebSocket ke /api/ws dengan auto-reconnect.
   * - role='overlay': resolve setelah hello WS atau fallback REST.
   * - role='dashboard': resolve setelah hello atau 1,5 detik (UX dashboard).
   */
  connect({ role = 'dashboard', id = '', presence = true } = {}) {
    return new Promise((resolve) => {
      if (typeof WebSocket === 'undefined') return resolve(false);

      const q = new URLSearchParams({ role });
      if (id) q.set('id', id);
      if (!presence) q.set('presence', '0');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = proto + '//' + location.host + '/api/ws?' + q.toString();

      let resolved = false;
      let retryDelay = 1000;   // mulai 1 detik
      const MAX_DELAY = 30000; // maks 30 detik
      let retryTimer = null;
      let currentWs = null;

      function scheduleReconnect() {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          open();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_DELAY);
      }

      // Saat tab kembali visible setelah di-background Android, WebSocket mungkin sudah
      // mati (Android freeze tab → pong tidak terkirim → server terminate).
      // Langsung reconnect tanpa tunggu retryDelay.
      function onVisible() {
        if (document.visibilityState !== 'visible') return;
        if (currentWs && currentWs.readyState === WebSocket.OPEN) return; // masih hidup
        // Batalkan retry yang sedang antri, reconnect sekarang
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (!currentWs || currentWs.readyState === WebSocket.CLOSED || currentWs.readyState === WebSocket.CLOSING) {
          retryDelay = 1000; // reset backoff
          open();
        }
      }
      document.addEventListener('visibilitychange', onVisible);

      function handleMessage(e) {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        const { event, data: d } = msg;
        if (!event) return;

        if (event === 'hello') {
          if (!d) return;
          retryDelay = 1000; // reset backoff saat koneksi berhasil
          Sync.state = d.state || {};
          Object.keys(Sync.state).forEach((k) => (Sync.recv[k] = Date.now()));
          Sync.status = d.status || { overlays: {}, queues: {} };
          if (d.tiktok) Sync.tiktok = d.tiktok;
          if (d.likeLeaderboard) Sync.likeLeaderboard = d.likeLeaderboard;
          if (d.giftLeaderboard) Sync.giftLeaderboard = d.giftLeaderboard;
          if (d.liveStats) Sync.liveStats = d.liveStats;
          if (d.musicstate) Sync.music = d.musicstate;
          const wasOffline = !Sync.online;
          Sync.online = true;
          Sync._hello = d;
          if (d.obsstate) Sync.obs = d.obsstate;
          if (d.tunnel) { Sync.tunnel = d.tunnel; setTunnelUrl(d.tunnel.url); }
          if (!resolved) {
            resolved = true;
            resolve(true);
          }
          if (wasOffline) {
            // reconnect berhasil — emit ulang semua state ke listener
            if (d.tiktok) Sync.emit('tiktok', d.tiktok);
            if (d.likeLeaderboard) Sync.emit('likeleaderboard', d.likeLeaderboard);
            if (d.giftLeaderboard) Sync.emit('giftleaderboard', d.giftLeaderboard);
            if (d.liveStats) Sync.emit('livestats', d.liveStats);
            if (d.musicstate) Sync.emit('musicstate', d.musicstate);
            if (d.obsstate) Sync.emit('obsstate', d.obsstate);
            if (d.tunnel) Sync.emit('tunnelstate', d.tunnel);
            Sync.emit('online', true);
            Sync.emit('state', { key: '*' });
            Sync.emit('status', Sync.status);
          }
          return;
        }

        if (event === 'state') {
          if (!d || d.src === cid) return;
          Sync.state[d.key] = d.value;
          Sync.recv[d.key] = Date.now();
          Sync.emit('state', { key: d.key, value: d.value });
          return;
        }

        if (event === 'status') {
          if (!d) return;
          Sync.status = d;
          Sync.emit('status', d);
          return;
        }

        if (event === 'play' || event === 'stop' || event === 'clear') {
          Sync.emit(event, d || {});
          return;
        }

        if (event === 'likeleaderboard') {
          if (!d) return;
          Sync.likeLeaderboard = d;
          Sync.emit('likeleaderboard', d);
          return;
        }

        if (event === 'giftleaderboard') {
          if (!d) return;
          Sync.giftLeaderboard = d;
          Sync.emit('giftleaderboard', d);
          return;
        }

        if (event === 'livestats') {
          if (!d) return;
          Sync.liveStats = d;
          Sync.emit('livestats', d);
          return;
        }

        if (event === 'musicstate') {
          if (!d) return;
          Sync.music = d;
          Sync.emit('musicstate', d);
          return;
        }

        if (event === 'musicskip') {
          if (!d) return;
          Sync.emit('musicskip', d);
          return;
        }

        if (event === 'obsstate') {
          if (!d) return;
          Sync.obs = d;
          Sync.emit('obsstate', d);
          return;
        }

        if (event === 'tunnelstate') {
          if (!d) return;
          Sync.tunnel = d;
          setTunnelUrl(d.url);
          Sync.emit('tunnelstate', d);
          return;
        }

        if (event === 'tiktokstate') {
          if (!d) return;
          Sync.tiktok = d;
          Sync.emit('tiktok', Object.assign({}, d, {
            event: d.state === 'online' ? 'connected'
                 : d.state === 'offline' ? 'disconnected'
                 : d.state
          }));
          return;
        }

        if (event === 'tiktok') {
          if (!d) return;
          if (d.event === 'connected')         Sync.tiktok = { state: 'online',      username: d.username,       error: '',             available: true };
          else if (d.event === 'connecting')   Sync.tiktok = { state: 'connecting',  username: d.username,       error: '',             available: true };
          else if (d.event === 'disconnected') Sync.tiktok = { state: 'offline',     username: '',               error: '',             available: true };
          else if (d.event === 'error')        Sync.tiktok = { state: 'error',       username: d.username || '', error: d.message || '', available: true };
          Sync.emit('tiktok', Object.assign({}, Sync.tiktok, { event: d.event, data: d.data }));
          return;
        }
      }

      function open() {
        let ws;
        try {
          ws = new WebSocket(wsUrl);
        } catch (_) {
          if (!resolved) { resolved = true; resolve(false); }
          scheduleReconnect();
          return;
        }
        currentWs = ws;

        ws.addEventListener('message', handleMessage);

        ws.addEventListener('close', () => {
          if (currentWs !== ws) return; // sudah diganti, abaikan
          currentWs = null;
          if (Sync.online) {
            Sync.online = false;
            Sync.status = { overlays: {}, queues: {} };
            Sync.emit('online', false);
            Sync.emit('status', Sync.status);
          }
          // Overlay: fallback REST untuk data awal saat pertama konek
          if (role === 'overlay' && !resolved) {
            Promise.all([
              fetch('/api/state').then((r) => r.json()).catch(() => ({})),
              fetch('/api/tiktok/status').then((r) => r.json()).catch(() => null),
              fetch('/api/music/state').then((r) => r.json()).catch(() => null),
              fetch('/api/live/stats').then((r) => r.json()).catch(() => null)
            ]).then(([st, tk, ms, ls]) => {
              if (st) { Sync.state = st; Object.keys(st).forEach((k) => (Sync.recv[k] = Date.now())); }
              if (tk) Sync.tiktok = tk;
              if (ms) Sync.music = ms;
              if (ls) Sync.liveStats = ls;
              if (!resolved) { resolved = true; resolve(false); }
            }).catch(() => {
              if (!resolved) { resolved = true; resolve(false); }
            });
          }
          scheduleReconnect();
        });

        ws.addEventListener('error', () => {
          // error selalu diikuti close — handled di close listener
        });
      }

      open();

      // Dashboard: resolve setelah 1,5 detik meski WS belum ready.
      // Overlay: timeout 5 detik sebagai safety net.
      setTimeout(() => {
        if (!resolved) { resolved = true; resolve(Sync.online); }
      }, role !== 'overlay' ? 1500 : 5000);
    });
  },

  get(key, fallback) {
    const v = Sync.state[key];
    return v === undefined || v === null ? fallback : v;
  },

  /** Simpan state (lokal langsung, server menyusul) dan sebarkan ke overlay. */
  set(key, value) {
    Sync.state[key] = value;
    Sync.recv[key] = Date.now();
    Sync.emit('state', { key, value, local: true });
    return fetch('/api/state/' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, src: cid })
    })
      .then((r) => r.ok)
      .catch(() => false);
  },

  isOnline(id) {
    return (Sync.status.overlays[id] || 0) > 0;
  }
};

async function json(url, opts) {
  const r = await fetch(url, opts);
  let j = {};
  try {
    j = await r.json();
  } catch (_) {
    /* body kosong */
  }
  if (!r.ok) throw new Error(j.error || r.statusText || 'Permintaan gagal');
  return j;
}

export const API = {
  info: () => json('/api/info'),
  tiktokConnect: (username) => json('/api/tiktok/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  }),
  tiktokDisconnect: () => json('/api/tiktok/disconnect', { method: 'POST' }),
  tiktokStatus: () => json('/api/tiktok/status'),
  keystrokeStatus: () => json('/api/keystroke/status'),
  keystrokeConfig: () => json('/api/keystroke/config'),
  saveKeystrokeConfig: (cfg) => json('/api/keystroke/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg)
  }),
  appQuit: () => json('/api/app/quit', { method: 'POST' }),
  restartAdmin: () => json('/api/app/restart-admin', { method: 'POST' }),
  play: (n, item) =>
    json('/api/screen/' + n + '/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    }),
  clearQueues: () => json('/api/queue/clear', { method: 'POST' }),
  resetData: () => json('/api/reset-data', { method: 'POST' }),
  resetGoal: (goal) => json('/api/goals/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal })
  }),

  /* ----- Config export / import ----- */
  // Ambil semua konfigurasi server (interaksi, aktivitas, music, subathon, goals, dst.)
  configExport: () => json('/api/config/export'),
  // Kirim payload ekspor kembali; server restore key yang diizinkan.
  configImport: (payload) => json('/api/config/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  }),

  /* ----- Music ----- */
  musicState: () => json('/api/music/state'),
  musicEnqueue: (user, title, ytId) => json('/api/music/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, title, ytId: ytId || '' })
  }),
  musicSkip: (by) => json('/api/music/skip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ by: by || 'dashboard' })
  }),
  /** Set jeda (pause/resume) dan/atau volume (0-100) untuk semua player musik. */
  musicControl: (payload) => json('/api/music/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  }),
  musicRevoke: (user, title) => json('/api/music/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: user || 'dashboard', title: title || null })
  }),
  musicDuration: (uid, dur) => json('/api/music/duration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, dur })
  }),
  musicTitle: (uid, title) => json('/api/music/title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, title })
  }),
  musicSetYtId: (uid, ytId) => json('/api/music/ytid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, ytId })
  }),
  musicSearch: (q) => json('/api/music/search?' + new URLSearchParams({ q })),
  musicClear: () => json('/api/music/clear', { method: 'POST' }),

  /* ----- Tunnel ----- */
  tunnelStatus: () => json('/api/tunnel/status'),

  /* ----- OBS ----- */
  obsConnect: (ip, port, password) => json('/api/obs/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, port, password })
  }),
  obsDisconnect: () => json('/api/obs/disconnect', { method: 'POST' }),
  obsStatus: () => json('/api/obs/status'),
  obsScenes: () => json('/api/obs/scenes'),
  obsSources: (scene) => json('/api/obs/sources' + (scene ? '?' + new URLSearchParams({ scene }) : '')),
  obsCommand: (payload) => json('/api/obs/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }),

  /** Upload file ke server (data/uploads). onProgress menerima 0..1. */
  upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let j = {};
        try {
          j = JSON.parse(xhr.responseText);
        } catch (_) {
          /* abaikan */
        }
        if (xhr.status >= 200 && xhr.status < 300 && j.url) resolve(j);
        else reject(new Error(j.error || 'Upload gagal'));
      };
      xhr.onerror = () => reject(new Error('Tidak bisa terhubung ke server'));
      xhr.send(file);
    });
  }
};
