'use strict';

/**
 * JekInteract License CLI — dijalankan OWNER dari Termux.
 * File ini TIDAK ikut ke dalam .exe (tidak ada di daftar `build.files`).
 *
 * Siapkan dulu tools/.env (copy dari tools/.env.example):
 *   LICENSE_URL=https://jek-license.<subdomain>.workers.dev
 *   ADMIN_TOKEN=rahasia-panjang-dari-secret
 *
 * Contoh:
 *   node tools/license.js gen --days 30 --username "nobita_1940"
 *   node tools/license.js info --key JEKK-XXXX-XXXX-XXXX-XXXX
 *   node tools/license.js revoke --key JEKK-XXXX-XXXX-XXXX-XXXX
 *   node tools/license.js unbind --key JEKK-XXXX-XXXX-XXXX-XXXX
 *   node tools/license.js list              # 200 key terakhir + waktu generate/expired
 *
 * Catatan: --note masih diterima sebagai alias lama dari --username.
 */

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnv();

const LICENSE_URL = (process.env.LICENSE_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function usage() {
  console.log(`JekInteract License CLI

Usage:
  node tools/license.js gen    --days 30 [--username "nobita_1940"] [--max 1]
  node tools/license.js info   --key JEKK-XXXX-XXXX-XXXX-XXXX
  node tools/license.js revoke --key JEKK-XXXX-XXXX-XXXX-XXXX
  node tools/license.js unbind --key JEKK-XXXX-XXXX-XXXX-XXXX [--hwid W-XXXX]
  node tools/license.js list

  --note "..."  alias lama untuk --username (tetap didukung)

Config: tools/.env (LICENSE_URL, ADMIN_TOKEN)
`);
}

function args() {
  const out = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--help') { out.help = true; continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}

async function call(pathname, body = {}, method = 'POST') {
  if (!LICENSE_URL) throw new Error('LICENSE_URL belum diisi. Copy tools/.env.example -> tools/.env');
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN belum diisi di tools/.env');

  // Endpoint GET (list) baca token dari query string, bukan dari body.
  const isGet = method === 'GET';
  const url = isGet
    ? LICENSE_URL + pathname + (pathname.includes('?') ? '&' : '?') +
      'adminToken=' + encodeURIComponent(ADMIN_TOKEN)
    : LICENSE_URL + pathname;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method,
      headers: isGet ? {} : { 'Content-Type': 'application/json' },
      body: isGet ? undefined : JSON.stringify({ ...body, adminToken: ADMIN_TOKEN }),
      signal: controller.signal
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    if (!res.ok || data.ok === false) {
      throw new Error(data.message || data.code || ('HTTP ' + res.status + ': ' + text.slice(0, 200)));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Server menyimpan key tanpa dash; rapikan jadi JEKK-XXXX-XXXX-XXXX-XXXX di CLI.
function prettyKey(value) {
  const s = String(value || '').replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
  const body = s.replace(/^JEKK/, '');
  return body ? 'JEKK-' + (body.match(/.{1,4}/g) || []).join('-') : s;
}

// Tampilkan waktu dalam timezone lokal Termux: YYYY-MM-DD HH:mm
function fmtTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function printKey(data) {
  console.log('\n  KEY BARU:  ' + data.key);
  console.log('  Berlaku            : ' + data.days + ' hari, sampai ' + fmtTime(data.expiresAt));
  console.log('  Device             : maksimal ' + data.maxDevices + ' PC');
  if (data.note) console.log('  Username Tiktok    : ' + data.note);
  console.log('  Kirim key ini ke user. Setelah generate, HP lu boleh mati.\n');
}

(async () => {
  const cmd = (process.argv[2] || '').toLowerCase();
  const o = args();
  if (!cmd || cmd === 'help' || cmd.startsWith('-') || o.help) { usage(); return; }

  if (cmd === 'gen' || cmd === 'generate') {
    const days = o.days ? parseInt(o.days, 10) : 30;
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      throw new Error('--days harus angka 1 sampai 3650');
    }
    // --username dipakai bareng --note sebagai alias backward-compatible.
    const username = typeof o.username === 'string'
      ? o.username
      : (typeof o.note === 'string' ? o.note : '');
    const data = await call('/api/admin/generate', {
      days,
      note: username,
      maxDevices: o.max ? parseInt(o.max, 10) : 1
    });
    printKey(data);
    return;
  }

  if (cmd === 'info') {
    if (!o.key) throw new Error('--key wajib diisi');
    const d = await call('/api/admin/info', { key: o.key });
    console.log('\nKey                : ' + d.key);
    console.log('Username Tiktok    : ' + (d.note || '-'));
    console.log('Dibuat             : ' + fmtTime(d.createdAt));
    console.log('Durasi             : ' + d.days + ' hari');
    console.log('Expired            : ' + fmtTime(d.expiresAt));
    console.log('Status             : ' + (d.revoked ? 'DICABUT' : 'aktif'));
    console.log('Device             : ' + d.devices.length + '/' + d.maxDevices);
    d.devices.forEach((dev) => console.log('  - ' + dev.hwid + '  (last ' + fmtTime(dev.last_seen) + ')'));
    console.log('');
    return;
  }

  if (cmd === 'revoke') {
    if (!o.key) throw new Error('--key wajib diisi');
    const d = await call('/api/admin/revoke', { key: o.key });
    console.log('Key ' + d.key + ' sudah DICABUT. User akan diminta key baru.\n');
    return;
  }

  if (cmd === 'unbind') {
    if (!o.key) throw new Error('--key wajib diisi');
    const d = await call('/api/admin/unbind', { key: o.key, hwid: o.hwid || '' });
    console.log('Device ' + d.hwid + ' dari key ' + d.key + ' sudah dihapus (' + d.removed + ' baris).\n');
    return;
  }

  if (cmd === 'list') {
    const d = await call('/api/admin/list', {}, 'GET');
    if (!d.keys.length) { console.log('Belum ada key.\n'); return; }
    console.log('\nKEY                       DIBUAT           EXPIRED          STATUS   DEVICE  USERNAME TIKTOK');
    d.keys.forEach((k) => {
      console.log(
        prettyKey(k.key).padEnd(25) +
        fmtTime(k.created_at).padEnd(17) +
        fmtTime(k.expires_at).padEnd(17) +
        (k.revoked ? 'DICABUT ' : 'aktif   ') +
        String(k.max_devices).padEnd(8) +
        (k.note || '-')
      );
    });
    console.log('\nTotal: ' + d.keys.length + ' key (maksimal 200 terakhir dari server).\n');
    return;
  }

  usage();
  throw new Error('Perintah tidak dikenal: ' + cmd);
})().catch((e) => {
  console.error('\nGAGAL: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exitCode = 1;
});
