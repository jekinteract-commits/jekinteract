'use strict';

/**
 * Preload script — jembatan antara renderer (web) dan main process Electron.
 * contextIsolation: true → hanya exposeInMainWorld yang bisa diakses dari halaman web.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose flag bahwa app berjalan di dalam Electron
// (bisa dipakai di JS frontend untuk menyembunyikan tip "buka di browser", dll)
contextBridge.exposeInMainWorld('__ELECTRON__', true);

// ── Tunnel URL dari main process ──────────────────────────────────────────────
// Main process mengirim 'tunnel-url' via ipcMain.send setiap kali tunnel online.
// Renderer juga bisa aktif minta via invoke('get-tunnel-url').
contextBridge.exposeInMainWorld('__electronBridge__', {
  /**
   * Daftarkan listener yang dipanggil saat tunnel URL diterima dari main.
   * fn(url: string) dipanggil setiap kali tunnel URL berubah.
   * Mengembalikan fungsi unlisten.
   */
  onTunnelUrl(fn) {
    const handler = (_event, url) => fn(url);
    ipcRenderer.on('tunnel-url', handler);
    return () => ipcRenderer.removeListener('tunnel-url', handler);
  },

  /**
   * Ambil tunnel URL saat ini dari main process (sekali panggil).
   * Berguna saat halaman baru dimuat dan belum sempat menerima event.
   */
  getTunnelUrl() {
    return ipcRenderer.invoke('get-tunnel-url');
  }
});
