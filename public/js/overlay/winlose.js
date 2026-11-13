/* Overlay Win/Lose Bar — mengikuti state 'winlose' dari server. */
import { fmt } from '../lib/format.js';

export default function mount(ctx) {
  const { root, Sync } = ctx;
  root.innerHTML =
    '<div class="ovp cut wlo">' +
    '<div class="wlo-side win"><span class="wlo-l">Win</span><b class="wlo-n" id="w-win">0</b></div>' +
    '<div class="wlo-mid"><span class="wlo-vs">VS</span><div class="wlo-bar empty" id="w-bar"><i class="w" id="w-bw"></i><i class="l" id="w-bl"></i></div></div>' +
    '<div class="wlo-side lose"><span class="wlo-l">Lose</span><b class="wlo-n" id="w-lose">0</b></div>' +
    '</div>';

  const $ = (s) => root.querySelector(s);
  const prev = { win: -1, lose: -1 };

  const paint = () => {
    const v = Object.assign({ win: 0, lose: 0 }, Sync.get('winlose', {}));
    const total = v.win + v.lose;
    let pw = total ? v.win / total : 0.5;
    if (total) pw = Math.min(0.94, Math.max(0.06, pw));
    $('#w-bw').style.flexGrow = String(pw);
    $('#w-bl').style.flexGrow = String(1 - pw);
    $('#w-bar').classList.toggle('empty', !total);

    ['win', 'lose'].forEach((k) => {
      if (prev[k] === v[k]) return;
      const el = $('#w-' + k);
      el.textContent = fmt(v[k]);
      if (prev[k] !== -1) {
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
      }
      prev[k] = v[k];
    });
  };

  paint();
  Sync.on('state', (e) => {
    if (e.key === 'winlose' || e.key === '*') paint();
  });

  // Fetch state winlose sekali setelah mount — fix untuk Cloudflare/tunnel di mana
  // SSE hello bisa terlambat sehingga Sync.state['winlose'] masih kosong saat render pertama.
  fetch('/api/state/winlose')
    .then((r) => r.json())
    .then((d) => {
      if (d && d.value != null) {
        Sync.state['winlose'] = d.value;
        paint();
      }
    })
    .catch(() => {});
}
