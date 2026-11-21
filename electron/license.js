'use strict';

/**
 * JekInteract — License client (main process)
 *
 * - Cek lisensi ke Cloudflare Worker saat aplikasi dibuka.
 * - Simpan hasilnya di folder data yang sama dengan state.json (license.json).
 * - Kalau server nggak bisa dihubungi, kasih grace period N hari.
 * - Device ID (HWID) di-hash, di-cache di license.json supaya stabil.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let APP = null;
let LOG = () => {};
let cachedHwid = '';
let lastStatus = { ok: false, reason: 'NOT_CHECKED', message: 'Belum dicek.' };

function init(electronApp, logFn) {
  APP = electronApp || null;
  if (typeof logFn === 'function') LOG = logFn;
}

function config() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'license-config.json'), 'utf8')) || {};
  } catch (_) {}
  const url = String(process.env.JEK_LICENSE_URL || cfg.licenseUrl || '').replace(/\/+$/, '');
  return {
    url,
    graceDays: Number.isFinite(cfg.graceDays) ? cfg.graceDays : 7,
    requireLicense: cfg.requireLicense === true
  };
}

function dataDir() {
  const candidates = [];
  if (process.env.JEK_DATA_DIR) candidates.push(process.env.JEK_DATA_DIR);
  try {
    if (APP && APP.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
      candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'));
    }
  } catch (_) {}
  try { if (APP) candidates.push(path.join(APP.getPath('userData'), 'data')); } catch (_) {}
  candidates.push(path.join(os.tmpdir(), 'jekinteract-data'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.license-probe');
      fs.writeFileSync(probe, '1');
      fs.unlinkSync(probe);
      return dir;
    } catch (_) {}
  }
  return candidates[candidates.length - 1];
}

function licensePath() {
  return path.join(dataDir(), 'license.json');
}

function readLicense() {
  try {
    const raw = fs.readFileSync(licensePath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

function writeLicense(data) {
  const target = licensePath();
  const tmp = target + '.tmp';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  } catch (e) {
    LOG('[license] gagal simpan license.json: ' + (e && e.message ? e.message : e));
  }
}

function sha(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function detectDeviceId() {
  if (process.platform === 'win32') {
    const ps = [
      '$v = (Get-CimInstance Win32_ComputerSystemProduct -ErrorAction SilentlyContinue).UUID',
      'if (-not $v) { $v = (Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue).SerialNumber }',
      'if (-not $v) { $v = (Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue | Select-Object -First 1).SerialNumber }',
      'if (-not $v) { $v = $env:COMPUTERNAME + "|" + $env:USERNAME }',
      'Write-Output $v'
    ].join('; ');
    try {
      const raw = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (raw && raw.length >= 4) {
        return 'W-' + sha(raw.replace(/\s+/g, '')).slice(0, 32).toUpperCase();
      }
    } catch (e) {
      LOG('[license] gagal baca HWID via WMI: ' + (e && e.message ? e.message : e));
    }
  }

  let mac = '';
  try {
    const nets = os.networkInterfaces() || {};
    for (const name of Object.keys(nets)) {
      const found = (nets[name] || []).find((a) => a.mac && a.mac !== '00:00:00:00:00:00');
      if (found) { mac = found.mac; break; }
    }
  } catch (_) {}
  let user = '';
  try { user = (os.userInfo() || {}).username || ''; } catch (_) {}
  return 'D-' + sha([os.platform(), os.arch(), os.hostname(), user, mac].join('|')).slice(0, 32).toUpperCase();
}

function getHwid(local) {
  if (local && local.hwid) return local.hwid;
  if (!cachedHwid) cachedHwid = detectDeviceId();
  return cachedHwid;
}

function normalizeKey(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}

function postJson(url, body, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
      .then((res) => res.text().then((text) => {
        let data;
        try { data = JSON.parse(text); } catch (_) { data = null; }
        if (!data) throw new Error('Respons server bukan JSON: ' + text.slice(0, 120));
        resolve({ status: res.status, data });
      }))
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

const HARD_CODES = ['INVALID_KEY', 'INVALID_DEVICE', 'REVOKED', 'EXPIRED', 'DEVICE_LIMIT', 'UNAUTHORIZED'];
const DAY_MS = 24 * 60 * 60 * 1000;

function result(ok, reason, message, extra = {}) {
  lastStatus = { ok, reason, message, ...extra };
  return lastStatus;
}

function setFromServer(data, local) {
  const saved = {
    key: data.key || (local && local.key) || '',
    hwid: (local && local.hwid) || getHwid(local),
    activatedAt: data.activatedAt || (local && local.activatedAt) || new Date().toISOString(),
    expiresAt: data.expiresAt,
    lastVerifiedAt: data.serverTime || new Date().toISOString(),
    lastVerifiedLocalAt: Date.now(),
    graceDays: data.graceDays || 7,
    status: 'active',
    server: data
  };
  writeLicense(saved);
  return saved;
}

async function verify() {
  const cfg = config();

  // Mode pengembangan: belum deploy Worker → aplikasi jalan seperti biasa.
  if (!cfg.requireLicense || !cfg.url) {
    LOG('[license] requireLicense=false / URL kosong → cek lisensi dilewati (mode development).');
    return result(true, 'DISABLED', 'Cek lisensi belum diaktifkan.', { mode: 'disabled' });
  }

  const local = readLicense();
  const hwid = getHwid(local);
  LOG('[license] cek ke server ' + cfg.url + ' (device ' + hwid + ')');

  try {
    const { status, data } = await postJson(cfg.url + '/api/license/check', {
      key: local && local.key ? local.key : '',
      hwid,
      platform: process.platform,
      appVersion: (APP && APP.getVersion && APP.getVersion()) || ''
    });

    if (data.ok && data.expiresAt) {
      const saved = setFromServer(data, local);
      LOG('[license] valid sampai ' + saved.expiresAt);
      return result(true, 'ACTIVE', 'Lisensi aktif.', { mode: 'online', info: saved });
    }

    if (HARD_CODES.indexOf(data.code) !== -1) {
      LOG('[license] ditolak server: ' + data.code + ' — ' + data.message);
      return result(false, data.code, data.message || 'Lisensi tidak valid.', {
        mode: 'online', hwid, expiresAt: data.expiresAt
      });
    }

    LOG('[license] respons tidak dikenal: HTTP ' + status + ' ' + JSON.stringify(data).slice(0, 200));
  } catch (e) {
    LOG('[license] server tidak bisa dihubungi: ' + (e && e.message ? e.message : e));
  }

  // ── Fallback offline: grace period ──────────────────────────────────────────
  if (local && local.expiresAt && local.lastVerifiedLocalAt) {
    const now = Date.now();
    const elapsed = now - Number(local.lastVerifiedLocalAt);
    const graceMs = (Number(local.graceDays || cfg.graceDays) || 7) * DAY_MS;
    const clockRolledBack = now < Number(local.lastVerifiedLocalAt) - DAY_MS;
    const locallyExpired = now > Date.parse(local.expiresAt) + DAY_MS;

    if (!clockRolledBack && !locallyExpired && elapsed >= 0 && elapsed <= graceMs) {
      const sisa = Math.max(0, Math.ceil((graceMs - elapsed) / DAY_MS));
      LOG('[license] offline grace period, sisa ~' + sisa + ' hari.');
      return result(true, 'GRACE', 'Sedang offline. Lisensi berlaku kembali setelah online.', {
        mode: 'grace', graceLeftDays: sisa, info: local
      });
    }

    if (locallyExpired) {
      return result(false, 'EXPIRED', 'Masa aktif key sudah habis. Masukin key baru.', {
        mode: 'offline', hwid, expiresAt: local.expiresAt
      });
    }

    return result(false, 'OFFLINE_EXPIRED',
      'Grace period ' + cfg.graceDays + ' hari habis dan server tidak bisa dihubungi. ' +
      'Hubungkan internet atau masukin key baru.', { mode: 'offline', hwid });
  }

  return result(false, 'NO_LICENSE',
    'Belum ada lisensi aktif di perangkat ini. Masukin Auth Key untuk mulai.',
    { mode: 'offline', hwid });
}

async function activate(key) {
  const cfg = config();
  const normalized = normalizeKey(key);
  if (!cfg.url) {
    return result(false, 'CONFIG', 'LICENSE_URL belum diisi di license-config.json.', { hwid: getHwid(null) });
  }
  if (normalized.length < 8) {
    return result(false, 'INVALID_KEY', 'Key terlalu pendek. Cek lagi kodenya.', { hwid: getHwid(null) });
  }

  const local = readLicense();
  const hwid = getHwid(local);
  LOG('[license] aktivasi key ' + normalized + ' untuk device ' + hwid);

  try {
    const { data } = await postJson(cfg.url + '/api/license/activate', {
      key: normalized,
      hwid,
      platform: process.platform,
      appVersion: (APP && APP.getVersion && APP.getVersion()) || ''
    });

    if (data.ok && data.expiresAt) {
      const saved = setFromServer(data, local);
      LOG('[license] aktivasi BERHASIL, expired ' + saved.expiresAt);
      return result(true, 'ACTIVE', 'Aktivasi berhasil. Selamat pakai JekInteract!', {
        mode: 'online', info: saved
      });
    }

    LOG('[license] aktivasi gagal: ' + (data.code || '-') + ' — ' + (data.message || '-'));
    return result(false, data.code || 'FAILED', data.message || 'Key ditolak server.', {
      mode: 'online', hwid
    });
  } catch (e) {
    LOG('[license] aktivasi error: ' + (e && e.message ? e.message : e));
    return result(false, 'SERVER_OFFLINE',
      'Server lisensi tidak bisa dihubungi. Cek koneksi internet lu, lalu coba lagi.', { hwid });
  }
}

function getStatus() {
  const cfg = config();
  return {
    ...lastStatus,
    key: (lastStatus.info && lastStatus.info.key) || '',
    expiresAt: (lastStatus.info && lastStatus.info.expiresAt) || '',
    hwid: lastStatus.hwid || getHwid(readLicense()),
    graceDays: cfg.graceDays,
    configured: !!cfg.url && cfg.requireLicense
  };
}

module.exports = { init, verify, activate, getStatus, config, licensePath };
