/**
 * musicPlayer.js — Singleton YouTube Music Player yang persistent.
 *
 * Player ini hidup di elemen #yt-music-player yang berada di luar #view,
 * sehingga tidak pernah dihancurkan saat user ganti halaman menu di dashboard.
 *
 * Tugasnya:
 *  - Mendengarkan SSE musicstate dari Sync
 *  - Saat ada nowPlaying.ytId → load + autoplay video YouTube
 *  - Kirim durasi & judul asli ke server saat video mulai playing
 *  - Skip otomatis saat video selesai
 *  - Tetap berjalan meski user pindah ke halaman #/interaksi, #/gift, dll
 *  - Tetap berjalan meski user pindah tab browser (dengan keepAlive AudioContext)
 */

import { Sync, API } from './sync.js';

/* ------------------------------------------------------------------ */
/* Cegah tab di-throttle browser saat tidak aktif                      */
/* Putar 100ms silence via Web Audio API setiap 25 detik               */
/* ------------------------------------------------------------------ */
function startKeepAlive() {
  let ctx = null;

  function ping() {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      // Buat buffer 100ms silence
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.1), ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    } catch (_) { /* tidak ada AudioContext — abaikan */ }
  }

  // Juga gunakan navigator.locks jika tersedia untuk mencegah throttle
  if (navigator.locks && navigator.locks.request) {
    navigator.locks.request('yt-music-keepalive', { mode: 'shared' }, () =>
      new Promise(() => { /* lock ini tidak pernah di-resolve → tab tetap dianggap aktif */ })
    ).catch(() => {});
  }

  // Page Visibility: saat tab kembali aktif, resume AudioContext
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  });

  // Ping setiap 25 detik
  setInterval(ping, 25000);

  // Coba langsung (beberapa browser tidak butuh gesture)
  setTimeout(ping, 500);

  // Juga coba saat pertama ada interaksi user (untuk yang butuh gesture)
  const onGesture = () => {
    document.removeEventListener('click', onGesture);
    document.removeEventListener('keydown', onGesture);
    ping();
  };
  document.addEventListener('click', onGesture);
  document.addEventListener('keydown', onGesture);
}

/* ------------------------------------------------------------------ */
/* YouTube IFrame API loader                                           */
/* ------------------------------------------------------------------ */
let ytApiReady = false;
const ytApiCallbacks = [];

function ensureYtApi(cb) {
  if (ytApiReady) { cb(); return; }
  ytApiCallbacks.push(cb);
  if (window.YT && window.YT.Player) {
    ytApiReady = true;
    ytApiCallbacks.forEach((f) => f());
    ytApiCallbacks.length = 0;
    return;
  }
  if (!document.getElementById('yt-iframe-api')) {
    const s = document.createElement('script');
    s.id = 'yt-iframe-api';
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }
  window.onYouTubeIframeAPIReady = () => {
    ytApiReady = true;
    ytApiCallbacks.forEach((f) => f());
    ytApiCallbacks.length = 0;
  };
}

/* ------------------------------------------------------------------ */
/* Player state                                                        */
/* ------------------------------------------------------------------ */
let ytPlayer = null;       // instance YT.Player
let ytPlayerReady = false; // true setelah onReady — loadVideoById aman dipanggil
let pendingYtId = '';      // video yang diminta sebelum player siap
let currentUid = '';       // uid lagu yang sedang di-load
let currentYtId = '';      // ytId yang sedang di-load
let musicPaused = false;   // status jeda dari server
let musicVolume = 100;     // volume dari server (0-100)
let resumeTimer = null;    // timer retry play untuk kasus autoplay diblokir/throttle

function clearResumeTimer() {
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
}

/** Paksa play jika seharusnya memutar tapi player masih pause/unstarted. */
function ensurePlaying(reason) {
  if (musicPaused || !ytPlayer || !ytPlayerReady) return;
  const np = Sync.music && Sync.music.nowPlaying;
  if (!np || np.uid !== currentUid) return;
  try {
    const st = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -2;
    // 1=playing, 3=buffering → biarkan; 0=ended ditangani onStateChange
    if (st === 1 || st === 3 || st === 0) return;
    if (ytPlayer.playVideo) ytPlayer.playVideo();
  } catch (_) {}
}

/**
 * Terapkan pause + volume ke instance player. Dipanggil tiap kali musicstate
 * datang dan juga saat player siap / baru mulai play, supaya control tetap
 * berlaku walau player dibuat atau di-load ulang setelah perubahan.
 */
function applyControl(ms) {
  if (ms) {
    musicPaused = !!ms.paused;
    if (typeof ms.volume === 'number') musicVolume = ms.volume;
  }
  if (!ytPlayer || !ytPlayerReady) return;
  try {
    if (typeof ytPlayer.setVolume === 'function') ytPlayer.setVolume(musicVolume);
    if (musicPaused) {
      clearResumeTimer();
      if (ytPlayer.pauseVideo) ytPlayer.pauseVideo();
    } else {
      const st = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -2;
      if (st !== 1 && st !== 3 && st !== 0) {
        if (ytPlayer.playVideo) ytPlayer.playVideo();
      }
    }
  } catch (_) {}
}

