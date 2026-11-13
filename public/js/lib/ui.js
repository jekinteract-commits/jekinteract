/* Komponen UI bersama untuk dashboard. */
import { $, $$, esc, on } from './dom.js';
import { icon } from './icons.js';
import { Sync } from './sync.js';
import { baseUrl } from './store.js';
import { isoDate, addDays, parseISO, startOfDay } from './format.js';

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */
const TOAST_ICON = { ok: 'checkCircle', err: 'xCircle', warn: 'alert', info: 'info' };

export function toast(msg, type = 'info', ms = 3800) {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast t-' + type;
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  el.innerHTML = '<span class="ti">' + icon(TOAST_ICON[type] || 'info') + '</span><span class="tm">' + esc(msg) + '</span>';
  host.appendChild(el);
  while (host.children.length > 4) host.firstChild.remove();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 280);
  };
  el.addEventListener('click', close);
  setTimeout(close, ms);
}

/** Blok alert statis (untuk status koneksi dll). */
export function alertHTML(type, title, text = '') {
  const ic = TOAST_ICON[type] || 'info';
  return (
    '<div class="alert a-' + type + '" role="' + (type === 'err' ? 'alert' : 'status') + '">' +
    icon(ic) + '<div><b>' + esc(title) + '</b>' + (text ? esc(text) : '') + '</div></div>'
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */
const stack = [];
let escBound = false;

export function openModal(opts) {
  const { title = '', body = '', footer = '', size = '', dismissible = true, onMount, onClose } = opts;
  const host = $('#modals');
  const el = document.createElement('div');
  el.className = 'modal';
  el.style.zIndex = String(100 + stack.length * 10);
  el.innerHTML =
    '<div class="mcard ' + size + '" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" tabindex="-1">' +
    '<div class="mhead"><h3>' + esc(title) + '</h3>' +
    '<button type="button" class="btn icon sm ghost" data-close aria-label="Tutup">' + icon('x') + '</button></div>' +
    '<div class="mbody">' + body + '</div>' +
    (footer ? '<div class="mfoot">' + footer + '</div>' : '') +
    '</div>';
  host.appendChild(el);

  const prevFocus = document.activeElement;
  const m = {
    el,
    card: $('.mcard', el),
    body: $('.mbody', el),
    foot: $('.mfoot', el),
    dismissible,
    closed: false,
    $: (sel) => el.querySelector(sel),
    $$: (sel) => Array.from(el.querySelectorAll(sel)),
    close(result) {
      if (m.closed) return;
      m.closed = true;
      const i = stack.indexOf(m);
      if (i >= 0) stack.splice(i, 1);
      el.remove();
      if (!stack.length) document.documentElement.classList.remove('modal-open');
      if (onClose) {
        try {
          onClose(result);
        } catch (e) {
          console.error(e);
        }
      }
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) {
        try {
          prevFocus.focus({ preventScroll: true });
        } catch (_) {
          /* abaikan */
        }
      }
    }
  };
  stack.push(m);
  document.documentElement.classList.add('modal-open');

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) m.close();
    else if (e.target === el && dismissible) m.close();
  });

  if (!escBound) {
    escBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !stack.length) return;
      const top = stack[stack.length - 1];
      if (top.dismissible) top.close();
    });
  }

  if (onMount) onMount(m);
  m.card.focus({ preventScroll: true });
  return m;
}

export function confirmDialog({ title = 'Konfirmasi', message = '', okText = 'Ya', cancelText = 'Batal', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title,
      size: 'sm',
      body: '<p class="dim">' + esc(message) + '</p>',
      footer:
        '<button type="button" class="btn" data-close>' + esc(cancelText) + '</button>' +
        '<button type="button" class="btn ' + (danger ? 'danger' : 'primary') + '" data-ok>' + esc(okText) + '</button>',
      onClose: () => resolve(result)
    });
    const ok = m.$('[data-ok]');
    ok.addEventListener('click', () => {
      result = true;
      m.close();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Salin & link overlay                                                */
/* ------------------------------------------------------------------ */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    /* lanjut ke cara lama */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, 99999);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (_) {
    ok = false;
  }
  ta.remove();
  return ok;
}

export const overlayUrl = (path) => baseUrl() + path;

