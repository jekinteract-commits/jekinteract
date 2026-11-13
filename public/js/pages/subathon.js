import { $, $$, esc, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Store, DEFAULTS } from '../lib/store.js';
import { Sync } from '../lib/sync.js';
import { OVERLAYS } from '../lib/overlays.js';
import { fmtHMS, parseDecimal } from '../lib/format.js';
import { remainingMs, timerStatus, defaultMs } from '../lib/timer.js';
import { toast, linkRowHTML, previewHTML, statusHTML, bindStatuses, mountPreviews } from '../lib/ui.js';

/** Sync subathon per-event config ke server state agar TikTok live bisa tambah waktu */
function syncSubathonCfgToServer(cfg) {
  Sync.set('subathonCfg', { per: cfg.per });
}

const PER = [
  ['coin', 'Per Coin'],
  ['subscribe', 'Per Subscribe'],
  ['follow', 'Per Follow'],
  ['share', 'Per Share'],
  ['like', 'Per Like'],
  ['comment', 'Per Komen']
];

function loadCfg() {
  const s = Store.get('subathon', {});
  return {
    value: s.value != null ? s.value : DEFAULTS.subathon.value,
    unit: s.unit || DEFAULTS.subathon.unit,
    per: Object.assign({}, DEFAULTS.subathon.per, s.per || {})
  };
}

const showNum = (n) => String(n).replace('.', ',');

