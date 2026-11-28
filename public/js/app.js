/* JekInteract — shell dashboard + router (hash). */
import { $, $$, on, esc } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { Sync } from './lib/sync.js';
import { Store, Session } from './lib/store.js';
import { toast, bindCopy } from './lib/ui.js';
import { OVERLAY_TOTAL } from './lib/overlays.js';
import { initMusicPlayer } from './lib/musicPlayer.js';
import { initTTS } from './lib/tts.js';
import { initAlertSounds } from './lib/alertSounds.js';

import dashboard from './pages/dashboard.js';
import analytics from './pages/analytics.js';
import connection from './pages/connection.js';
import interaksi from './pages/interaksi.js';
import gifts from './pages/gifts.js';
import music from './pages/music.js';
import tts from './pages/tts.js';
import subathon from './pages/subathon.js';
import winlose from './pages/winlose.js';
import likes from './pages/likes.js';
import chat from './pages/chat.js';
import joinAlert from './pages/joinAlert.js';
import followAlert from './pages/followAlert.js';
import gifters from './pages/gifters.js';
import goals from './pages/goals.js';
import settings from './pages/settings.js';
import customSocialbuzz from './pages/customSocialbuzz.js';

const PAGES = [dashboard, analytics, connection, interaksi, gifts, music, tts, subathon, winlose, likes, chat, joinAlert, followAlert, customSocialbuzz, gifters, goals, settings];
const BY_ID = Object.fromEntries(PAGES.map((p) => [p.id, p]));
const GROUPS = [
  { name: 'Selamat Datang', ids: ['dashboard', 'analytics'] },
  { name: 'Setup', ids: ['connection', 'interaksi', 'gifts'] },
  { name: 'Tools', ids: ['music', 'tts', 'subathon', 'winlose'] },
  { name: 'Overlays', ids: ['likes', 'chat', 'joinalert', 'followalert', 'customsocialbuzz', 'gifters', 'goals'] }
];

/* ---------------------------- Shell ---------------------------- */
function renderSidebar() {
  const ui = Store.get('ui', {});
  const groups = ui.groups || {};
  const nav = GROUPS.map((g) => {
    const open = groups[g.name] !== false;
    const items = g.ids
      .map((id) => {
        const p = BY_ID[id];
        return '<a class="nav-i" href="#/' + p.id + '" data-route="' + p.id + '" title="' + esc(p.title) + '">' + icon(p.icon) + '<span>' + esc(p.title) + '</span></a>';
      })
      .join('');
    return (
      '<div class="nav-g' + (open ? ' open' : '') + '" data-g="' + esc(g.name) + '">' +
      '<button type="button" class="nav-gh" aria-expanded="' + open + '"><span>' + esc(g.name) + '</span>' + icon('chevDown') + '</button>' +
      '<div class="nav-gb">' + items + '</div></div>'
    );
  }).join('');

  $('#sidebar').innerHTML =
    '<a class="sb-brand" href="#/dashboard" aria-label="JekInteract, ke Dashboard">' +
    '<img class="sb-logo" src="/assets/logo.svg" alt="" width="38" height="38">' +
    '<span class="sb-word"><b>JEKINTERACT</b><small>Live interaction suite</small></span></a>' +
    '<nav class="sb-nav" aria-label="Menu utama">' + nav + '</nav>' +
    '<div class="sb-foot">' +
    '<a class="nav-i" href="#/settings" data-route="settings" title="Pengaturan">' + icon('sliders') + '<span>Pengaturan</span></a>' +
    '<div class="sb-conn" id="sb-conn"></div></div>';
}

function renderTopbar() {
  $('#topbar').innerHTML =
    '<button type="button" class="tb-btn tb-menu" id="btn-menu" aria-label="Buka menu">' + icon('menu') + '</button>' +
    '<button type="button" class="tb-btn tb-rail" id="btn-rail" aria-label="Ciutkan menu samping">' + icon('panelLeft') + '</button>' +
    '<div class="tb-crumb"><small id="tb-group"></small><b id="tb-title"></b></div>' +
    '<div class="tb-grow"></div>' +
    '<div class="tb-chips">' +
    '<span class="st off st-ov" id="tb-ov" title="Overlay yang sedang terbuka"><i></i><b>Overlay 0/' + OVERLAY_TOTAL + '</b></span>' +
    '<a href="#/connection" class="st off" id="tb-conn" title="Status koneksi live"><i></i><b>Belum terhubung</b></a></div>';
}