/** Baris: kolom link + tombol Salin (+ buka di tab baru). */
export function linkRowHTML(ov, { open = true } = {}) {
  const url = overlayUrl(ov.path);
  return (
    '<div class="linkrow">' +
    '<div class="field ro"><input type="text" readonly value="' + esc(url) + '" aria-label="Link overlay ' + esc(ov.label) + '" data-link></div>' +
    '<button type="button" class="btn" data-copy="' + esc(url) + '">' + icon('copy') + 'Salin Link</button>' +
    (open
      ? '<a class="btn ghost icon" href="' + esc(url) + '?bg=1" target="_blank" rel="noopener" title="Buka di tab baru" aria-label="Buka overlay di tab baru">' + icon('external') + '</a>'
      : '') +
    '</div>'
  );
}

/** Pasang penyalin global untuk semua tombol [data-copy]. */
export function bindCopy(root = document) {
  return on(root, 'click', '[data-copy]', async (e, btn) => {
    const ok = await copyText(btn.dataset.copy);
    toast(ok ? 'Link overlay disalin.' : 'Tidak bisa menyalin otomatis. Tekan lama kolom link lalu salin manual.', ok ? 'ok' : 'warn');
  });
}

/* ------------------------------------------------------------------ */
/* Status online / offline                                             */
/* ------------------------------------------------------------------ */
export function statusHTML(id) {
  const on = Sync.isOnline(id);
  return '<span class="st ' + (on ? 'on' : 'off') + '" data-ov-status="' + esc(id) + '"><i></i><b>' + (on ? 'Online' : 'Offline') + '</b></span>';
}

/** Perbarui semua [data-ov-status] di dalam root saat status overlay berubah. */
export function bindStatuses(root) {
  const paint = () =>
    $$('[data-ov-status]', root).forEach((el) => {
      const isOn = Sync.isOnline(el.dataset.ovStatus);
      el.classList.toggle('on', isOn);
      el.classList.toggle('off', !isOn);
      const b = $('b', el);
      if (b) b.textContent = isOn ? 'Online' : 'Offline';
    });
  paint();
  return Sync.on('status', paint);
}

/* ------------------------------------------------------------------ */
/* Preview overlay (iframe berskala, latar kotak-kotak = transparan)   */
/* ------------------------------------------------------------------ */
export function previewHTML(ov, { title = 'Preview Overlay', extra = '' } = {}) {
  return (
    '<div class="pv" data-ov="' + ov.id + '" data-w="' + ov.w + '" data-h="' + ov.h + '">' +
    '<div class="pv-head"><span class="pv-t">' + esc(title) + '</span>' +
    '<div class="row">' + extra +
    '<button type="button" class="btn sm" data-pv-refresh>' + icon('refresh') + 'Refresh Overlay</button></div></div>' +
    '<div class="pv-stage" style="--w:' + ov.w + ';--h:' + ov.h + '">' +
    '<div class="pv-scale" style="width:' + ov.w + 'px;height:' + ov.h + 'px">' +
    '<iframe src="' + ov.path + '?preview=1" title="Preview ' + esc(ov.label) + '" width="' + ov.w + '" height="' + ov.h + '" allow="autoplay" referrerpolicy="same-origin"></iframe>' +
    '</div></div>' +
    '<p class="hint pv-foot">Latar transparan. Ukuran Browser Source di OBS: ' + ov.w + ' × ' + ov.h + '.</p>' +
    '</div>'
  );
}

export function mountPreviews(root) {
  const cleanups = [];
  $$('.pv', root).forEach((pv) => {
    const stage = $('.pv-stage', pv);
    const scale = $('.pv-scale', pv);
    const w = Number(pv.dataset.w);
    const fit = () => {
      const s = Math.min(1, stage.clientWidth / w);
      scale.style.transform = 'scale(' + s + ')';
    };
    fit();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(fit);
      ro.observe(stage);
      cleanups.push(() => ro.disconnect());
    } else {
      window.addEventListener('resize', fit);
      cleanups.push(() => window.removeEventListener('resize', fit));
    }
  });
  cleanups.push(
    on(root, 'click', '[data-pv-refresh]', (e, btn) => {
      const fr = $('iframe', btn.closest('.pv'));
      try {
        fr.contentWindow.location.reload();
      } catch (_) {
        fr.src = fr.src;
      }
      btn.classList.remove('spin');
      void btn.offsetWidth;
      btn.classList.add('spin');
    })
  );
  return () => cleanups.forEach((fn) => fn());
}

