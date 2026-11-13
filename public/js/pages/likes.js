import { $, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Sync } from '../lib/sync.js';
import { OVERLAYS } from '../lib/overlays.js';
import { toast, linkRowHTML, previewHTML, statusHTML, bindStatuses, mountPreviews, postToPreview } from '../lib/ui.js';

export const LIKES_DEFAULT = { decayOn: true, amount: 2, every: 8 };

export default {
  id: 'likes',
  title: 'Like Leaderboard',
  icon: 'heart',

  render() {
    const ov = OVERLAYS.likes;
    const c = Object.assign({}, LIKES_DEFAULT, Sync.get('likesCfg', {}));
    return (
      '<div class="ph"><h1>Like Leaderboard</h1><p>Tampilkan peringkat 10 penonton berdasarkan jumlah like (taptap) saat live berlangsung, lengkap dengan fitur pengurangan otomatis dalam interval tertentu.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Link Overlay</h2></div>' + statusHTML(ov.id) + '</div>' +
      linkRowHTML(ov) +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Status Data</h2><div class="sub">Sumber data yang saat ini ditampilkan di overlay.</div></div></div>' +
      '<div id="lk-data-status"></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Pengurangan Otomatis</h2><div class="sub">Like semua penonton dikurangi tiap interval tertentu, supaya peringkat terus bergerak. Hanya berlaku saat data demo (belum terhubung TikTok Live).</div></div></div>' +
      '<div class="sw-row"><div class="t"><b>Aktifkan pengurangan otomatis</b><span>Matikan jika like ingin tetap menumpuk.</span></div>' +
      '<label class="sw"><input type="checkbox" id="lk-on"' + (c.decayOn ? ' checked' : '') + ' aria-label="Aktifkan pengurangan otomatis"><i></i></label></div>' +
      '<div class="g2">' +
      '<div class="fgrp"><label class="lbl" for="lk-amt">Jumlah pengurangan</label><div class="field"><input id="lk-amt" type="number" inputmode="numeric" min="1" step="1" value="' + c.amount + '"><span class="unit">like</span></div></div>' +
      '<div class="fgrp"><label class="lbl" for="lk-int">Setiap interval</label><div class="field"><input id="lk-int" type="number" inputmode="numeric" min="1" step="1" value="' + c.every + '"><span class="unit">detik</span></div></div>' +
      '</div>' +
      '<div class="row"><button type="button" class="btn primary" id="lk-save">' + icon('save') + 'Simpan</button></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Preview Overlay</h2><div class="sub">Tampilan overlay sesuai kondisi saat ini.</div></div></div>' +
      previewHTML(ov, {
        title: 'Tampilan overlay',
        extra: '<button type="button" class="btn sm danger" id="lk-reset">' + icon('reset') + 'Reset Leaderboard</button>'
      }) +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    d(mountPreviews(root));
    d(bindStatuses(root));

    // ---- Status data (live / demo) ----
    function paintDataStatus() {
      const el = $('#lk-data-status', root);
      if (!el) return;
      const isLive = Sync.tiktok && Sync.tiktok.state === 'online';
      if (isLive) {
        const count = (Sync.likeLeaderboard || []).reduce((s, x) => s + (x.count || 0), 0);
        el.innerHTML =
          '<div class="alert a-ok">' + icon('checkCircle') +
          '<div><b>Data live TikTok aktif</b>' +
          '<span>Terhubung ke @' + (Sync.tiktok.username || '?') + ' — ' + count.toLocaleString('id') + ' like terkumpul.</span></div></div>';
      } else {
        el.innerHTML =
          '<div class="alert a-info">' + icon('info') +
          '<div><b>Menampilkan data demo</b>' +
          '<span>Hubungkan ke TikTok Live di halaman Koneksi untuk menampilkan data asli.</span></div></div>';
      }
    }

    paintDataStatus();
    d(Sync.on('tiktok', paintDataStatus));
    d(Sync.on('likeleaderboard', paintDataStatus));

    // Fetch status TikTok + config saat mount — fix untuk Cloudflare/tunnel.
    fetch('/api/tiktok/status')
      .then((r) => r.json())
      .then((s) => { if (s) { Sync.tiktok = s; paintDataStatus(); } })
      .catch(() => {});
    fetch('/api/state/likesCfg')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.value == null) return;
        Sync.state['likesCfg'] = res.value;
        const c = Object.assign({}, LIKES_DEFAULT, res.value);
        const onEl = $('#lk-on', root);
        const amtEl = $('#lk-amt', root);
        const intEl = $('#lk-int', root);
        if (onEl && document.activeElement !== onEl) onEl.checked = !!c.decayOn;
        if (amtEl && document.activeElement !== amtEl) amtEl.value = c.amount;
        if (intEl && document.activeElement !== intEl) intEl.value = c.every;
      })
      .catch(() => {});

    // ---- Reset leaderboard ----
    $('#lk-reset', root).addEventListener('click', async () => {
      const isLive = Sync.tiktok && Sync.tiktok.state === 'online';
      if (isLive) {
        try {
          await fetch('/api/likes/reset', { method: 'POST' });
          toast('Leaderboard live direset.', 'ok', 2200);
        } catch (e) {
          toast('Gagal reset: ' + e.message, 'err');
        }
        // Juga reset preview iframe
        postToPreview(root, 'likes', { type: 'reset' });
      } else {
        postToPreview(root, 'likes', { type: 'reset' });
        toast('Preview leaderboard direset.', 'info', 2000);
      }
    });

    // ---- Simpan pengaturan decay ----
    $('#lk-save', root).addEventListener('click', () => {
      const amount = Math.round(Number($('#lk-amt', root).value));
      const every = Math.round(Number($('#lk-int', root).value));
      if (!(amount >= 1)) return toast('Jumlah pengurangan minimal 1.', 'err');
      if (!(every >= 1)) return toast('Interval minimal 1 detik.', 'err');
      Sync.set('likesCfg', { decayOn: $('#lk-on', root).checked, amount, every });
      toast('Pengaturan leaderboard disimpan.', 'ok');
    });

    return () => d.run();
  }
};
