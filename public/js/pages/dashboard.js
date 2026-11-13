import { $, esc, on, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Sync } from '../lib/sync.js';
import { Session } from '../lib/store.js';
import { OVERLAY_TOTAL } from '../lib/overlays.js';
import { avatar } from '../lib/avatar.js';
import { fmt, compact, fmtMinutes, fmtDateShort, fmtDateLong, DAYS_SHORT } from '../lib/format.js';
import { dailyFromSessions, aggregateDays, sessionsBetween, topGiftersFromSessions } from '../lib/live.js';
import { rangeFilterHTML, bindRangeFilter, countUp } from '../lib/ui.js';

/** Animasi pembuka hanya sekali per sesi browser. */
function bootClass() {
  try {
    if (sessionStorage.getItem('ji:booted')) return '';
    sessionStorage.setItem('ji:booted', '1');
    return 'boot';
  } catch (_) {
    return '';
  }
}

const CELLS = [
  { k: 'lives', label: 'Total live', f: fmt, unit: 'sesi' },
  { k: 'minutes', label: 'Total durasi', f: fmtMinutes },
  { k: 'peak', label: 'Penonton puncak', f: fmt },
  { k: 'likes', label: 'Total like', f: compact, tone: 'like' },
  { k: 'coins', label: 'Total koin', f: compact, tone: 'coin' },
  { k: 'followers', label: 'Follower baru', f: fmt },
  { k: 'shares', label: 'Total share', f: fmt },
  { k: 'comments', label: 'Total komentar', f: compact }
];

