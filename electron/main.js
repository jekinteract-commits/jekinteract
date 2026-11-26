'use strict';

/**
 * JekInteract — Electron main process
 *
 * Alur:
 *  1. Load server.js langsung di main process (Electron IS Node.js)
 *  2. Tunggu server siap (cek HTTP /api/info)
 *  3. Polling tunnel URL dari /api/tunnel/status hingga online (maks 60 detik)
 *  4. Buka BrowserWindow yang load http://localhost:<port>
 *  5. Inject tunnel URL ke renderer via IPC agar overlay links pakai URL Cloudflare
 *  6. Saat app quit → server otomatis mati (sama process)
 */

const { app, BrowserWindow, shell, Tray, Menu, nativeImage, ipcMain, globalShortcut, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawnSync, execFile } = require('child_process');
const license = require('./license');

// ── Deteksi Wine ──────────────────────────────────────────────────────────────
// Winlator/BoxedWine (Android) butuh setelan GPU khusus (OpenGL/gladio).
// Windows asli dibiarkan pakai default Chromium (ANGLE D3D11) yang paling stabil,
// supaya tidak menukar bug "gagal start" dengan bug "layar blank".
let IS_WINE = false;
try {
  if (process.env.WINEPREFIX || process.env.WINEARCH || process.env.WINEDLLOVERRIDES) {
    IS_WINE = true;
  } else if (process.platform === 'win32') {
    // Wine selalu punya wineboot.exe di system32; Windows asli tidak.
    const windir = process.env.WINDIR || 'C:\\windows';
    IS_WINE = fs.existsSync(path.join(windir, 'system32', 'wineboot.exe'));
  }
} catch (_) {}

app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
if (IS_WINE) {
  // Winlator: pakai OpenGL (gladio) yang sudah ada, jangan override dengan swiftshader
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('use-gl', 'desktop');
  app.commandLine.appendSwitch('use-angle', 'gl');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}

