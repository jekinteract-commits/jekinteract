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
 *   node tools/license.js gen --days 30 --note "Key Buat Andi"
 *   node tools/license.js info --key JEKK-XXXX-XXXX-XXXX-XXXX
 *   node tools/license.js revoke --key JEKK-XXXX-XXXX-XXXX-XXXX
 *   node tools/license.js unbind --key JEKK-XXXX-XXXX-XXXX-XXXX
 *   node tools/license.js list
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
  node tools/license.js gen    --days 30 [--note "Nama"] [--max 1]
  node tools/license.js info   --key JEKK-XXXX-XXXX-XXXX-XXXX
  node tools/license.js revoke --key JEKK-XXXX-XXXX-XXXX-XXXX
  node tools/license.js unbind --key JEKK-XXXX-XXXX-XXXX-XXXX [--hwid W-XXXX]
  node tools/license.js list

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(LICENSE_URL + pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ ...body, adminToken: ADMIN_TOKEN }),
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

function printKey(data) {
  console.log('\n  KEY BARU:  ' + data.key);
  console.log('  Berlaku : ' + data.days + ' hari, sampai ' + data.expiresAt.slice(0, 10));
  console.log('  Device  : maksimal ' + data.maxDevices + ' PC');
  if (data.note) console.log('  Catatan : ' + data.note);
  console.log('  Kirim key ini ke user. Setelah generate, HP lu boleh mati.\n');
}

(async () => {
  const cmd = (process.argv[2] || '').toLowerCase();
  const o = args();
  if (!cmd || cmd === 'help' || o.help) { usage(); return; }

  if (cmd === 'gen' || cmd === 'generate') {
    const days = o.days ? parseInt(o.days, 10) : 30;
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      throw new Error('--days harus angka 1 sampai 3650');
    }
    const data = await call('/api/admin/generate', {
      days,
      note: typeof o.note === 'string' ? o.note : '',
      maxDevices: o.max ? parseInt(o.max, 10) : 1
    });
    printKey(data);
    return;
  }

  if (cmd === 'info') {
    if (!o.key) throw new Error('--key wajib diisi');
    const d = await call('/api/admin/info', { key: o.key });
    console.log('\nKey         : ' + d.key);
    console.log('Catatan     : ' + (d.note || '-'));
    console.log('Durasi      : ' + d.days + ' hari');
    console.log('Expired     : ' + d.expiresAt.slice(0, 10));
    console.log('Status      : ' + (d.revoked ? 'DICABUT' : 'aktif'));
    console.log('Device      : ' + d.devices.length + '/' + d.maxDevices);
    d.devices.forEach((dev) => console.log('  - ' + dev.hwid + '  (last ' + dev.last_seen + ')'));
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
    console.log('\nKEY                       EXPIRED     STATUS   DEVICE  CATATAN');
    d.keys.forEach((k) => {
      console.log(
        k.key.padEnd(25) +
        String(k.expires_at).slice(0, 10).padEnd(12) +
        (k.revoked ? 'DICABUT ' : 'aktif   ') +
        String(k.max_devices).padEnd(8) +
        (k.note || '-')
      );
    });
    console.log('');
    return;
  }

  usage();
  throw new Error('Perintah tidak dikenal: ' + cmd);
})().catch((e) => {
  console.error('\nGAGAL: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exitCode = 1;
});