export default {
  id: 'subathon',
  title: 'Subathon Timer',
  icon: 'timer',

  render() {
    const ov = OVERLAYS.subathon;
    const c = loadCfg();
    return (
      '<div class="ph"><h1>Subathon Timer</h1><p>Subathon Timer adalah alat yang memungkinkan Anda untuk mengatur timer subathon Anda.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Preview Overlay</h2><div class="sub">Tema arcade futuristik, latar transparan.</div></div>' + statusHTML(ov.id) + '</div>' +
      previewHTML(ov, { title: 'Tampilan timer' }) +
      '<div class="fgrp sb-link"><span class="lbl">Link Overlay</span>' + linkRowHTML(ov) + '</div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Control</h2><div class="sub">Mulai, jeda, atau reset timer. Overlay ikut berubah seketika.</div></div><span class="st off" id="sb-state"><i></i><b>Siap</b></span></div>' +
      '<div class="ctl"><div class="ctl-read"><span class="ctl-l">Sisa waktu</span><b class="ctl-t" id="sb-read">00:00:00</b></div>' +
      '<div class="row">' +
      '<button type="button" class="btn primary" id="sb-start">' + icon('play') + 'Mulai</button>' +
      '<button type="button" class="btn" id="sb-pause">' + icon('pause') + 'Pause</button>' +
      '<button type="button" class="btn danger" id="sb-reset">' + icon('reset') + 'Reset</button></div></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Setting</h2></div></div>' +
      '<div class="fgrp"><label class="lbl" for="sb-val">Default Start Value</label>' +
      '<div class="row nowrap sb-start"><div class="field short"><input id="sb-val" type="text" inputmode="decimal" autocomplete="off" value="' + showNum(c.value) + '"></div>' +
      '<div class="field sel short"><select id="sb-unit" aria-label="Satuan waktu">' +
      '<option value="s"' + (c.unit === 's' ? ' selected' : '') + '>Detik</option>' +
      '<option value="m"' + (c.unit === 'm' ? ' selected' : '') + '>Menit</option>' +
      '<option value="h"' + (c.unit === 'h' ? ' selected' : '') + '>Jam</option></select></div></div></div>' +
      '<p class="dim sb-note">Tentukan berapa detik waktu bertambah atau berkurang untuk setiap jenis interaksi. Gunakan nilai positif untuk menambah waktu dan nilai negatif (misalnya -5) untuk mengurangi waktu. ' +
      'Anda juga dapat menggunakan angka desimal misalnya 0,05 jika satu detik penuh terlalu lama.</p>' +
      '<div class="g2 sb-per">' +
      PER.map(([k, label]) =>
        '<div class="fgrp"><label class="lbl" for="sb-p-' + k + '">' + label + '</label>' +
        '<div class="field"><input id="sb-p-' + k + '" data-per="' + k + '" type="text" inputmode="decimal" autocomplete="off" value="' + showNum(c.per[k]) + '"><span class="unit">detik</span></div>' +
        '<p class="hint">Isi 1 untuk menambah 1 detik dari durasi subathon.</p></div>'
      ).join('') +
      '</div>' +
      '<div class="row"><button type="button" class="btn primary" id="sb-save">' + icon('save') + 'Simpan</button></div>' +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    d(mountPreviews(root));
    d(bindStatuses(root));

    const dMs = () => defaultMs(loadCfg());
    const st = () => Sync.get('subathon', null);
    const rem = () => (st() ? remainingMs(st(), Sync.recv.subathon) : dMs());
    const status = () => (st() ? timerStatus(st(), Sync.recv.subathon) : 'idle');
    const push = (s, r) => Sync.set('subathon', {
      status: s,
      remainingMs: r,
      defaultMs: dMs(),
      // startedAt: epoch ms dari server — dipakai timer.js untuk sinkron di semua client
      // (termasuk via Cloudflare) tanpa bergantung pada kapan SSE state diterima.
      startedAt: s === 'running' ? Date.now() : null
    });

    // Fetch state subathon + subathonCfg via REST — fix Cloudflare/tunnel (SSE hello bisa terlambat).
    Promise.all([
      fetch('/api/state/subathon').then((r) => r.json()).catch(() => null),
      fetch('/api/state/subathonCfg').then((r) => r.json()).catch(() => null)
    ]).then(([rs, rc]) => {
      if (rs && rs.value != null) {
        Sync.state['subathon'] = rs.value;
        Sync.recv['subathon'] = Date.now();
        paint();
      }
      if (rc && rc.value != null) {
        Sync.state['subathonCfg'] = rc.value;
      }
    });

    if (!Sync.state.subathon) push('idle', dMs());

    // Sync config ke server segera saat halaman dibuka (supaya server tahu nilai per-event)
    syncSubathonCfgToServer(loadCfg());

    const paint = () => {
      const s = status();
      $('#sb-read', root).textContent = fmtHMS(rem());
      const chip = $('#sb-state', root);
      const map = { running: ['on', 'Berjalan'], paused: ['wait', 'Dijeda'], finished: ['off', 'Selesai'], idle: ['off', 'Siap'] };
      chip.className = 'st ' + map[s][0];
      $('b', chip).textContent = map[s][1];
      $('#sb-start', root).disabled = s === 'running';
      $('#sb-pause', root).disabled = s !== 'running';
    };
    paint();
    const tick = setInterval(paint, 250);
    d(() => clearInterval(tick));
    d(Sync.on('state', (e) => {
      if (e.key === 'subathon' || e.key === '*') paint();
    }));

    $('#sb-start', root).addEventListener('click', () => {
      const s = st();
      const cur = status();
      if (cur === 'running') return;
      let r;
      if (cur === 'paused') r = s.remainingMs;
      else if (cur === 'finished' || !s || !(s.remainingMs > 0)) r = dMs();
      else r = s.remainingMs;
      push('running', r);
      toast('Timer dimulai.', 'ok', 2000);
    });
    $('#sb-pause', root).addEventListener('click', () => {
      if (status() !== 'running') return;
      push('paused', rem());
      toast('Timer dijeda.', 'info', 2000);
    });
    $('#sb-reset', root).addEventListener('click', () => {
      push('idle', dMs());
      toast('Timer direset ke nilai awal.', 'info', 2000);
    });

    $('#sb-save', root).addEventListener('click', () => {
      $$('.field.err', root).forEach((f) => f.classList.remove('err'));
      const value = parseDecimal($('#sb-val', root).value);
      if (!(value > 0)) {
        $('#sb-val', root).closest('.field').classList.add('err');
        $('#sb-val', root).focus();
        return toast('Default Start Value harus angka lebih dari 0.', 'err');
      }
      const per = {};
      for (const [k, label] of PER) {
        const inp = $('#sb-p-' + k, root);
        const raw = inp.value.trim();
        const n = raw === '' ? 0 : parseDecimal(raw);
        if (Number.isNaN(n)) {
          inp.closest('.field').classList.add('err');
          inp.focus();
          return toast('Nilai "' + label + '" bukan angka yang valid.', 'err');
        }
        per[k] = n;
      }
      const newCfg = { value, unit: $('#sb-unit', root).value, per };
      Store.set('subathon', newCfg);
      syncSubathonCfgToServer(newCfg);
      if (status() === 'idle') push('idle', dMs());
      toast('Setting subathon disimpan.', 'ok');
    });

    return () => d.run();
  }
};