// ── Logging ke file ───────────────────────────────────────────────────────────
// Di .exe Windows tidak ada console, jadi semua log ditulis ke file agar bisa
// diperiksa saat troubleshooting.
let LOG_FILE = '';        // path utama (buat ditampilkan di dialog error)
const LOG_FILES = [];     // semua lokasi log yang berhasil dibuat
function initLog() {
  const candidates = [];
  // 1) Di samping file .exe portable — paling gampang ditemukan (Windows & Winlator).
  //    electron-builder men-set PORTABLE_EXECUTABLE_DIR ke folder .exe aslinya.
  try {
    const dir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (dir) candidates.push(path.join(dir, 'jekinteract.log'));
  } catch (_) {}
  // 2) %APPDATA%\JekInteract\jekinteract.log
  try { candidates.push(path.join(app.getPath('userData'), 'jekinteract.log')); } catch (_) {}
  // 3) %TEMP%\jekinteract.log
  try { candidates.push(path.join(os.tmpdir(), 'jekinteract.log')); } catch (_) {}

  const header = '=== JekInteract ' + new Date().toISOString() + ' ===\n';
  for (const f of candidates) {
    if (LOG_FILES.indexOf(f) !== -1) continue;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, header);
      LOG_FILES.push(f);
      if (!LOG_FILE) LOG_FILE = f;
    } catch (_) {}
  }
}
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  for (const f of LOG_FILES) { try { fs.appendFileSync(f, line + '\n'); } catch (_) {} }
  try { if (process.stdout) process.stdout.write(line + '\n'); } catch (_) {}
}
// Tangkap console.log/warn/error dari server.js ke file log juga.
function captureConsole() {
  ['log', 'info', 'warn', 'error'].forEach((m) => {
    const orig = console[m] ? console[m].bind(console) : () => {};
    console[m] = (...args) => {
      try { orig(...args); } catch (_) {}
      try {
        if (LOG_FILES.length) {
          const text = args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' ');
          for (const f of LOG_FILES) { try { fs.appendFileSync(f, text + '\n'); } catch (_) {} }
        }
      } catch (_) {}
    };
  });
}
function safeString(v) {
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

// ── Path root proyek ──────────────────────────────────────────────────────────
const isPackaged = app.isPackaged;
const ROOT = isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_JS = path.join(ROOT, 'server.js');

// ── Ikon aplikasi (window + tray) ────────────────────────────────────────────
// Tanpa ikon, Tray di Windows jadi tidak terlihat → app seolah "hilang" padahal
// masih hidup di background. Ikon PNG ini ikut dibundel lewat folder public.
const ICON_PATH = path.join(ROOT, 'public', 'assets', 'logo.png');
function appIcon() {
  try {
    const img = nativeImage.createFromPath(ICON_PATH);
    if (img && !img.isEmpty()) return img;
  } catch (_) {}
  return nativeImage.createEmpty();
}

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let serverPort = 3000;
let serverReady = false;
let tunnelUrl = '';
let licenseWindow = null;
let appStarted = false;
let appQuitting = false;
let loadingReady = false;
let loadingPageActive = false;
let lastLoadingStatus = { text: 'Menyiapkan jendela aplikasi…', pct: 8 };

// ── Keluar & hak Administrator ────────────────────────────────────────────────
const QUIT_SHORTCUT = 'Ctrl+Alt+Shift+Q';

function isElevated() {
  if (process.platform !== 'win32') return false;
  try {
    return spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0;
  } catch (_) {
    return false;
  }
}

/** Tutup server, helper keystroke, tunnel, lalu matikan aplikasi. */
function shutdownAndQuit() {
  try { if (typeof global.__JEK_SHUTDOWN === 'function') global.__JEK_SHUTDOWN(); } catch (_) {}
  app.quit();
}

/**
 * Restart aplikasi dengan UAC elevation. Diperlukan supaya keystroke sintetis
 * bisa masuk ke game/app yang dijalankan sebagai Administrator (Roblox).
 */
function restartAsAdmin() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Fitur ini hanya untuk Windows.' };
  }
  if (isElevated()) {
    return { ok: false, error: 'JekInteract sudah berjalan sebagai Administrator.' };
  }

  // Untuk packaged app, process.execPath adalah JekInteract.exe.
  // Buang argumen yang merupakan path exe itu sendiri supaya tidak dobel.
  const args = process.argv.slice(1).filter((a) => {
    try { return path.resolve(a) !== path.resolve(process.execPath); } catch (_) { return true; }
  });
  const psCmd =
    '$p = ' + JSON.stringify(process.execPath) + '; ' +
    '$a = ' + JSON.stringify(args) + '; ' +
    'Start-Process -FilePath $p -ArgumentList $a -Verb RunAs';

  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
    { windowsHide: true },
    (err) => {
      if (err) {
        log('[electron] gagal meminta elevasi: ' + err.message);
        dialog.showErrorBox('JekInteract - Gagal Restart Admin',
          'Tidak bisa meminta izin Administrator:\n\n' + err.message +
          '\n\nAlternatif: klik kanan JekInteract.exe → Run as administrator.');
      }
    });

  setTimeout(shutdownAndQuit, 500);
  return { ok: true };
}

// Dipanggil server.js lewat endpoint /api/app/quit dan /api/app/restart-admin.
global.__JEK_QUIT = shutdownAndQuit;
global.__JEK_RESTART_ADMIN = restartAsAdmin;

// ── Driver keyboard opsional (Interception) ───────────────────────────────────
// Keystroke sudah berfungsi lewat helper PowerShell (keybd_event) / nut.js tanpa
// driver dan tanpa Administrator. Driver Interception hanya dipasang bila user
// memilih manual lewat menu tray "Pasang ulang driver keyboard…".
const INTERCEPTION_SETUP_ARG = '--interception-setup';

/** Cek apakah driver Interception sudah terpasang di sistem. */
function interceptionDriverInstalled() {
  if (process.platform !== 'win32' || IS_WINE) return false;
  const windir = process.env.WINDIR || 'C:\\Windows';
  try {
    if (fs.existsSync(path.join(windir, 'System32', 'drivers', 'interception.sys'))) return true;
  } catch (_) {}
  try {
    const r = spawnSync('sc', ['query', 'interception'], { windowsHide: true, encoding: 'utf8' });
    if (r && (r.stdout || '').toLowerCase().indexOf('interception') >= 0) return true;
  } catch (_) {}
  return false;
}

/** Cari install-interception.exe di bundel (.exe) atau folder resources. */
function findInterceptionInstaller() {
  const roots = [];
  if (isPackaged) roots.push(path.join(process.resourcesPath, 'interception'));
  roots.push(path.join(ROOT, 'resources', 'interception'));
  roots.push(path.join(ROOT, 'interception'));
  const walk = (dir, depth) => {
    if (depth > 5) return null;
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isFile() && ent.name.toLowerCase() === 'install-interception.exe') return p;
        if (ent.isDirectory()) {
          const hit = walk(p, depth + 1);
          if (hit) return hit;
        }
      }
    } catch (_) {}
    return null;
  };
  for (const root of roots) {
    const hit = walk(root, 0);
    if (hit) return hit;
  }
  return null;
}

