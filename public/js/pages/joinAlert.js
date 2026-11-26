/* Halaman Join Alert — filter pemicu, durasi/antrian, jeda join ulang, history,
 * soundboard, link overlay, tes, dan preview. */
import { $, esc, disposer } from '../lib/dom.js';
import { Sync, API } from '../lib/sync.js';
import { OVERLAYS } from '../lib/overlays.js';
import { icon } from '../lib/icons.js';
import { toast, linkRowHTML, previewHTML, statusHTML, bindStatuses, bindRanges, mountPreviews, confirmDialog } from '../lib/ui.js';
import { openAudioPicker } from './interaksi.js';

/* Hanya tiga pilihan yang diminta fitur ini. */
const JOIN_WHO = [
  ['all', 'Semua Orang'],
  ['follower', 'Follower'],
  ['fanclub', 'Fan Club']
];

const DEFAULT_CFG = {
  enabled: false,
  who: 'all',
  soundOn: true,
  sound: null,
  volume: 100,
  duration: 5,     // detik, tampil per alert
  rejoinMinutes: 2 // menit, jeda join ulang; 0 = selalu muncul
};

function intIn(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function cfg() {
  const raw = Sync.get('joinAlertCfg', {}) || {};
  const merged = Object.assign({}, DEFAULT_CFG, raw);
  const who = JOIN_WHO.some(([v]) => v === merged.who) ? merged.who : 'all';
  const vol = Number(merged.volume);
  return {
    enabled: merged.enabled !== false,
    who,
    soundOn: merged.soundOn !== false,
    sound: merged.sound && merged.sound.url ? merged.sound : null,
    volume: Number.isFinite(vol) ? Math.min(100, Math.max(0, vol)) : 100,
    duration: intIn(merged.duration, 1, 30, 5),
    rejoinMinutes: intIn(merged.rejoinMinutes, 0, 1440, 2)
  };
}

function soundInfoHTML(sound) {
  if (!sound || !sound.url) return '<span class="muted">Belum ada audio dipilih.</span>';
  const src = sound.source === 'upload' ? 'Upload' : 'Soundboard myinstants';
  return '<span><b>' + esc(sound.name || 'Audio') + '</b><small class="muted"> · ' + src + '</small></span>';
}

/* ---------------- History ---------------- */

function historyEntries() {
  const raw = Sync.get('joinAlertHistory', []);
  return Array.isArray(raw) ? raw : [];
}

function statusChip(e) {
  if (e && e.status === 'follower') return '<span class="chip c-obs">Follower kamu</span>';
  if (e && e.status === 'repeat') return '<span class="chip c-aud">Pernah join live</span>';
  return '<span class="chip c-img">User Baru</span>';
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
      '<div>Belum ada penonton yang join. History akan terisi otomatis saat TikTok terhubung.</div></div>';
  }
  return '<div class="list">' + entries.map((e) => {
    const item = e || {};
    const nick = String(item.nickname || '').trim().replace(/^@+/, '') || 'viewer';
    // Entry lama mungkin menyimpan id numerik sebagai username — jangan tampilkan.
    const rawUname = String(item.username || '').trim().replace(/^@+/, '');
    const uname = rawUname && !/^\d+$/.test(rawUname) ? rawUname : '';
    const when = timeText(item.at);
    const skipped = item.alerted === false;
    const meta = [
      uname ? 'Username: @' + uname : 'Username: -',
      when || null,
      skipped ? 'alert dilewati' : null
    ].filter(Boolean).join(' · ');
    return (
      '<div class="itm">' +
      '<span class="itm-ico c-act">' + icon('userPlus') + '</span>' +
      '<span class="itm-txt"><b>@' + esc(nick) + '</b><small>' + esc(meta) + '</small></span>' +
      '<div class="itm-act">' + statusChip(item) + '</div>' +
      '</div>'
    );
  }).join('') + '</div>';
}