function paintStatus() {
  const c = Session.get().connection;
  const map = {
    online: ['on', '@' + c.username],
    connecting: ['wait', 'Menghubungkan...'],
    offline: ['off', 'Belum terhubung']
  };
  const [cls, text] = map[c.status] || map.offline;
  const tb = $('#tb-conn');
  if (tb) {
    tb.className = 'st ' + cls;
    $('b', tb).textContent = text;
  }
  const n = Object.values(Sync.status.overlays).filter((v) => v > 0).length;
  const ov = $('#tb-ov');
  if (ov) {
    ov.className = 'st st-ov ' + (n > 0 ? 'on' : 'off');
    $('b', ov).textContent = 'Overlay ' + n + '/' + OVERLAY_TOTAL;
  }
  const sb = $('#sb-conn');
  if (sb) sb.innerHTML = '<i class="' + (cls === 'on' ? 'on' : cls === 'wait' ? 'wait' : '') + '"></i><span>' + esc(cls === 'on' ? text : cls === 'wait' ? text : 'Offline') + '</span>';
}

function closeNav() {
  $('#app').classList.remove('nav-open');
  document.documentElement.classList.remove('nav-lock');
}

function bindShell() {
  const app = $('#app');
  $('#btn-menu').addEventListener('click', () => {
    app.classList.add('nav-open');
    document.documentElement.classList.add('nav-lock');
  });
  $('#scrim').addEventListener('click', closeNav);
  $('#btn-rail').addEventListener('click', () => {
    const rail = app.classList.toggle('rail');
    Store.set('ui', Object.assign({}, Store.get('ui', {}), { rail }));
    $('#btn-rail').setAttribute('aria-label', rail ? 'Lebarkan menu samping' : 'Ciutkan menu samping');
  });
  on($('#sidebar'), 'click', '.nav-gh', (e, btn) => {
    const g = btn.closest('.nav-g');
    const open = g.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
    const ui = Store.get('ui', {});
    ui.groups = Object.assign({}, ui.groups, { [g.dataset.g]: open });
    Store.set('ui', ui);
  });
  on($('#sidebar'), 'click', '.nav-i, .sb-brand', closeNav);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNav();
  });
}

/* ---------------------------- Router ---------------------------- */
let current = null;

function groupOf(id) {
  const g = GROUPS.find((x) => x.ids.includes(id));
  return g ? g.name : 'Sistem';
}

function go() {
  const id = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  const page = BY_ID[id] || dashboard;

  if (current && current.cleanup) {
    try {
      current.cleanup();
    } catch (e) {
      console.error(e);
    }
  }
  current = null;

  const view = $('#view');
  view.innerHTML = '';
  try {
    view.innerHTML = page.render();
    const cleanup = page.mount ? page.mount(view) : null;
    current = { page, cleanup };
  } catch (e) {
    console.error(e);
    view.innerHTML =
      '<div class="alert a-err">' + icon('xCircle') + '<div><b>Halaman gagal dimuat</b>' + esc(e && e.message ? e.message : 'Terjadi kesalahan.') + '</div></div>';
  }

  $$('.nav-i').forEach((a) => a.classList.toggle('on', a.dataset.route === page.id));
  $('#tb-group').textContent = groupOf(page.id);
  $('#tb-title').textContent = page.title;
  document.title = page.title + ' - JekInteract';
  closeNav();
  window.scrollTo(0, 0);
  if (window.__muFloatSetPage) window.__muFloatSetPage(page.id);
}

/* ---------------------------- Audio dari Dashboard ---------------------------- */
/**
 * Audio Queue Manager — memutar audio interaksi langsung dari browser dashboard.
 * Server mengirim event SSE 'play' tepat saat item boleh mulai (delay sudah lewat di
 * sisi server). Dashboard cukup langsung memutar audio saat menerima event tersebut.
 *
 * Per-screen: setiap screen menyimpan referensi Audio aktif, sehingga kalau server
 * mengirim 'stop' atau 'clear', audio bisa dihentikan.
 *
 * Audio unlock: browser memblokir autoplay sampai ada gestur user. Saat pertama kali
 * ada interaksi user di dashboard (klik apapun), AudioContext di-unlock. Kalau ada
 * audio yang antri sebelum unlock, diputar setelah unlock.
 */

let _audioUnlocked = false;
const _pendingUnlock = []; // fungsi yang akan dijalankan setelah unlock

function onAudioUnlock(fn) {
  if (_audioUnlocked) {
    fn();
  } else {
    _pendingUnlock.push(fn);
  }
}

function initAudioUnlock() {
  // Auto-unlock saat ada interaksi pertama user (klik/tap apapun di halaman),
  // tanpa perlu overlay. Browser tetap butuh gestur user sebelum izinkan audio —
  // kita tangkap gestur itu secara silent di background.
  function doUnlock() {
    if (_audioUnlocked) return;
    _audioUnlocked = true;
    document.removeEventListener('pointerdown', doUnlock, true);
    document.removeEventListener('keydown', doUnlock, true);
    const fns = _pendingUnlock.splice(0);
    fns.forEach((f) => { try { f(); } catch (_) {} });
  }
  document.addEventListener('pointerdown', doUnlock, true);
  document.addEventListener('keydown', doUnlock, true);
}