/** Jalankan ulang .exe dengan UAC, membawa flag --interception-setup. */
function relaunchElevatedForSetup() {
  const args = process.argv.slice(1).filter((a) => {
    if (a === INTERCEPTION_SETUP_ARG) return false;
    try { return path.resolve(a) !== path.resolve(process.execPath); } catch (_) { return true; }
  });
  args.push(INTERCEPTION_SETUP_ARG);
  const psCmd =
    '$p = ' + JSON.stringify(process.execPath) + '; ' +
    '$a = ' + JSON.stringify(args) + '; ' +
    'Start-Process -FilePath $p -ArgumentList $a -Verb RunAs';
  try {
    // Lepas lock dulu supaya instance elevated bisa langsung jalan.
    try { app.releaseSingleInstanceLock(); } catch (_) {}
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
      { windowsHide: true },
      (err) => {
        if (err) {
          log('[setup] gagal meminta elevasi: ' + err.message);
          dialog.showErrorBox('JekInteract - Siapkan keyboard',
            'Gagal meminta izin Administrator:\n\n' + err.message +
            '\n\nKlik kanan JekInteract.exe → Run as administrator, lalu buka lagi.');
        }
      });
    return true;
  } catch (e) {
    dialog.showErrorBox('JekInteract - Siapkan keyboard',
      'Gagal meminta izin Administrator: ' + (e && e.message ? e.message : e));
    return false;
  }
}

/** Instal driver secara diam-diam (dijalankan dari instance elevated). */
function runInterceptionInstaller() {
  return new Promise((resolve) => {
    const installer = findInterceptionInstaller();
    if (!installer) {
      return resolve({ ok: false, error: 'File installer driver tidak ditemukan di bundel .exe.' });
    }
    const psCmd =
      '$i = ' + JSON.stringify(installer) + '; ' +
      'Start-Process -FilePath $i -ArgumentList ' + JSON.stringify('/install') +
      ' -Verb RunAs -Wait -WindowStyle Hidden';
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
      { windowsHide: true, cwd: path.dirname(installer) },
      (err) => {
        const installed = interceptionDriverInstalled();
        log('[setup] installer selesai — err=' + (err ? err.message : '-') + ', driverFound=' + installed);
        resolve({ ok: installed, installed, error: err ? err.message : '' });
      });
  });
}

/**
 * Startup normal langsung jalan: TANPA dialog "Siapkan keyboard", tanpa UAC,
 * tanpa restart. Keystroke memakai helper PowerShell (keybd_event) / nut.js yang
 * bekerja tanpa driver dan tanpa hak Administrator.
 *
 * Driver Interception hanya diproses saat mode install manual aktif (dipicu
 * dari menu tray "Pasang ulang driver keyboard…").
 * Mengembalikan true bila startup harus dihentikan (sedang install/elevasi).
 */
