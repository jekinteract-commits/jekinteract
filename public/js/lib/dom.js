/* Helper DOM kecil — tanpa framework. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape teks agar aman disisipkan ke innerHTML. */
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Delegasi event. Mengembalikan fungsi untuk melepas listener. */
export function on(root, type, selector, fn, opts) {
  const handler = (e) => {
    const t = e.target && e.target.closest ? e.target.closest(selector) : null;
    if (t && root.contains(t)) fn(e, t);
  };
  root.addEventListener(type, handler, opts);
  return () => root.removeEventListener(type, handler, opts);
}

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9);
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clone = (o) => JSON.parse(JSON.stringify(o));

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Gabungkan beberapa fungsi pembersih menjadi satu. */
export function disposer() {
  const fns = [];
  const d = (fn) => {
    if (typeof fn === 'function') fns.push(fn);
    return fn;
  };
  d.run = () => {
    while (fns.length) {
      try {
        fns.pop()();
      } catch (e) {
        console.error(e);
      }
    }
  };
  return d;
}