export default {
  id: 'dashboard',
  title: 'Dashboard',
  icon: 'dashboard',

  render() {
    return (
      '<div class="stack">' +
      '<section class="panel hero ' + bootClass() + '">' +
      '<div class="marquee" aria-hidden="true"></div>' +
      '<div class="hero-body">' +
      '<img class="hero-emblem" src="/assets/logo.svg" alt="" width="120" height="120">' +
      '<div class="hero-copy">' +
      '<h1 class="hero-title">Selamat Datang di JekInteract</h1>' +
      '<p class="hero-sub">Atur interaksi live TikTok, overlay, dan tools stream dari satu panel.</p>' +
      '<div class="row hero-cta">' +
      '<a class="btn primary" href="#/connection">' + icon('plug') + 'Hubungkan ke Live</a>' +
      '<a class="btn" href="#/interaksi">' + icon('gamepad') + 'Pusat Interaksi</a></div></div></div>' +
      '<dl class="hud">' +
      '<div><dt>Koneksi live</dt><dd id="hud-conn"></dd></div>' +
      '<div><dt>Overlay online</dt><dd id="hud-ov"></dd></div>' +
      '<div><dt>Kontrol OBS</dt><dd id="hud-obs"></dd></div>' +
      '<div><dt>Antrean screen</dt><dd id="hud-q"></dd></div></dl>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Sorotan Live</h2><div class="sub" id="st-sub"></div></div>' + rangeFilterHTML('stats') + '</div>' +
      '<div class="score" id="score"></div>' +
      '<div class="bars-wrap">' +
      '<div class="bars-head"><span>Koin per hari</span><span class="muted" id="bars-cap">Ketuk batang untuk melihat nilainya</span></div>' +
      '<div class="bars" id="bars"></div>' +
      '<div class="bars-axis"><span id="ax-a"></span><span id="ax-b"></span></div></div>' +
      '<p class="hint demo-note" id="st-note">Data diambil dari live TikTok yang terhubung. Riwayat disimpan 30 hari terakhir.</p>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Top Gifter Selama Live</h2><div class="sub" id="gf-sub"></div></div>' + rangeFilterHTML('gifters') + '</div>' +
      '<ol class="lb" id="gf-list"></ol>' +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();

    /* ---- HUD hero ---- */
    const paintHud = () => {
      const s = Session.get();
      const tk = Sync.tiktok || {};
      const conn = tk.state === 'online' || tk.state === 'connecting' || tk.state === 'error'
        ? { status: tk.state === 'online' ? 'online' : tk.state === 'connecting' ? 'connecting' : 'offline', username: tk.username || '' }
        : s.connection;
      $('#hud-conn', root).innerHTML =
        conn.status === 'online' ? '<span class="st on"><i></i>@' + esc(conn.username) + '</span>'
        : conn.status === 'connecting' ? '<span class="st wait"><i></i>Menghubungkan</span>'
        : '<span class="st off"><i></i>Offline</span>';
      const n = Object.values(Sync.status.overlays).filter((v) => v > 0).length;
      $('#hud-ov', root).innerHTML = '<span class="hud-n">' + n + '</span><small>dari ' + OVERLAY_TOTAL + '</small>';
      $('#hud-obs', root).innerHTML =
        s.obs.status === 'online' ? '<span class="st on"><i></i>Tersambung</span>' : '<span class="st off"><i></i>Belum tersambung</span>';
      const q = Object.values(Sync.status.queues).reduce((a, b) => a + b, 0);
      $('#hud-q', root).innerHTML = '<span class="hud-n">' + q + '</span><small>item menunggu</small>';
    };
    paintHud();
    d(Session.on(paintHud));
    d(Sync.on('status', paintHud));
    d(Sync.on('tiktok', paintHud));

    /* ---- Sorotan Live ---- */
    const paintStats = ({ from, to }) => {
      const days = dailyFromSessions(from, to);
      const agg = aggregateDays(days);
      $('#st-sub', root).textContent = fmtDateLong(from) + ' sampai ' + fmtDateLong(to);

      const host = $('#score', root);
      if (!host.children.length) {
        host.innerHTML = CELLS.map(
          (c) => '<div class="sc ' + (c.tone || '') + '"><span class="sc-l">' + c.label + '</span><b class="sc-v" data-k="' + c.k + '">0</b>' + (c.unit ? '<span class="sc-u">' + c.unit + '</span>' : '') + '</div>'
        ).join('');
      }
      CELLS.forEach((c) => countUp($('[data-k="' + c.k + '"]', host), agg[c.k], c.f));

      const bars = $('#bars', root);
      if (!days.length) {
        bars.innerHTML = '<div class="bars-empty">Tidak ada data pada rentang ini.</div>';
        $('#ax-a', root).textContent = '';
        $('#ax-b', root).textContent = '';
        return;
      }
      const max = Math.max(1, ...days.map((x) => x.coins));
      bars.innerHTML = days
        .map((x) => {
          const tip = DAYS_SHORT[x.date.getDay()] + ', ' + fmtDateShort(x.date) + ': ' + fmt(x.coins) + ' koin';
          return '<i class="' + (x.coins ? '' : 'z') + '" style="height:' + Math.max(3, Math.round((x.coins / max) * 100)) + '%" data-tip="' + esc(tip) + '" title="' + esc(tip) + '"></i>';
        })
        .join('');
      $('#bars-cap', root).textContent = 'Ketuk batang untuk melihat nilainya';
      $('#ax-a', root).textContent = fmtDateShort(days[0].date);
      $('#ax-b', root).textContent = fmtDateShort(days[days.length - 1].date);
    };
    d(on(root, 'click', '.bars i', (e, el) => {
      $('#bars-cap', root).textContent = el.dataset.tip;
    }));
    const statsRange = bindRangeFilter(root, 'stats', paintStats);

    /* ---- Top Gifter ---- */
    const paintGifters = ({ from, to }) => {
      const list = topGiftersFromSessions(sessionsBetween(from, to), 10);
      $('#gf-sub', root).textContent = fmtDateLong(from) + ' sampai ' + fmtDateLong(to);
      const host = $('#gf-list', root);
      if (!list.length) {
        host.innerHTML = '<li class="empty">' + icon('crown') + '<b>Belum ada gifter</b><span>Belum ada gift pada rentang ini.</span></li>';
        return;
      }
      const top = list[0].coins;
      host.innerHTML = list
        .map(
          (g, i) =>
            '<li class="lb-i r' + (i + 1) + '"><span class="lb-r">' + (i + 1) + '</span>' + avatar(g.user, 42) +
            '<div class="lb-m"><b>@' + esc(g.user) + '</b><span class="lb-bar"><i style="width:' + Math.max(4, Math.round((g.coins / top) * 100)) + '%"></i></span></div>' +
            '<span class="lb-v">' + icon('coin') + fmt(g.coins) + '</span></li>'
        )
        .join('');
    };
    const giftersRange = bindRangeFilter(root, 'gifters', paintGifters);

    /* ---- Perbarui kedua panel saat data live berubah (realtime) ---- */
    d(Sync.on('livestats', () => {
      paintStats(statsRange.bounds());
      paintGifters(giftersRange.bounds());
    }));

    // Fetch live stats sekali saat mount — fix untuk Cloudflare/tunnel di mana
    // SSE hello bisa terlambat sehingga Sync.liveStats masih kosong saat render pertama.
    fetch('/api/live/stats')
      .then((r) => r.json())
      .then((d) => {
        if (!d) return;
        Sync.liveStats = d;
        paintStats(statsRange.bounds());
        paintGifters(giftersRange.bounds());
      })
      .catch(() => {});

    return () => d.run();
  }
};
