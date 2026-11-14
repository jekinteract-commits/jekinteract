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
      '<div class="fh"><div class="fh-t"><h2>Skor</h2><div class="sub" id="wl-hot-sub">Hotkey bekerja selama halaman ini fokus.</div></div>' +
      '<button type="button" class="btn sm ghost" id="wl-reset">' + icon('reset') + 'Reset skor</button></div>' +
      '<div class="wl">' +
      '<div class="wl-box win"><span class="wl-l">Win</span><b class="wl-n" id="wl-win">0</b>' +
      '<div class="row nowrap wl-b"><button type="button" class="btn icon" data-wl="win" data-d="-1" aria-label="Kurangi Win">' + icon('minus') + '</button>' +
      '<button type="button" class="btn icon primary" data-wl="win" data-d="1" aria-label="Tambah Win">' + icon('plus') + '</button></div>' +
      '<span class="hint" id="wl-hint-win">Hotkey: Numpad Add ( + )</span></div>' +
      '<div class="wl-box lose"><span class="wl-l">Lose</span><b class="wl-n" id="wl-lose">0</b>' +
      '<div class="row nowrap wl-b"><button type="button" class="btn icon" data-wl="lose" data-d="-1" aria-label="Kurangi Lose">' + icon('minus') + '</button>' +
      '<button type="button" class="btn icon primary" data-wl="lose" data-d="1" aria-label="Tambah Lose">' + icon('plus') + '</button></div>' +
      '<span class="hint" id="wl-hint-lose">Hotkey: Numpad Minus ( - )</span></div>' +
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

    /* ---- Hotkey Numpad + (Win) / - (Lose) --------------------------------
       Di Electron hotkey didaftarkan sebagai global shortcut, sehingga tetap
       terpicu walau fokus ada di OBS/TikTok Studio/game. Di browser biasa
       tetap berfungsi selama halaman ini fokus (keterbatasan browser). */
    const bridge = window.__electronBridge__;
    const hasGlobalHotkeys = !!(bridge &&
      typeof bridge.setWinloseHotkeys === 'function' &&
      typeof bridge.onWinloseHotkey === 'function');
    const lastGlobal = { win: 0, lose: 0 };
    const lastLocal = { win: 0, lose: 0 };

    const sub = $('#wl-hot-sub', root);
    const hintWin = $('#wl-hint-win', root);
    const hintLose = $('#wl-hint-lose', root);

    if (hasGlobalHotkeys) {
      if (sub) sub.textContent = 'Hotkey global aktif selama halaman ini terbuka — tetap jalan saat fokus di aplikasi lain.';
      if (hintWin) hintWin.textContent = 'Hotkey global: Numpad +';
      if (hintLose) hintLose.textContent = 'Hotkey global: Numpad -';

      d(bridge.onWinloseHotkey((key) => {
        if (key !== 'win' && key !== 'lose') return;
        // Kalau keydown lokal sudah memproses tombol yang sama, jangan dobel.
        if (Date.now() - lastLocal[key] < 350) return;
        lastGlobal[key] = Date.now();
        change(key, 1);
      }));

      bridge.setWinloseHotkeys(true)
        .then((res) => {
          if (!res || res.ok !== false) return;
          toast(res.error || 'Hotkey global tidak bisa didaftarkan.', 'warn', 7000);
          if (sub) sub.textContent = 'Hotkey hanya aktif saat halaman ini fokus — global gagal didaftarkan.';
          if (hintWin) hintWin.textContent = 'Hotkey: Numpad Add ( + ) — halaman harus fokus';
          if (hintLose) hintLose.textContent = 'Hotkey: Numpad Minus ( - ) — halaman harus fokus';
        })
        .catch(() => {});

      // Lepas saat pindah halaman / app ditutup agar Numpad tidak terus ditahan.
      d(() => {
        try { bridge.setWinloseHotkeys(false); } catch (_) {}
      });
    }

    const onKey = (e) => {
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.code === 'NumpadAdd' ? 'win'
        : e.code === 'NumpadSubtract' ? 'lose' : '';
      if (!key) return;

      e.preventDefault();
      // Saat window fokus, global shortcut dan keydown bisa sama-sama terpicu.
      // Abaikan duplikat yang datang beruntun untuk aksi yang sama.
      if (Date.now() - lastGlobal[key] < 350) return;
      lastLocal[key] = Date.now();
      change(key, 1);
    };
    document.addEventListener('keydown', onKey);
    d(() => document.removeEventListener('keydown', onKey));

    return () => d.run();
  }
};
