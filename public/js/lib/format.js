/* Format angka, tanggal, dan durasi (Indonesia). */
const NF = new Intl.NumberFormat('id-ID');

export const fmt = (n) => NF.format(Math.round(Number(n) || 0));

/** 12.345 -> "12,3 rb" ; 1.234.567 -> "1,2 jt" ; angka kecil tetap utuh. */
export function compact(n) {
  n = Math.round(Number(n) || 0);
  const trim = (v) => v.toFixed(1).replace('.', ',').replace(/,0$/, '');
  if (n >= 1e9) return trim(n / 1e9) + ' M';
  if (n >= 1e6) return trim(n / 1e6) + ' jt';
  if (n >= 1e4) return trim(n / 1e3) + ' rb';
  return fmt(n);
}

export const pad2 = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');

export const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export const DAYS_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const isoDate = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

/** "2026-11-07" -> Date lokal (00:00). Mengembalikan null jika tidak valid. */
export function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const fmtDateShort = (d) => d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()];
export const fmtDateLong = (d) => d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();

/** 135 menit -> "2 j 15 m" */
export function fmtMinutes(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return m + ' m';
  return h + ' j' + (m ? ' ' + m + ' m' : '');
}

/** milidetik -> "HH:MM:SS" */
export function fmtHMS(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
}

/** detik -> "m:ss" */
export function fmtMMSS(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + pad2(sec % 60);
}

/** Terima "0,05" maupun "0.05". Mengembalikan NaN jika bukan angka. */
export function parseDecimal(v) {
  const s = String(v == null ? '' : v).trim().replace(',', '.');
  if (s === '' || s === '-' || s === '+') return NaN;
  return /^[-+]?\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
}
