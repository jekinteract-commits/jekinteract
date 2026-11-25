/* Overlay YouTube Music — sinkron dengan server via SSE.
 * - Iframe YouTube langsung diputar di overlay ini (bukan di dashboard).
 * - Judul diambil dari YouTube Player API (getVideoData().title).
 * - Durasi dilaporkan ke server agar progress bar akurat.
 * - Saat TikTok offline: tampilkan data demo.
 * - Overlay ini yang mengeluarkan suara (volume bisa dikontrol dari OBS).
 * - AudioContext dummy digunakan agar browser tidak suspend tab saat berpindah.
 */
import { SONGS } from '../lib/demo.js';
import { esc } from '../lib/dom.js';
import { fmtMMSS } from '../lib/format.js';
import { icon } from '../lib/icons.js';
import { Sync, API } from '../lib/sync.js';

/**
 * Cegah browser men-throttle/suspend audio saat iframe tidak visible.
 *
 * Tiga lapisan perlindungan:
 * 1. navigator.locks — Web Lock yang tidak pernah di-release, membuat browser
 *    menganggap tab/iframe sedang mengerjakan sesuatu yang penting.
 * 2. AudioContext silence — ping setiap 20 detik agar audio context tetap aktif.
 * 3. postMessage heartbeat — parent dashboard mengirim 'mu-keepalive' setiap
 *    20 detik; kita resume AudioContext saat menerimanya.
 */
function keepAlive() {
  let ctx = null;

  function resumeCtx() {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (_) {}
  }

  function ping() {
    resumeCtx();
    try {
      if (ctx && ctx.state === 'running') {
        const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
      }
    } catch (_) {}
  }

  // Lapisan 1: Web Locks — lock ini tidak pernah di-release
  if (navigator.locks && navigator.locks.request) {
    navigator.locks.request(
      'mu-overlay-keepalive',
      { mode: 'shared' },
      () => new Promise(() => { /* tidak pernah resolve */ })
    ).catch(() => {});
  }

  // Lapisan 2: AudioContext ping berkala
  const startPing = () => {
    ping();
    setInterval(ping, 20000);
  };

  // Butuh gesture untuk AudioContext — coba langsung, fallback ke click
  try {
    const probe = new (window.AudioContext || window.webkitAudioContext)();
    probe.resume().then(() => {
      probe.close().catch(() => {});
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      startPing();
    }).catch(() => {
      document.addEventListener('click', () => startPing(), { once: true });
      setTimeout(startPing, 500);
    });
  } catch (_) {}

  // Lapisan 3: terima heartbeat dari parent dashboard
  window.addEventListener('message', (e) => {
    if (e.data === 'mu-keepalive') resumeCtx();
  });

  // Resume saat visibility berubah (tab kembali aktif)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeCtx();
  });
}

/* ---- YouTube IFrame API loader ---- */
let ytApiReady = false;
let ytApiCallbacks = [];
function ensureYtApi(cb) {
  if (ytApiReady) { cb(); return; }
  ytApiCallbacks.push(cb);
  if (window.YT && window.YT.Player) {
    ytApiReady = true;
    ytApiCallbacks.forEach((f) => f());
    ytApiCallbacks = [];
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
    ytApiCallbacks = [];
  };
}

