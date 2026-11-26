/* Halaman Follow Alert — toggle enable, durasi, soundboard, link overlay,
 * tes, preview, dan history. Polanya sama seperti Join Alert. */
import { $, esc, disposer } from '../lib/dom.js';
import { Sync, API } from '../lib/sync.js';
import { OVERLAYS } from '../lib/overlays.js';
import { icon } from '../lib/icons.js';
import { toast, linkRowHTML, previewHTML, statusHTML, bindStatuses, bindRanges, mountPreviews, confirmDialog } from '../lib/ui.js';
import { openAudioPicker } from './interaksi.js';

const DEFAULT_CFG = {
  enabled: false,
  soundOn: true,
  sound: null,
  volume: 100,
  duration: 5 // detik, tampil per alert
};

function intIn(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function cfg() {
  const raw = Sync.get('followAlertCfg', {}) || {};
  const merged = Object.assign({}, DEFAULT_CFG, raw);
  const vol = Number(merged.volume);
  return {
    enabled: merged.enabled !== false,
    soundOn: merged.soundOn !== false,
    sound: merged.sound && merged.sound.url ? merged.sound : null,
    volume: Number.isFinite(vol) ? Math.min(100, Math.max(0, vol)) : 100,
    duration: intIn(merged.duration, 1, 30, 5)
  };
}

function soundInfoHTML(sound) {
  if (!sound || !sound.url) return '<span class="muted">Belum ada audio dipilih.</span>';
  const src = sound.source === 'upload' ? 'Upload' : 'Soundboard myinstants';
  return '<span><b>' + esc(sound.name || 'Audio') + '</b><small class="muted"> · ' + src + '</small></span>';
}

/* ---------------- History ---------------- */

function historyEntries() {
  const raw = Sync.get('followAlertHistory', []);
  return Array.isArray(raw) ? raw : [];
}

function statusChip(e) {
  if (e && e.status === 'repeat') return '<span class="chip c-aud">Pernah follow</span>';
  return '<span class="chip c-img">Follower Baru</span>';
}

function timeText(at) {
  const n = Number(at);
  if (!Number.isFinite(n) || !n) return '';
  try {
    return new Date(n).toLocaleString('id-ID', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  } catch (_) {
    return '';
  }
}

function historyHTML(entries) {
  if (!entries.length) {
    return '<div class="alert a-info">' + icon('info') +
      '<div>Belum ada yang follow. History akan terisi otomatis saat TikTok terhubung.</div></div>';
  }
  return '<div class="list">' + entries.map((e) => {
    const item = e || {};
    const nick = String(item.nickname || '').trim().replace(/^@+/, '') || 'viewer';
    // Entry lama mungkin menyimpan id numerik sebagai username — jangan tampilkan.
    const rawUname = String(item.username || '').trim().replace(/^@+/, '');
    const uname = rawUname && !/^\d+$/.test(rawUname) ? rawUname : '';
    const when = timeText(item.at);
    const meta = [
      uname ? 'Username: @' + uname : 'Username: -',
      when || null
    ].filter(Boolean).join(' · ');
    return (
      '<div class="itm">' +
      '<span class="itm-ico c-act">' + icon('heart') + '</span>' +
      '<span class="itm-txt"><b>@' + esc(nick) + '</b><small>' + esc(meta) + '</small></span>' +
      '<div class="itm-act">' + statusChip(item) + '</div>' +
      '</div>'
    );
  }).join('') + '</div>';
}

export default {
  id: 'followalert',
  title: 'Follow Alert',
  icon: 'heart',

  render() {
    const ov = OVERLAYS.followalert;
    const c = cfg();

    return (
      '<div class="ph"><h1>Follow Alert</h1><p>Kartu alert muncul saat ada penonton follow ke live yang terhubung di halaman Connection. Overlay transparan dan hanya muncul ketika event follow terjadi.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Setingan Alert</h2></div><span class="saved" id="fa-saved" aria-live="polite"></span></div>' +

      '<div class="fgrp">' +
      '<div class="sw-row"><div class="t"><b>Enabled</b><span>Aktifkan Follow Alert saat ada yang follow. Default: mati.</span></div>' +
      '<label class="sw"><input type="checkbox" id="fa-enabled"' + (c.enabled ? ' checked' : '') + ' aria-label="Aktifkan Follow Alert"><i></i></label></div>' +
      '<p class="hint">Tes Alert tetap bisa dipakai walau toggle dimatikan, untuk melihat tampilan dan suaranya.</p></div>' +

      '<div class="fgrp"><label class="lbl" for="fa-duration">Durasi tampil alert (detik)</label>' +
      '<div class="field short"><input id="fa-duration" type="number" min="1" max="30" step="1" value="' + c.duration + '" inputmode="numeric"></div>' +
      '</div>' +
      '<p class="hint">Setiap event follow dari live yang terhubung memicu alert tanpa jeda, dan tampil berurutan lewat antrian (tidak saling ngeskip).</p>' +

      '<div class="fgrp">' +
      '<div class="sw-row"><div class="t"><b>Mainkan Suara Follow Alert</b><span>Suara diputar dari overlay (Browser Source OBS / preview).</span></div>' +
      '<label class="sw"><input type="checkbox" id="fa-sound-on"' + (c.soundOn ? ' checked' : '') + ' aria-label="Mainkan suara saat follow"><i></i></label></div>' +
      '<div class="row" style="gap:.5rem;margin-top:.5rem">' +
      '<button type="button" class="btn sm" id="fa-pick-sound">' + icon('search') + 'Pilih Audio</button>' +
      '<button type="button" class="btn sm ghost" id="fa-clear-sound"' + (c.sound ? '' : ' hidden') + '>' + icon('xCircle') + 'Hapus</button></div>' +
      '<div class="up-info" id="fa-sound-info">' + soundInfoHTML(c.sound) + '</div>' +
      '<p class="hint">Modal soundboard myinstants.com sama seperti Trigger Audio di Form Tambah Interaksi: cari suara, preview, lalu Terapkan. Aktifkan audio pada Browser Source di OBS agar penonton mendengar.</p></div>' +

      '<div class="fgrp"><label class="lbl" for="fa-vol">Volume suara</label>' +
      '<div class="rng"><input id="fa-vol" type="range" min="0" max="100" step="1" value="' + c.volume + '"><output>' + c.volume + '%</output></div></div>' +

      '<div class="alert a-info">' + icon('info') + '<div>Follow Alert aktif hanya saat TikTok terhubung. Tanpa koneksi, gunakan tombol Tes Alert untuk melihat tampilan dan mendengar suaranya.</div></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Link Overlay</h2></div>' + statusHTML(ov.id) + '</div>' +
      linkRowHTML(ov) +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Tes Alert</h2></div><button type="button" class="btn primary sm" id="fa-test">' + icon('bolt') + 'Tes Alert</button></div>' +
      '<p class="hint">Mengirim alert contoh ke overlay Follow Alert (termasuk panel preview) tanpa perlu menunggu orang follow. Tidak mengubah data live dan tidak masuk history.</p>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Preview Overlay</h2><div class="sub">Latar transparan. Klik Tes Alert untuk melihat animasi dan mendengar suaranya di sini.</div></div></div>' +
      previewHTML(ov, { title: 'Tampilan overlay' }) +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>History Follow</h2><div class="sub">Nickname, username, dan keterangan penonton yang follow (maksimal 100 entri terakhir).</div></div>' +
      '<button type="button" class="btn sm ghost" id="fa-clear-history">' + icon('trash') + 'Hapus History</button></div>' +
      '<div id="fa-history" class="fa-history-scroll">' + historyHTML(historyEntries()) + '</div>' +
      '</section>' +

      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    d(mountPreviews(root));
    d(bindStatuses(root));
    d(bindRanges(root));

    let savedTimer = null;
    d(() => clearTimeout(savedTimer));

    function flashSaved() {
      const el = $('#fa-saved', root);
      if (!el) return;
      el.textContent = 'Tersimpan otomatis';
      el.classList.add('show');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => el.classList.remove('show'), 1600);
    }

    function save(patch) {
      Sync.set('followAlertCfg', Object.assign({}, cfg(), patch));
      flashSaved();
    }

    function paintSound() {
      const c = cfg();
      const info = $('#fa-sound-info', root);
      if (info) info.innerHTML = soundInfoHTML(c.sound);
      const clear = $('#fa-clear-sound', root);
      if (clear) clear.hidden = !c.sound;
      const on = $('#fa-sound-on', root);
      if (on && document.activeElement !== on) on.checked = c.soundOn;
      const vol = $('#fa-vol', root);
      if (vol && document.activeElement !== vol) {
        vol.value = String(c.volume);
        vol.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    function paintFields() {
      const c = cfg();
      const enabled = $('#fa-enabled', root);
      if (enabled && document.activeElement !== enabled) enabled.checked = c.enabled;
      const dur = $('#fa-duration', root);
      if (dur && document.activeElement !== dur) dur.value = String(c.duration);
      paintSound();
    }

    function paintHistory() {
      const el = $('#fa-history', root);
      if (el) el.innerHTML = historyHTML(historyEntries());
    }

    d(Sync.on('state', (e) => {
      if (!e) return;
      if (e.key === 'followAlertHistory' || e.key === '*') paintHistory();
      if (e.key === 'followAlertCfg' || e.key === '*') paintFields();
    }));

    // Fallback REST bila hello WebSocket terlambat (mis. lewat tunnel).
    fetch('/api/state/followAlertCfg')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.value == null) return;
        Sync.state.followAlertCfg = res.value;
        paintFields();
      })
      .catch(() => {});

    fetch('/api/state/followAlertHistory')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.value == null) return;
        Sync.state.followAlertHistory = res.value;
        paintHistory();
      })
      .catch(() => {});

    $('#fa-enabled', root).addEventListener('change', (e) => save({ enabled: e.target.checked }));
    $('#fa-duration', root).addEventListener('change', (e) =>
      save({ duration: intIn(e.target.value, 1, 30, cfg().duration) }));
    $('#fa-sound-on', root).addEventListener('change', (e) => save({ soundOn: e.target.checked }));

    $('#fa-pick-sound', root).addEventListener('click', () => {
      openAudioPicker((audio) => {
        save({
          sound: { name: audio.name, url: audio.url, source: audio.source || 'myinstants' },
          soundOn: true
        });
        paintSound();
      });
    });

    $('#fa-clear-sound', root).addEventListener('click', () => {
      save({ sound: null });
      paintSound();
    });

    $('#fa-vol', root).addEventListener('change', (e) => save({ volume: Number(e.target.value) }));

    $('#fa-clear-history', root).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Hapus History Follow',
        message: 'Semua riwayat Follow Alert akan dihapus. Pengaturan alert tidak berubah.',
        okText: 'Hapus',
        danger: true
      });
      if (!ok) return;
      try {
        await API.followAlertClearHistory();
        Sync.state.followAlertHistory = [];
        paintHistory();
        toast('History Follow Alert dihapus.', 'ok');
      } catch (err) {
        toast('Gagal menghapus history: ' + (err && err.message ? err.message : 'unknown'), 'err');
      }
    });

    $('#fa-test', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await API.followAlertTest();
        toast('Tes alert dikirim ke overlay.', 'ok');
      } catch (err) {
        toast('Gagal mengirim tes alert: ' + (err && err.message ? err.message : 'unknown'), 'err');
      } finally {
        btn.disabled = false;
      }
    });

    return () => d.run();
  }
};
