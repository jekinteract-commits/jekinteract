'use strict';

/**
 * JekInteract License Server — Cloudflare Worker + D1
 *
 * Endpoint publik (dipanggil .exe):
 *   POST /api/license/activate   { key, hwid, appVersion?, platform? }
 *   POST /api/license/check      { key, hwid, ... } (sama, untuk cek rutin)
 *   GET  /api/health
 *
 * Endpoint admin (hanya dipanggil dari Termux owner, pakai ADMIN_TOKEN):
 *   POST /api/admin/generate     { adminToken, days, note?, maxDevices? }
 *   POST /api/admin/revoke       { adminToken, key }
 *   POST /api/admin/unbind       { adminToken, key, hwid? }
 *   POST /api/admin/info         { adminToken, key }
 *   GET  /api/admin/list         { adminToken }  -> lewat query ?adminToken=
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa I,O,0,1
const DAY_MS = 24 * 60 * 60 * 1000;

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
  });
}

function fail(code, message, status = 400, extra = {}) {
  return respond({ ok: false, code, message, serverTime: new Date().toISOString(), ...extra }, status);
}

function ok(data = {}, status = 200) {
  return respond({ ok: true, serverTime: new Date().toISOString(), ...data }, status);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeKey(value) {
  return String(value || '').replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
}

function prettyKey(raw) {
  const s = normalizeKey(raw);
  return 'JEKK-' + s.replace(/^JEKK/, '').match(/.{1,4}/g).join('-');
}

function randomKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return 'JEKK-' + (s.match(/.{1,4}/g) || []).join('-');
}

function isAdmin(request, env, body) {
  const token = env.ADMIN_TOKEN || '';
  const supplied = body && body.adminToken
    ? body.adminToken
    : new URL(request.url).searchParams.get('adminToken') || '';
  return !!token && safeEqual(token, String(supplied));
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function handleActivate(request, env, body) {
  const key = normalizeKey(body.key);
  const hwid = String(body.hwid || '').trim().toUpperCase();
  if (!key || key.length < 8) return fail('INVALID_KEY', 'Format key tidak valid.');
  if (!hwid || hwid.length < 8) return fail('INVALID_DEVICE', 'Device ID tidak valid.');

  const row = await env.DB.prepare('SELECT * FROM keys WHERE key = ?').bind(key).first();
  if (!row) return fail('INVALID_KEY', 'Key tidak dikenal. Cek lagi kode yang kamu masukkan.', 403);
  if (row.revoked) return fail('REVOKED', 'Key ini sudah dicabut oleh owner. Masukin key baru.', 403);
  if (Date.parse(row.expires_at) <= Date.now()) {
    return fail('EXPIRED', 'Masa aktif key sudah habis. Masukin key baru.', 403, { expiresAt: row.expires_at });
  }

  const existing = await env.DB.prepare('SELECT * FROM devices WHERE key = ? AND hwid = ?')
    .bind(key, hwid).first();
  const now = new Date().toISOString();

  if (existing) {
    await env.DB.prepare('UPDATE devices SET last_seen = ? WHERE key = ? AND hwid = ?')
      .bind(now, key, hwid).run();
  } else {
    const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE key = ?').bind(key).first();
    if ((used?.n || 0) >= row.max_devices) {
      return fail('DEVICE_LIMIT',
        'Key ini sudah terikat di ' + row.max_devices + ' perangkat. Hubungi owner untuk reset perangkat.',
        403, { maxDevices: row.max_devices });
    }
    await env.DB.prepare('INSERT INTO devices (key, hwid, first_seen, last_seen) VALUES (?, ?, ?, ?)')
      .bind(key, hwid, now, now).run();
  }

  return ok({
    key: prettyKey(key),
    expiresAt: row.expires_at,
    activatedAt: existing ? existing.first_seen : now,
    lastSeen: now,
    graceDays: 7,
    maxDevices: row.max_devices,
    note: row.note || ''
  });
}

async function handleAdmin(request, env, pathname, body) {
  if (!isAdmin(request, env, body)) return fail('UNAUTHORIZED', 'Admin token salah.', 401);

  if (pathname === '/api/admin/generate' && request.method === 'POST') {
    const days = clampInt(body.days, 1, 3650, 30);
    const maxDevices = clampInt(body.maxDevices, 1, 10, 1);
    const note = String(body.note || '').trim().slice(0, 120);
    const displayKey = randomKey();
    const key = normalizeKey(displayKey); // disimpan tanpa dash supaya lookup konsisten
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + days * DAY_MS).toISOString();

    await env.DB.prepare(
      'INSERT INTO keys (key, note, days, max_devices, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(key, note, days, maxDevices, createdAt, expiresAt).run();

    return ok({ key: displayKey, days, maxDevices, note, createdAt, expiresAt }, 201);
  }

  if (pathname === '/api/admin/revoke' && request.method === 'POST') {
    const key = normalizeKey(body.key);
    if (!key) return fail('INVALID_KEY', 'Key wajib diisi.');
    const result = await env.DB.prepare('UPDATE keys SET revoked = 1, revoked_at = ? WHERE key = ?')
      .bind(new Date().toISOString(), key).run();
    if (!result.meta || !result.meta.changes) return fail('NOT_FOUND', 'Key tidak ditemukan.', 404);
    return ok({ key: prettyKey(key), revoked: true });
  }

  if (pathname === '/api/admin/unbind' && request.method === 'POST') {
    const key = normalizeKey(body.key);
    const hwid = body.hwid ? String(body.hwid).trim().toUpperCase() : '';
    if (!key) return fail('INVALID_KEY', 'Key wajib diisi.');
    const sql = hwid
      ? 'DELETE FROM devices WHERE key = ? AND hwid = ?'
      : 'DELETE FROM devices WHERE key = ?';
    const stmt = hwid ? env.DB.prepare(sql).bind(key, hwid) : env.DB.prepare(sql).bind(key);
    const result = await stmt.run();
    return ok({ key: prettyKey(key), hwid: hwid || '(semua)', removed: (result.meta && result.meta.changes) || 0 });
  }

  if (pathname === '/api/admin/info' && request.method === 'POST') {
    const key = normalizeKey(body.key);
    const row = await env.DB.prepare('SELECT * FROM keys WHERE key = ?').bind(key).first();
    if (!row) return fail('NOT_FOUND', 'Key tidak ditemukan.', 404);
    const devices = await env.DB.prepare('SELECT hwid, first_seen, last_seen FROM devices WHERE key = ?')
      .bind(key).all();
    return ok({
      key: prettyKey(row.key),
      note: row.note,
      days: row.days,
      maxDevices: row.max_devices,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revoked: !!row.revoked,
      revokedAt: row.revoked_at,
      devices: devices.results || []
    });
  }

  if (pathname === '/api/admin/list' && request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT key, note, days, max_devices, created_at, expires_at, revoked FROM keys ORDER BY created_at DESC LIMIT 200'
    ).all();
    return ok({ keys: rows.results || [] });
  }

  return fail('NOT_FOUND', 'Endpoint tidak ditemukan.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (pathname === '/api/health' && request.method === 'GET') {
        return ok({ service: 'jek-license', version: 1 });
      }

      if (request.method !== 'POST') return fail('NOT_FOUND', 'Endpoint tidak ditemukan.', 404);

      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        return fail('BAD_JSON', 'Body harus JSON.');
      }

      if (pathname === '/api/license/activate' || pathname === '/api/license/check') {
        return await handleActivate(request, env, body);
      }

      if (pathname.startsWith('/api/admin/')) {
        return await handleAdmin(request, env, pathname, body);
      }

      return fail('NOT_FOUND', 'Endpoint tidak ditemukan.', 404);
    } catch (e) {
      return fail('SERVER_ERROR', 'Gagal memproses: ' + (e && e.message ? e.message : String(e)), 500);
    }
  }
};
