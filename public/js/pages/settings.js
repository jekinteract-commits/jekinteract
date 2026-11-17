import { $, esc, on, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Store, DEFAULTS, baseUrl } from '../lib/store.js';
import { Sync, API } from '../lib/sync.js';
import { SCREEN_COUNT } from '../lib/overlays.js';
import { toast, confirmDialog } from '../lib/ui.js';

/* ---------- Ekspor/Impor Konfigurasi ---------- */

// Ikon "download" tidak ada di ikon bawaan, buat inline.
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>';

// Kunci localStorage (prefix 'ji:') yang ikut di-export bersama server config.
const LS_KEYS = ['settings', 'obs', 'music', 'tts', 'subathon', 'history'];

/** Kumpulkan semua config: server (via API) + localStorage. */
async function exportConfig() {
  const server = await API.configExport();
  const local = {};
  LS_KEYS.forEach((k) => {
    const v = Store.get(k, null);
    if (v !== null) local[k] = v;
  });
  return {
    app: 'jekinteract',
    exportedAt: new Date().toISOString(),
    server: server.server || {},
    local
  };
}

/** Download object sebagai file JSON. */
function downloadJSON(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Baca file JSON dan kembalikan parsed object. */
function readJSONFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (e) {
        reject(new Error('File bukan JSON yang valid.'));
      }
    };
    reader.onerror = () => reject(new Error('Gagal membaca file.'));
    reader.readAsText(file);
  });
}

/** Impor payload ekspor: restore server config + localStorage. */
async function importConfig(payload) {
  const restored = [];
  if (payload.server && Object.keys(payload.server).length) {
    const r = await API.configImport({ server: payload.server });
    if (r && r.restored) restored.push(r.restored + ' key server');
  }
  if (payload.local) {
    Object.keys(payload.local).forEach((k) => {
      Store.set(k, payload.local[k]);
    });
    restored.push(Object.keys(payload.local).length + ' key lokal');
  }
  return restored;
}

