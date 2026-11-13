/* Penyimpanan lokal + state sesi. */
import { seedHistory } from './demo.js';

const PREFIX = 'ji:';
const subs = {};

function emit(key, value) {
  (subs[key] || []).slice().forEach((fn) => {
    try {
      fn(value);
    } catch (e) {
      console.error(e);
    }
  });
}

export const Store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
      console.warn('[store]', e.message);
    }
    emit(key, value);
    return value;
  },
  on(key, fn) {
    (subs[key] = subs[key] || []).push(fn);
    return () => {
      subs[key] = (subs[key] || []).filter((f) => f !== fn);
    };
  },
  clearAll() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => localStorage.removeItem(k));
    } catch (_) {
      /* diabaikan */
    }
  }
};

/** Nilai awal tiap fitur (dipakai bersama oleh halaman dan overlay). */
export const DEFAULTS = {
  settings: { baseUrl: '' },
  obs: { ip: '127.0.0.1', port: '4455', password: '' },
  music: { playOn: true, skipOn: true, playWho: 'all', skipWho: 'all' },
  tts: { enabled: false, lang: 'id', gender: 'female', random: false, speed: 50, volume: 80, who: 'all', filter: '' },
  subathon: { value: 1, unit: 'h', per: { coin: 0, subscribe: 0, follow: 0, share: 0, like: 0, comment: 0 } }
};

/** Tunnel URL aktif dari server (di-set oleh sync.js saat dapat tunnelstate). */
let _tunnelUrl = '';
export function setTunnelUrl(url) { _tunnelUrl = url || ''; }
export function getTunnelUrl()    { return _tunnelUrl; }

/** Inisialisasi tunnel URL dari Electron IPC (jika berjalan di dalam Electron).
 *  Dipanggil sekali saat app.js / sync.js load. */
export function initElectronTunnel() {
  if (typeof window === 'undefined' || !window.__electronBridge__) return;
  // Ambil URL yang sudah ada di main process (sinkron via invoke)
  window.__electronBridge__.getTunnelUrl().then((url) => {
    if (url) setTunnelUrl(url);
  }).catch(() => {});
  // Dengarkan perubahan tunnel URL dari main process
  window.__electronBridge__.onTunnelUrl((url) => {
    setTunnelUrl(url);
  });
}

/** Alamat dasar untuk link overlay.
 *  Prioritas: baseUrl manual (jika diisi) → tunnel URL aktif → location.origin
 */
export function baseUrl() {
  const s = Store.get('settings', DEFAULTS.settings) || {};
  const b = String(s.baseUrl || '').trim().replace(/\/+$/, '');
  if (b) return b;
  if (_tunnelUrl) return _tunnelUrl;
  return location.origin;
}

/* ---------- Sesi (dalam memori; hilang saat halaman di-refresh) ---------- */
const sess = {
  connection: { status: 'offline', username: '', since: 0 },
  obs: { status: 'idle', detail: '' }
};
const sessSubs = [];

export const Session = {
  get() {
    return sess;
  },
  set(patch) {
    Object.assign(sess, patch);
    sessSubs.slice().forEach((fn) => {
      try {
        fn(sess);
      } catch (e) {
        console.error(e);
      }
    });
  },
  on(fn) {
    sessSubs.push(fn);
    return () => {
      const i = sessSubs.indexOf(fn);
      if (i >= 0) sessSubs.splice(i, 1);
    };
  }
};

/* ---------- Riwayat live: hanya 30 hari terakhir ---------- */
const DAY = 864e5;
export const HISTORY_DAYS = 30;

export const History = {
  list() {
    let l = Store.get('history', null);
    if (!Array.isArray(l)) {
      l = seedHistory();
      Store.set('history', l);
    }
    return l;
  },
  /** Hapus entri yang lewat 30 hari. Mengembalikan jumlah yang dihapus. */
  purge() {
    const limit = Date.now() - HISTORY_DAYS * DAY;
    const l = History.list();
    const keep = l.filter((e) => e.ts >= limit);
    const removed = l.length - keep.length;
    if (removed > 0) Store.set('history', keep);
    return removed;
  },
  add(entry) {
    const l = History.list();
    l.push(Object.assign({ id: 'h_' + Date.now().toString(36) }, entry));
    Store.set('history', l);
  }
};