// activeAudios: Map<screenNum, HTMLAudioElement> — audio yang sedang diputar per screen
const activeAudios = new Map();

function playAudioForScreen(screen, audioUrl, vol) {
  // Hentikan audio screen ini yang sedang jalan (kalau ada)
  stopAudioForScreen(screen);

  const a = new Audio(audioUrl);
  a.volume = Math.min(1, Math.max(0, vol));
  // Preload agar buffer sudah siap saat play() dipanggil — mengurangi latency
  a.preload = 'auto';
  activeAudios.set(screen, a);
  a.addEventListener('ended', () => {
    if (activeAudios.get(screen) === a) activeAudios.delete(screen);
  });

  const doPlay = () => {
    // Pastikan masih audio yang aktif untuk screen ini (belum di-replace)
    if (activeAudios.get(screen) !== a) return;
    a.play().catch(() => {
      if (activeAudios.get(screen) === a) activeAudios.delete(screen);
    });
  };

  onAudioUnlock(doPlay);
}

function stopAudioForScreen(screen) {
  const a = activeAudios.get(screen);
  if (a) {
    try { a.pause(); a.src = ''; } catch (_) {}
    activeAudios.delete(screen);
  }
}

function startAudioListener() {
  // Dengarkan event 'play' dari server — server sudah memperhitungkan delay,
  // jadi audio langsung diputar saat event ini diterima.
  Sync.on('play', ({ screen, item }) => {
    if (!item) return;
    const m = item.media || {};
    // hanya audio trigger yang diputar di dashboard; video suaranya dari overlay langsung
    const audioUrl = m.audio || null;
    if (!audioUrl) return;
    const vol = (item.volume == null ? 100 : item.volume) / 100;
    playAudioForScreen(screen, audioUrl, vol);
  });

  // Hentikan audio saat server kirim stop untuk uid yang sesuai
  Sync.on('stop', ({ screen }) => {
    if (screen != null) stopAudioForScreen(screen);
  });

  // Bersihkan semua audio saat clear
  Sync.on('clear', () => {
    activeAudios.forEach((a) => { try { a.pause(); a.src = ''; } catch (_) {} });
    activeAudios.clear();
  });

}


/* ---------------------------- Mini Float Music Player ---------------------------- */
/**
 * #mu-float: iframe overlay music persistent (preview=1, tanpa audio).
 *  - Tersembunyi saat tidak ada lagu (default)
 *  - Muncul di pojok kanan bawah (mu-float-mini) saat ada lagu & bukan di halaman Music
 *  - Muncul full di halaman Music sebagai preview embed (mu-float-embed)
 *
 * #mu-float hanya preview tanpa audio. Suara keluar dari #yt-music-player
 * via musicPlayer.js; overlay/OBS juga tanpa audio, cukup baca progres server.
 */
function initMusicFloat() {
  const floatEl = document.getElementById('mu-float');
  if (!floatEl) return;

  let currentPage = '';

  const update = () => {
    const hasTrack = !!(Sync.music && Sync.music.nowPlaying);
    const onMusicPage = currentPage === 'music';

    floatEl.classList.remove('mu-float-mini', 'mu-float-embed');

    if (onMusicPage) {
      floatEl.classList.add('mu-float-embed');
    } else if (hasTrack) {
      floatEl.classList.add('mu-float-mini');
    }
  };

  window.__muFloatSetPage = (pageId) => {
    currentPage = pageId;
    update();
  };

  Sync.on('musicstate', update);
  update();
}

/* ---------------------------- Boot ---------------------------- */
async function boot() {
  if (Store.get('ui', {}).rail) $('#app').classList.add('rail');
  renderSidebar();
  renderTopbar();
  bindShell();
  bindCopy(document);
  initAudioUnlock();

  Session.on(paintStatus);
  Sync.on('status', paintStatus);
  Sync.on('online', paintStatus);
  paintStatus();

  await Sync.connect({ role: 'dashboard' });
  startAudioListener();
  initTTS();
  initAlertSounds(onAudioUnlock); // suara alert tetap terdengar dari halaman mana pun
  initMusicPlayer();
  initMusicFloat();
  if (!Sync.online) toast('Server JekInteract tidak merespons. Preview overlay dan status online belum aktif.', 'warn', 6500);

  window.addEventListener('hashchange', go);
  go();
}

boot();
