/* Hitung sisa waktu timer dari state server tanpa bergantung pada jam perangkat. */
export const UNIT_MS = { s: 1000, m: 60000, h: 3600000 };

/**
 * Sisa milidetik.
 * Kalau state punya startedAt (epoch ms dari server), pakai Date.now() — akurat di semua
 * client termasuk via Cloudflare tunnel karena tidak bergantung pada kapan state diterima.
 * Fallback ke recvAt (performance.now) untuk backward-compat state lama yang belum punya startedAt.
 */
export function remainingMs(state, recvAt) {
  if (!state) return 0;
  const base = Number(state.remainingMs) || 0;
  if (state.status === 'running') {
    if (state.startedAt) {
      // Pakai jam absolut — sinkron di semua client
      const elapsed = Math.max(0, Date.now() - Number(state.startedAt));
      return Math.max(0, base - elapsed);
    }
    // Fallback: state lama belum punya startedAt
    const elapsed = performance.now() - (recvAt || performance.now());
    return Math.max(0, base - elapsed);
  }
  return base;
}

/** idle | running | paused | finished */
export function timerStatus(state, recvAt) {
  if (!state) return 'idle';
  if (state.status === 'running' && remainingMs(state, recvAt) <= 0) return 'finished';
  return state.status || 'idle';
}

/** Nilai awal timer (ms) dari pengaturan {value, unit}. */
export function defaultMs(cfg) {
  const v = Number(cfg && cfg.value) || 0;
  return Math.max(1000, Math.round(v * (UNIT_MS[cfg && cfg.unit] || 1000)));
}