export default {
  id: 'joinalert',
  title: 'Join Alert',
  icon: 'userPlus',

  render() {
    const ov = OVERLAYS.joinalert;
    const c = cfg();

    return (
      '<div class="ph"><h1>Join Alert</h1><p>Kartu alert muncul saat penonton bergabung ke live yang terhubung di halaman Connection. Overlay transparan dan hanya muncul ketika event join terjadi.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Setingan Alert</h2></div><span class="saved" id="ja-saved" aria-live="polite"></span></div>' +

      '<div class="fgrp">' +
      '<div class="sw-row"><div class="t"><b>Enabled</b><span>Aktifkan Join Alert saat penonton join. Default: mati.</span></div>' +
      '<label class="sw"><input type="checkbox" id="ja-enabled"' + (c.enabled ? ' checked' : '') + ' aria-label="Aktifkan Join Alert"><i></i></label></div>' +
      '<p class="hint">Tes Alert tetap bisa dipakai walau toggle dimatikan, untuk melihat tampilan dan suaranya.</p></div>' +

      '<div class="fgrp"><label class="lbl" for="ja-who">Siapa yang memicu Join Alert?</label>' +
      '<div class="field sel"><select id="ja-who">' +
      JOIN_WHO.map(([v, l]) => '<option value="' + v + '"' + (c.who === v ? ' selected' : '') + '>' + l + '</option>').join('') +
      '</select></div>' +
      '<p class="hint">Perubahan langsung tersimpan. Filter Follower / Fan Club dibaca dari data akun TikTok saat event join diterima.</p></div>' +

      '<div class="row" style="gap:.75rem">' +
      '<div class="fgrp" style="flex:1 1 180px"><label class="lbl" for="ja-duration">Durasi tampil alert (detik)</label>' +
      '<div class="field short"><input id="ja-duration" type="number" min="1" max="30" step="1" value="' + c.duration + '" inputmode="numeric"></div>' +
      '</div>' +
      '<div class="fgrp" style="flex:1 1 180px"><label class="lbl" for="ja-rejoin">Jeda join ulang (menit)</label>' +
      '<div class="field short"><input id="ja-rejoin" type="number" min="0" max="1440" step="1" value="' + c.rejoinMinutes + '" inputmode="numeric"></div>' +
      '</div>' +
      '</div>' +
      '<p class="hint">Alert berurutan (antrian), tidak saling ngeskip. Jeda join ulang dihitung sejak alert terakhir untuk orang yang sama: misal 2 menit, maka join bolak-balik dalam 2 menit tidak memunculkan alert. Isi 0 agar setiap join tetap muncul.</p>' +

      '<div class="fgrp">' +
      '<div class="sw-row"><div class="t"><b>Mainkan Suara Join Alert</b><span>Suara diputar dari overlay (Browser Source OBS / preview).</span></div>' +
      '<label class="sw"><input type="checkbox" id="ja-sound-on"' + (c.soundOn ? ' checked' : '') + ' aria-label="Mainkan suara saat join"><i></i></label></div>' +
      '<div class="row" style="gap:.5rem;margin-top:.5rem">' +
      '<button type="button" class="btn sm" id="ja-pick-sound">' + icon('search') + 'Pilih Audio</button>' +
      '<button type="button" class="btn sm ghost" id="ja-clear-sound"' + (c.sound ? '' : ' hidden') + '>' + icon('xCircle') + 'Hapus</button></div>' +
      '<div class="up-info" id="ja-sound-info">' + soundInfoHTML(c.sound) + '</div>' +
      '<p class="hint">Modal soundboard myinstants.com sama seperti Trigger Audio di Form Tambah Interaksi: cari suara, preview, lalu Terapkan. Aktifkan audio pada Browser Source di OBS agar penonton mendengar.</p></div>' +

      '<div class="fgrp"><label class="lbl" for="ja-vol">Volume suara</label>' +
      '<div class="rng"><input id="ja-vol" type="range" min="0" max="100" step="1" value="' + c.volume + '"><output>' + c.volume + '%</output></div></div>' +

      '<div class="alert a-info">' + icon('info') + '<div>Join Alert aktif hanya saat TikTok terhubung. Tanpa koneksi, gunakan tombol Tes Alert untuk melihat tampilan dan mendengar suaranya.</div></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Link Overlay</h2></div>' + statusHTML(ov.id) + '</div>' +
      linkRowHTML(ov) +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Tes Alert</h2></div><button type="button" class="btn primary sm" id="ja-test">' + icon('bolt') + 'Tes Alert</button></div>' +
      '<p class="hint">Mengirim alert contoh ke overlay Join Alert (termasuk panel preview) tanpa perlu menunggu orang join. Tidak mengubah data live dan tidak masuk history.</p>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Preview Overlay</h2><div class="sub">Latar transparan. Klik Tes Alert untuk melihat animasi dan mendengar suaranya di sini.</div></div></div>' +
      previewHTML(ov, { title: 'Tampilan overlay' }) +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>History Join</h2><div class="sub">Nickname, username, dan keterangan penonton yang join (maksimal 100 entri terakhir).</div></div>' +
      '<button type="button" class="btn sm ghost" id="ja-clear-history">' + icon('trash') + 'Hapus History</button></div>' +
      '<div id="ja-history" class="ja-history-scroll">' + historyHTML(historyEntries()) + '</div>' +
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
      const el = $('#ja-saved', root);
      if (!el) return;
      el.textContent = 'Tersimpan otomatis';
      el.classList.add('show');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => el.classList.remove('show'), 1600);
    }

    function save(patch) {
      Sync.set('joinAlertCfg', Object.assign({}, cfg(), patch));
      flashSaved();
    }

    function paintSound() {
      const c = cfg();
      const info = $('#ja-sound-info', root);
      if (info) info.innerHTML = soundInfoHTML(c.sound);
      const clear = $('#ja-clear-sound', root);
      if (clear) clear.hidden = !c.sound;
      const on = $('#ja-sound-on', root);
      if (on && document.activeElement !== on) on.checked = c.soundOn;
      const vol = $('#ja-vol', root);
      if (vol && document.activeElement !== vol) {
        vol.value = String(c.volume);
        vol.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    function paintFields() {
      const c = cfg();
      const enabled = $('#ja-enabled', root);
      if (enabled && document.activeElement !== enabled) enabled.checked = c.enabled;
      const sel = $('#ja-who', root);
      if (sel && document.activeElement !== sel) sel.value = c.who;
      const dur = $('#ja-duration', root);
      if (dur && document.activeElement !== dur) dur.value = String(c.duration);
      const rej = $('#ja-rejoin', root);
      if (rej && document.activeElement !== rej) rej.value = String(c.rejoinMinutes);
      paintSound();
    }

    function paintHistory() {
      const el = $('#ja-history', root);
      if (el) el.innerHTML = historyHTML(historyEntries());
    }

    d(Sync.on('state', (e) => {
      if (!e) return;
      if (e.key === 'joinAlertHistory' || e.key === '*') paintHistory();
      if (e.key === 'joinAlertCfg' || e.key === '*') paintFields();
    }));

    // Fallback REST bila hello WebSocket terlambat (mis. lewat tunnel).
    fetch('/api/state/joinAlertCfg')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.value == null) return;
        Sync.state.joinAlertCfg = res.value;
        paintFields();
      })
      .catch(() => {});

    fetch('/api/state/joinAlertHistory')
      .then((r) => r.json())
      .then((res) => {
        if (!res || res.value == null) return;
        Sync.state.joinAlertHistory = res.value;
        paintHistory();
      })
      .catch(() => {});

    $('#ja-enabled', root).addEventListener('change', (e) => save({ enabled: e.target.checked }));
    $('#ja-who', root).addEventListener('change', (e) => save({ who: e.target.value }));
    $('#ja-duration', root).addEventListener('change', (e) =>
      save({ duration: intIn(e.target.value, 1, 30, cfg().duration) }));
    $('#ja-rejoin', root).addEventListener('change', (e) =>
      save({ rejoinMinutes: intIn(e.target.value, 0, 1440, cfg().rejoinMinutes) }));
    $('#ja-sound-on', root).addEventListener('change', (e) => save({ soundOn: e.target.checked }));

    $('#ja-pick-sound', root).addEventListener('click', () => {
      openAudioPicker((audio) => {
        save({
          sound: { name: audio.name, url: audio.url, source: audio.source || 'myinstants' },
          soundOn: true
        });
        paintSound();
      });
    });

    $('#ja-clear-sound', root).addEventListener('click', () => {
      save({ sound: null });
      paintSound();
    });

    $('#ja-vol', root).addEventListener('change', (e) => save({ volume: Number(e.target.value) }));

    $('#ja-clear-history', root).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Hapus History Join',
        message: 'Semua riwayat Join Alert akan dihapus. Pengaturan alert tidak berubah.',
        okText: 'Hapus',
        danger: true
      });
      if (!ok) return;
      try {
        await API.joinAlertClearHistory();
        Sync.state.joinAlertHistory = [];
        paintHistory();
        toast('History Join Alert dihapus.', 'ok');
      } catch (err) {
        toast('Gagal menghapus history: ' + (err && err.message ? err.message : 'unknown'), 'err');
      }
    });

    $('#ja-test', root).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await API.joinAlertTest();
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
