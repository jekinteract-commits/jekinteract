import { $, esc, on, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Sync } from '../lib/sync.js';
import { HISTORY_DAYS } from '../lib/store.js';
import { allSessions } from '../lib/live.js';
import { fmt, pad2, MONTHS_SHORT } from '../lib/format.js';

const STEP = 10;

export default {
  id: 'analytics',
  title: 'Analytics',
  icon: 'analytics',

  render() {
    return (
      '<div class="ph"><h1>Analytics</h1><p>Lihat akun TikTok yang pernah live, lengkap dengan judul, waktu, follower, dan statistik gift-nya.</p></div>' +
      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Riwayat Live</h2><div class="sub" id="an-sub"></div></div>' +
      '<span class="chip" id="an-live" hidden>Live sekarang</span></div>' +
      '<div class="alert a-info">' + icon('info') + '<div><b>Disimpan ' + HISTORY_DAYS + ' hari terakhir</b>' +
      'Riwayat yang sudah lewat dari ' + HISTORY_DAYS + ' hari dihapus otomatis. Data diambil langsung dari live yang terhubung.</div></div>' +
      '<div class="tbl" id="an-table" role="table" aria-label="Riwayat live"></div>' +
      '<div class="an-more" id="an-more"></div>' +
      '</section>'
    );
  },

  mount(root) {
    const d = disposer();
    let shown = STEP;

    const paint = () => {
      const list = allSessions().slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      $('#an-sub', root).textContent = list.length ? list.length + ' sesi live tersimpan' : 'Belum ada sesi';
      $('#an-live', root).hidden = !list.some((e) => e.live);

      const table = $('#an-table', root);
      const more = $('#an-more', root);

      if (!list.length) {
        table.innerHTML =
          '<div class="empty">' + icon('analytics') + '<b>Belum ada riwayat live</b>' +
          '<span>Riwayat akan muncul setelah kamu terhubung ke sebuah live.</span></div>';
        more.innerHTML = '';
        return;
      }

      const rows = list.slice(0, shown).map((e) => {
        const dt = new Date(e.startedAt || Date.now());
        const time = pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
        const date = pad2(dt.getDate()) + ' ' + MONTHS_SHORT[dt.getMonth()] + ' ' + dt.getFullYear();
        const top = e.topGifter;
        const topUser = top ? (top.user || top.nickname || 'Anonim') : '';
        return (
          '<div class="tr" role="row">' +
          '<span class="td acc" role="cell"><b>@' + esc(e.username || e.nickname || '—') + '</b></span>' +
          '<span class="td ttl" role="cell">' + esc(e.title || ('Live @' + (e.username || ''))) + '</span>' +
          '<span class="td" role="cell" data-l="Jam">' + time + '</span>' +
          '<span class="td" role="cell" data-l="Tanggal">' + date + '</span>' +
          '<span class="td" role="cell" data-l="Follower" title="Follower baru saat live. Total follower akun: ' + fmt(e.followerCount) + '">' + fmt(e.followers) + '</span>' +
          '<span class="td" role="cell" data-l="Top Gifter">' + (top ? '@' + esc(topUser) : '—') + '</span>' +
          '<span class="td" role="cell" data-l="Coin Top Gifter">' + (top ? fmt(top.coins) : '—') + '</span>' +
          '<span class="td" role="cell" data-l="Total Coin">' + fmt(e.coins) + '</span>' +
          '</div>'
        );
      });

      table.innerHTML =
        '<div class="tr th" role="row"><span class="td acc" role="columnheader">Akun TikTok</span>' +
        '<span class="td ttl" role="columnheader">Judul Live</span>' +
        '<span class="td" role="columnheader">Jam</span><span class="td" role="columnheader">Tanggal</span>' +
        '<span class="td" role="columnheader">Follower</span><span class="td" role="columnheader">Top Gifter</span>' +
        '<span class="td" role="columnheader">Coin Top Gifter</span><span class="td" role="columnheader">Total Coin</span></div>' + rows.join('');

      const left = list.length - shown;
      more.innerHTML = left > 0 ? '<button type="button" class="btn" data-more>Tampilkan ' + Math.min(STEP, left) + ' lagi (' + left + ' tersisa)</button>' : '';
    };

    d(on(root, 'click', '[data-more]', () => {
      shown += STEP;
      paint();
    }));
    d(Sync.on('livestats', paint));

    // Fetch live stats sekali saat mount — fix untuk Cloudflare/tunnel di mana
    // SSE hello bisa terlambat sehingga Sync.liveStats masih kosong saat render pertama.
    fetch('/api/live/stats')
      .then((r) => r.json())
      .then((data) => {
        if (!data) return;
        Sync.liveStats = data;
        paint();
      })
      .catch(() => {});

    paint();
    return () => d.run();
  }
};
