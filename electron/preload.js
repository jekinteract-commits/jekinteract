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
  },

  /**
   * Update teks/progress halaman loading saat aplikasi masih menyiapkan diri.
   * fn({ text: string, pct: number }) → dipanggil tiap kali status berubah.
   */
  onLoadingStatus(fn) {
    const handler = (_event, status) => fn(status);
    ipcRenderer.on('loading-status', handler);
    return () => ipcRenderer.removeListener('loading-status', handler);
  },

  /**
   * Aktifkan/nonaktifkan hotkey global Numpad Add/Subtract (Win/Lose).
   * Hotkey global tetap diterima walau window JekInteract tidak fokus.
   * Mengembalikan Promise<{ ok, enabled, error? }>.
   */
  setWinloseHotkeys(enabled) {
    return ipcRenderer.invoke('winlose-hotkeys', !!enabled);
  },

  /**
   * Listener saat hotkey global Win/Lose ditekan.
   * fn(key: 'win' | 'lose'). Mengembalikan fungsi unlisten.
   */
  onWinloseHotkey(fn) {
    const handler = (_event, key) => fn(key);
    ipcRenderer.on('winlose-hotkey', handler);
    return () => ipcRenderer.removeListener('winlose-hotkey', handler);
  }
});
