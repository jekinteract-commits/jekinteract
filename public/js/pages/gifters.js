import { $, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Sync } from '../lib/sync.js';
import { OVERLAYS } from '../lib/overlays.js';
import { toast, linkRowHTML, previewHTML, statusHTML, bindStatuses, mountPreviews, confirmDialog } from '../lib/ui.js';

const SOURCES = [
  ['realtime', 'Realtime', 'Realtime data dari live sekarang.'],
  ['7d', '7 Hari Terakhir', 'Menampilkan data selama 7 hari terakhir.'],
  ['14d', '14 Hari Terakhir', 'Menampilkan data selama 14 hari terakhir.'],
  ['30d', '30 Hari Terakhir', 'Menampilkan data selama 30 hari terakhir.']
];

export default {
  id: 'gifters',
  title: 'Top Gifter Leaderboard',
  icon: 'crown',

  render() {
    const ov = OVERLAYS.gifters;
    const c = Object.assign({ source: 'realtime' }, Sync.get('gifterCfg', {}));
    const cur = SOURCES.find((s) => s[0] === c.source) || SOURCES[0];
    return (
      '<div class="ph"><h1>Top Gifter Leaderboard</h1><p>Tampilkan peringkat 10 penonton berdasarkan jumlah koin yang diberikan saat live berlangsung.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Link Overlay</h2></div>' + statusHTML(ov.id) + '</div>' +
      linkRowHTML(ov) +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Setingan</h2></div>' +
      '<button type="button" class="btn sm danger" id="gf-reset">' + icon('reset') + 'Reset Leaderboard</button></div>' +
      '<div class="fgrp"><label class="lbl" for="gf-src">Sumber Data</label>' +
      '<div class="field sel"><select id="gf-src">' +
      SOURCES.map(([v, l]) => '<option value="' + v + '"' + (c.source === v ? ' selected' : '') + '>' + l + '</option>').join('') +
      '</select></div><p class="hint" id="gf-src-desc">' + cur[2] + '</p></div>' +
      '<div class="row"><button type="button" class="btn primary" id="gf-save">' + icon('save') + 'Simpan</button></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Preview Overlay</h2><div class="sub">Menampilkan data gift live jika TikTok sudah terhubung, atau data contoh bila belum.</div></div></div>' +
      previewHTML(ov, { title: 'Tampilan overlay' }) +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    d(mountPreviews(root));
    d(bindStatuses(root));

    // Fetch gifterCfg via REST — fix Cloudflare/tunnel (SSE hello bisa terlambat).
    fetch('/api/state/gifterCfg')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.value == null) return;
        Sync.state['gifterCfg'] = res.value;
        const src = res.value.source || 'realtime';
        const sel = $('#gf-src', root);
        if (sel && document.activeElement !== sel) {
          sel.value = src;
          const s = SOURCES.find((x) => x[0] === src);
          const desc = $('#gf-src-desc', root);
          if (s && desc) desc.textContent = s[2];
        }
      })
      .catch(() => {});

    $('#gf-src', root).addEventListener('change', (e) => {
      const s = SOURCES.find((x) => x[0] === e.target.value);
      $('#gf-src-desc', root).textContent = s ? s[2] : '';
    });

    $('#gf-save', root).addEventListener('click', () => {
      Sync.set('gifterCfg', { source: $('#gf-src', root).value });
      toast('Sumber data disimpan.', 'ok');
    });

    $('#gf-reset', root).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Reset leaderboard',
        message: 'Hapus semua peringkat gifter pada leaderboard? Tindakan ini tidak bisa dibatalkan.',
        okText: 'Reset',
        danger: true
      });
      if (!ok) return;
      if (Sync.tiktok && Sync.tiktok.state === 'online') {
        // Saat live: reset langsung di server via API
        fetch('/api/gifters/reset', { method: 'POST' }).catch(() => {});
      }
      Sync.set('cmd-gifters', { ts: Date.now() });
      toast('Leaderboard direset.', 'ok');
    });

    return () => d.run();
  }
};
