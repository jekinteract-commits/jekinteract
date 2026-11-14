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

const { app, BrowserWindow, shell, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

// Winlator: pakai OpenGL (gladio) yang sudah ada, jangan override dengan swiftshader
// Vulkan (vortex) + OpenGL (gladio) tersedia — biarkan Chromium pakai GPU langsung
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('use-gl', 'desktop');
app.commandLine.appendSwitch('use-angle', 'gl');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');

// ── Logging ke file ───────────────────────────────────────────────────────────
// Di .exe Windows tidak ada console, jadi semua log ditulis ke file agar bisa
// diperiksa saat troubleshooting.
let LOG_FILE = '';
function initLog() {
  const candidates = [];
  try { candidates.push(path.join(app.getPath('userData'), 'jekinteract.log')); } catch (_) {}
  try { candidates.push(path.join(os.tmpdir(), 'jekinteract.log')); } catch (_) {}
  for (const f of candidates) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '=== JekInteract ' + new Date().toISOString() + ' ===\n');
      LOG_FILE = f;
      break;
    } catch (_) {}
  }
}
function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  try { if (process.stdout) process.stdout.write(line + '\n'); } catch (_) {}
}
// Tangkap console.log/warn/error dari server.js ke file log juga.
function captureConsole() {
  ['log', 'info', 'warn', 'error'].forEach((m) => {
    const orig = console[m] ? console[m].bind(console) : () => {};
    console[m] = (...args) => {
      try { orig(...args); } catch (_) {}
      try {
        if (LOG_FILE) {
          const text = args.map((a) => (typeof a === 'string' ? a : safeString(a))).join(' ');
          fs.appendFileSync(LOG_FILE, text + '\n');
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

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let serverPort = 3000;
let serverReady = false;
let tunnelUrl = '';

// ── Jalankan server langsung di main process ──────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    // Set env sebelum require server.js
    process.env.ELECTRON = '1';

    // Selalu bind ke semua interface. Jangan warisi env HOST yang aneh dari
    // sistem (bisa bikin server bind ke alamat yang tak terjangkau / gagal).
    if (process.env.HOST && process.env.HOST !== '0.0.0.0') {
      log('[electron] mengabaikan env HOST=' + process.env.HOST + ' (dipaksa 0.0.0.0)');
    }
    process.env.HOST = '0.0.0.0';

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

// ── Buat window utama ─────────────────────────────────────────────────────────
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'JekInteract',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  });

  mainWindow.loadURL('http://127.0.0.1:' + port);

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
    if (tunnelUrl) injectTunnelUrl(tunnelUrl);
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('[electron] window GAGAL load: code=' + code + ' desc=' + desc + ' url=' + url);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('[electron] renderer mati: ' + safeString(details));
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('http://127.0.0.1:' + port) || url.startsWith('http://localhost:' + port)) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Tray icon ─────────────────────────────────────────────────────────────────
function createTray(port) {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('JekInteract — port ' + port);

  const menu = Menu.buildFromTemplate([
    {
      label: 'Buka JekInteract',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow(port);
        }
      }
    },
    {
      label: 'Buka di Browser',
      click: () => shell.openExternal('http://localhost:' + port)
    },
    { type: 'separator' },
    { label: 'Keluar', click: () => app.quit() }
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-tunnel-url', () => tunnelUrl);

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  initLog();
  captureConsole();
  log('[electron] mulai — electron ' + process.versions.electron + ', node ' + process.versions.node +
      ', packaged=' + isPackaged + ', ROOT=' + ROOT);

  try {
    const port = await startServer();

    createWindow(port);
    createTray(port);

    log('[electron] menunggu tunnel Cloudflare...');
    const url = await waitForTunnel(port);
    if (url) {
      injectTunnelUrl(url);
    } else {
      log('[electron] cloudflared tidak aktif — overlay links pakai localhost');
    }
  } catch (e) {
    log('[electron] gagal start: ' + (e && e.stack ? e.stack : e));
    const { dialog } = require('electron');
    dialog.showErrorBox('JekInteract - Gagal Start',
      'Server tidak bisa dijalankan:\n\n' + (e && e.message ? e.message : e) + '\n\n' +
      'Log lengkap: ' + (LOG_FILE || '(tidak tersedia)'));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Tetap jalan di tray
});

app.on('activate', () => {
  if (mainWindow === null && serverReady) {
    createWindow(serverPort);
  }
});

app.on('before-quit', () => {
  // Server jalan di main process — otomatis mati saat app quit
});