export default function mount(ctx) {
  const { root } = ctx;
  const isPreview = !!ctx.preview;

  root.innerHTML =
    '<div class="ovp cut mus">' +
    '<div class="mus-yt-wrap" id="m-yt-wrap" style="display:none">' +
    '<img id="m-yt-thumb" src="" alt="" style="width:100%;height:100%;object-fit:cover;">' +
    (isPreview ? '' : '<div id="m-yt-player" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;"></div>') +
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

  /* Cegah tab di-suspend browser saat tidak aktif — hanya untuk overlay asli, bukan preview */
  if (!isPreview) keepAlive();

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

  /* ---- YouTube player instance ---- */
  let ytPlayer = null;
  let ytPlayerReady = false;
  let pendingYtId = '';
  let currentYtId = '';
  let currentUid = '';
  let currentSong = null; // referensi ke song yang sedang diputar
  let localElapsed = 0;
  let localDur = 0;
  let localTick = null;
  let musicPaused = false; // dari server (kontrol Pause Music)
  let musicVolume = 100;   // dari server (kontrol Volume Music)
  let resumeTimer = null;

  function clearResumeTimer() {
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  }

  function ensurePlaying() {
    if (isPreview || musicPaused || !ytPlayer || !ytPlayerReady) return;
    const np = Sync.music && Sync.music.nowPlaying;
    if (!np || np.uid !== currentUid) return;
    try {
      const st = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -2;
      if (st === 1 || st === 3 || st === 0) return;
      if (ytPlayer.playVideo) ytPlayer.playVideo();
    } catch (_) {}
  }

  /** Terapkan pause + volume dari musicstate ke player overlay (bukan preview). */
  const applyControl = (ms) => {
    if (ms) {
      musicPaused = !!ms.paused;
      if (typeof ms.volume === 'number') musicVolume = ms.volume;
    }
    if (isPreview || !ytPlayer) return;
    try {
      if (typeof ytPlayer.setVolume === 'function') ytPlayer.setVolume(musicVolume);
      if (musicPaused) {
        clearResumeTimer();
        if (ytPlayer.pauseVideo) ytPlayer.pauseVideo();
        stopTick();
      } else if (ytPlayerReady) {
        const st = ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -2;
        if (st !== 1 && st !== 3 && st !== 0) {
          if (ytPlayer.playVideo) ytPlayer.playVideo();
        } else if (st === 1) {
          startTick();
        }
      }
    } catch (_) {}
  };

  const stopTick = () => {
    if (localTick) { clearInterval(localTick); localTick = null; }
  };

  const startTick = () => {
    // Jangan jalankan progress timer saat lagu sedang dijeda.
    if (musicPaused) return;
    stopTick();
    localTick = setInterval(() => {
      // Sinkronkan elapsed dari player YouTube langsung jika tersedia
      if (ytPlayer && ytPlayer.getCurrentTime) {
        try {
          const ct = ytPlayer.getCurrentTime();
          localElapsed = ct; // selalu pakai nilai dari player, termasuk detik pertama (0)
        } catch (_) {
          localElapsed += 1;
        }
      } else {
        localElapsed += 1;
      }
      if (localDur > 0) localElapsed = Math.min(localElapsed, localDur);
      paintProgress(localElapsed, localDur);
    }, 1000);
  };

  /** Muat video baru ke player. Bila belum ada player, buat dulu. */
  const loadVideo = (ytId, song) => {
    currentSong = song; // simpan referensi agar onStateChange selalu pakai song terkini
    if (!ytId) {
      // Tidak ada ytId — tampilkan ikon musik default
      $('#m-yt-wrap').style.display = 'none';
      $('#m-art').style.display = '';
      if (ytPlayer && ytPlayer.stopVideo) { try { ytPlayer.stopVideo(); } catch (_) {} }
      return;
    }

    // Sembunyikan ikon, tampilkan area video
    $('#m-yt-wrap').style.display = '';
    $('#m-art').style.display = 'none';

    // Selalu tampilkan thumbnail (preview maupun overlay asli)
    const thumb = $('#m-yt-thumb');
    if (thumb) thumb.src = 'https://img.youtube.com/vi/' + ytId + '/mqdefault.jpg';
    if (isPreview) return; // preview: hanya thumbnail, tidak ada audio

    const onPlayerReady = (player) => {
      ytPlayerReady = true;
      if (typeof player.setVolume === 'function') {
        try { player.setVolume(musicVolume); } catch (_) {}
      }
      if (pendingYtId && pendingYtId !== ytId) {
        try { player.loadVideoById(pendingYtId); } catch (_) {}
      } else {
        try { player.playVideo(); } catch (_) {}
      }
      pendingYtId = '';
      applyControl(null);
      setTimeout(ensurePlaying, 400);
    };

    const onStateChange = (e, player) => {
      // YT.PlayerState.PLAYING = 1
      if (e.data === 1) {
        clearResumeTimer();
        try {
          const dur = Math.round(player.getDuration());
          if (dur > 0 && dur !== localDur) {
            localDur = dur;
            // Kirim durasi ke server
            if (currentUid) API.musicDuration(currentUid, dur).catch(() => {});
          }
          // Ambil judul asli dari YouTube Player (pakai currentSong agar selalu up-to-date)
          const info = player.getVideoData && player.getVideoData();
          if (info && info.title && currentSong && info.title !== currentSong.title) {
            // Perbarui tampilan judul dengan judul asli YouTube
            paintTitle(currentSong.user, info.title);
            // Kirim judul asli ke server agar overlay lain juga dapat
            if (currentUid) {
              API.musicTitle(currentUid, info.title).catch(() => {});
            }
          }
        } catch (_) {}
        applyControl(null);
        startTick();
      }
      // YT.PlayerState.ENDED = 0
      if (e.data === 0) {
        clearResumeTimer();
        stopTick();
        const np = Sync.music && Sync.music.nowPlaying;
        if (np && np.uid === currentUid) API.musicSkip('yt-ended').catch(() => {});
      }
      // UNSTARTED = -1, CUED = 5, PAUSED = 2
      if (e.data === -1 || e.data === 2 || e.data === 5) {
        if (e.data === 2) stopTick();
        if (!musicPaused) {
          const np = Sync.music && Sync.music.nowPlaying;
          if (np && np.uid === currentUid) {
            clearResumeTimer();
            let tries = 0;
            const retry = () => {
              if (musicPaused) return;
              const now = Sync.music && Sync.music.nowPlaying;
              if (!now || now.uid !== currentUid) return;
              try {
                const st = player.getPlayerState ? player.getPlayerState() : -2;
                if (st === 1 || st === 3 || st === 0) return;
                if (player.playVideo) player.playVideo();
              } catch (_) {}
              tries += 1;
              if (tries < 5) resumeTimer = setTimeout(retry, 1200);
            };
            resumeTimer = setTimeout(retry, 500);
          }
        }
      }
    };

    if (!ytPlayer) {
      ensureYtApi(() => {
        if (ytPlayer) {
          if (ytPlayerReady) {
            try { ytPlayer.loadVideoById(ytId); } catch (_) {}
            setTimeout(ensurePlaying, 300);
          } else {
            pendingYtId = ytId;
          }
          return;
        }
        ytPlayerReady = false;
        pendingYtId = '';
        ytPlayer = new window.YT.Player($('#m-yt-player'), {
          height: '100%',
          width: '100%',
          videoId: ytId,
          playerVars: {
            autoplay: 1,
            controls: 0,
            rel: 0,
            modestbranding: 1,
            enablejsapi: 1,
            playsinline: 1
          },
          events: {
            onReady: (e) => onPlayerReady(e.target),
            onStateChange: (e) => onStateChange(e, e.target)
          }
        });
      });
    } else if (!ytPlayerReady) {
      pendingYtId = ytId;
    } else {
      try { ytPlayer.loadVideoById(ytId); } catch (_) {}
      setTimeout(ensurePlaying, 300);
    }
    // Video baru ikut status jeda/volume terkini dari server.
    applyControl(null);
  };

  /* ---- Mode live ---- */
  let liveMode = false;

  const applyMusicState = (ms) => {
    // Pause/volume dari server berlaku sebelum logika lagu dijalankan.
    applyControl(ms);
    // Antrean berikutnya ikut ditampilkan di overlay (juga di preview dashboard).
    paintQueue(ms && ms.queue);
    if (!ms || !ms.nowPlaying) {
      paintTitle('—', 'Menunggu request...');
      paintProgress(0, 0);
      stopTick();
      if (ytPlayer && ytPlayer.stopVideo) { try { ytPlayer.stopVideo(); } catch (_) {} }
      $('#m-yt-wrap').style.display = 'none';
      $('#m-art').style.display = '';
      currentUid = '';
      currentYtId = '';
      return;
    }
    const s = ms.nowPlaying;

    // Selalu update judul & user (bisa berubah saat server resolve judul asli YouTube)
    paintTitle(s.user, s.title);

    if (s.uid === currentUid) {
      // Lagu yang sama — cek apakah ytId baru datang
      if (s.ytId && !currentYtId) {
        // Server baru selesai mencari — load video sekarang
        currentYtId = s.ytId;
        localDur = s.dur || 0;
        if (isPreview) {
          // Preview: pakai elapsed dari server, tampilkan thumbnail baru
          paintProgress(ms.elapsed || 0, localDur);
          loadVideo(currentYtId, s);
        } else {
          loadVideo(currentYtId, s);
        }
        return;
      }
      // Update durasi jika berubah
      if (s.dur && s.dur !== localDur) localDur = s.dur;
      if (isPreview) {
        // Preview tidak punya player/tick — update progress dari elapsed server
        paintProgress(ms.elapsed || 0, localDur);
      } else if (!localTick) {
        // Non-preview tapi tick belum jalan (ytId belum ada / player belum ready)
        // — gunakan elapsed dari server sebagai fallback
        localElapsed = ms.elapsed || 0;
        paintProgress(localElapsed, localDur);
      }
      // Non-preview + tick sudah jalan: progress diupdate oleh startTick()
      return;
    }

    // Lagu baru
    currentUid = s.uid;
    currentYtId = s.ytId || '';
    localDur = s.dur || 0;

    if (isPreview) {
      // Preview: gunakan elapsed server, tidak ada player/tick
      const serverElapsed = ms.elapsed || 0;
      localElapsed = serverElapsed;
      paintProgress(serverElapsed, localDur);
      if (!currentYtId) {
        $('#m-yt-wrap').style.display = 'none';
        $('#m-art').style.display = '';
        $('#m-time').textContent = 'Mencari...';
      } else {
        loadVideo(currentYtId, s);
      }
    } else {
      localElapsed = 0; // player YouTube yang jadi sumber kebenaran elapsed
      paintProgress(0, localDur);
      if (!currentYtId) {
        // ytId belum ada — server sedang mencari
        $('#m-yt-wrap').style.display = 'none';
        $('#m-art').style.display = '';
        $('#m-time').textContent = 'Mencari...';
      } else {
        loadVideo(currentYtId, s);
      }
    }
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
    stopTick();
    clearInterval(demoTimer);
    // Sembunyikan iframe player di mode demo
    $('#m-yt-wrap').style.display = 'none';
    $('#m-art').style.display = '';
    if (ytPlayer && ytPlayer.stopVideo) { try { ytPlayer.stopVideo(); } catch (_) {} }

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
      stopTick();
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
  // sync.js emit 'online' true + 'musicstate' → overlay langsung update.
  Sync.on('online', (isOnline) => {
    if (!isOnline) return;
    const tk = Sync.tiktok;
    const ms = Sync.music;
    const shouldLive = tk && tk.state === 'online';
    if (shouldLive && !liveMode) switchMode(true);
    else if (!shouldLive && liveMode) switchMode(false);
    else if (liveMode && ms) applyMusicState(ms);
  });

  // Dengarkan update musik dari server
  Sync.on('musicstate', (ms) => {
    if (!liveMode) return;
    applyMusicState(ms);
  });

  // Dengarkan skip
  Sync.on('musicskip', () => {
    if (!liveMode) return;
    stopTick();
    currentUid = '';
    currentYtId = '';
    if (ytPlayer && ytPlayer.stopVideo) { try { ytPlayer.stopVideo(); } catch (_) {} }
    $('#m-yt-wrap').style.display = 'none';
    $('#m-art').style.display = '';
    // State baru akan datang via musicstate
  });

  // Dengarkan koneksi TikTok
  Sync.on('tiktok', (t) => switchMode(t.state === 'online'));
  Sync.on('tiktokstate', (t) => switchMode(t.state === 'online'));
}
