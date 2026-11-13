/* Overlay leaderboard top 10 — dipakai untuk Like Leaderboard dan Top Gifter.
 * Like Leaderboard: data realtime dari TikTok Live bila sudah terhubung, demo bila belum.
 * Top Gifter: data realtime dari TikTok Live bila sudah terhubung, demo bila belum.
 */
import { USERS, pick, rand } from '../lib/demo.js';
import { avatar, avatarURL } from '../lib/avatar.js';
import { icon } from '../lib/icons.js';
import { fmt } from '../lib/format.js';
import { esc } from '../lib/dom.js';

const ROW = 64;
const FACTOR = { realtime: 1, '7d': 8, '14d': 15, '30d': 30 };
const SRC_LABEL = { realtime: 'Realtime', '7d': '7 hari terakhir', '14d': '14 hari terakhir', '30d': '30 hari terakhir' };

export default function mount(ctx) {
  const { root, Sync, type, preview } = ctx;
  const isLikes = type === 'likes';
  const isGifters = type === 'gifters';

  root.innerHTML =
    '<div class="ovp cut brd ' + type + '">' +
    '<div class="brd-h"><span class="brd-ic">' + icon(isLikes ? 'heart' : 'crown') + '</span>' +
    '<div><b>' + (isLikes ? 'Top 10 Like' : 'Top Gifter') + '</b><small id="b-sub"></small></div></div>' +
    '<div class="brd-list" id="b-list" style="height:' + ROW * 10 + 'px"><div class="brd-empty" id="b-empty" hidden>Belum ada data</div></div>' +
    '</div>';

  const list = root.querySelector('#b-list');
  const empty = root.querySelector('#b-empty');
  const sub = root.querySelector('#b-sub');
  const rows = new Map();
  const vals = new Map(); // user/id → angka (untuk demo)
  const demoUsers = USERS.slice(0, 16);

  const cfg = () =>
    isLikes
      ? Object.assign({ decayOn: true, amount: 2, every: 8 }, Sync.get('likesCfg', {}))
      : Object.assign({ source: 'realtime' }, Sync.get('gifterCfg', {}));

  // Apakah sedang dalam mode live (TikTok sudah connect)?
  // Tracked via flag — diset true saat connected, false saat disconnected.
  let liveMode = false;

  const flash = (el) => {
    el.classList.remove('up');
    void el.offsetWidth;
    el.classList.add('up');
  };

  /**
   * Buat elemen row. Untuk live: tampilkan foto profil TikTok asli kalau ada.
   * avatarSrc: URL foto TikTok atau null (pakai generated SVG).
   */
  function rowEl(displayName, avatarSrc) {
    const el = document.createElement('div');
    el.className = 'brd-row';
    const imgSrc = avatarSrc || avatarURL(displayName);
    el.innerHTML =
      '<span class="brd-rank"></span>' +
      '<img class="av brd-av" src="' + esc(imgSrc) + '" width="46" height="46" alt="" draggable="false" onerror="this.src=\'' + avatarURL(displayName) + '\'">' +
      '<div class="brd-main"><b class="brd-name">' + esc(displayName) + '</b>' +
      '<span class="brd-val">' + icon(isLikes ? 'heart' : 'coin') + '<em data-v="0">0</em></span></div>';
    return el;
  }

  function layout(entries) {
    // entries: [{user, v, avatarSrc?}] (demo) atau [{id, nickname, avatarUrl, count}] (live)
    const top = entries
      .filter((x) => (x.v || x.count || 0) > 0)
      .sort((a, b) => (b.v || b.count || 0) - (a.v || a.count || 0))
      .slice(0, 10)
      .map((x) => ({
        user: x.user || x.id,
        label: x.nickname || x.user || x.id,
        v: x.v || x.count || 0,
        avatarSrc: x.avatarUrl || x.avatarSrc || null
      }));

    const keep = new Set(top.map((x) => x.user));

    rows.forEach((el, u) => {
      if (keep.has(u)) return;
      rows.delete(u);
      el.classList.add('leave');
      setTimeout(() => el.remove(), 340);
    });

    top.forEach((x, i) => {
      let el = rows.get(x.user);
      if (!el) {
        el = rowEl(x.label, x.avatarSrc);
        el.style.transform = 'translateY(' + (i * ROW + 24) + 'px)';
        list.appendChild(el);
        rows.set(x.user, el);
        void el.offsetWidth; // pastikan posisi awal tercatat sebelum dianimasikan
      }
      // Update nama kalau berubah
      const nameEl = el.querySelector('.brd-name');
      if (nameEl && nameEl.textContent !== x.label) nameEl.textContent = x.label;
      // Update foto profil kalau ada URL baru
      if (x.avatarSrc) {
        const img = el.querySelector('.brd-av');
        if (img && img.src !== x.avatarSrc) img.src = x.avatarSrc;
      }
      el.style.transform = 'translateY(' + i * ROW + 'px)';
      el.style.opacity = '1';
      el.dataset.rank = String(i + 1);
      el.querySelector('.brd-rank').textContent = String(i + 1);
      const em = el.querySelector('em');
      const prev = Number(em.dataset.v);
      if (x.v !== prev) {
        em.textContent = fmt(x.v);
        em.dataset.v = String(x.v);
        if (x.v > prev && prev > 0) flash(em);
      }
    });
    empty.hidden = top.length > 0;
  }

  function subtitle() {
    const c = cfg();
    if (liveMode) {
      sub.textContent = 'Data live TikTok';
    } else if (isLikes) {
      sub.textContent = c.decayOn ? 'Tap-tap terbanyak, berkurang otomatis' : 'Tap-tap terbanyak';
    } else {
      sub.textContent = SRC_LABEL[c.source] || 'Realtime';
    }
  }

  /* -------- Demo data (dipakai saat TikTok belum terhubung) -------- */
  function buildDemoEntries() {
    return Array.from(vals, ([user, v]) => ({ user, v }));
  }

  function seed() {
    const f = isLikes ? 1 : FACTOR[cfg().source] || 1;
    demoUsers.forEach((u) => vals.set(u, Math.round(rand(isLikes ? 120 : 200, isLikes ? 2400 : 5200) * f)));
  }

  function reset() {
    vals.forEach((_, u) => vals.set(u, 0));
    layout(buildDemoEntries());
  }

  let decay = null;
  function setupDecay() {
    clearInterval(decay);
    if (!isLikes || liveMode) return; // decay hanya untuk demo
    const c = cfg();
    if (!c.decayOn) return;
    decay = setInterval(() => {
      if (liveMode) { clearInterval(decay); decay = null; return; }
      vals.forEach((v, u) => vals.set(u, Math.max(0, v - c.amount)));
      layout(buildDemoEntries());
    }, Math.max(1, c.every) * 1000);
  }

  let demoTicker = null;
  function startDemo() {
    stopDemo();
    liveMode = false;
    seed();
    subtitle();
    setupDecay();
    layout(buildDemoEntries());
    demoTicker = setInterval(() => {
      if (liveMode) { stopDemo(); return; }
      const u = pick(demoUsers);
      const inc = isLikes ? rand(6, 70) : Math.random() < 0.12 ? rand(200, 900) : rand(1, 120);
      vals.set(u, (vals.get(u) || 0) + inc);
      layout(buildDemoEntries());
    }, isLikes ? 900 : 1500);
  }

  function stopDemo() {
    clearInterval(demoTicker);
    demoTicker = null;
    clearInterval(decay);
    decay = null;
  }

  /* -------- Live data -------- */
  function applyLive(board) {
    // board: [{id, nickname, avatarUrl, count}]
    layout(board);
    subtitle();
  }

  function switchToLive() {
    stopDemo();
    liveMode = true;
    // Hapus baris demo dengan animasi
    rows.forEach((el) => { el.classList.add('leave'); setTimeout(() => el.remove(), 340); });
    rows.clear();
    subtitle();
    applyLive(isGifters ? (Sync.giftLeaderboard || []) : (Sync.likeLeaderboard || []));
  }

  function switchToDemo() {
    liveMode = false;
    stopDemo();
    rows.forEach((el) => { el.classList.add('leave'); setTimeout(() => el.remove(), 340); });
    rows.clear();
    startDemo();
  }

  /* -------- Init -------- */
  // Kalau TikTok sudah online saat overlay dibuka → langsung mode live.
  // Cek via Sync.tiktok (diisi dari SSE hello) ATAU langsung fetch REST API
  // sebagai fallback (menangani Cloudflare/tunnel di mana SSE hello bisa terlambat
  // atau tidak tersampaikan sama sekali).
  if ((isLikes || isGifters) && Sync.tiktok && Sync.tiktok.state === 'online') {
    liveMode = true;
    subtitle();
    applyLive(isGifters ? (Sync.giftLeaderboard || []) : (Sync.likeLeaderboard || []));
  } else {
    startDemo();
  }

  /* -------- Sync events -------- */

  Sync.on('likeleaderboard', (board) => {
    if (!isLikes) return;
    if (!liveMode) return;
    applyLive(Array.isArray(board) ? board : []);
  });

  Sync.on('giftleaderboard', (board) => {
    if (!isGifters) return;
    if (!liveMode) return;
    applyLive(Array.isArray(board) ? board : []);
  });

  Sync.on('tiktok', (ev) => {
    if (!isLikes && !isGifters) return;
    if (ev.state === 'online' || ev.event === 'connected') {
      if (!liveMode) switchToLive();
    } else if (ev.state === 'offline' || ev.event === 'disconnected') {
      if (liveMode) switchToDemo();
    }
  });

  Sync.on('state', (e) => {
    if (isLikes && (e.key === 'likesCfg' || e.key === '*')) {
      if (!liveMode) setupDecay();
      subtitle();
    }
    if (isGifters && (e.key === 'gifterCfg' || e.key === '*')) {
      if (!liveMode) { seed(); subtitle(); layout(buildDemoEntries()); }
    }
    if (isGifters && e.key === 'cmd-gifters') {
      if (liveMode) {
        fetch('/api/gifters/reset', { method: 'POST' }).catch(() => {});
      } else {
        reset();
      }
    }
  });

  // tombol "Reset Leaderboard" di dashboard (pesan dari iframe)
  if (preview) {
    window.addEventListener('message', (e) => {
      if (e.origin === location.origin && e.data && e.data.type === 'reset') {
        if (isLikes) {
          if (liveMode) fetch('/api/likes/reset', { method: 'POST' }).catch(() => {});
          else reset();
        } else if (isGifters) {
          if (liveMode) fetch('/api/gifters/reset', { method: 'POST' }).catch(() => {});
          else reset();
        }
      }
    });
  }
}
