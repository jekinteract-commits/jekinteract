'use strict';

/**
 * JekInteract — Electron main process
 *
 * Alur:
 *  1. Jalankan server.js sebagai child process (Node.js fork)
 *  2. Tunggu server siap (cek HTTP /api/info)
 *  3. Buka BrowserWindow yang load http://localhost:<port>
 *  4. Saat window ditutup → matikan server child process
 */

const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

// ── Path root proyek ──────────────────────────────────────────────────────────
// Saat dev  : __dirname = electron/
// Saat .exe : file dikemas, resources ada di process.resourcesPath
const isPackaged = app.isPackaged;
const ROOT = isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_JS = path.join(ROOT, 'server.js');

// ── State ─────────────────────────────────────────────────────────────────────
let serverProcess = null;
let mainWindow = null;
let tray = null;
let serverPort = 3000;
let serverReady = false;

// ── Jalankan server Node.js ───────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = fork(SERVER_JS, [], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { ELECTRON: '1' }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });

    // Forward log server ke console Electron (terlihat di DevTools)
    serverProcess.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
    serverProcess.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

    serverProcess.on('exit', (code) => {
      console.log('[electron] server berhenti, code=' + code);
      serverProcess = null;
      // Jika window masih terbuka dan server mati tak terduga → reload
      if (mainWindow && !mainWindow.isDestroyed() && serverReady) {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadFile(path.join(__dirname, 'error.html'));
          }
        }, 500);
      }
    });

    serverProcess.on('error', (e) => {
      console.error('[electron] gagal fork server:', e.message);
      reject(e);
    });

    // Polling sampai server siap menjawab HTTP
    const start = Date.now();
    const TIMEOUT = 30000;
    const INTERVAL = 300;

    function tryPort(port) {
      http.get('http://127.0.0.1:' + port + '/api/info', (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const info = JSON.parse(body);
            serverPort = info.port || port;
          } catch (_) {
            serverPort = port;
          }
          serverReady = true;
          resolve(serverPort);
        });
      }).on('error', () => {
        if (Date.now() - start > TIMEOUT) {
          reject(new Error('Server tidak merespons setelah ' + (TIMEOUT / 1000) + 's'));
          return;
        }
        // Coba port berikutnya (server otomatis naik port jika 3000 pakai)
        setTimeout(() => {
          // Coba port 3000-3010
          if (port < 3010) tryPort(port + 1);
          else tryPort(3000); // Balik ke 3000 dan tunggu lagi
        }, INTERVAL);
      });
    }

    // Beri waktu server untuk start sebelum polling
    setTimeout(() => tryPort(3000), 500);
  });
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
    show: false, // tampil setelah konten siap
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Izinkan autoplay audio (tidak ada gesture-requirement di Electron)
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  // Load dashboard
  mainWindow.loadURL('http://127.0.0.1:' + port);

  // Tampilkan window setelah selesai load (hindari flash putih)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Link eksternal buka di browser sistem, bukan di window Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    // Biarkan navigasi ke localhost server
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
    {
      label: 'Keluar',
      click: () => app.quit()
    }
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Single instance — jika sudah ada yang jalan, fokus ke window yang ada
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

  try {
    console.log('[electron] menjalankan server...');
    const port = await startServer();
    console.log('[electron] server siap di port', port);
    createWindow(port);
    createTray(port);
  } catch (e) {
    console.error('[electron] gagal start server:', e.message);
    // Tampilkan dialog error
    const { dialog } = require('electron');
    dialog.showErrorBox('JekInteract - Gagal Start', 
      'Server tidak bisa dijalankan:\n\n' + e.message + '\n\nPastikan port 3000 tidak dipakai aplikasi lain.');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Di Windows/Linux: tetap jalan di tray saat semua window ditutup
  // (tidak quit, hanya hide)
});

app.on('activate', () => {
  // macOS: buka kembali window jika dock icon diklik
  if (mainWindow === null && serverReady) {
    createWindow(serverPort);
  }
});

app.on('before-quit', () => {
  // Matikan server child process dengan bersih
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});