async function ensureKeyboardDriverSetup() {
  if (process.platform !== 'win32' || IS_WINE) return false;

  const inSetupMode = process.argv.includes(INTERCEPTION_SETUP_ARG);
  log('[setup] cek driver — elevated=' + isElevated() + ', modeInstall=' + inSetupMode);

  // Jangan pernah mengganggu peluncuran biasa dengan prompt/UAC.
  if (!inSetupMode) {
    log('[setup] startup biasa — setup driver dilewati (mode keystroke standar aktif)');
    return false;
  }

  if (interceptionDriverInstalled()) {
    log('[setup] driver keyboard sudah terpasang — lewati setup');
    return false;
  }

  // Butuh hak Administrator untuk memasang driver. Kalau belum elevated,
  // jalankan ulang .exe sekali dengan flag mode install.
  if (!isElevated()) {
    relaunchElevatedForSetup();
    app.quit();
    return true;
  }

  // Sudah elevated → pasang langsung (jalur manual dari tray).
  const res = await runInterceptionInstaller();

  if (res.ok) {
    const choice = dialog.showMessageBoxSync({
      type: 'info',
      buttons: ['Restart sekarang', 'Nanti saja'],
      defaultId: 0,
      cancelId: 1,
      title: 'JekInteract - Siapkan keyboard',
      message: 'Driver keyboard berhasil dipasang.',
      detail: 'PC perlu di-restart sekali supaya driver aktif.\nSetelah itu cukup buka JekInteract.exe.'
    });
    if (choice === 0) {
      try { spawnSync('shutdown', ['/r', '/t', '5'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
    }
  } else {
    dialog.showErrorBox('JekInteract - Siapkan keyboard',
      'Driver tidak bisa dipasang otomatis.\n\n' + (res.error || 'Installer gagal.') +
      '\n\nAplikasi tetap berjalan memakai keystroke mode lama.');
  }
  app.quit();
  return true;
}

// ── Hotkey global Win/Lose (Numpad + / -) ─────────────────────────────────────
// Didaftarkan hanya saat halaman Win Lose Bar terbuka, supaya Numpad tidak
// "dibajak" terus-menerus saat halaman lain yang sedang dipakai.
const WINLOSE_HOTKEYS = [
  { accelerator: 'numadd', key: 'win' },
  { accelerator: 'numsub', key: 'lose' }
];

function unregisterWinloseHotkeys() {
  for (const { accelerator } of WINLOSE_HOTKEYS) {
    try { globalShortcut.unregister(accelerator); } catch (_) {}
  }
}

function setWinloseHotkeys(enabled) {
  unregisterWinloseHotkeys();
  if (!enabled) return { ok: true, enabled: false };

  const failed = [];
  for (const { accelerator, key } of WINLOSE_HOTKEYS) {
    let ok = false;
    try {
      // Callback berjalan di main process, jadi tetap terpicu walau window
      // JekInteract tidak fokus / sedang di belakang aplikasi lain.
      ok = globalShortcut.register(accelerator, () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('winlose-hotkey', key);
      });
    } catch (_) {}
    if (!ok) failed.push(accelerator);
  }

  if (failed.length) {
    unregisterWinloseHotkeys();
    return {
      ok: false,
      enabled: false,
      error: 'Tidak bisa mendaftarkan hotkey global (' + failed.join(', ') + '). Mungkin sedang dipakai aplikasi lain.'
    };
  }

  log('[electron] hotkey global Win/Lose aktif (numadd, numsub)');
  return { ok: true, enabled: true };
}

// ── Jalankan server langsung di main process ──────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    // Set env sebelum require server.js
    process.env.ELECTRON = '1';
    // Teruskan hasil deteksi Wine agar server.js bisa memilih mesin keystroke
    // yang tepat (PowerShell hanya ada di Windows asli, bukan di Wine).
    process.env.JEK_IS_WINE = IS_WINE ? '1' : '0';

    // Selalu bind ke semua interface. Jangan warisi env HOST yang aneh dari
    // sistem (bisa bikin server bind ke alamat yang tak terjangkau / gagal).
    if (process.env.HOST && process.env.HOST !== '0.0.0.0') {
      log('[electron] mengabaikan env HOST=' + process.env.HOST + ' (dipaksa 0.0.0.0)');
    }
    process.env.HOST = '0.0.0.0';

    // ── Folder data yang persisten ──────────────────────────────────────────
    // Mode portable mengekstrak app ke folder TEMP yang dihapus saat keluar.
    // Kalau data disimpan di sana, state.json & upload hilang tiap launch.
    // Simpan di samping .exe (portable) atau di %APPDATA% (installer).
    try {
      let dataDir = '';
      const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
      if (isPackaged) {
        dataDir = portableDir
          ? path.join(portableDir, 'data')
          : path.join(app.getPath('userData'), 'data');
      }
      if (dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });
        const probe = path.join(dataDir, '.write-test');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        process.env.JEK_DATA_DIR = dataDir;
        log('[electron] folder data: ' + dataDir);
      }
    } catch (e) {
      try {
        const fallback = path.join(app.getPath('userData'), 'data');
        fs.mkdirSync(fallback, { recursive: true });
        process.env.JEK_DATA_DIR = fallback;
        log('[electron] folder data (fallback): ' + fallback);
      } catch (e2) {
        log('[electron] gagal menyiapkan folder data: ' + (e2 && e2.message ? e2.message : e2));
      }
    }

    log('[electron] memuat server... env HOST=' + process.env.HOST + ' PORT=' + (process.env.PORT || '(default 3000)'));

    // Lokasi cloudflared yang dibundel saat build (.exe)
    if (isPackaged) {
      const cfBundled = path.join(
        process.resourcesPath, 'cloudflared',
        process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
      );
      if (fs.existsSync(cfBundled)) {
        process.env.CLOUDFLARED_PATH = cfBundled;
        log('[electron] cloudflared bundled: ' + cfBundled);
      } else {
        log('[electron] cloudflared bundled TIDAK ditemukan di ' + cfBundled);
      }
    }

    let settled = false;
    function ready(port, via) {
      if (settled) return;
      settled = true;
      serverPort = port;
      serverReady = true;
      log('[electron] server siap di port ' + port + ' (via ' + via + ')');
      resolve(port);
    }

    // Sinyal in-process: server.js memanggil ini tepat setelah listen sukses.
    // Tidak bergantung pada HTTP loopback (yang bisa diblokir firewall/AV).
    global.__JEK_ON_SERVER_READY = (port) => ready(port, 'signal');

    try {
      // Load server.js di main process — tidak perlu child process
      // Electron main process adalah Node.js, semua module bisa di-require langsung
      require(SERVER_JS);
      log('[electron] server.js loaded di main process');
    } catch (e) {
      log('[electron] gagal load server.js: ' + (e && e.stack ? e.stack : e));
      reject(e);
      return;
    }

    // Fallback: polling HTTP (jika sinyal di atas tidak terpanggil).
    const start = Date.now();
    const TIMEOUT = 60000;
    const INTERVAL = 300;
    const HOSTS = ['127.0.0.1', 'localhost'];
    // Tambahkan IP LAN — berguna bila loopback diblokir firewall/AV.
    try {
      const ifaces = os.networkInterfaces();
      Object.keys(ifaces).forEach((name) => {
        (ifaces[name] || []).forEach((a) => {
          if (a.family === 'IPv4' && !a.internal && HOSTS.indexOf(a.address) === -1) {
            HOSTS.push(a.address);
          }
        });
      });
    } catch (_) {}

    function probe(port, hostIdx) {
      if (settled) return;
      const host = HOSTS[hostIdx];
      const req = http.get('http://' + host + ':' + port + '/api/info', (res) => {
        res.resume();
        ready(port, 'http ' + host);
      });
      req.setTimeout(2000, () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        if (settled) return;
        if (Date.now() - start > TIMEOUT) {
          reject(new Error(
            'Server tidak merespons setelah ' + (TIMEOUT / 1000) + 's.\n' +
            'Percobaan terakhir: http://' + host + ':' + port + ' → ' + (err && err.code || err && err.message || 'error') + '\n' +
            'Log: ' + (LOG_FILE || '(tidak tersedia)')
          ));
          return;
        }
        setTimeout(() => {
          if (hostIdx + 1 < HOSTS.length) probe(port, hostIdx + 1);
          else if (port < 3010) probe(port + 1, 0);
          else probe(3000, 0);
        }, INTERVAL);
      });
    }

    setTimeout(() => probe(3000, 0), 500);
  });
}

