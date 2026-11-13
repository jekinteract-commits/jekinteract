import { $, disposer } from '../lib/dom.js';
import { Sync } from '../lib/sync.js';
import { OVERLAYS } from '../lib/overlays.js';
import { WHO_FULL } from '../lib/demo.js';
import { linkRowHTML, previewHTML, statusHTML, bindStatuses, mountPreviews } from '../lib/ui.js';

export default {
  id: 'chat',
  title: 'Komen',
  icon: 'chat',

  render() {
    const ov = OVERLAYS.chat;
    const c = Object.assign({ who: 'all' }, Sync.get('chatCfg', {}));
    return (
      '<div class="ph"><h1>Chat / Komen</h1><p>Tampilkan komentar penonton live di layar. Tiap komentar menampilkan foto profil, nama TikTok, dan isi komentarnya.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Link Overlay</h2></div>' + statusHTML(ov.id) + '</div>' +
      linkRowHTML(ov) +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Setingan Umum</h2></div><span class="saved" id="ch-saved" aria-live="polite"></span></div>' +
      '<div class="fgrp"><label class="lbl" for="ch-who">Siapa saja yang ditampilkan di overlay chat/komen?</label>' +
      '<div class="field sel"><select id="ch-who">' +
      WHO_FULL.map(([v, l]) => '<option value="' + v + '"' + (c.who === v ? ' selected' : '') + '>' + l + '</option>').join('') +
      '</select></div><p class="hint">Perubahan langsung tersimpan dan terlihat di preview.</p></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Preview Overlay</h2><div class="sub">Menampilkan komentar live jika TikTok sudah terhubung, atau komentar contoh bila belum.</div></div></div>' +
      previewHTML(ov, { title: 'Tampilan overlay' }) +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    d(mountPreviews(root));
    d(bindStatuses(root));

    // Fetch chatCfg via REST — fix Cloudflare/tunnel (SSE hello bisa terlambat).
    fetch('/api/state/chatCfg')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.value == null) return;
        Sync.state['chatCfg'] = res.value;
        const sel = $('#ch-who', root);
        if (sel && document.activeElement !== sel) sel.value = res.value.who || 'all';
      })
      .catch(() => {});

    let timer = null;
    d(() => clearTimeout(timer));
    $('#ch-who', root).addEventListener('change', (e) => {
      Sync.set('chatCfg', { who: e.target.value });
      const el = $('#ch-saved', root);
      el.textContent = 'Tersimpan otomatis';
      el.classList.add('show');
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove('show'), 1600);
    });

    return () => d.run();
  }
};
