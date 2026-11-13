'use strict';

/**
 * Preload script — jembatan antara renderer (web) dan main process Electron.
 * contextIsolation: true → hanya exposeInMainWorld yang bisa diakses dari halaman web.
 *
 * Saat ini tidak ada fungsi khusus yang perlu di-expose karena server berjalan
 * sebagai HTTP lokal dan semua komunikasi sudah via fetch/WebSocket biasa.
 * File ini tetap diperlukan agar webPreferences.preload valid.
 */

const { contextBridge } = require('electron');

// Expose flag bahwa app berjalan di dalam Electron
// (bisa dipakai di JS frontend untuk menyembunyikan tip "buka di browser", dll)
contextBridge.exposeInMainWorld('__ELECTRON__', true);