// ── Polling tunnel URL hingga online ─────────────────────────────────────────
function waitForTunnel(port) {
  return new Promise((resolve) => {
    const TUNNEL_TIMEOUT = 60000;
    const TUNNEL_INTERVAL = 1000;
    const start = Date.now();

    function poll() {
      http.get('http://127.0.0.1:' + port + '/api/tunnel/status', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const t = JSON.parse(body);
            if (t.status === 'online' && t.url) {
              console.log('[electron] tunnel online:', t.url);
              resolve(t.url);
              return;
            }
            if (t.status === 'error') {
              console.warn('[electron] tunnel error:', t.error);
              resolve('');
              return;
            }
          } catch (_) {}
          if (Date.now() - start > TUNNEL_TIMEOUT) {
            console.warn('[electron] tunnel timeout — lanjut tanpa tunnel URL');
            resolve('');
            return;
          }
          setTimeout(poll, TUNNEL_INTERVAL);
        });
      }).on('error', () => {
        if (Date.now() - start > TUNNEL_TIMEOUT) {
          resolve('');
          return;
        }
        setTimeout(poll, TUNNEL_INTERVAL);
      });
    }

    poll();
  });
}

// ── Inject tunnel URL ke semua renderer ──────────────────────────────────────
function injectTunnelUrl(url) {
  tunnelUrl = url || '';
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tunnel-url', tunnelUrl);
}

