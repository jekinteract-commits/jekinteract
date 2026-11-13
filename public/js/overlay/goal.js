/* Overlay Goals — tampil "Target Like 0/5000" dengan bar segmen.
 * Bila TikTok sudah terhubung, progres diisi dari data live;
 * bila belum / saat disconnect, current di-reset ke 0. */
import { icon } from '../lib/icons.js';

const META = {
  like: ['Target Like', 'heart'],
  share: ['Target Share', 'share'],
  follower: ['Target Follower', 'userPlus'],
  coin: ['Target Coin', 'coin']
};
const DEF = { like: 5000, share: 100, follower: 100, coin: 1000 };
const SEG = 36;

export default function mount(ctx) {
  const { root, Sync, arg } = ctx;
  const meta = META[arg];
  if (!meta) {
    root.innerHTML = '<div class="ov-missing">Goal tidak dikenal.</div>';
    return;
  }

  root.innerHTML =
    '<div class="ovp cut gol gol-' + arg + '" id="gol">' +
    '<div class="gol-h"><span class="gol-ic">' + icon(meta[1]) + '</span><b class="gol-t">' + meta[0] + '</b><span class="gol-n" id="g-n">0/0</span></div>' +
    '<div class="gol-seg" id="g-seg"></div>' +
    '<div class="gol-f"><span id="g-pct">0%</span><span id="g-note"></span></div></div>';

  const box = root.querySelector('#gol');
  const num = root.querySelector('#g-n');
  const pctEl = root.querySelector('#g-pct');
  const note = root.querySelector('#g-note');
  const segWrap = root.querySelector('#g-seg');
  const segs = [];
  for (let i = 0; i < SEG; i++) {
    const el = document.createElement('i');
    segWrap.appendChild(el);
    segs.push(el);
  }

  const read = () => {
    const g = (Sync.get('goals', {}) || {})[arg] || {};
    return { target: Math.max(1, Number(g.target) || DEF[arg]), current: Math.max(0, Number(g.current) || 0) };
  };

  let shown = 0;
  let raf = 0;
  const paint = (animate) => {
    const { target, current } = read();
    const from = shown;
    const t0 = performance.now();
    cancelAnimationFrame(raf);
    const step = (t) => {
      const k = animate ? Math.min(1, (t - t0) / 600) : 1;
      const v = from + (current - from) * (1 - Math.pow(1 - k, 3));
      shown = v;
      num.textContent = Math.round(v) + '/' + target;
      const pct = Math.min(1, v / target);
      const lit = pct >= 1 ? SEG : pct > 0 ? Math.max(1, Math.round(pct * SEG)) : 0;
      segs.forEach((el, i) => el.classList.toggle('on', i < lit));
      pctEl.textContent = Math.floor(pct * 100) + '%';
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const done = current >= target;
    box.classList.toggle('done', done);
    note.textContent = done ? 'Tercapai!' : '';
  };

  // Reset current ke 0 di Sync.state (lokal saja, tidak simpan ke server)
  const resetCurrent = () => {
    const g = Object.assign({}, Sync.get('goals', {}));
    g[arg] = Object.assign({}, g[arg] || {}, { current: 0 });
    Sync.state['goals'] = g;
    shown = 0;
    paint(false);
  };

  // Init: jika TikTok belum online, pastikan tampilan mulai dari 0
  if (!Sync.tiktok || Sync.tiktok.state !== 'online') {
    resetCurrent();
  } else {
    paint(false);
  }

  Sync.on('state', (e) => {
    if (e.key === 'goals' || e.key === '*') paint(true);
  });

  Sync.on('tiktok', (ev) => {
    if (ev.state === 'online' || ev.event === 'connected') paint(true);
    else if (ev.state === 'offline' || ev.event === 'disconnected') resetCurrent();
  });

  // Saat WS reconnect, hello membawa state + tiktok terbaru — paint ulang.
  Sync.on('online', (isOnline) => {
    if (!isOnline) return;
    if (Sync.tiktok && Sync.tiktok.state === 'online') paint(true);
    else resetCurrent();
  });
}
