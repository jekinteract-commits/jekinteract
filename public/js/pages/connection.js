import { $, esc, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Store, DEFAULTS, Session } from '../lib/store.js';
import { Sync, API } from '../lib/sync.js';
import { toast, alertHTML } from '../lib/ui.js';

const USER_RE = /^[A-Za-z0-9._]{2,30}$/;
const HOST_RE = /^(\d{1,3}(\.\d{1,3}){3}|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)$/;

function validIPv4OrHost(v) {
  if (!HOST_RE.test(v)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split('.').every((n) => +n <= 255);
  return true;
}

export default {
  id: 'connection',
  title: 'Connection',
  icon: 'plug',

  render() {
    const obs = Store.get('obs', DEFAULTS.obs);
    return (
      '<div class="ph"><h1>Connection</h1><p>Hubungkan JekInteract ke live TikTok lewat username. Koneksi ke OBS bersifat opsional.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Konek ke Live via Username</h2><div class="sub">Akun TikTok harus sedang LIVE saat dihubungkan.</div></div><span id="cn-chip"></span></div>' +
      '<div class="fgrp"><label class="lbl" for="cn-user">Username TikTok</label>' +
      '<div class="field pre"><i>@</i><input id="cn-user" type="text" inputmode="text" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="30" placeholder="username_tiktok"></div>' +
      '<p class="hint">Tulis tanpa tanda @. Akun harus sedang LIVE.</p></div>' +
      '<div class="row cn-actions">' +
      '<button type="button" class="btn primary" id="cn-go">' + icon('plug') + 'Connect</button>' +
      '<button type="button" class="btn danger" id="cn-stop">' + icon('power') + 'Disconnect</button></div>' +
      '<div class="cn-alert" id="cn-alert" aria-live="polite"></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Koneksi Opsional</h2><div class="sub">Kontrol OBS (Scene &amp; Source)</div></div><span id="obs-chip"></span></div>' +
      '<p class="dim obs-desc">Biar JekInteract bisa ganti scene atau menyalakan source di OBS otomatis saat ada gift atau komentar. ' +
      'Pilihannya ada di Pusat Interaksi: &quot;Switch Scene OBS&quot; dan &quot;Aktifkan Source&quot;.</p>' +
      '<div class="g2 obs-form">' +
      '<div class="fgrp"><label class="lbl" for="obs-ip">IP</label>' +
      '<div class="field"><input id="obs-ip" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="127.0.0.1" value="' + esc(obs.ip) + '"></div></div>' +
      '<div class="fgrp"><label class="lbl" for="obs-port">Port</label>' +
      '<div class="field"><input id="obs-port" type="text" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="4455" value="' + esc(obs.port) + '"></div></div>' +
      '</div>' +
      '<div class="fgrp"><label class="lbl" for="obs-pass">Password <span class="opt">(opsional)</span></label>' +
      '<div class="field"><input id="obs-pass" type="password" autocomplete="off" placeholder="Kosongkan jika tidak memakai password" value="' + esc(obs.password) + '"></div></div>' +
      '<div class="row cn-actions">' +
      '<button type="button" class="btn" id="obs-connect">' + icon('radio') + 'Sambungkan OBS</button>' +
      '<button type="button" class="btn danger" id="obs-disconnect">' + icon('power') + 'Putuskan OBS</button>' +
      '<button type="button" class="btn primary" id="obs-save">' + icon('save') + 'Simpan</button></div>' +
      '<div class="cn-alert" id="obs-alert" aria-live="polite"></div>' +
      '<p class="hint">Ambil IP dan Port dari OBS: Tools → WebSocket Server Settings. Port bawaan OBS: 4455.</p>' +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    let alive = true;
    d(() => (alive = false));

    const userEl = $('#cn-user', root);
    const goBtn = $('#cn-go', root);
    const stopBtn = $('#cn-stop', root);
    const alertBox = $('#cn-alert', root);
    const obsBox = $('#obs-alert', root);

    /* ---- Sinkronisasi state dari Sync.tiktok ---- */
    const applyTiktok = (tk) => {
      const online = tk.state === 'online';
      const busy = tk.state === 'connecting';
      const err = tk.state === 'error';

      // Library gagal dimuat (umum di build lama: require() pada modul ESM).
      // Tampilkan detail error, jangan cuma tulis "tidak tersedia".
      if (tk.available === false && !tk.loading) {
        $('#cn-chip', root).innerHTML = '<span class="st off"><i></i>Library TikTok error</span>';
        goBtn.disabled = true;
        stopBtn.disabled = true;
        userEl.readOnly = true;
        alertBox.innerHTML = alertHTML(
          'err',
          'Library TikTok tidak tersedia',
          (tk.importError ? 'Detail: ' + esc(tk.importError) + '. ' : '') +
          'Perbarui ke build terbaru (v1.0.24+), atau jalankan dari source dengan <code>npm install &amp;&amp; npm start</code>.'
        );
        return;
      }

      $('#cn-chip', root).innerHTML =
        online ? '<span class="st on"><i></i>Terhubung @' + esc(tk.username) + '</span>'
        : busy  ? '<span class="st wait"><i></i>Menghubungkan @' + esc(tk.username) + '</span>'
        : err   ? '<span class="st off"><i></i>Error koneksi</span>'
        : '<span class="st off"><i></i>Tidak terhubung</span>';

      goBtn.disabled = online || busy;
      stopBtn.disabled = !online && !busy && !err;
      userEl.readOnly = online || busy;
      if ((online || busy) && !userEl.value) userEl.value = tk.username;

      // Sinkronkan ke Session agar topbar ikut update
      Session.set({
        connection: {
          status: online ? 'online' : busy ? 'connecting' : 'offline',
          username: tk.username || '',
          since: online ? Date.now() : 0
        }
      });
    };

    // Saat halaman dibuka, tampilkan status saat ini langsung (tanpa tunggu SSE baru)
    applyTiktok(Sync.tiktok);
    if (Sync.tiktok.state === 'online') {
      alertBox.innerHTML = alertHTML('ok', 'Terhubung', 'Terhubung ke live @' + esc(Sync.tiktok.username) + '.');
    } else if (Sync.tiktok.state === 'connecting') {
      alertBox.innerHTML = alertHTML('info', 'Menghubungkan…', 'Sedang menghubungkan ke live @' + esc(Sync.tiktok.username) + '. Tunggu sebentar…');
    } else if (Sync.tiktok.state === 'error') {
      alertBox.innerHTML = alertHTML('err', 'Gagal terhubung', Sync.tiktok.error || 'Terjadi kesalahan.');
    }

    // Fetch status TikTok via REST — fix Cloudflare/tunnel (SSE hello bisa terlambat).
    fetch('/api/tiktok/status')
      .then((r) => r.json())
      .then((tk) => {
        if (!tk || !alive) return;
        Sync.tiktok = tk;
        applyTiktok(tk);
        if (tk.state === 'online' && !alertBox.innerHTML) {
          alertBox.innerHTML = alertHTML('ok', 'Terhubung', 'Terhubung ke live @' + esc(tk.username) + '.');
        }
      })
      .catch(() => {});

    // Terima update real-time dari SSE
    d(Sync.on('tiktok', (tk) => {
      if (!alive) return;
      applyTiktok(Sync.tiktok);

      const ev = tk.event;
      if (ev === 'connected') {
        if (alive) alertBox.innerHTML = alertHTML('ok', 'Terhubung', 'Berhasil terhubung ke live @' + esc(tk.username) + '.');
        toast('Terhubung ke live @' + tk.username + '.', 'ok');
      } else if (ev === 'disconnected') {
        if (tk.manual) {
          if (alive) alertBox.innerHTML = alertHTML('warn', 'Koneksi diputus', 'JekInteract tidak lagi menerima event dari TikTok.');
          toast('Koneksi diputus.', 'warn');
        } else {
          if (alive) alertBox.innerHTML = alertHTML('warn', 'Koneksi terputus', 'Koneksi ke TikTok Live terputus. Coba sambungkan kembali.');
          toast('Koneksi ke TikTok terputus.', 'warn');
        }
      } else if (ev === 'error') {
        const msg = tk.error || 'Gagal terhubung.';
        if (alive) alertBox.innerHTML = alertHTML('err', 'Gagal terhubung', msg);
        toast('Error TikTok: ' + msg, 'err');
      }
    }));

    /* ---- OBS status dari Sync.obs (real-time dari server) ---- */
    const paintObs = () => {
      const o = Sync.obs.status;
      $('#obs-chip', root).innerHTML =
        o === 'online'      ? '<span class="st on"><i></i>OBS tersambung</span>'
        : o === 'connecting' ? '<span class="st wait"><i></i>Menyambungkan…</span>'
        : o === 'error'      ? '<span class="st off"><i></i>OBS error: ' + esc(Sync.obs.error || '') + '</span>'
        : '<span class="st off"><i></i>OBS belum tersambung</span>';
      const connectBtn    = $('#obs-connect', root);
      const disconnectBtn = $('#obs-disconnect', root);
      if (connectBtn)    connectBtn.disabled    = o === 'connecting' || o === 'online';
      if (disconnectBtn) disconnectBtn.disabled = o === 'offline';
    };
    paintObs();
    d(Sync.on('obsstate', () => {
      paintObs();
      const o = Sync.obs;
      const obsBox = $('#obs-alert', root);
      if (!obsBox) return;
      if (o.status === 'online') {
        obsBox.innerHTML = alertHTML('ok', 'OBS terhubung', 'Berhasil terhubung ke OBS di ws://' + esc(o.ip) + ':' + esc(o.port) + '.');
        toast('OBS terhubung.', 'ok');
      } else if (o.status === 'error') {
        obsBox.innerHTML = alertHTML('err', 'OBS gagal terhubung', o.error || 'Tidak bisa terhubung ke OBS.');
        toast('OBS error: ' + (o.error || ''), 'err');
      } else if (o.status === 'offline') {
        obsBox.innerHTML = alertHTML('warn', 'OBS terputus', 'Koneksi ke OBS diputus.');
      }
    }));

    // Sinkronkan Session.obs untuk komponen topbar (tetap didukung untuk backward-compat)
    const syncObsSession = () => {
      Session.set({ obs: { status: Sync.obs.status === 'online' ? 'online' : Sync.obs.status === 'connecting' ? 'testing' : 'idle', detail: Sync.obs.ip + ':' + Sync.obs.port } });
    };
    syncObsSession();
    d(Sync.on('obsstate', syncObsSession));

    /* ---- Tombol Connect ---- */
    const connect = async () => {
      const u = userEl.value.trim().replace(/^@/, '');
      if (!u) {
        alertBox.innerHTML = alertHTML('err', 'Username belum diisi', 'Masukkan username TikTok yang sedang live.');
        toast('Username belum diisi.', 'err');
        return userEl.focus();
      }
      if (!USER_RE.test(u)) {
        alertBox.innerHTML = alertHTML('err', 'Username tidak valid', 'Pakai huruf, angka, titik, atau underscore (2 sampai 30 karakter).');
        toast('Username tidak valid.', 'err');
        return userEl.focus();
      }
      alertBox.innerHTML = '';
      goBtn.disabled = true;
      try {
        await API.tiktokConnect(u);
        // Langsung tampilkan status "Menghubungkan" tanpa tunggu SSE (SSE kadang terlambat)
        applyTiktok({ state: 'connecting', username: u, error: '', available: true });
        alertBox.innerHTML = alertHTML('info', 'Menghubungkan…', 'Sedang menghubungkan ke live @' + esc(u) + '. Tunggu sebentar…');
      } catch (e) {
        const msg = e && e.message ? e.message : 'Gagal mengirim permintaan ke server.';
        alertBox.innerHTML = alertHTML('err', 'Gagal', msg);
        toast(msg, 'err');
        goBtn.disabled = false;
      }
    };

    /* ---- Tombol Disconnect ---- */
    const disconnect = async () => {
      stopBtn.disabled = true;
      try {
        await API.tiktokDisconnect();
      } catch (e) {
        toast('Gagal memutus koneksi: ' + (e && e.message || ''), 'err');
        stopBtn.disabled = false;
      }
    };

    goBtn.addEventListener('click', connect);
    stopBtn.addEventListener('click', disconnect);
    userEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

    /* ---- OBS ---- */
    const readObs = () => ({ ip: $('#obs-ip', root).value.trim(), port: $('#obs-port', root).value.trim(), password: $('#obs-pass', root).value });
    const checkObs = (v) => {
      if (!validIPv4OrHost(v.ip)) return 'IP tidak valid. Contoh: 127.0.0.1 atau 192.168.1.10.';
      if (!/^\d{1,5}$/.test(v.port) || +v.port < 1 || +v.port > 65535) return 'Port tidak valid. Isi angka 1 sampai 65535 (bawaan OBS: 4455).';
      return '';
    };

    $('#obs-connect', root).addEventListener('click', async () => {
      const v = readObs();
      const err = checkObs(v);
      if (err) { obsBox.innerHTML = alertHTML('err', 'Data belum benar', err); toast(err, 'err'); return; }
      obsBox.innerHTML = '';
      // Simpan config dulu ke localStorage agar bisa dibaca saat reload
      Store.set('obs', v);
      try {
        await API.obsConnect(v.ip, v.port, v.password);
        obsBox.innerHTML = alertHTML('info', 'Menyambungkan…', 'Menghubungkan ke OBS di ws://' + esc(v.ip) + ':' + esc(v.port) + '. Tunggu sebentar…');
        toast('Menyambungkan ke OBS…', 'info');
      } catch (e) {
        const msg = e && e.message ? e.message : 'Gagal mengirim permintaan.';
        obsBox.innerHTML = alertHTML('err', 'Gagal', msg);
        toast(msg, 'err');
      }
    });

    $('#obs-disconnect', root).addEventListener('click', async () => {
      try {
        await API.obsDisconnect();
        toast('OBS diputus.', 'info');
      } catch (e) {
        toast('Gagal putus OBS: ' + (e && e.message || ''), 'err');
      }
    });

    $('#obs-save', root).addEventListener('click', () => {
      const v = readObs();
      const err = checkObs(v);
      if (err) { obsBox.innerHTML = alertHTML('err', 'Belum bisa disimpan', err); toast(err, 'err'); return; }
      Store.set('obs', v);
      obsBox.innerHTML = alertHTML('ok', 'Tersimpan', 'Pengaturan OBS disimpan.');
      toast('Pengaturan OBS disimpan.', 'ok');
    });

    return () => d.run();
  }
};