/**
 * Update teks/progress splash. splash memakai DOM biasa (id #status, #pct, #bar),
 * jadi tidak perlu menambah bridge/IPC baru di preload.
 */
function setLoadingStatus(text, pct) {
  lastLoadingStatus = { text: String(text), pct: Number(pct) || 0 };
  if (!loadingPageActive || !loadingReady) return;
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const value = Math.max(4, Math.min(100, Math.round(lastLoadingStatus.pct)));
    const js =
      '(function(){' +
      'var s=document.getElementById("status");if(s)s.textContent=' + JSON.stringify(lastLoadingStatus.text) + ';' +
      'var p=document.getElementById("pct");if(p)p.textContent=' + JSON.stringify(value + '%') + ';' +
      'var b=document.getElementById("bar");if(b)b.style.setProperty("--p",' + JSON.stringify(value + '%') + ');' +
      '})()';
    mainWindow.webContents.executeJavaScript(js).catch(() => {});
  } catch (_) {}
}

// ── Buat window utama ─────────────────────────────────────────────────────────
function createWindow(port) {
  loadingReady = false;
  loadingPageActive = !port; // tanpa port → splash lokal, langsung terlihat
  if (port) serverPort = port;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'JekInteract',
    icon: appIcon(),
    backgroundColor: loadingPageActive ? '#07050f' : '#0f172a',
    show: loadingPageActive, // splash langsung muncul; dashboard menunggu ready-to-show
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  });

  if (port) mainWindow.loadURL('http://127.0.0.1:' + port);
  else mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (tunnelUrl) injectTunnelUrl(tunnelUrl);
  });

  // Fallback: paksa tampil setelah 3 detik jika ready-to-show tidak fire
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.log('[electron] fallback show window');
      mainWindow.show();
    }
  }, 3000);

  mainWindow.webContents.on('did-finish-load', () => {
    log('[electron] window selesai load (did-finish-load)');
    if (loadingPageActive) {
      loadingReady = true;
      setLoadingStatus(lastLoadingStatus.text, lastLoadingStatus.pct);
    }
    if (tunnelUrl) injectTunnelUrl(tunnelUrl);
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('[electron] window GAGAL load: code=' + code + ' desc=' + desc + ' url=' + url);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    // Renderer mati → listener hotkey ikut hilang, jangan biarkan Numpad
    // tetap "ditahan" secara global tanpa ada yang memproses.
    unregisterWinloseHotkeys();
    log('[electron] renderer mati: ' + safeString(details));
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('http://127.0.0.1:' + serverPort) || url.startsWith('http://localhost:' + serverPort)) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    unregisterWinloseHotkeys();
    loadingReady = false;
    loadingPageActive = false;
    mainWindow = null;
  });
}

/** Ganti isi jendela splash yang SUDAH ADA ke dashboard — tanpa bikin window baru. */
function showDashboard(port) {
  serverPort = port;
  if (mainWindow && !mainWindow.isDestroyed()) {
    setLoadingStatus('Membuka dashboard…', 92);
  }
  loadingPageActive = false;
  loadingReady = false;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(port);
    return;
  }
  mainWindow.loadURL('http://127.0.0.1:' + port);
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  if (tunnelUrl) injectTunnelUrl(tunnelUrl);
}

// ── Tray icon ─────────────────────────────────────────────────────────────────
function createTray(port) {
  tray = new Tray(appIcon());
  tray.setToolTip('JekInteract — port ' + port);

  const showWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (serverReady) {
      createWindow(serverPort);
    }
  };

  const menu = Menu.buildFromTemplate([
    {
      label: 'Buka JekInteract',
      click: showWindow
    },
    {
      label: 'Buka di Browser',
      click: () => shell.openExternal('http://localhost:' + port)
    },
    { type: 'separator' },
    {
      label: 'Jalankan sebagai Administrator…',
      click: () => {
        const r = restartAsAdmin();
        if (!r.ok) dialog.showErrorBox('JekInteract', r.error || 'Tidak bisa restart sebagai Administrator.');
      }
    },
    {
      label: 'Pasang ulang driver keyboard…',
      click: () => {
        if (interceptionDriverInstalled()) {
          dialog.showMessageBoxSync({
            type: 'info', title: 'JekInteract',
            message: 'Driver keyboard sudah terpasang.',
            detail: 'Tidak perlu dipasang ulang.'
          });
          return;
        }
        if (relaunchElevatedForSetup()) app.quit();
      }
    },
    { label: 'Keluar (tutup server & helper)', click: shutdownAndQuit }
  ]);

  tray.setContextMenu(menu);
  // Klik kiri pada ikon tray juga membuka window (Windows: single click).
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-tunnel-url', () => tunnelUrl);

