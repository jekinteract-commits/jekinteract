import { $, esc, on, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Sync, API } from '../lib/sync.js';
import { OVERLAYS } from '../lib/overlays.js';
import { toast, linkRowHTML, previewHTML, statusHTML, bindStatuses, mountPreviews } from '../lib/ui.js';

export const GOALS = [
  { k: 'like', title: 'Target Like/Tap Tap', def: 5000 },
  { k: 'share', title: 'Target Share', def: 100 },
  { k: 'follower', title: 'Target Follower', def: 100 },
  { k: 'coin', title: 'Target Coin', def: 1000 }
];

const load = () => {
  const s = Sync.get('goals', {});
  const out = {};
  GOALS.forEach((g) => {
    out[g.k] = Object.assign({ target: g.def, current: 0 }, s[g.k] || {});
  });
  return out;
};

export default {
  id: 'goals',
  title: 'Goals',
  icon: 'target',

  render() {
    const all = load();
    return (
      '<div class="ph"><h1>Goals</h1><p>Tampilkan target yang ingin dicapai selama live. Progres terisi otomatis dari data TikTok Live saat sudah terhubung, dan di-reset ke 0 saat disconnect.</p></div>' +
      '<div class="g2 goals">' +
      GOALS.map((g) => {
        const ov = OVERLAYS['goal-' + g.k];
        return (
          '<section class="panel goal" data-goal="' + g.k + '">' +
          '<div class="fh"><div class="fh-t"><h2>' + g.title + '</h2><div class="sub" data-prog>' + all[g.k].current + '/' + all[g.k].target + '</div></div>' + statusHTML(ov.id) + '</div>' +
          linkRowHTML(ov) +
          '<div class="fgrp"><label class="lbl" for="gl-t-' + g.k + '">Target</label>' +
          '<div class="row nowrap"><div class="field short"><input id="gl-t-' + g.k + '" data-target type="number" inputmode="numeric" min="1" step="1" value="' + all[g.k].target + '"></div>' +
          '<button type="button" class="btn primary" data-save>' + icon('save') + 'Simpan</button></div></div>' +
          (g.k === 'coin'
            ? '<div class="fgrp"><label class="lbl" for="gl-l-coin">Tulisan Overlay</label>' +
              '<div class="field"><input id="gl-l-coin" data-label type="text" maxlength="60" autocomplete="off" placeholder="Target Coin" value="' + esc(all.coin.label || 'Target Coin') + '"></div>' +
              '<p class="hint">Tulisan di overlay. Kosongkan untuk kembali ke "Target Coin".</p></div>'
            : '') +
          previewHTML(ov, {
            title: 'Preview Overlay — live saat TikTok terhubung',
            extra:
              '<button type="button" class="btn sm" data-test title="Tambah progres contoh">' + icon('plus') + 'Tes</button>' +
              '<button type="button" class="btn sm danger" data-reset>' + icon('reset') + 'Reset Jumlah</button>'
          }) +
          '</section>'
        );
      }).join('') +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    d(mountPreviews(root));
    d(bindStatuses(root));

    const paint = () => {
      const all = load();
      GOALS.forEach((g) => {
        const card = $('[data-goal="' + g.k + '"]', root);
        $('[data-prog]', card).textContent = all[g.k].current + '/' + all[g.k].target;
        // Update juga nilai input target kalau berubah dari server
        const inp = $('[data-target]', card);
        if (inp && document.activeElement !== inp) inp.value = all[g.k].target;
        const labelEl = $('[data-label]', card);
        if (labelEl && document.activeElement !== labelEl) labelEl.value = all[g.k].label || g.title;
      });
    };
    d(Sync.on('state', (e) => {
      if (e.key === 'goals' || e.key === '*') paint();
    }));

    // Fetch state langsung saat mount — fix untuk Cloudflare/tunnel.
    fetch('/api/state/goals')
      .then((r) => r.json())
      .then((res) => {
        if (res && res.value != null) { Sync.state['goals'] = res.value; paint(); }
      })
      .catch(() => {});

    const update = (k, patch) => {
      const all = load();
      all[k] = Object.assign(all[k], patch);
      all[k].current = Math.min(Math.max(0, all[k].current), all[k].target);
      Sync.set('goals', all);
      paint();
    };
    const keyOf = (btn) => btn.closest('[data-goal]').dataset.goal;

    d(on(root, 'click', '[data-goal] [data-save]', (e, btn) => {
      const k = keyOf(btn);
      const card = btn.closest('[data-goal]');
      const target = Math.round(Number($('[data-target]', card).value));
      if (!(target >= 1)) return toast('Target minimal 1.', 'err');
      const patch = { target };
      const labelEl = $('[data-label]', card);
      if (labelEl) patch.label = labelEl.value.trim();
      update(k, patch);
      toast('Target disimpan.', 'ok', 2200);
    }));
    d(on(root, 'click', '[data-goal] [data-reset]', (e, btn) => {
      const k = keyOf(btn);
      if (Sync.tiktok && Sync.tiktok.state === 'online') {
        // Saat live: reset hanya counter goal yang diklik di server.
        API.resetGoal(k).catch((err) => toast('Gagal reset: ' + err.message, 'err'));
      } else {
        update(k, { current: 0 });
      }
      toast('Jumlah direset ke 0.', 'info', 2000);
    }));
    d(on(root, 'click', '[data-goal] [data-test]', (e, btn) => {
      const k = keyOf(btn);
      const cur = load()[k];
      update(k, { current: cur.current + Math.max(1, Math.round(cur.target * 0.1)) });
    }));

    return () => d.run();
  }
};