export default {
  id: 'settings',
  title: 'Pengaturan',
  icon: 'sliders',

  render() {
    const s = Object.assign({}, DEFAULTS.settings, Store.get('settings', {}));
    return (
      '<div class="ph"><h1>Pengaturan</h1><p>Kelola antrean screen overlay, alamat server, dan data lokal.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Hapus Cache</h2><div class="sub">Menghapus semua antrean Screen Overlay 1 sampai 20.</div></div>' +
      '<button type="button" class="btn danger" id="st-clear">' + icon('trash') + 'Hapus Cache</button></div>' +
      '<div class="qgrid" id="qgrid"></div>' +
      '<p class="hint">Angka di tiap kotak adalah jumlah interaksi yang sedang tampil atau menunggu. Titik hijau berarti screen sedang online.</p>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Cloudflare Tunnel</h2><div class="sub">URL publik untuk link overlay — wajib untuk TikTok Live Studio.</div></div>' +
      '<span id="st-tun-chip"></span></div>' +
      '<div id="st-tun-info"></div>' +
      '<p class="hint">Tunnel otomatis aktif saat server berjalan. Semua link overlay otomatis memakai URL tunnel ini. Jika tunnel belum aktif, tunggu beberapa detik atau pastikan <code>cloudflared</code> terinstall.</p>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Alamat Server</h2><div class="sub">Override manual alamat yang dipakai di link overlay.</div></div></div>' +
      '<div class="addrs" id="st-addrs"><span class="muted">Mendeteksi alamat...</span></div>' +
      '<div class="fgrp"><label class="lbl" for="st-base">Override alamat link overlay <span class="opt">(opsional)</span></label>' +
      '<div class="field"><input id="st-base" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://192.168.1.5:3000" value="' + esc(s.baseUrl) + '"></div>' +
      '<p class="hint">Kosongkan agar link overlay otomatis memakai URL tunnel Cloudflare (jika aktif). Isi hanya jika ingin override manual ke IP jaringan. Aktif: <b id="st-cur"></b></p></div>' +
      '<div class="row"><button type="button" class="btn primary" id="st-base-save">' + icon('save') + 'Simpan</button></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Data Lokal</h2><div class="sub">Interaksi, aktivitas, goals, dan pengaturan fitur tersimpan di browser ini dan server lokal.</div></div></div>' +
      '<div class="row"><button type="button" class="btn" id="st-export">' + ICON_DOWNLOAD + 'Ekspor Konfigurasi</button>' +
      '<button type="button" class="btn" id="st-import">' + icon('upload') + 'Impor Konfigurasi</button></div>' +
      '<p class="hint">Ekspor menghasilkan file JSON berisi semua interaksi, aktivitas, music, subathon, goals, dan pengaturan fitur. Impor mengembalikan konfigurasi ke server dan browser ini.</p>' +
      '<input type="file" id="st-file" accept="application/json,.json" style="display:none">' +
      '<button type="button" class="btn danger" id="st-reset">' + icon('reset') + 'Reset semua data lokal</button>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Keluar & Hak Administrator</h2><div class="sub">Tutup semua proses JekInteract (termasuk helper keyboard & tunnel) agar file .exe bisa dihapus/diganti.</div></div></div>' +
      '<div id="st-ks-status"><span class="muted">Mendeteksi mesin keystroke…</span></div>' +
      '<p class="hint">Jika Roblox dijalankan dengan <b>Run as administrator</b>, JekInteract juga harus elevated. Windows memblokir keystroke dari proses biasa ke proses Administrator. Shortcut keluar global: <b>Ctrl+Alt+Shift+Q</b>.</p>' +
      '<div class="row"><button type="button" class="btn" id="st-admin">' + icon('bolt') + 'Jalankan sebagai Administrator</button>' +
      '<button type="button" class="btn danger" id="st-quit">' + icon('power') + 'Keluar JekInteract</button></div>' +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();

    /* ---- tunnel status ---- */
    const paintTunnel = () => {
      const t = Sync.tunnel;
      const chip = $('#st-tun-chip', root);
      const info = $('#st-tun-info', root);
      if (!chip || !info) return;

      if (t.status === 'online') {
        chip.innerHTML = '<span class="st on"><i></i>Tunnel aktif</span>';
        info.innerHTML =
          '<div class="fgrp"><label class="lbl">URL Tunnel (pakai di TikTok Live Studio)</label>' +
          '<div class="field ro"><input type="text" readonly value="' + esc(t.url) + '" aria-label="URL Tunnel" data-link></div>' +
          '<button type="button" class="btn sm" id="st-tun-copy">' + icon('copy') + 'Salin URL</button></div>' +
          '<p class="hint">Semua link overlay otomatis memakai URL ini. Contoh Screen 1: <b>' + esc(t.url) + '/overlay/screen/1</b></p>';
        const copyBtn = $('#st-tun-copy', root);
        if (copyBtn) {
          copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(t.url).then(() => toast('URL tunnel disalin.', 'ok')).catch(() => {
              const inp = info.querySelector('input[data-link]');
              if (inp) { inp.select(); document.execCommand('copy'); toast('URL tunnel disalin.', 'ok'); }
            });
          });
        }
      } else if (t.status === 'starting') {
        chip.innerHTML = '<span class="st wait"><i></i>Tunnel sedang dimulai…</span>';
        info.innerHTML = '<p class="dim">Cloudflare tunnel sedang dimulai, biasanya 5-10 detik. Tunggu sebentar…</p>';
      } else if (t.status === 'error') {
        chip.innerHTML = '<span class="st off"><i></i>Tunnel error</span>';
        info.innerHTML = '<p class="dim">' + esc(t.error || 'Tunnel tidak aktif.') + '</p>';
      } else {
        chip.innerHTML = '<span class="st off"><i></i>Tunnel tidak aktif</span>';
        info.innerHTML = '<p class="dim">Tunnel belum aktif. Link overlay memakai alamat lokal.</p>';
      }
    };
    paintTunnel();
    d(Sync.on('tunnelstate', paintTunnel));

    // Fetch tunnel status saat mount (fix: SSE bisa terlambat)
    API.tunnelStatus().then((t) => {
      if (!t) return;
      Sync.tunnel = t;
      paintTunnel();
    }).catch(() => {});

    /* ---- antrean screen ---- */
    const paintQ = () => {
      const q = Sync.status.queues || {};
      $('#qgrid', root).innerHTML = Array.from({ length: SCREEN_COUNT }, (_, i) => {
        const n = i + 1;
        const c = q[n] || 0;
        return '<div class="qt' + (c ? ' busy' : '') + '"><i class="dot' + (Sync.isOnline('screen-' + n) ? ' on' : '') + '"></i><b>' + n + '</b><span>' + c + '</span></div>';
      }).join('');
    };
    paintQ();
    d(Sync.on('status', paintQ));

    $('#st-clear', root).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Hapus cache',
        message: 'Hapus semua antrean pada Screen Overlay 1 sampai 20? Interaksi yang sedang tampil juga dihentikan.',
        okText: 'Hapus Cache',
        danger: true
      });
      if (!ok) return;
      try {
        await API.clearQueues();
        toast('Cache antrean Screen 1 sampai 20 dihapus.', 'ok');
      } catch (e) {
        toast('Gagal menghapus cache: ' + e.message, 'err');
      }
    });

    /* ---- alamat server ---- */
    const cur = () => {
      $('#st-cur', root).textContent = baseUrl();
    };
    cur();
    API.info()
      .then((info) => {
        const box = $('#st-addrs', root);
        if (!box) return;
        const urls = ['http://localhost:' + info.port].concat((info.addresses || []).map((ip) => 'http://' + ip + ':' + info.port));
        box.innerHTML =
          '<span class="muted sm-t">Alamat yang terdeteksi:</span>' +
          urls.map((u) => '<button type="button" class="btn sm" data-use="' + esc(u) + '">' + esc(u) + '</button>').join('') +
          (info.addresses && info.addresses.length ? '' : '<p class="hint">Alamat jaringan tidak terdeteksi. Lihat IP HP di pengaturan Wi-Fi, lalu isi manual di bawah.</p>');
      })
      .catch(() => {
        const box = $('#st-addrs', root);
        if (box) box.innerHTML = '<span class="muted sm-t">Alamat server tidak bisa dideteksi.</span>';
      });
    d(on(root, 'click', '[data-use]', (e, btn) => {
      $('#st-base', root).value = btn.dataset.use;
    }));

    $('#st-base-save', root).addEventListener('click', () => {
      const v = $('#st-base', root).value.trim().replace(/\/+$/, '');
      if (v && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(v)) return toast('Format alamat belum benar. Contoh: http://192.168.1.5:3000', 'err');
      Store.set('settings', Object.assign({}, Store.get('settings', {}), { baseUrl: v }));
      cur();
      toast(v ? 'Alamat dasar disimpan. Link overlay memakai alamat ini.' : 'Memakai alamat yang sedang dibuka.', 'ok');
    });

    /* ---- data lokal ---- */
    // Ekspor konfigurasi
    $('#st-export', root).addEventListener('click', async () => {
      const btn = $('#st-export', root);
      const original = btn.innerHTML;
      btn.innerHTML = icon('loader') + 'Mengambil…';
      btn.disabled = true;
      try {
        const payload = await exportConfig();
        downloadJSON(payload, 'jekinteract-config-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('Konfigurasi diekspor.', 'ok');
      } catch (e) {
        toast('Gagal ekspor: ' + e.message, 'err');
      } finally {
        btn.innerHTML = original;
        btn.disabled = false;
      }
    });

    // Impor konfigurasi (pilih file dulu, lalu konfirmasi)
    const fileInput = $('#st-file', root);
    $('#st-import', root).addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      let payload;
      try {
        payload = await readJSONFile(file);
      } catch (e) {
        toast(e.message, 'err');
        fileInput.value = '';
        return;
      }
      if (!payload || typeof payload !== 'object') {
        toast('File bukan payload konfigurasi yang valid.', 'err');
        fileInput.value = '';
        return;
      }
      const ok = await confirmDialog({
        title: 'Impor Konfigurasi',
        message: 'Konfigurasi dari "' + file.name + '" akan menggantikan interaksi, aktivitas, music, subathon, goals, dan pengaturan fitur yang ada. Tindakan ini tidak bisa dibatalkan.',
        okText: 'Impor',
        danger: true
      });
      if (!ok) {
        fileInput.value = '';
        return;
      }
      const btn = $('#st-import', root);
      const original = btn.innerHTML;
      btn.innerHTML = icon('loader') + 'Mengimpor…';
      btn.disabled = true;
      try {
        const restored = await importConfig(payload);
        toast('Konfigurasi diimpor (' + restored.join(', ') + ').', 'ok', 2500);
        setTimeout(() => location.reload(), 900);
      } catch (e) {
        toast('Gagal impor: ' + e.message, 'err');
      } finally {
        btn.innerHTML = original;
        btn.disabled = false;
        fileInput.value = '';
      }
    });

    // Reset data lokal
    $('#st-reset', root).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Reset data lokal',
        message: 'Hapus semua interaksi, aktivitas, goals, dan pengaturan fitur dari browser ini dan server lokal? Tindakan ini tidak bisa dibatalkan.',
        okText: 'Reset',
        danger: true
      });
      if (!ok) return;
      try {
        await API.resetData();
      } catch (e) {
        toast('Data server gagal direset: ' + e.message, 'warn', 3500);
      }
      Store.clearAll();
      toast('Data lokal dihapus. Memuat ulang...', 'ok', 1500);
      setTimeout(() => location.reload(), 900);
    });

    /* ---- status keystroke & kontrol aplikasi ---- */
    API.keystrokeStatus().then((s) => {
      const box = $('#st-ks-status', root);
      if (!box) return;
      if (!s.available) {
        box.innerHTML = '<span class="st off"><i></i>Keystroke tidak tersedia (simulasi)</span>';
      } else if (s.elevatedTargetBlocked) {
        box.innerHTML = '<span class="st wait"><i></i>Keystroke aktif, tapi belum Administrator</span>' +
          '<p class="hint" style="color:#fbbf24">' + esc(s.hint) + '</p>';
      } else {
        box.innerHTML = '<span class="st on"><i></i>Keystroke aktif' + (s.elevated ? ' (Administrator)' : '') + '</span>' +
          '<p class="hint">' + esc(s.hint) + '</p>';
      }
    }).catch(() => {
      const box = $('#st-ks-status', root);
      if (box) box.innerHTML = '<span class="muted sm-t">Status keystroke gagal dideteksi.</span>';
    });

    $('#st-admin', root).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Jalankan sebagai Administrator',
        message: 'JekInteract akan ditutup lalu dibuka ulang dengan izin Administrator. Klik Ya pada prompt UAC Windows. Ini diperlukan agar keystroke bisa masuk ke Roblox yang dijalankan sebagai Administrator.',
        okText: 'Restart Admin'
      });
      if (!ok) return;
      try {
        await API.restartAdmin();
        toast('Menunggu konfirmasi UAC…', 'info', 4000);
      } catch (e) {
        toast(e.message, 'err', 6000);
      }
    });

    $('#st-quit', root).addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Keluar JekInteract',
        message: 'Menutup JekInteract akan mematikan server, overlay, helper keyboard, dan tunnel. Setelah proses benar-benar keluar, file JekInteract.exe bisa dihapus atau diganti.',
        okText: 'Keluar',
        danger: true
      });
      if (!ok) return;
      try {
        await API.appQuit();
        toast('JekInteract ditutup. Jika file masih terkunci, tunggu 1–2 detik.', 'ok', 4000);
      } catch (e) {
        toast('Gagal keluar lewat dashboard. Gunakan tray → Keluar atau Ctrl+Alt+Shift+Q.', 'err', 6000);
      }
    });

    return () => d.run();
  }
};