// Halaman Win Lose Bar minta hotkey global Numpad + / - didaftarkan/dilepas.
ipcMain.handle('winlose-hotkeys', (e, enabled) => {
  if (!mainWindow || e.sender !== mainWindow.webContents) {
    return { ok: false, enabled: false, error: 'Window dashboard tidak aktif.' };
  }
  return setWinloseHotkeys(!!enabled);
});

// ── Auth Key / lisensi ────────────────────────────────────────────────────────
function isLicenseSender(e) {
  return licenseWindow && !licenseWindow.isDestroyed() && e.sender === licenseWindow.webContents;
}

/** Tampilkan jendela masukin key. Belum valid → server.js TIDAK di-load. */
function showLicenseWindow(status) {
  if (appQuitting) return;
  log('[license] akses ditolak: ' + (status && status.reason) + ' — ' + (status && status.message));
  if (licenseWindow && !licenseWindow.isDestroyed()) {
    licenseWindow.focus();
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
  licenseWindow = new BrowserWindow({
    width: 560,
    height: 650,
    resizable: false,
    maximizable: false,
    title: 'JekInteract — Auth Key',
    icon: appIcon(),
    backgroundColor: '#070b16',
    webPreferences: {
      preload: path.join(__dirname, 'license-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  try { licenseWindow.setMenuBarVisibility(false); } catch (_) {}
  licenseWindow.loadFile(path.join(__dirname, 'license-window.html'));
  licenseWindow.once('ready-to-show', () => {
    if (licenseWindow && !licenseWindow.isDestroyed()) licenseWindow.show();
  });
  // Fallback kalau ready-to-show tidak fire (window manager aneh / Wine).
  setTimeout(() => {
    if (licenseWindow && !licenseWindow.isDestroyed() && !licenseWindow.isVisible()) licenseWindow.show();
  }, 2000);
  licenseWindow.on('closed', () => {
    licenseWindow = null;
    // Ditutup sebelum berhasil aktivasi → matikan aplikasi (jangan jalan diam-diam).
    if (!appStarted) shutdownAndQuit();
  });
}

/** Start server + dashboard + tray. Dipanggil hanya setelah lisensi valid. */
async function startProtectedApp() {
  if (appStarted || appQuitting) return;
  appStarted = true;
  try {
    if (licenseWindow && !licenseWindow.isDestroyed()) licenseWindow.close();

    setLoadingStatus('Menyiapkan dashboard…', 88);
    const port = await startServer();
    showDashboard(port); // pakai ulang jendela splash — jangan bikin window baru
    createTray(port);

    // Tunnel tidak menahan jendela: dashboard sudah tampil.
    log('[electron] menunggu tunnel Cloudflare (background)...');
    waitForTunnel(port).then((url) => {
      if (url) {
        injectTunnelUrl(url);
      } else {
        log('[electron] cloudflared tidak aktif — overlay links pakai localhost');
      }
    });
  } catch (e) {
    log('[electron] gagal start: ' + (e && e.stack ? e.stack : e));
    dialog.showErrorBox('JekInteract - Gagal Start',
      'Server tidak bisa dijalankan:\n\n' + (e && e.message ? e.message : e) + '\n\n' +
      'Log lengkap:\n' + (LOG_FILES.length ? LOG_FILES.join('\n') : '(tidak tersedia)'));
    app.quit();
  }
}

ipcMain.handle('license:get-status', (e) => {
  if (!isLicenseSender(e)) return { ok: false, reason: 'FORBIDDEN', message: 'Akses ditolak.' };
  return license.getStatus();
});

ipcMain.handle('license:submit', async (e, key) => {
  if (!isLicenseSender(e)) return { ok: false, reason: 'FORBIDDEN', message: 'Akses ditolak.' };
  const r = await license.activate(key);
  if (r.ok) {
    log('[license] aktivasi berhasil — melanjutkan startup');
    await startProtectedApp();
  }
  return r;
});

ipcMain.handle('license:retry', async (e) => {
  if (!isLicenseSender(e)) return { ok: false, reason: 'FORBIDDEN', message: 'Akses ditolak.' };
  const s = await license.verify();
  if (s.ok) await startProtectedApp();
  return s;
});

ipcMain.handle('license:quit', (e) => {
  if (isLicenseSender(e)) shutdownAndQuit();
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (licenseWindow && !licenseWindow.isDestroyed()) {
      licenseWindow.focus();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (serverReady) {
      // Window sudah ditutup tapi app masih hidup di tray. Dulu di sini tidak
      // terjadi apa-apa, jadi user yang klik .exe lagi merasa "app tidak mau
      // terbuka" padahal prosesnya masih jalan di background.
      createWindow(serverPort);
    }
  });

  initLog();
  captureConsole();
  license.init(app, log);
  log('[electron] mulai — electron ' + process.versions.electron + ', node ' + process.versions.node +
      ', packaged=' + isPackaged + ', ROOT=' + ROOT);
  log('[electron] env: platform=' + process.platform + ' arch=' + process.arch +
      ' wine=' + (IS_WINE ? 'ya' : 'tidak') +
      ' portableDir=' + (process.env.PORTABLE_EXECUTABLE_DIR || '-'));
  log('[electron] file log: ' + (LOG_FILES.length ? LOG_FILES.join(' | ') : '(tidak ada yang bisa ditulis)'));

  // Jendela (dan tombol taskbar) muncul SEBELUM cek lisensi / start server.
  // Mode install driver tidak butuh jendela — dia langsung restart / minta UAC.
  if (!process.argv.includes(INTERCEPTION_SETUP_ARG)) {
    createWindow();
    log('[electron] jendela loading ditampilkan');
  }

  // Shortcut keluar global — berguna saat window disembunyikan di tray dan
  // pengguna ingin menghapus/mengganti file .exe (file sedang dikunci proses).
  try {
    const ok = globalShortcut.register(QUIT_SHORTCUT, shutdownAndQuit);
    log('[electron] shortcut keluar ' + QUIT_SHORTCUT + ': ' + (ok ? 'aktif' : 'gagal didaftarkan'));
  } catch (e) {
    log('[electron] gagal mendaftarkan shortcut keluar: ' + e.message);
  }

  // Startup normal langsung berjalan tanpa dialog/UAC. Fungsi ini hanya aktif
  // saat instalasi driver diminta manual lewat menu tray.
  try {
    if (await ensureKeyboardDriverSetup()) return;
  } catch (e) {
    log('[setup] gagal menyiapkan driver keyboard: ' + (e && e.stack ? e.stack : e));
    // Setup gagal tidak boleh menghalangi aplikasi berjalan (fallback keystroke lama).
  }

  // ── Gate lisensi: jangan jalankan server sebelum key tervalidasi ──────────
  // Cek lisensi berjalan di belakang splash yang sudah terlihat.
  setLoadingStatus('Memeriksa lisensi…', 28);
  let status;
  try {
    status = await license.verify();
  } catch (e) {
    log('[license] error saat verifikasi: ' + (e && e.stack ? e.stack : e));
    status = {
      ok: false, reason: 'LICENSE_ERROR',
      message: 'Gagal mengecek lisensi: ' + (e && e.message ? e.message : String(e))
    };
  }

  if (appQuitting) return;
  if (status.ok) {
    await startProtectedApp();
  } else {
    showLicenseWindow(status);
  }
});

app.on('window-all-closed', () => {
  // Tutup aplikasi sepenuhnya saat jendela ditutup, supaya tidak ada proses
  // yang tertinggal di background dan user tidak perlu end task manual.
  shutdownAndQuit();
});

app.on('activate', () => {
  if (licenseWindow && !licenseWindow.isDestroyed()) {
    licenseWindow.focus();
  } else if (mainWindow === null && serverReady) {
    createWindow(serverPort);
  }
});

app.on('will-quit', () => {
  // Lepas semua hotkey global agar Numpad kembali normal setelah app keluar.
  try { globalShortcut.unregisterAll(); } catch (_) {}
});

app.on('before-quit', () => {
  appQuitting = true;
  // Server jalan di main process, tapi helper PowerShell/cloudflared adalah
  // child process yang tidak otomatis mati di Windows. Matikan eksplisit supaya
  // file .exe tidak tetap "in use" setelah aplikasi ditutup.
  try { if (typeof global.__JEK_SHUTDOWN === 'function') global.__JEK_SHUTDOWN(); } catch (_) {}
});
