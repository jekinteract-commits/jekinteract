/**
 * gifts.js — data gift TikTok.
 * Fetch dari /api/gifts (proxy streamtoearn.io/gifts?region=ID).
 * Fallback otomatis ke GIFTS demo jika jaringan tidak tersedia.
 */
import { GIFTS as GIFTS_DEMO } from './demo.js';

let _cache = null;    // { ts, list }
const TTL = 3600000;  // 1 jam — sinkron dengan cache server

/**
 * Kembalikan array gift: [{ name, coins, image|null, emoji? }]
 * Selalu resolve (tidak pernah reject) — saat gagal pakai demo.
 */
export async function loadGifts() {
  const now = Date.now();
  if (_cache && now - _cache.ts < TTL) return _cache.list;

  try {
    const r = await fetch('/api/gifts');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const body = await r.json();
    if (!body.ok || !Array.isArray(body.gifts) || !body.gifts.length) throw new Error('data kosong');
    const list = body.gifts;
    _cache = { ts: now, list };
    return list;
  } catch (_) {
    // Fallback ke data demo — tetap gunakan field yang sama
    return GIFTS_DEMO;
  }
}

/** Invalidasi cache supaya fetch berikutnya akan menarik data baru. */
export function invalidateGifts() {
  _cache = null;
}

/**
 * Render satu kartu gift sebagai string HTML.
 * Mendukung field `image` (URL) dari data live maupun `emoji` dari data demo.
 */
export function giftCardHTML(g, _selectedName, escFn, iconFn, fmtFn) {
  const media = g.image
    ? '<img class="gift-img" src="' + escFn(g.image) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
    : '<span class="gift-e" aria-hidden="true">' + (g.emoji || '🎁') + '</span>';
  return (
    '<div class="gift">' +
    media +
    '<b>' + escFn(g.name) + '</b>' +
    '<span class="gift-c">' + iconFn('coin') + fmtFn(g.coins) + '</span>' +
    '</div>'
  );
}

export function giftPickerHTML(g, selectedName, escFn, iconFn, fmtFn) {
  const isSelected = g.name === selectedName;
  const media = g.image
    ? '<img class="gift-img" src="' + escFn(g.image) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
    : '<span class="gift-e" aria-hidden="true">' + (g.emoji || '🎁') + '</span>';
  return (
    '<button type="button" class="gp-i' + (isSelected ? ' on' : '') + '" data-gift="' + escFn(g.name) + '">' +
    media + '<b>' + escFn(g.name) + '</b>' +
    '<span class="gift-c">' + iconFn('coin') + fmtFn(g.coins) + '</span>' +
    '</button>'
  );
}
