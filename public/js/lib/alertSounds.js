/* Pemutar suara Join Alert / Follow Alert di dashboard.
 *
 * Suara tetap asalnya dari overlay (Browser Source OBS). Kalau overlay asli
 * tidak sedang terbuka, dashboard yang memutar suaranya — jadi user tidak perlu
 * standby di halaman Join Alert/Follow Alert. Preview overlay sengaja tidak
 * ikut menyuarakan (ctx.preview) supaya tidak dobel dengan dashboard.
 *
 * Tiap jenis alert punya antrean FIFO sendiri: suara diputar satu per satu,
 * tidak saling menimpa. */

import { Sync } from './sync.js';

const KINDS = ['joinalert', 'followalert'];
const MAX_QUEUE = 20;

export function initAlertSounds(onUnlock) {
  const queues = { joinalert: [], followalert: [] };
  const playing = { joinalert: false, followalert: false };

  function playNext(kind) {
    if (playing[kind]) return;
    const item = queues[kind].shift();
    if (!item) return;

    const url = item.sound && item.sound.url;
    if (!url) { playNext(kind); return; }

    playing[kind] = true;
    let settled = false;
    let audio = null;

    const done = () => {
      if (settled) return;
      settled = true;
      try {
        if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      } catch (_) {}
      playing[kind] = false;
      playNext(kind); // lanjut antrean berikutnya
    };

    const start = () => {
      if (settled) return;
      try {
        audio = new Audio(url);
        audio.preload = 'auto';
        const v = Number(item.volume);
        audio.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 1;
        audio.addEventListener('ended', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(() => done());
      } catch (_) { done(); }
    };

    // Browser butuh gestur user sebelum mengizinkan audio; app.js sudah
    // menangkap gestur pertama dan menjalankan callback yang tertunda.
    if (typeof onUnlock === 'function') onUnlock(start);
    else start();
  }

  function receive(kind, d) {
    if (!d || typeof d !== 'object') return;
    // Overlay asli (OBS Browser Source) yang memutar → dashboard jangan dobel.
    // Preview tidak dihitung online (presence: false), jadi tetap lewat sini.
    if (Sync.isOnline(kind)) return;
    queues[kind].push(d);
    if (queues[kind].length > MAX_QUEUE) queues[kind].shift();
    playNext(kind);
  }

  for (const kind of KINDS) {
    Sync.on(kind, (d) => receive(kind, d));
  }
}
