/* Overlay YouTube Music — sinkron dengan server via SSE.
 *
 * IMPORTANT: overlay ini TIDAK memutar audio. Satu-satunya sumber suara adalah
 * player tersembunyi di dashboard (#yt-music-player / musicPlayer.js).
 * Overlay hanya menampilkan thumbnail, judul, antrean, dan progres detik yang
 * dikirim server (musicstate.elapsed — berasal dari getCurrentTime() dashboard),
 * jadi angka detik di dashboard dan di link overlay selalu sama.
 *
 * Saat TikTok offline: tampilkan data demo.
 */
import { SONGS } from '../lib/demo.js';
import { esc } from '../lib/dom.js';
import { fmtMMSS } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { Sync } from '../lib/sync.js';

export default function mount(ctx) {
  const { root } = ctx;

  root.innerHTML =
    '<div class="ovp cut mus">' +
    '<div class="mus-yt-wrap" id="m-yt-wrap" style="display:none">' +
    '<img id="m-yt-thumb" src="" alt="" style="width:100%;height:100%;object-fit:cover;">' +
    '</div>' +
    '<div class="mus-art" id="m-art">' + icon('music') + '</div>' +
    '<div class="mus-body">' +
    '<div class="mus-req">' + icon('mic') + '<span>Request oleh</span><b id="m-user"></b></div>' +
    '<div class="mus-title"><span id="m-title"></span></div>' +
    '<div class="mus-prog"><div class="mus-bar"><i id="m-fill"></i></div><span id="m-time"></span></div>' +
    '<div class="mus-next" id="m-next"></div>' +
    '</div>' +
    '<div class="mus-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' +
    '</div>';

  const $ = (s) => root.querySelector(s);

  /* ---- Helpers render ---- */
  const fit = () => {
    const el = $('#m-title');
    el.classList.remove('mq');
    el.style.removeProperty('--mq');
    el.style.removeProperty('--mqd');
    const over = el.scrollWidth - el.parentElement.clientWidth;
    if (over > 4) {
      el.style.setProperty('--mq', -(over + 28) + 'px');
      el.style.setProperty('--mqd', Math.max(6, (over + 28) / 28) + 's');
      el.classList.add('mq');
    }
  };

  const paintTitle = (user, title) => {
    $('#m-user').textContent = '@' + user;
    $('#m-title').textContent = title;
    requestAnimationFrame(fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  };

  const paintProgress = (elapsed, dur) => {
    const pct = dur > 0 ? Math.min(100, (elapsed / dur) * 100) : 0;
    $('#m-fill').style.width = pct + '%';
    $('#m-time').textContent = dur > 0
      ? fmtMMSS(elapsed) + ' / ' + fmtMMSS(dur)
      : fmtMMSS(elapsed);
  };

  /** Tampilkan antrean lagu yang akan diputar berikutnya (maks. 2 + sisa). */
  const paintQueue = (list) => {
    const el = $('#m-next');
    if (!el) return;
    const items = (list || []).slice();
    if (!items.length) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const more = items.length > 2
      ? '<span class="mus-next-more">+' + (items.length - 2) + ' lagi</span>'
      : '';
    const rows = items.slice(0, 2).map((s, i) =>
      '<div class="mus-next-i">' +
      '<span class="mus-next-n">' + (i + 1) + '</span>' +
      '<span class="mus-next-t">' + esc(s.title) + '</span>' +
      '<span class="mus-next-u">@' + esc(s.user) + '</span>' +
      '</div>'
    ).join('');
    el.innerHTML = '<div class="mus-next-h"><b>Berikutnya</b>' + more + '</div>' + rows;
  };

  let currentUid = '';
  let currentYtId = '';

  const showArt = () => {
    $('#m-yt-wrap').style.display = 'none';
    $('#m-art').style.display = '';
  };

  const showThumb = (ytId) => {
    if (!ytId) { showArt(); return; }
    const thumb = $('#m-yt-thumb');
    if (thumb && thumb.src !== 'https://img.youtube.com/vi/' + ytId + '/mqdefault.jpg') {
      thumb.src = 'https://img.youtube.com/vi/' + ytId + '/mqdefault.jpg';
    }
    $('#m-yt-wrap').style.display = '';
    $('#m-art').style.display = 'none';
  };

  /* ---- Mode live: semua angka berasal dari server ---- */
  let liveMode = false;

  const applyMusicState = (ms) => {
    paintQueue(ms && ms.queue);
    if (!ms || !ms.nowPlaying) {
      paintTitle('—', 'Menunggu request...');
      paintProgress(0, 0);
      showArt();
      currentUid = '';
      currentYtId = '';
      return;
    }
    const s = ms.nowPlaying;
    paintTitle(s.user, s.title);
    currentUid = s.uid;
    currentYtId = s.ytId || '';

    // Sama persis dengan dashboard: ms.elapsed sudah berasal dari
    // getCurrentTime() player dashboard, bukan timer lokal overlay.
    paintProgress(ms.elapsed || 0, s.dur || 0);
    if (!currentYtId) $('#m-time').textContent = 'Mencari...';
    showThumb(currentYtId);
  };

  /* ---- Demo loop ---- */
  let demoIdx = 0;
  let demoElapsed = 24;
  let demoTimer = null;

  const demoSong = () => SONGS[demoIdx % SONGS.length];
  const demoQueue = () => [
    SONGS[(demoIdx + 1) % SONGS.length],
    SONGS[(demoIdx + 2) % SONGS.length]
  ];

  const startDemo = () => {
    clearInterval(demoTimer);
    showArt();
    paintTitle(demoSong().user, demoSong().title);
    paintProgress(demoElapsed, demoSong().dur);
    paintQueue(demoQueue());

    demoTimer = setInterval(() => {
      if (liveMode) { clearInterval(demoTimer); demoTimer = null; return; }
      demoElapsed += 0.25;
      if (demoElapsed >= demoSong().dur) {
        demoIdx++;
        demoElapsed = 0;
        paintTitle(demoSong().user, demoSong().title);
        paintQueue(demoQueue());
      }
      paintProgress(demoElapsed, demoSong().dur);
    }, 250);
  };

  /* ---- Mode switch ---- */
  const isTikTokOnline = () => Sync.tiktok && Sync.tiktok.state === 'online';

  const switchMode = (toLive) => {
    if (toLive === liveMode) return;
    liveMode = toLive;
    if (liveMode) {
      clearInterval(demoTimer);
      demoTimer = null;
      applyMusicState(Sync.music);
    } else {
      currentUid = '';
      currentYtId = '';
      startDemo();
    }
  };

  // Inisialisasi — cek Sync.tiktok dari SSE hello (mungkin belum terisi via Cloudflare)
  if (isTikTokOnline()) {
    liveMode = true;
    applyMusicState(Sync.music);
  } else {
    liveMode = false;
    startDemo();
  }

  // Saat WS reconnect, hello membawa tiktok + musicstate terbaru.
  Sync.on('online', (isOnline) => {
    if (!isOnline) return;
    const tk = Sync.tiktok;
    const ms = Sync.music;
    const shouldLive = tk && tk.state === 'online';
    if (shouldLive && !liveMode) switchMode(true);
    else if (!shouldLive && liveMode) switchMode(false);
    else if (liveMode && ms) applyMusicState(ms);
  });

  // Dengarkan update musik dari server (sudah termasuk elapsed dari dashboard).
  Sync.on('musicstate', (ms) => {
    if (!liveMode) return;
    applyMusicState(ms);
  });

  Sync.on('musicskip', () => {
    if (!liveMode) return;
    currentUid = '';
    currentYtId = '';
    showArt();
    // State lagu berikutnya akan datang via musicstate.
  });

  // Dengarkan koneksi TikTok
  Sync.on('tiktok', (t) => switchMode(t.state === 'online'));
  Sync.on('tiktokstate', (t) => switchMode(t.state === 'online'));
}
