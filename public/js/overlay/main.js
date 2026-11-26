/* Router overlay: /overlay/screen/N, /overlay/music, /overlay/goal/like, dst. */
import { Sync } from '../lib/sync.js';
import { overlayById, SCREEN_COUNT } from '../lib/overlays.js';

/**
 * Cegah Android Chrome men-freeze background tab.
 * Chrome Android sangat agresif: tab yang tidak ada suara/video di-suspend
 * dalam hitungan detik, memutus WebSocket dan semua timer.
 *
 * Tiga lapisan perlindungan:
 * 1. Web Locks — lock yang tidak pernah di-release agar browser anggap tab aktif
 * 2. AudioContext silent ping tiap 20 detik — browser tidak suspend tab yang punya audio aktif
 * 3. visibilitychange — saat tab kembali visible, paksa resume AudioContext
 */
function keepAliveTab() {
  // Lapisan 1: Web Locks (Chrome 69+, paling efektif)
  if (navigator.locks && navigator.locks.request) {
    navigator.locks.request(
      'jekinteract-overlay-keepalive',
      { mode: 'shared' },
      () => new Promise(() => { /* tidak pernah resolve — lock selamanya */ })
    ).catch(() => {});
  }

  // Lapisan 2: AudioContext silent ping tiap 20 detik
  let ctx = null;

  function resumeCtx() {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (_) {}
  }

  function silentPing() {
    resumeCtx();
    try {
      if (ctx && ctx.state === 'running') {
        const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
      }
    } catch (_) {}
  }

  function startPing() {
    silentPing();
    setInterval(silentPing, 20000);
  }

  // AudioContext butuh gesture — coba langsung, kalau gagal tunggu interaksi user
  try {
    const probe = new (window.AudioContext || window.webkitAudioContext)();
    probe.resume().then(() => {
      probe.close().catch(() => {});
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      startPing();
    }).catch(() => {
      document.addEventListener('click', startPing, { once: true });
      document.addEventListener('touchend', startPing, { once: true });
      // Coba lagi tanpa gesture setelah 1 detik (kadang berhasil di OBS)
      setTimeout(startPing, 1000);
    });
  } catch (_) {}

  // Lapisan 3: resume saat tab kembali aktif
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeCtx();
  });
}

const parts = location.pathname.replace(/^\/overlay\/?/, '').split('/').filter(Boolean);
const q = new URLSearchParams(location.search);
const type = parts[0] || '';
const rawArg = parts[1] || '';

let arg = rawArg;
let id = type;
if (type === 'screen') {
  const n = Number(rawArg);
  arg = Number.isInteger(n) && n >= 1 && n <= SCREEN_COUNT ? String(n) : '';
  id = 'screen-' + arg;
} else if (type === 'goal') {
  id = 'goal-' + rawArg;
}

const ctx = {
  id,
  type,
  arg,
  preview: q.get('preview') === '1', // dibuka di dalam dashboard: tidak dihitung "online"
  debug: q.get('bg') === '1', // dibuka di tab browser: tampilkan kotak-kotak gelap
  root: document.getElementById('root'),
  Sync
};

const LOADERS = {
  screen: () => import('./screen.js'),
  music: () => import('./music.js'),
  subathon: () => import('./subathon.js'),
  winlose: () => import('./winlose.js'),
  likes: () => import('./board.js'),
  gifters: () => import('./board.js'),
  chat: () => import('./chat.js'),
  joinalert: () => import('./joinAlert.js'),
  followalert: () => import('./followAlert.js'),
  goal: () => import('./goal.js')
};

function debugTag() {
  const el = document.createElement('div');
  el.className = 'dbg';
  el.innerHTML = '<i></i><span></span>';
  document.body.appendChild(el);
  const paint = () => {
    el.classList.toggle('on', Sync.online);
    el.querySelector('span').textContent = 'JekInteract ' + id + (Sync.online ? ' tersambung' : ' terputus');
  };
  paint();
  Sync.on('online', paint);
}

async function start() {
  keepAliveTab();
  const ov = overlayById(id);
  const root = ctx.root;
  if (ctx.debug) document.body.classList.add('bg');
  if (!ov || !LOADERS[type] || (type === 'screen' && !arg)) {
    root.innerHTML = '<div class="ov-missing">Overlay tidak dikenal. Salin link dari dashboard JekInteract.</div>';
    return;
  }
  document.documentElement.dataset.ov = id;
  // Untuk screen overlay: root mengisi penuh viewport agar centering bekerja di semua device/OBS
  if (type === 'screen') {
    root.style.width = '100%';
    root.style.height = '100%';
  } else {
    root.style.width = ov.w + 'px';
    root.style.height = ov.h + 'px';
  }

  // Mount overlay segera — tidak nunggu SSE connect.
  // Data dari SSE/REST akan masuk via event listener yang dipasang di dalam mount().
  // connect() berjalan paralel; setelah selesai, emit ulang data ke listener yang sudah terpasang.
  let mod;
  try {
    mod = await LOADERS[type]();
    mod.default(ctx);
  } catch (e) {
    console.error(e);
    root.innerHTML = '<div class="ov-missing">Overlay gagal dimuat.</div>';
    return;
  }
  if (ctx.debug) debugTag();

  // Buka koneksi SSE di background; setelah data tiba, emit ke listener overlay.
  Sync.connect({ role: 'overlay', id, presence: !ctx.preview }).then(() => {
    // Emit semua data yang sudah ada di Sync ke listener overlay.
    // Ini terjadi saat: (1) hello SSE diterima, (2) fallback REST selesai.
    if (Sync.tiktok) Sync.emit('tiktok', Object.assign({}, Sync.tiktok, {
      event: Sync.tiktok.state === 'online' ? 'connected' : 'disconnected'
    }));
    if (Sync.likeLeaderboard && Sync.likeLeaderboard.length) Sync.emit('likeleaderboard', Sync.likeLeaderboard);
    if (Sync.giftLeaderboard && Sync.giftLeaderboard.length) Sync.emit('giftleaderboard', Sync.giftLeaderboard);
    if (Sync.liveStats) Sync.emit('livestats', Sync.liveStats);
    if (Sync.music) Sync.emit('musicstate', Sync.music);
    Sync.emit('online', Sync.online);
    Sync.emit('state', { key: '*' });
    Sync.emit('status', Sync.status);
  });
}

start();
