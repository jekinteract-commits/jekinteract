import { $, $$, on, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Sync } from '../lib/sync.js';
import { OVERLAYS } from '../lib/overlays.js';
import { fmt } from '../lib/format.js';
import { toast, linkRowHTML, previewHTML, statusHTML, bindStatuses, mountPreviews, confirmDialog } from '../lib/ui.js';

const get = () => Object.assign({ win: 0, lose: 0 }, Sync.get('winlose', {}));

export default {
  id: 'winlose',
  title: 'Win Lose Bar',
  icon: 'versus',

  render() {
    const ov = OVERLAYS.winlose;
    return (
      '<div class="ph"><h1>Win/Lose Bar</h1><p>Papan skor menang dan kalah untuk ditampilkan di OBS/Tiktok Studio. Ubah angkanya dari sini atau lewat hotkey, dan overlay ikut berubah seketika.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Skor</h2><div class="sub">Hotkey bekerja selama halaman ini terbuka.</div></div>' +
      '<button type="button" class="btn sm ghost" id="wl-reset">' + icon('reset') + 'Reset skor</button></div>' +
      '<div class="wl">' +
      '<div class="wl-box win"><span class="wl-l">Win</span><b class="wl-n" id="wl-win">0</b>' +
      '<div class="row nowrap wl-b"><button type="button" class="btn icon" data-wl="win" data-d="-1" aria-label="Kurangi Win">' + icon('minus') + '</button>' +
      '<button type="button" class="btn icon primary" data-wl="win" data-d="1" aria-label="Tambah Win">' + icon('plus') + '</button></div>' +
      '<span class="hint">Hotkey: Numpad Add ( + )</span></div>' +
      '<div class="wl-box lose"><span class="wl-l">Lose</span><b class="wl-n" id="wl-lose">0</b>' +
      '<div class="row nowrap wl-b"><button type="button" class="btn icon" data-wl="lose" data-d="-1" aria-label="Kurangi Lose">' + icon('minus') + '</button>' +
      '<button type="button" class="btn icon primary" data-wl="lose" data-d="1" aria-label="Tambah Lose">' + icon('plus') + '</button></div>' +
      '<span class="hint">Hotkey: Numpad Minus ( - )</span></div>' +
      '</div></section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Link Overlay</h2></div>' + statusHTML(ov.id) + '</div>' +
      linkRowHTML(ov) +
      previewHTML(ov) +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    d(mountPreviews(root));
    d(bindStatuses(root));

    const paint = (bumpKey) => {
      const v = get();
      ['win', 'lose'].forEach((k) => {
        const el = $('#wl-' + k, root);
        el.textContent = fmt(v[k]);
        if (bumpKey === k) {
          el.classList.remove('bump');
          void el.offsetWidth;
          el.classList.add('bump');
        }
      });
    };
    const change = (key, delta) => {
      const v = get();
      v[key] = Math.max(0, (v[key] | 0) + delta);
      Sync.set('winlose', v);
      paint(key);
    };
    paint();
    d(Sync.on('state', (e) => {
      if (e.key === 'winlose' || e.key === '*') paint();
    }));

    // Fetch winlose state via REST — fix Cloudflare/tunnel (SSE hello bisa terlambat).
    fetch('/api/state/winlose')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.value == null) return;
        Sync.state['winlose'] = res.value;
        paint();
      })
      .catch(() => {});

    d(on(root, 'click', '[data-wl]', (e, btn) => change(btn.dataset.wl, Number(btn.dataset.d))));

    $('#wl-reset', root).addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Reset skor', message: 'Kembalikan skor Win dan Lose ke 0?', okText: 'Reset', danger: true });
      if (!ok) return;
      Sync.set('winlose', { win: 0, lose: 0 });
      paint();
      toast('Skor direset.', 'ok', 2000);
    });

    // hotkey Numpad + (Win) dan Numpad - (Lose)
    const onKey = (e) => {
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'NumpadAdd') {
        e.preventDefault();
        change('win', 1);
      } else if (e.code === 'NumpadSubtract') {
        e.preventDefault();
        change('lose', 1);
      }
    };
    document.addEventListener('keydown', onKey);
    d(() => document.removeEventListener('keydown', onKey));

    return () => d.run();
  }
};
