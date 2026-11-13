import { $, esc, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmt } from '../lib/format.js';
import { loadGifts, invalidateGifts, giftCardHTML } from '../lib/gifts.js';

export default {
  id: 'gifts',
  title: 'TikTok Data Gift',
  icon: 'gift',

  render() {
    return (
      '<div class="ph"><h1>TikTok Data Gift</h1><p>Database gift TikTok lengkap dengan gambar dan namanya. Cari gift lewat nama.</p></div>' +
      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Daftar Gift</h2><div class="sub" id="gf-count"></div></div>' +
      '<span class="chip" id="gf-src" hidden></span></div>' +
      '<div class="gifts-search"><div class="field pre"><i>' + icon('search') + '</i>' +
      '<input id="gf-q" type="search" autocomplete="off" spellcheck="false" placeholder="Cari nama gift" aria-label="Cari nama gift"></div>' +
      '<button type="button" class="btn sm ghost" id="gf-refresh" title="Muat ulang data gift">' + icon('refresh') + 'Refresh</button></div>' +
      '<div id="gf-alert"></div>' +
      '<div class="gifts" id="gf-grid"></div>' +
      '</section>'
    );
  },

  mount(root) {
    const d = disposer();
    const grid = $('#gf-grid', root);
    const countEl = $('#gf-count', root);
    const srcChip = $('#gf-src', root);
    const alertBox = $('#gf-alert', root);

    let allGifts = [];
    let loading = false;

    const setAlert = (msg, type) => {
      alertBox.innerHTML = msg
        ? '<div class="alert a-' + (type || 'info') + '">' + icon(type === 'err' ? 'alertCircle' : 'info') + '<div>' + msg + '</div></div>'
        : '';
    };

    const paint = () => {
      const q = $('#gf-q', root).value.trim().toLowerCase();
      const list = allGifts.filter((g) => !q || g.name.toLowerCase().includes(q));
      countEl.textContent = q ? list.length + ' dari ' + allGifts.length + ' gift' : allGifts.length + ' gift';
      grid.innerHTML = loading
        ? '<div class="empty" style="grid-column:1/-1">' + icon('loader') + '<b>Memuat data gift…</b></div>'
        : list.length
          ? list.map((g) => giftCardHTML(g, null, esc, icon, fmt)).join('')
          : '<div class="empty" style="grid-column:1/-1">' + icon('search') + '<b>Gift tidak ditemukan</b><span>Coba kata kunci lain.</span></div>';
    };

    const doLoad = async (forceRefresh) => {
      if (loading) return;
      if (forceRefresh) invalidateGifts();
      loading = true;
      setAlert('');
      paint();
      const gifts = await loadGifts();
      allGifts = gifts;
      loading = false;
      // gift demo punya field 'emoji'; gift live dari server tidak
      if (gifts.length && gifts[0].emoji !== undefined) {
        srcChip.textContent = 'Data demo (offline)';
        srcChip.hidden = false;
        setAlert('<b>Mode offline</b> — Tidak berhasil terhubung ke streamtoearn.io. Menampilkan data contoh.', 'warn');
      } else {
        srcChip.textContent = 'Live: streamtoearn.io';
        srcChip.hidden = false;
        setAlert('');
      }
      paint();
    };

    $('#gf-q', root).addEventListener('input', paint);
    $('#gf-refresh', root).addEventListener('click', () => doLoad(true));
    doLoad(false);

    return () => d.run();
  }
};
