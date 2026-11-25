import { $, $$, esc, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Store, DEFAULTS } from '../lib/store.js';
import { OVERLAYS } from '../lib/overlays.js';
import { WHO_FULL, SONGS } from '../lib/demo.js';
import { avatar } from '../lib/avatar.js';
import { fmtMMSS } from '../lib/format.js';
import { toast, linkRowHTML, statusHTML, bindStatuses, bindRanges } from '../lib/ui.js';
import { Sync, API } from '../lib/sync.js';

const CMDS = [
  [['!play [Judul - Artist]'], 'Command request lagu.'],
  [['!req [Judul - Artist]'], 'Command alternatif jika !play kena filter TikTok.'],
  [['!skip'], 'Skip lagu yang sedang diputar.'],
  [['!revoke'], 'Batalkan request-an terakhir.'],
  [['!revoke [Judul]'], 'Batalkan request dengan judul tertentu.'],
  [['!remove', '!cancel', ';remove', ';cancel'], 'Command alternatif jika !revoke kena filter TikTok.']
];

const whoOptions = (sel) => WHO_FULL.map(([v, l]) => '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + l + '</option>').join('');

export default {
  id: 'music',
  title: 'YouTube Music',
  icon: 'music',

  render() {
    const ov = OVERLAYS.music;
    const cfg = Object.assign({}, DEFAULTS.music, Store.get('music', {}));
    const initVol = Math.max(0, Math.min(100, Number(cfg.volume == null ? 100 : cfg.volume) || 0));
    return (
      '<div class="ph"><h1>YouTube Music</h1><p>Penonton request lagu lewat komentar. Lagu diputar langsung dari <b>overlay</b> (iframe YouTube ada di overlay, bukan di sini). Buka overlay di OBS atau tab terpisah agar suara keluar.</p></div>' +
      '<div class="stack">' +

      /* ---- Status Sedang Diputar ---- */
      '<section class="panel mu-player-panel">' +
      '<div class="fh"><div class="fh-t"><h2>Sedang Diputar</h2><div class="sub">Lagu diputar dari iframe di overlay. Suara keluar dari browser yang membuka overlay.</div></div>' +
      '<div class="mu-player-acts">' +
      '<button type="button" class="btn sm secondary" id="mu-btn-pause">' + icon('pause') + '<span id="mu-pause-label">Pause</span></button>' +
      '<button type="button" class="btn sm" id="mu-btn-skip">' + icon('skip') + 'Skip</button>' +
      '<button type="button" class="btn sm secondary" id="mu-btn-clear">' + icon('trash') + 'Kosongkan</button>' +
      '</div></div>' +
      '<div class="mu-vol-row rng">' +
      '<span class="mu-vol-label">' + icon('volume') + '<b>Volume Music</b></span>' +
      '<input type="range" id="mu-vol" min="0" max="100" step="1" value="' + initVol + '" aria-label="Volume music">' +
      '<output for="mu-vol">' + initVol + '%</output>' +
      '</div>' +
      '<div class="mu-now" id="mu-now">' +
      '<div class="mu-now-empty" id="mu-player-empty"><span>' + icon('music') + '</span><p>Belum ada lagu. Tunggu request dari penonton atau tambah manual di bawah.</p></div>' +
      '</div>' +
      '</section>' +

      /* ---- Tambah manual ---- */
      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Tambah Manual</h2><div class="sub">Masukkan URL YouTube atau "Judul - Artist".</div></div></div>' +
      '<div class="g2">' +
      '<div class="fgrp"><label class="lbl" for="mu-add-title">Judul / URL YouTube</label>' +
      '<div class="field"><input type="text" id="mu-add-title" placeholder="Contoh: Sial - Mahalini atau https://youtu.be/..." maxlength="200"></div></div>' +
      '<div class="fgrp"><label class="lbl" for="mu-add-user">Username Peminta (opsional)</label>' +
      '<div class="field"><input type="text" id="mu-add-user" placeholder="rina.kece" maxlength="80"></div></div>' +
      '</div>' +
      '<button type="button" class="btn" id="mu-add-btn">' + icon('plus') + 'Tambah ke Antrian</button>' +
      '</section>' +

      /* ---- Link Overlay ---- */
      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Link Overlay</h2><div class="sub">Hanya video YouTube yang diambil. YouTube Shorts diabaikan.</div></div>' + statusHTML(ov.id) + '</div>' +
      linkRowHTML(ov) +
      '<div id="mu-float-slot"></div>' +
      '</section>' +

      /* ---- Info Command ---- */
      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Info Command</h2><div class="sub">Ketik di komentar live TikTok.</div></div></div>' +
      '<div class="cmds">' +
      CMDS.map(([codes, desc]) => '<div class="cmd"><div class="cmd-c">' + codes.map((c) => '<code>' + esc(c) + '</code>').join('') + '</div><p>' + esc(desc) + '</p></div>').join('') +
      '</div></section>' +

      /* ---- Pengaturan ---- */
      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Pengaturan</h2></div><span class="saved" id="mu-saved" aria-live="polite"></span></div>' +
      '<div class="sw-row"><div class="t"><b>!play / !req enabled</b><span>Penonton bisa request lagu.</span></div>' +
      '<label class="sw"><input type="checkbox" id="mu-play"' + (cfg.playOn ? ' checked' : '') + ' aria-label="Aktifkan !play dan !req"><i></i></label></div>' +
      '<div class="sw-row"><div class="t"><b>!skip enabled</b><span>Penonton bisa melewati lagu yang sedang diputar.</span></div>' +
      '<label class="sw"><input type="checkbox" id="mu-skip"' + (cfg.skipOn ? ' checked' : '') + ' aria-label="Aktifkan !skip"><i></i></label></div>' +
      '<div class="g2 mu-who">' +
      '<div class="fgrp"><label class="lbl" for="mu-playwho">Siapa yang bisa !play / !req?</label><div class="field sel"><select id="mu-playwho">' + whoOptions(cfg.playWho) + '</select></div></div>' +
      '<div class="fgrp"><label class="lbl" for="mu-skipwho">Siapa yang bisa !skip?</label><div class="field sel"><select id="mu-skipwho">' + whoOptions(cfg.skipWho) + '</select></div></div>' +
      '</div></section>' +

      /* ---- Antrian ---- */
      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Antrian &amp; Riwayat Request Lagu</h2><div class="sub">Akun TikTok, judul lagu, dan durasi.</div></div>' +
      '<button type="button" class="btn sm" id="mu-refresh">' + icon('refresh') + 'Refresh</button></div>' +
      '<ol class="q" id="mu-q"></ol>' +
      '<p class="hint demo-note" id="mu-demo-note">Data demo. Antrian asli muncul setelah TikTok terhubung.</p>' +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    const ov = OVERLAYS.music;
    d(bindStatuses(root));
    d(bindRanges(root));

    /* ---- Kontrol Pause + Volume Music ---- */
    const volInput  = $('#mu-vol', root);
    const volOut    = volInput && volInput.closest('.rng').querySelector('output');
    const pauseBtn  = $('#mu-btn-pause', root);
    const pauseLbl  = $('#mu-pause-label', root);
    let lastPaused = false;
    let volTimer = null;

    const paintVolume = (v) => {
      const val = Math.max(0, Math.min(100, Number(v) || 0));
      if (!volInput) return;
      volInput.value = val;
      volInput.style.setProperty('--p', val + '%');
      if (volOut) volOut.textContent = val + '%';
    };

    const paintPaused = (v) => {
      lastPaused = !!v;
      if (!pauseBtn) return;
      pauseBtn.classList.toggle('on', lastPaused);
      if (pauseLbl) pauseLbl.textContent = lastPaused ? 'Play' : 'Pause';
      const ico = pauseBtn.querySelector('svg');
      if (ico) ico.outerHTML = icon(lastPaused ? 'play' : 'pause');
    };

    d(() => clearTimeout(volTimer));
    if (volInput) {
      volInput.addEventListener('input', () => {
        if (volOut) volOut.textContent = volInput.value + '%';
        clearTimeout(volTimer);
        volTimer = setTimeout(async () => {
          const volume = Number(volInput.value);
          try {
            await API.musicControl({ volume });
            const cfg = Object.assign({}, Store.get('music', {}), { volume });
            Store.set('music', cfg);
          } catch (e) {
            toast(e.message || 'Gagal mengubah volume.', 'err');
          }
        }, 180);
      });
    }
    if (pauseBtn) {
      pauseBtn.addEventListener('click', async () => {
        if (!isTikTokConnected) { toast('TikTok belum terhubung.', 'warn', 2000); return; }
        const next = !lastPaused;
        try {
          await API.musicControl({ paused: next });
          paintPaused(next);
          toast(next ? 'Musik dijeda.' : 'Musik dilanjutkan.', 'ok', 1800);
        } catch (e) {
          toast(e.message || 'Gagal mengubah status musik.', 'err');
        }
      });
    }

    /* ---- Embed #mu-float ke slot preview di halaman ini ---- */
    const floatEl = document.getElementById('mu-float');
    const slotEl  = document.getElementById('mu-float-slot');
    if (floatEl && slotEl) {
      slotEl.appendChild(floatEl);
      d(() => {
        document.body.appendChild(floatEl);
      });
    }

    /* ---- pengaturan (tersimpan otomatis) ---- */
    let saveTimer = null;
    d(() => clearTimeout(saveTimer));
    const saved = () => {
      const el = $('#mu-saved', root);
      el.textContent = 'Tersimpan otomatis';
      el.classList.add('show');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => el.classList.remove('show'), 1600);
    };
    const save = () => {
      const cfg = {
        playOn:  $('#mu-play',    root).checked,
        skipOn:  $('#mu-skip',    root).checked,
        playWho: $('#mu-playwho', root).value,
        skipWho: $('#mu-skipwho', root).value,
        volume:  volInput ? Number(volInput.value) : 100
      };
      Store.set('music', cfg);
      // Simpan ke server agar handler TikTok chat tahu konfigurasi terkini
      Sync.set('music', cfg);
      saved();
    };
    ['#mu-play', '#mu-skip', '#mu-playwho', '#mu-skipwho'].forEach((s) => $(s, root).addEventListener('change', save));

    /* ---- state musik & antrian ---- */
    let currentUid = null;
    let isTikTokConnected = Sync.tiktok && Sync.tiktok.state === 'online';

    /* Render antrian */
    const paintQueue = (musicState) => {
      const isDemo = !isTikTokConnected;
      const demoNote = $('#mu-demo-note', root);
      if (demoNote) demoNote.style.display = isDemo ? '' : 'none';

      if (isDemo) {
        // Tampilkan data demo
        const list = SONGS.slice();
        $('#mu-q', root).innerHTML = list.map((s, i) =>
          '<li class="q-i' + (i === 0 ? ' now' : '') + '">' +
          '<span class="q-n">' + (i + 1) + '</span>' +
          avatar(s.user, 38) +
          '<div class="q-m"><b>@' + esc(s.user) + '</b><span>' + esc(s.title) + '</span></div>' +
          (i === 0 ? '<span class="chip c-aud">Sedang diputar (demo)</span>' : '') +
          '<span class="q-d">' + fmtMMSS(s.dur) + '</span></li>'
        ).join('');
        return;
      }

      const ms  = musicState || Sync.music || { nowPlaying: null, elapsed: 0, queue: [] };
      const now = ms.nowPlaying;
      const q   = ms.queue || [];

      const rows = [];
      if (now) {
        const elapsed  = ms.elapsed || 0;
        const durText  = now.dur > 0 ? fmtMMSS(elapsed) + ' / ' + fmtMMSS(now.dur) : fmtMMSS(elapsed);
        rows.push(
          '<li class="q-i now">' +
          '<span class="q-n">▶</span>' +
          avatar(now.user, 38) +
          '<div class="q-m"><b>@' + esc(now.user) + '</b><span>' + esc(now.title) + '</span></div>' +
          '<span class="chip c-aud">' + (ms.paused ? 'Dijeda' : 'Sedang diputar') + '</span>' +
          '<span class="q-d">' + esc(durText) + '</span>' +
          '</li>'
        );
      }
      q.forEach((s, i) => {
        rows.push(
          '<li class="q-i">' +
          '<span class="q-n">' + (i + 1) + '</span>' +
          avatar(s.user, 38) +
          '<div class="q-m"><b>@' + esc(s.user) + '</b><span>' + esc(s.title) + '</span></div>' +
          '<button class="btn xs mu-revoke" data-uid="' + esc(s.uid) + '" data-title="' + esc(s.title) + '" title="Batalkan request ini">' + icon('x') + '</button>' +
          '<span class="q-d">' + (s.dur > 0 ? fmtMMSS(s.dur) : '—') + '</span>' +
          '</li>'
        );
      });

      if (!rows.length) {
        $('#mu-q', root).innerHTML = '<li class="q-empty">Antrian kosong.</li>';
      } else {
        $('#mu-q', root).innerHTML = rows.join('');
      }

      // Delegasi revoke button
      $$('.mu-revoke', root).forEach((btn) => {
        btn.addEventListener('click', async () => {
          const t = btn.dataset.title;
          try {
            await API.musicRevoke('dashboard', t);
            toast('Request "' + t + '" dibatalkan.', 'ok', 2000);
          } catch (e) {
            toast(e.message || 'Gagal membatalkan.', 'err');
          }
        });
      });
    };

    /* ---- Panel "Sedang Diputar" — info saja, tanpa iframe ---- */
    const nowEl      = $('#mu-now',         root);
    const emptyEl    = $('#mu-player-empty', root);

    const paintNowPlaying = (ms) => {
      const now = ms && ms.nowPlaying;
      if (!now) {
        if (emptyEl) emptyEl.style.display = '';
        // Hapus info lagu jika ada
        const info = nowEl && nowEl.querySelector('.mu-now-info');
        if (info) info.remove();
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      // Render / update blok info
      let info = nowEl && nowEl.querySelector('.mu-now-info');
      const elapsed = ms.elapsed || 0;
      const durText = now.dur > 0 ? fmtMMSS(elapsed) + ' / ' + fmtMMSS(now.dur) : fmtMMSS(elapsed);
      const statusText = ms && ms.paused ? 'Dijeda' : (now.ytId ? 'Memutar' : 'Mencari di YouTube...');
      const ytLink = now.ytId ? 'https://www.youtube.com/watch?v=' + now.ytId : '';
      const html =
        '<div class="mu-now-info">' +
        '<div class="mu-ni-row">' +
        (now.ytId
          ? '<img class="mu-ni-thumb" src="https://img.youtube.com/vi/' + now.ytId + '/mqdefault.jpg" alt="" loading="lazy">'
          : '<div class="mu-ni-thumb mu-ni-search">' + icon('music') + '</div>') +
        '<div class="mu-ni-body">' +
        '<div class="mu-ni-title">' + esc(now.title) + '</div>' +
        '<div class="mu-ni-meta">Diminta oleh <b>@' + esc(now.user) + '</b></div>' +
        '<div class="mu-ni-status">' + statusText + (ytLink ? ' — <a href="' + ytLink + '" target="_blank" rel="noopener">Buka di YouTube</a>' : '') + '</div>' +
        '</div></div>' +
        '<div class="mu-ni-prog">' +
        '<div class="mu-ni-bar"><i style="width:' + (now.dur > 0 ? Math.min(100, (elapsed / now.dur) * 100) : 0) + '%"></i></div>' +
        '<span class="mu-ni-time">' + durText + '</span>' +
        '</div></div>';
      if (!info) {
        nowEl.insertAdjacentHTML('beforeend', html);
      } else {
        info.outerHTML = html;
      }
    };

    /* ---- Reaksi terhadap perubahan musicstate ---- */
    const onMusicState = (ms) => {
      paintQueue(ms);
      paintNowPlaying(ms);
      if (ms) {
        paintPaused(ms.paused);
        // Jangan timpa slider saat user sedang menarik knob (server masih
        // mengirim nilai lama sampai debounce 180ms selesai).
        if (typeof ms.volume === 'number' && document.activeElement !== volInput) {
          paintVolume(ms.volume);
        }
      }
      const now = ms && ms.nowPlaying;
      if (now) {
        currentUid = now.uid;
      } else {
        currentUid = null;
      }
    };

    // Inisialisasi awal
    if (isTikTokConnected) {
      onMusicState(Sync.music);
    } else {
      paintQueue(null);
    }

    // Fetch status TikTok + music state via REST — fix Cloudflare/tunnel.
    Promise.all([
      fetch('/api/tiktok/status').then((r) => r.json()).catch(() => null),
      fetch('/api/music/state').then((r) => r.json()).catch(() => null)
    ]).then(([tk, ms]) => {
      if (tk) { Sync.tiktok = tk; isTikTokConnected = tk.state === 'online'; }
      if (ms) Sync.music = ms;
      if (isTikTokConnected) onMusicState(ms || Sync.music);
      else paintQueue(null);
    });

    d(Sync.on('musicstate', onMusicState));
    d(Sync.on('tiktok', (t) => {
      isTikTokConnected = t.state === 'online';
      if (isTikTokConnected) {
        onMusicState(Sync.music);
      } else {
        currentUid = null;
        paintQueue(null);
      }
    }));

    /* ---- Refresh button ---- */
    $('#mu-refresh', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.classList.remove('spin');
      void btn.offsetWidth;
      btn.classList.add('spin');
      if (isTikTokConnected) {
        try {
          const ms = await API.musicState();
          if (ms) { Sync.music = ms; onMusicState(ms); }
          toast('Antrian diperbarui.', 'info', 2000);
        } catch (_) {
          toast('Gagal memuat antrian.', 'err');
        }
      } else {
        paintQueue(null);
        toast('TikTok belum terhubung — menampilkan data demo.', 'info', 2500);
      }
    });

    /* ---- Skip button ---- */
    $('#mu-btn-skip', root).addEventListener('click', async () => {
      if (!isTikTokConnected) { toast('TikTok belum terhubung.', 'warn', 2000); return; }
      try {
        await API.musicSkip('dashboard');
        toast('Lagu di-skip.', 'ok', 1800);
      } catch (e) {
        toast(e.message || 'Gagal skip.', 'err');
      }
    });

    /* ---- Clear button ---- */
    $('#mu-btn-clear', root).addEventListener('click', async () => {
      if (!isTikTokConnected) { toast('TikTok belum terhubung.', 'warn', 2000); return; }
      const addTitle = $('#mu-add-title', root);
      const addUser  = $('#mu-add-user',  root);
      const restoreFocus = () => {
        setTimeout(() => {
          try { window.focus(); } catch (_) {}
          [addTitle, addUser].forEach((el) => { if (el) { el.disabled = false; el.readOnly = false; } });
          const ae = document.activeElement;
          const tag = ae && ae.tagName ? ae.tagName.toLowerCase() : '';
          if (!ae || ae === document.body || tag === 'iframe') {
            try { document.body.focus(); } catch (_) {}
            if (addTitle) addTitle.focus();
          }
        }, 150);
      };
      if (!confirm('Kosongkan seluruh antrian dan hentikan musik?')) { restoreFocus(); return; }
      try {
        await API.musicClear();
        currentUid = null;
        toast('Antrian dikosongkan.', 'ok', 2000);
      } catch (e) {
        toast(e.message || 'Gagal mengosongkan.', 'err');
      } finally {
        restoreFocus();
      }
    });

    /* ---- Tambah manual ---- */
    $('#mu-add-btn', root).addEventListener('click', async () => {
      const titleEl = $('#mu-add-title', root);
      const userEl  = $('#mu-add-user',  root);
      const raw = titleEl.value.trim();
      if (!raw) { toast('Masukkan judul atau URL YouTube.', 'warn', 2500); return; }
      const user = userEl.value.trim() || 'dashboard';
      try {
        await API.musicEnqueue(user, raw, '');
        titleEl.value = '';
        userEl.value  = '';
        toast('Lagu ditambahkan ke antrian.', 'ok', 2000);
      } catch (e) {
        toast(e.message || 'Gagal menambahkan.', 'err');
      }
    });

    return () => {
      d.run();
    };
  }
};
