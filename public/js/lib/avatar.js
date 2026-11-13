/* Avatar sementara: lingkaran gradien + inisial (foto TikTok asli menyusul saat integrasi). */
export function hash(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const cache = new Map();

export function avatarURL(name) {
  if (cache.has(name)) return cache.get(name);
  const h = hash(name);
  const a = h % 360;
  const b = (a + 50 + ((h >> 8) % 70)) % 360;
  const ch = (String(name).replace(/[^a-z0-9]/gi, '')[0] || '?').toUpperCase();
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="hsl(' + a + ',85%,58%)"/>' +
    '<stop offset="1" stop-color="hsl(' + b + ',85%,40%)"/></linearGradient></defs>' +
    '<rect width="64" height="64" fill="url(#g)"/>' +
    '<text x="32" y="43" text-anchor="middle" font-family="Orbitron,Arial,sans-serif" font-weight="800" font-size="30" fill="#fff" fill-opacity=".94">' + ch + '</text></svg>';
  const url = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  cache.set(name, url);
  return url;
}

export function avatar(name, size = 40, cls = '') {
  return '<img class="av ' + cls + '" src="' + avatarURL(name) + '" width="' + size + '" height="' + size + '" alt="" draggable="false">';
}
