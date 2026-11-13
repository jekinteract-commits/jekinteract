/* Overlay Subathon Timer — mengikuti state 'subathon' dari server.
 * Bila TikTok terhubung, waktu bertambah otomatis sesuai per-event config. */
import { remainingMs, timerStatus } from '../lib/timer.js';
import { fmtHMS } from '../lib/format.js';

const SEG = 28;
const LABEL = { idle: 'Siap', running: 'Berjalan', paused: 'Dijeda', finished: 'Selesai' };
const lerp = (a, b, t) => Math.round(a + (b - a) * t);

export default function mount(ctx) {
  const { root, Sync } = ctx;
  root.innerHTML =
    '<div class="ovp cut sbo" id="sbo" data-state="idle">' +
    '<div class="sbo-h"><span class="sbo-t">Subathon</span><span class="sbo-s" id="s-st">Siap</span><span class="sbo-live" id="s-live" hidden title="Live TikTok terhubung">● LIVE</span></div>' +
    '<div class="sbo-time" id="s-time">00:00:00</div>' +
    '<div class="sbo-seg" id="s-seg"></div></div>';

  const box = root.querySelector('#sbo');
  const time = root.querySelector('#s-time');
  const stat = root.querySelector('#s-st');
  const liveEl = root.querySelector('#s-live');
  const seg = root.querySelector('#s-seg');
  const segs = [];
  for (let i = 0; i < SEG; i++) {
    const el = document.createElement('i');
    const t = i / (SEG - 1);
    el.style.setProperty('--sc', 'rgb(' + lerp(41, 255, t) + ',' + lerp(243, 45, t) + ',' + lerp(255, 143, t) + ')');
    seg.appendChild(el);
    segs.push(el);
  }

  let lastText = '';
  let lastFilled = -1;
  const paint = () => {
    const st = Sync.get('subathon', null);
    const rec = Sync.recv.subathon;
    const rem = st ? remainingMs(st, rec) : 0;
    const status = st ? timerStatus(st, rec) : 'idle';

    const text = fmtHMS(rem);
    if (text !== lastText) {
      time.textContent = text;
      lastText = text;
    }
    box.dataset.state = status;
    stat.textContent = LABEL[status];
    box.classList.toggle('hot', status === 'running' && rem <= 60000);

    const base = st ? Math.max(Number(st.defaultMs) || 0, rem, 1) : 1;
    const filled = Math.min(SEG, Math.round((rem / base) * SEG));
    if (filled !== lastFilled) {
      segs.forEach((el, i) => el.classList.toggle('on', i < filled));
      lastFilled = filled;
    }
  };

  // Init live badge berdasarkan status TikTok saat ini
  if (liveEl) liveEl.hidden = !(Sync.tiktok && Sync.tiktok.state === 'online');

  paint();
  setInterval(paint, 200);
  Sync.on('state', (e) => {
    if (e.key === 'subathon' || e.key === '*') paint();
  });

  // Tampilkan/sembunyikan badge LIVE saat status TikTok berubah
  Sync.on('tiktok', (ev) => {
    if (!liveEl) return;
    if (ev.state === 'online' || ev.event === 'connected') liveEl.hidden = false;
    else if (ev.state === 'offline' || ev.event === 'disconnected') liveEl.hidden = true;
  });

  // Saat WS reconnect, hello dari server sudah membawa state terbaru via Sync.state.
  // Emit 'state' dengan key '*' dipicu oleh sync.js — subathon langsung paint ulang.
  Sync.on('online', (isOnline) => {
    if (!isOnline) return;
    // Update indikator live dari Sync.tiktok yang sudah diisi ulang oleh hello
    if (liveEl) liveEl.hidden = !(Sync.tiktok && Sync.tiktok.state === 'online');
    paint();
  });
}
