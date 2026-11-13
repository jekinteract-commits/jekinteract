import { $, esc, on, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Store, DEFAULTS, baseUrl } from '../lib/store.js';
import { Sync, API } from '../lib/sync.js';
import { SCREEN_COUNT } from '../lib/overlays.js';
import { toast, confirmDialog } from '../lib/ui.js';

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
      '<div class="fh"><div class="fh-t"><h2>Alamat Server</h2><div class="sub">Dipakai pada link overlay yang disalin.</div></div></div>' +
      '<div class="addrs" id="st-addrs"><span class="muted">Mendeteksi alamat...</span></div>' +
      '<div class="fgrp"><label class="lbl" for="st-base">Alamat dasar link overlay <span class="opt">(opsional)</span></label>' +
      '<div class="field"><input id="st-base" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://192.168.1.5:3000" value="' + esc(s.baseUrl) + '"></div>' +
      '<p class="hint">Isi dengan IP jaringan jika overlay dibuka dari perangkat lain, misalnya OBS di PC. Kosongkan untuk memakai alamat yang sedang dibuka: <b id="st-cur"></b></p></div>' +
      '<div class="row"><button type="button" class="btn primary" id="st-base-save">' + icon('save') + 'Simpan</button></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Data Lokal</h2><div class="sub">Interaksi, aktivitas, goals, dan pengaturan fitur tersimpan di browser ini dan server lokal.</div></div></div>' +
      '<button type="button" class="btn danger" id="st-reset">' + icon('reset') + 'Reset semua data lokal</button>' +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();

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

    return () => d.run();
  }
};