function loadVideo(ytId, song) {
  if (!ytId) return;
  currentYtId = ytId;

  if (!ytPlayer) {
    ensureYtApi(() => {
      // Player mungkin sudah dibuat oleh panggilan lain saat menunggu API.
      if (ytPlayer) {
        if (ytPlayerReady) {
          try { ytPlayer.loadVideoById(ytId); } catch (_) {}
          setTimeout(() => ensurePlaying('load-existing'), 300);
        } else {
          pendingYtId = ytId;
        }
        return;
      }
      const container = document.getElementById('yt-music-iframe');
      if (!container) return;
      ytPlayerReady = false;
      pendingYtId = '';
      ytPlayer = new window.YT.Player(container, {
        height: '1',
        width: '1',
        videoId: ytId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          rel: 0,
          enablejsapi: 1,
          playsinline: 1,
          fs: 0
        },
        events: {
          onReady: (e) => {
            ytPlayerReady = true;
            const p = e.target;
            if (typeof p.setVolume === 'function') {
              try { p.setVolume(musicVolume); } catch (_) {}
            }
            // Jika ada permintaan video lebih baru saat player belum siap, muat itu.
            if (pendingYtId && pendingYtId !== ytId) {
              try { p.loadVideoById(pendingYtId); } catch (_) {}
            } else {
              try { p.playVideo(); } catch (_) {}
            }
            pendingYtId = '';
            applyControl(null);
            setTimeout(() => ensurePlaying('ready'), 400);
          },
          onStateChange: onPlayerStateChange
        }
      });
    });
    return;
  }

  if (!ytPlayerReady) {
    pendingYtId = ytId;
    return;
  }
  try { ytPlayer.loadVideoById(ytId); } catch (_) {}
  setTimeout(() => ensurePlaying('load'), 300);
}

function onPlayerStateChange(e) {
  // PLAYING = 1
  if (e.data === 1 && ytPlayer) {
    clearResumeTimer();
    try {
      const dur = Math.round(ytPlayer.getDuration());
      const np = Sync.music && Sync.music.nowPlaying;
      if (np && np.uid === currentUid) {
        if (dur > 0) API.musicDuration(np.uid, dur).catch(() => {});
        const info = ytPlayer.getVideoData && ytPlayer.getVideoData();
        if (info && info.title && info.title !== np.title) {
          API.musicTitle(np.uid, info.title).catch(() => {});
        }
      }
    } catch (_) {}
    // Pastikan volume/pause tetap terpakai setelah load ulang / autoplay.
    applyControl(null);
  }
  // ENDED = 0
  if (e.data === 0) {
    clearResumeTimer();
    const np = Sync.music && Sync.music.nowPlaying;
    if (np && np.uid === currentUid) {
      API.musicSkip('yt-ended').catch(() => {});
    }
  }
  // UNSTARTED = -1, CUED = 5, PAUSED = 2 — coba play lagi bila user tidak menjeda.
  if ((e.data === -1 || e.data === 2 || e.data === 5) && !musicPaused) {
    const np = Sync.music && Sync.music.nowPlaying;
    if (np && np.uid === currentUid) {
      clearResumeTimer();
      let tries = 0;
      const retry = () => {
        if (musicPaused) return;
        const now = Sync.music && Sync.music.nowPlaying;
        if (!now || now.uid !== currentUid) return;
        try {
          const st = ytPlayer && ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -2;
          if (st === 1 || st === 3 || st === 0) return;
          if (ytPlayer && ytPlayer.playVideo) ytPlayer.playVideo();
        } catch (_) {}
        tries += 1;
        if (tries < 5) resumeTimer = setTimeout(retry, 1200);
      };
      resumeTimer = setTimeout(retry, 500);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Reaksi terhadap musicstate                                          */
/* ------------------------------------------------------------------ */
function onMusicState(ms) {
  // Pause + volume berlaku untuk semua kondisi (lagu sama, lagu baru, atau stop).
  applyControl(ms);
  const now = ms && ms.nowPlaying;

  if (!now) {
    // Tidak ada lagu — stop
    if (ytPlayer && ytPlayer.stopVideo) { try { ytPlayer.stopVideo(); } catch (_) {} }
    currentUid = '';
    currentYtId = '';
    return;
  }

  if (now.uid === currentUid) {
    // Lagu sama — muat ulang bila server mengganti ytId (mis. hasil pencarian berubah).
    if (now.ytId && now.ytId !== currentYtId) {
      currentYtId = now.ytId;
      loadVideo(now.ytId, now);
    }
    // Jika video pause karena throttle, resume — kecuali user memang menjeda.
    if (!musicPaused) {
      try {
        if (ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === 2) {
          ytPlayer.playVideo();
        }
      } catch (_) {}
    }
    return;
  }

  // Lagu baru
  currentUid = now.uid;
  currentYtId = now.ytId || '';
  if (currentYtId) loadVideo(currentYtId, now);
  // jika ytId belum ada, tunggu musicstate berikutnya
}

function onMusicSkip() {
  if (ytPlayer && ytPlayer.stopVideo) { try { ytPlayer.stopVideo(); } catch (_) {} }
  currentUid = '';
  currentYtId = '';
}

/* ------------------------------------------------------------------ */
/* Inisialisasi — dipanggil sekali dari app.js saat boot               */
/* ------------------------------------------------------------------ */
let initialized = false;

export function initMusicPlayer() {
  if (initialized) return;
  initialized = true;

  startKeepAlive();

  // Inisialisasi awal dari state yang sudah ada
  if (Sync.music && Sync.music.nowPlaying) {
    onMusicState(Sync.music);
  }

  Sync.on('musicstate', onMusicState);
  Sync.on('musicskip', onMusicSkip);
}