/** Kirim pesan ke iframe preview (khusus preview, tidak memengaruhi overlay asli). */
export function postToPreview(root, ovId, msg) {
  const fr = root.querySelector('.pv[data-ov="' + ovId + '"] iframe');
  if (fr && fr.contentWindow) fr.contentWindow.postMessage(msg, location.origin);
}

/* ------------------------------------------------------------------ */
/* Kontrol form                                                        */
/* ------------------------------------------------------------------ */
export function bindRanges(root) {
  const paint = (inp) => {
    const min = Number(inp.min) || 0;
    const max = Number(inp.max) || 100;
    inp.style.setProperty('--p', ((Number(inp.value) - min) / (max - min)) * 100 + '%');
    const out = inp.closest('.rng') && inp.closest('.rng').querySelector('output');
    if (out) out.textContent = inp.value + '%';
  };
  $$('.rng input[type="range"]', root).forEach(paint);
  return on(root, 'input', '.rng input[type="range"]', (e, inp) => paint(inp));
}

export function bindChoices(root) {
  const sync = () => $$('.choice', root).forEach((c) => c.classList.toggle('on', !!$('input', c).checked));
  sync();
  return on(root, 'change', '.choice input', sync);
}

/** Animasi hitung naik untuk angka. */
export function countUp(el, to, fmtFn = (v) => String(Math.round(v)), ms = 650) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = String(to);
  cancelAnimationFrame(Number(el.dataset.raf || 0));
  if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = fmtFn(to);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtFn(from + (to - from) * e);
    if (k < 1) el.dataset.raf = String(requestAnimationFrame(step));
  };
  el.dataset.raf = String(requestAnimationFrame(step));
}

export function bytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

/* ------------------------------------------------------------------ */
/* Filter rentang waktu: 7 hari / 30 hari / dari tanggal ke tanggal     */
/* ------------------------------------------------------------------ */
export function rangeFilterHTML(key) {
  const today = isoDate(new Date());
  const from = isoDate(addDays(new Date(), -13));
  return (
    '<div class="rf" data-rf="' + key + '">' +
    '<div class="seg" role="group" aria-label="Rentang waktu">' +
    '<button type="button" data-mode="7" class="on">7 hari</button>' +
    '<button type="button" data-mode="30">30 hari</button>' +
    '<button type="button" data-mode="custom">Pilih tanggal</button></div>' +
    '<div class="rf-custom" hidden>' +
    '<label class="field"><input type="date" data-from value="' + from + '" max="' + today + '" aria-label="Dari tanggal"></label>' +
    '<span class="muted">sampai</span>' +
    '<label class="field"><input type="date" data-to value="' + today + '" max="' + today + '" aria-label="Sampai tanggal"></label>' +
    '<button type="button" class="btn sm primary" data-apply>Terapkan</button></div></div>'
  );
}

/** onChange({from, to}, mode) dipanggil saat awal dan tiap perubahan. */
export function bindRangeFilter(root, key, onChange) {
  const el = root.querySelector('[data-rf="' + key + '"]');
  const custom = $('.rf-custom', el);
  const state = { mode: '7', from: null, to: null };

  const bounds = () => {
    const today = startOfDay(new Date());
    if (state.mode === '7') return { from: addDays(today, -6), to: today };
    if (state.mode === '30') return { from: addDays(today, -29), to: today };
    return { from: state.from, to: state.to };
  };
  const fire = () => onChange(bounds(), state.mode);

  const apply = () => {
    const f = parseISO($('[data-from]', el).value);
    const t = parseISO($('[data-to]', el).value);
    if (!f || !t) return toast('Isi kedua tanggal dulu.', 'warn');
    if (f > t) return toast('Tanggal awal tidak boleh setelah tanggal akhir.', 'err');
    state.from = f;
    state.to = t;
    fire();
  };

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) {
      state.mode = b.dataset.mode;
      $$('[data-mode]', el).forEach((x) => x.classList.toggle('on', x === b));
      custom.hidden = state.mode !== 'custom';
      if (state.mode === 'custom') apply();
      else fire();
      return;
    }
    if (e.target.closest('[data-apply]')) apply();
  });

  fire();
  return { bounds };
}
