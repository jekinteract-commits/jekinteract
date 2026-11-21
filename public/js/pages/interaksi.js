import { $, $$, esc, on, uid, clone, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Sync, API } from '../lib/sync.js';
import { SCREEN_COUNT, screenOverlay } from '../lib/overlays.js';
import { fmt } from '../lib/format.js';
import { OBS_SCENES, OBS_SOURCES, WHO_ACT } from '../lib/demo.js';
import { loadGifts, giftPickerHTML } from '../lib/gifts.js';
import { toast, openModal, confirmDialog, linkRowHTML, statusHTML, bindStatuses, bindRanges, bindChoices, bytes } from '../lib/ui.js';

/* ------------------------------------------------------------------ */
/* Konstanta                                                           */
/* ------------------------------------------------------------------ */
const TRIGGERS = [
  { k: 'image', label: 'Trigger Gambar', desc: 'Tampilkan gambar di screen', ic: 'image', cls: 'c-img', short: 'Gambar' },
  { k: 'video', label: 'Trigger Video', desc: 'Putar video di screen', ic: 'video', cls: 'c-vid', short: 'Video' },
  { k: 'audio', label: 'Trigger Audio', desc: 'Mainkan suara', ic: 'volume', cls: 'c-aud', short: 'Audio' },
  { k: 'keystroke', label: 'Trigger Keystroke/Hotkey', desc: 'Simulasikan tombol keyboard', ic: 'keyboard', cls: 'c-key', short: 'Keystroke' },
  { k: 'obsScene', label: 'Switch OBS Scene', desc: 'Pindah scene di OBS', ic: 'monitor', cls: 'c-obs', short: 'Switch Scene' },
  { k: 'obsSource', label: 'Aktifkan Source OBS', desc: 'Nyalakan source di OBS', ic: 'layers', cls: 'c-obs', short: 'Aktifkan Source' }
];

const WHEN_LABEL = {
  join: 'Orang Join Live',
  comment: 'Kirim Komentar',
  comment_exact: 'Kirim Komentar Tertentu',
  gift_min: 'Kirim Gift dengan Minimal Coin',
  like_min: 'Kirim Like/Tap Tap dengan Minimal',
  gift_specific: 'Kirim Gift Tertentu',
  follow: 'Orang Follow Kamu',
  share: 'Share Live'
};
const WHEN_ICON = { join: 'users', comment: 'chat', comment_exact: 'chat', gift_min: 'gift', like_min: 'heart', gift_specific: 'gift', follow: 'userPlus', share: 'share' };
const WHO_LABEL = Object.fromEntries(WHO_ACT);

const loadInts = () => Sync.get('interactions', []);
const loadActs = () => Sync.get('activities', []);

const blankInteraction = () => ({
  id: uid('int'),
  name: '',
  triggers: { image: false, video: false, audio: false, keystroke: false, obsScene: false, obsSource: false },
  media: { image: null, video: null, audio: null },
  keystrokes: [],
  obs: { scene: OBS_SCENES[0], mode: 'revert', srcScene: OBS_SCENES[0], source: OBS_SOURCES[0], srcOff: true },
  volume: 100,
  duration: 10,
  delay: 0,
  keystrokeDelay: 0,
  screen: 1,
  repeatCombo: false,
  fade: false
});

const blankActivity = () => ({
  id: uid('act'),
  enabled: true,
  who: 'all',
  when: { type: 'gift_specific', text: '', coins: 100, likes: 100, gift: '' },
  action: { mode: 'single', id: '', ids: [] }
});

const triggerList = (it) => TRIGGERS.filter((t) => it.triggers[t.k]);

/* ------------------------------------------------------------------ */
/* Halaman                                                             */
/* ------------------------------------------------------------------ */
export default {
  id: 'interaksi',
  title: 'Pusat Interaksi',
  icon: 'gamepad',

  render() {
    return (
      '<div class="ph"><h1>Pusat Interaksi</h1>' +
      '<p>Pusat Interaksi memungkinkan Anda mengelola dan merespons aktivitas pengguna dengan mudah, mulai dari event seperti like dan gift hingga aksi kustom seperti memainkan suara atau menampilkan alert.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Screen Overlay</h2><div class="sub">20 screen untuk menampilkan gambar, video, dan audio interaksi.</div></div>' +
      '<button type="button" class="btn" data-act="links">' + icon('link') + 'Link Overlay</button></div>' +
      '<div class="scr-sum" id="scr-sum"></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Interaksi</h2><div class="sub">Aksi yang bisa dipicu: gambar, video, audio, keystroke, atau pindah scene OBS.</div></div>' +
      '<button type="button" class="btn primary" data-act="int-add">' + icon('plus') + 'Tambah Interaksi</button></div>' +
      '<div class="list" id="int-list"></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Aktivitas</h2><div class="sub">Atur kapan sebuah interaksi dijalankan, misalnya saat ada gift tertentu.</div></div>' +
      '<button type="button" class="btn primary" data-act="act-add">' + icon('plus') + 'Tambah Aktivitas</button></div>' +
      '<div class="list" id="act-list"></div>' +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();

    /* ---------- ringkasan screen online ---------- */
    const paintScreens = () => {
      let n = 0;
      for (let i = 1; i <= SCREEN_COUNT; i++) if (Sync.isOnline('screen-' + i)) n++;
      $('#scr-sum', root).innerHTML =
        '<span class="st ' + (n ? 'on' : 'off') + '"><i></i>' + n + ' dari ' + SCREEN_COUNT + ' screen online</span>' +
        '<span class="muted sm-t">Buka Link Overlay untuk menyalin link tiap screen.</span>';
    };
    paintScreens();
    d(Sync.on('status', paintScreens));

    /* ---------- daftar interaksi ---------- */
    const paintInts = () => {
      const list = loadInts();
      const host = $('#int-list', root);
      if (!list.length) {
        host.innerHTML =
          '<div class="empty">' + icon('gamepad') + '<b>Belum ada interaksi</b><span>Tekan Tambah Interaksi untuk membuat yang pertama.</span></div>';
        return;
      }
      host.innerHTML = list.map(intItemHTML).join('');
    };

    /* ---------- daftar aktivitas ---------- */
    const paintActs = () => {
      const list = loadActs();
      const ints = loadInts();
      const host = $('#act-list', root);
      if (!list.length) {
        host.innerHTML =
          '<div class="empty">' + icon('bolt') + '<b>Belum ada aktivitas</b><span>' +
          (ints.length ? 'Tekan Tambah Aktivitas untuk menghubungkan event TikTok ke interaksi.' : 'Buat interaksi dulu, lalu hubungkan ke event TikTok di sini.') +
          '</span></div>';
        return;
      }
      host.innerHTML = list.map((a) => actItemHTML(a, ints)).join('');
    };

    const paintAll = () => {
      paintInts();
      paintActs();
    };
    paintAll();

    // Status keystroke (admin / mesin aktif) dipakai di form Interaksi.
    API.keystrokeStatus().then((s) => { ksStatus = s; }).catch(() => { ksStatus = null; });

    // Fetch state langsung saat mount — fix untuk Cloudflare/tunnel di mana
    // SSE hello bisa terlambat sehingga Sync.state masih kosong saat render pertama.
    Promise.all([
      fetch('/api/state/interactions').then((r) => r.json()).catch(() => null),
      fetch('/api/state/activities').then((r) => r.json()).catch(() => null)
    ]).then(([ri, ra]) => {
      let changed = false;
      if (ri && ri.value !== undefined && ri.value !== null) { Sync.state['interactions'] = ri.value; changed = true; }
      if (ra && ra.value !== undefined && ra.value !== null) { Sync.state['activities'] = ra.value; changed = true; }
      if (changed) paintAll();
    });

    // Re-render jika data interactions/activities berubah dari tab lain atau saat sync pertama kali masuk
    d(Sync.on('state', ({ key }) => {
      if (key === 'interactions' || key === 'activities' || key === '*') paintAll();
    }));

    /* ---------- aksi di halaman ---------- */
    d(on(root, 'click', '[data-act]', async (e, btn) => {
      const act = btn.dataset.act;
      const row = btn.closest('[data-id]');
      const id = row ? row.dataset.id : '';

      if (act === 'links') return openLinks();
      if (act === 'int-add') return openInteractionForm(null, (data) => saveInt(data, paintAll));
      if (act === 'act-add') {
        if (!loadInts().length) return toast('Tambahkan interaksi dulu sebelum membuat aktivitas.', 'warn');
        return openActivityForm(null, (data) => saveAct(data, paintAll));
      }

      if (act === 'edit' && row.classList.contains('itm')) {
        const it = loadInts().find((x) => x.id === id);
        if (it) openInteractionForm(it, (data) => saveInt(data, paintAll));
      } else if (act === 'edit' && row.classList.contains('act')) {
        const a = loadActs().find((x) => x.id === id);
        if (a) openActivityForm(a, (data) => saveAct(data, paintAll));
      } else if (act === 'play') {
        const it = loadInts().find((x) => x.id === id);
        if (it) testPlay(it);
      } else if (act === 'dup') {
        if (row.classList.contains('itm')) {
          const list = loadInts();
          const i = list.findIndex((x) => x.id === id);
          if (i < 0) return;
          const copy = clone(list[i]);
          copy.id = uid('int');
          copy.name = list[i].name + ' (salinan)';
          list.splice(i + 1, 0, copy);
          Sync.set('interactions', list);
          toast('Interaksi diduplikat.', 'ok');
        } else {
          const list = loadActs();
          const i = list.findIndex((x) => x.id === id);
          if (i < 0) return;
          const copy = clone(list[i]);
          copy.id = uid('act');
          list.splice(i + 1, 0, copy);
          Sync.set('activities', list);
          toast('Aktivitas diduplikat.', 'ok');
        }
        paintAll();
      } else if (act === 'del') {
        const isInt = row.classList.contains('itm');
        const list = isInt ? loadInts() : loadActs();
        const target = list.find((x) => x.id === id);
        if (!target) return;
        let message = 'Hapus ' + (isInt ? 'interaksi "' + target.name + '"' : 'aktivitas ini') + '? Tindakan ini tidak bisa dibatalkan.';
        if (isInt) {
          const used = loadActs().filter((a) => a.action.id === id || (a.action.ids || []).includes(id)).length;
          if (used) message += ' Interaksi ini dipakai di ' + used + ' aktivitas.';
        }
        const ok = await confirmDialog({ title: isInt ? 'Hapus interaksi' : 'Hapus aktivitas', message, okText: 'Hapus', danger: true });
        if (!ok) return;
        Sync.set(isInt ? 'interactions' : 'activities', list.filter((x) => x.id !== id));
        toast(isInt ? 'Interaksi dihapus.' : 'Aktivitas dihapus.', 'ok');
        paintAll();
      }
    }));

    // saklar aktif/nonaktif aktivitas
    d(on(root, 'change', '[data-toggle]', (e, input) => {
      const id = input.closest('[data-id]').dataset.id;
      const list = loadActs();
      const a = list.find((x) => x.id === id);
      if (!a) return;
      a.enabled = input.checked;
      Sync.set('activities', list);
      toast(a.enabled ? 'Aktivitas diaktifkan.' : 'Aktivitas dinonaktifkan.', 'info', 2200);
      paintActs();
    }));

    return () => d.run();
  }
};

/* ------------------------------------------------------------------ */
/* Item daftar                                                         */
/* ------------------------------------------------------------------ */
function intItemHTML(it) {
  const ks = triggerList(it);
  const p = ks[0];
  const kinds = ks.map((t) => t.short).join(', ') || 'belum dipilih';
  return (
    '<div class="itm" data-id="' + esc(it.id) + '">' +
    '<button type="button" class="itm-main" data-act="edit" aria-label="Ubah interaksi ' + esc(it.name) + '">' +
    '<span class="itm-ico ' + (p ? p.cls : '') + '">' + icon(p ? p.ic : 'bolt') + '</span>' +
    '<span class="itm-txt"><b>' + esc(it.name) + '</b>' +
    '<small>Screen ' + it.screen + ' • ' + it.duration + ' Detik • Trigger ' + esc(kinds) + '</small></span></button>' +
    '<div class="itm-act">' +
    '<button type="button" class="btn icon sm ghost" data-act="play" title="Tes interaksi" aria-label="Tes interaksi">' + icon('play') + '</button>' +
    '<button type="button" class="btn icon sm ghost" data-act="dup" title="Duplikat" aria-label="Duplikat interaksi">' + icon('copy') + '</button>' +
    '<button type="button" class="btn icon sm ghost" data-act="del" title="Hapus" aria-label="Hapus interaksi">' + icon('trash') + '</button>' +
    '</div></div>'
  );
}

function whenText(w) {
  switch (w.type) {
    case 'comment_exact': return 'Kirim Komentar Tertentu: "' + w.text + '"';
    case 'gift_min': return 'Kirim Gift minimal ' + fmt(w.coins) + ' Coin';
    case 'like_min': return 'Kirim minimal ' + fmt(w.likes) + ' Like/Tap Tap';
    case 'gift_specific': return 'Kirim Gift Tertentu: ' + (w.gift || '-');
    default: return WHEN_LABEL[w.type] || w.type;
  }
}

function actionText(a, ints) {
  if (a.action.mode === 'random') {
    const valid = (a.action.ids || []).filter((id) => ints.some((i) => i.id === id));
    if (!valid.length) return 'salah satu dari 0 interaksi (acak)';
    const first = ints.find((i) => i.id === valid[0]);
    const extra = valid.length - 1;
    return (first ? first.name : '?') + (extra > 0 ? ' +' + extra + ' lainnya (acak)' : ' (acak)');
  }
  const it = ints.find((i) => i.id === a.action.id);
  return it ? it.name : null;
}

function actItemHTML(a, ints) {
  const act = actionText(a, ints);
  const actMissing = act === null;
  return (
    '<div class="act' + (a.enabled ? '' : ' off') + (actMissing ? ' act-miss' : '') + '" data-id="' + esc(a.id) + '">' +
    '<span class="itm-ico c-act">' + icon(WHEN_ICON[a.when.type] || 'bolt') + '</span>' +
    '<span class="itm-txt"><b>' + esc(whenText(a.when)) + '</b>' +
    '<small>' + esc(WHO_LABEL[a.who] || a.who) + ' • Memicu ' + (actMissing ? '<em class="miss">interaksi sudah dihapus</em>' : esc(act)) + '</small></span>' +
    '<div class="itm-act">' +
    '<label class="sw sw-sm" title="Aktif / nonaktif"><input type="checkbox" data-toggle ' + (a.enabled ? 'checked' : '') + ' aria-label="Aktifkan aktivitas"><i></i></label>' +
    '<button type="button" class="btn icon sm ghost" data-act="edit" title="Ubah" aria-label="Ubah aktivitas">' + icon('edit') + '</button>' +
    '<button type="button" class="btn icon sm ghost" data-act="dup" title="Duplikat" aria-label="Duplikat aktivitas">' + icon('copy') + '</button>' +
    '<button type="button" class="btn icon sm ghost" data-act="del" title="Hapus" aria-label="Hapus aktivitas">' + icon('trash') + '</button>' +
    '</div></div>'
  );
}

function saveInt(data, done) {
  const list = loadInts();
  const i = list.findIndex((x) => x.id === data.id);
  if (i >= 0) list[i] = data;
  else list.push(data);
  Sync.set('interactions', list);
  toast('Interaksi disimpan.', 'ok');
  done();
}

function saveAct(data, done) {
  const list = loadActs();
  const i = list.findIndex((x) => x.id === data.id);
  if (i >= 0) list[i] = data;
  else list.push(data);
  Sync.set('activities', list);
  toast('Aktivitas disimpan.', 'ok');
  done();
}

/* ------------------------------------------------------------------ */
/* Tes interaksi (tombol Play)                                         */
/* ------------------------------------------------------------------ */
async function testPlay(it) {
  // media bisa berupa object {url, name, source} atau string URL langsung (format lama)
  const urlOf = (v) => v ? (typeof v === 'string' ? v : (v.url || null)) : null;
  const media = {
    image: it.triggers.image ? urlOf(it.media.image) : null,
    video: it.triggers.video ? urlOf(it.media.video) : null,
    audio: it.triggers.audio ? urlOf(it.media.audio) : null
  };

  console.log('[testPlay] name="' + it.name + '" screen=' + it.screen +
    ' triggers=' + JSON.stringify(it.triggers) +
    ' media.audio=' + (media.audio || 'null'));

  try {
    const r = await API.play(it.screen, { id: it.id, name: it.name, duration: it.duration, delay: it.delay || 0, volume: it.volume, fade: it.fade, test: true, media });
    console.log('[testPlay] response:', r);
    // Audio selalu diputar dari dashboard (via startAudioListener yang menangkap event 'play' dari server)
    if (r.online) {
      toast('Tes dikirim ke Screen ' + it.screen + '. Cek overlay.', 'ok');
    } else {
      toast('Screen ' + it.screen + ' sedang Offline. Audio tetap diputar di sini.', 'info', 4000);
    }
  } catch (e) {
    toast('Tes gagal: ' + e.message, 'err');
  }
  if (it.triggers.keystroke && it.keystrokes.length) {
    try {
      const kr = await fetch('/api/keystroke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: it.keystrokes,
          name: it.name,
          screen: it.screen,
          id: it.id,
          delay: it.delay || 0,
          keystrokeDelay: it.keystrokeDelay === undefined ? (it.delay || 0) : it.keystrokeDelay
        })
      });
      const kd = await kr.json();
      if (kd.simulated) {
        toast('Keystroke simulasi (mesin keystroke belum aktif): ' + it.keystrokes.join(', '), 'info', 4200);
      } else if (kd.ok && kd.delayed) {
        toast('Keystroke dijadwalkan +' + kd.delayed + 's: ' + it.keystrokes.join(', '), 'ok', 3500);
      } else if (kd.ok) {
        toast('Keystroke dikirim: ' + it.keystrokes.join(', '), 'ok', 3500);
      } else {
        toast('Keystroke gagal: ' + (kd.error || 'unknown'), 'err');
      }
      if (kd.warning) toast(kd.warning, 'warn', 6500);
    } catch (e) {
      toast('Keystroke error: ' + e.message, 'err');
    }
  }
  if (it.triggers.obsScene && it.obs && it.obs.scene) {
    if (Sync.obs && Sync.obs.status === 'online') {
      try {
        await API.obsCommand({ type: 'scene', scene: it.obs.scene, mode: it.obs.mode || 'revert', duration: it.duration || 10 });
        toast('OBS: pindah scene → "' + it.obs.scene + '"', 'ok', 3500);
      } catch (e) {
        toast('OBS scene gagal: ' + e.message, 'err');
      }
    } else {
      toast('Simulasi pindah scene OBS ke "' + it.obs.scene + '" (OBS belum terhubung).', 'info', 4200);
    }
  }
  if (it.triggers.obsSource && it.obs && it.obs.source) {
    if (Sync.obs && Sync.obs.status === 'online') {
      try {
        await API.obsCommand({ type: 'source', srcScene: it.obs.srcScene || '', source: it.obs.source, srcOff: it.obs.srcOff !== false, duration: it.duration || 10 });
        toast('OBS: aktifkan source "' + it.obs.source + '"', 'ok', 3500);
      } catch (e) {
        toast('OBS source gagal: ' + e.message, 'err');
      }
    } else {
      toast('Simulasi aktifkan source "' + it.obs.source + '" (OBS belum terhubung).', 'info', 4200);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Modal: Link Overlay (20 screen)                                     */
/* ------------------------------------------------------------------ */
function openLinks() {
  const rows = Array.from({ length: SCREEN_COUNT }, (_, i) => {
    const ov = screenOverlay(i + 1);
    return '<div class="lk"><div class="lk-h"><b>Screen ' + (i + 1) + '</b>' + statusHTML(ov.id) + '</div>' + linkRowHTML(ov) + '</div>';
  }).join('');
  const offs = [];
  const m = openModal({
    title: 'Link Overlay',
    size: 'lg',
    body:
      '<p class="dim">Tempel tiap link sebagai Browser Source di OBS (ukuran 1920 × 1080). Status Online berarti link sedang dibuka.</p>' +
      '<div class="lk-sum" id="lk-sum"></div><div class="lks">' + rows + '</div>',
    footer: '<button type="button" class="btn" data-close>Tutup</button>',
    onClose: () => offs.forEach((f) => f())
  });
  const sum = () => {
    let n = 0;
    for (let i = 1; i <= SCREEN_COUNT; i++) if (Sync.isOnline('screen-' + i)) n++;
    m.$('#lk-sum').innerHTML =
      '<span class="st ' + (n ? 'on' : 'off') + '"><i></i>' + n + ' dari ' + SCREEN_COUNT + ' screen online</span>';
  };
  offs.push(bindStatuses(m.el));
  offs.push(Sync.on('status', sum));
  sum();
  m.body.addEventListener('focusin', (e) => {
    if (e.target.matches('[data-link]')) e.target.select();
  });
}

/* ------------------------------------------------------------------ */
/* Modal: Tambah / ubah interaksi                                      */
/* ------------------------------------------------------------------ */
function mediaInfoHTML(kind, data) {
  const m = data.media[kind];
  if (!m) return '<span class="muted">Belum ada file dipilih</span>';
  const thumb = kind === 'image' && m.url ? '<img class="up-thumb" src="' + esc(m.url) + '" alt="">' : '';
  const sub = m.source === 'myinstants' ? 'myinstants.com' : m.size ? bytes(m.size) : '';
  return (
    thumb + '<span class="up-name"><b>' + esc(m.name) + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>' +
    '<button type="button" class="btn icon sm ghost" data-clear="' + kind + '" aria-label="Hapus pilihan">' + icon('x') + '</button>'
  );
}

function keysInfoHTML(data) {
  if (!data.keystrokes.length) return '<span class="muted">Belum ada keystroke dipilih</span>';
  return data.keystrokes.map((k) => '<span class="chip c-key">' + esc(k) + '</span>').join('');
}

/* Status mesin keystroke (diambil dari /api/keystroke/status). */
let ksStatus = null;
function keystrokeHintHTML() {
  if (!ksStatus) {
    return '<p class="hint small-dim" id="if-ks-hint">Mendeteksi mesin keystroke…</p>';
  }
  if (!ksStatus.available) {
    return '<p class="hint" id="if-ks-hint" style="color:#fca5a5">⚠ ' + esc(ksStatus.hint) + '</p>';
  }
  if (ksStatus.elevatedTargetBlocked) {
    return '<p class="hint" id="if-ks-hint" style="color:#fbbf24">⚠ ' + esc(ksStatus.hint) +
      ' <button type="button" class="btn sm" data-ks-admin>' + icon('bolt') + 'Jalankan sebagai Administrator</button></p>';
  }
  return '<p class="hint" id="if-ks-hint" style="color:#86efac">✓ ' + esc(ksStatus.hint) +
    (ksStatus.config && ksStatus.config.autoFocus ? ' <span class="small-dim">Target bisa diubah di Pengaturan.</span>' : '') + '</p>';
}

function triggerBlockHTML(t, d) {
  const on = d.triggers[t.k];
  let body = '';
  if (t.k === 'image' || t.k === 'video') {
    body =
      '<div class="up" data-up="' + t.k + '"><input type="file" accept="' + t.k + '/*" hidden>' +
      '<button type="button" class="btn sm" data-pick>' + icon('upload') + (t.k === 'image' ? 'Upload Gambar' : 'Upload Video') + '</button>' +
      '<div class="up-info" data-info></div></div>';
  } else if (t.k === 'audio') {
    body =
      '<div class="up" data-up="audio"><input type="file" accept="audio/*" hidden>' +
      '<div class="row"><button type="button" class="btn sm" data-pick-sound>' + icon('search') + 'Pilih Audio</button>' +
      '<button type="button" class="btn sm" data-pick>' + icon('upload') + 'Upload Audio</button></div>' +
      '<div class="up-info" data-info></div></div>';
  } else if (t.k === 'keystroke') {
    body = '<button type="button" class="btn sm" data-pick-keys>' + icon('keyboard') + 'Pilih Keystroke/Hotkey</button><div class="up-info" data-info-keys></div>';
  } else if (t.k === 'obsScene') {
    const obsConnected = Sync.obs && Sync.obs.status === 'online';
    const sceneList = obsConnected && Sync.obs.scenes && Sync.obs.scenes.length ? Sync.obs.scenes : OBS_SCENES;
    const sceneHint = obsConnected
      ? '<p class="hint" id="if-scene-hint">Diambil dari OBS (' + sceneList.length + ' scene). Scene aktif: ' + esc(Sync.obs.currentScene || '-') + '</p>'
      : '<p class="hint" id="if-scene-hint">Hubungkan OBS di halaman Connection terlebih dahulu agar daftar scene muncul secara otomatis.</p>';
    body =
      '<div class="fgrp"><label class="lbl" for="if-scene">Pilih Scene</label>' +
      '<div class="field sel"><select id="if-scene">' + sceneList.map((s) => '<option' + (s === d.obs.scene ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></div>' +
      sceneHint + '</div>' +
      '<div class="fgrp"><span class="lbl">Mode Scene</span>' +
      '<label class="choice"><input type="radio" name="scmode" value="revert"' + (d.obs.mode === 'revert' ? ' checked' : '') + '><i></i><span class="t"><b>Beralih ke scene sebelumnya</b><span>Kembali setelah durasi screen interaksi telah berakhir.</span></span></label>' +
      '<label class="choice"><input type="radio" name="scmode" value="stay"' + (d.obs.mode === 'stay' ? ' checked' : '') + '><i></i><span class="t"><b>Tetap berada di scene</b><span>Tetap di scene tersebut secara permanen.</span></span></label></div>';
  } else {
    const obsConnected = Sync.obs && Sync.obs.status === 'online';
    const sceneList = obsConnected && Sync.obs.scenes && Sync.obs.scenes.length ? Sync.obs.scenes : OBS_SCENES;
    const srcScene = d.obs.srcScene || (sceneList[0] || '');
    const sourceList = obsConnected && Sync.obs.sources && Sync.obs.sources[srcScene] && Sync.obs.sources[srcScene].length
      ? Sync.obs.sources[srcScene] : OBS_SOURCES;
    body =
      '<div class="g2"><div class="fgrp"><label class="lbl" for="if-srcscene">Scene</label>' +
      '<div class="field sel"><select id="if-srcscene">' + sceneList.map((s) => '<option' + (s === d.obs.srcScene ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></div></div>' +
      '<div class="fgrp"><label class="lbl" for="if-source">Source</label>' +
      '<div class="field sel"><select id="if-source">' + sourceList.map((s) => '<option' + (s === d.obs.source ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></div></div></div>' +
      (obsConnected ? '<p class="hint">Source dari OBS untuk scene "' + esc(srcScene) + '". Pilih scene lain untuk memuat ulang source-nya.</p>' : '<p class="hint">Hubungkan OBS di halaman Connection agar daftar source muncul secara otomatis.</p>') +
      '<label class="chk"><input type="checkbox" id="if-srcoff"' + (d.obs.srcOff ? ' checked' : '') + '><i></i><span class="t"><b>Matikan source setelah durasi berakhir</b><span>Jika tidak dicentang, source tetap menyala.</span></span></label>';
  }
  return (
    '<div class="trg' + (on ? ' on' : '') + '" data-t="' + t.k + '">' +
    '<label class="chk trg-h"><input type="checkbox" data-trg="' + t.k + '"' + (on ? ' checked' : '') + '><i></i>' +
    '<span class="trg-ico ' + t.cls + '">' + icon(t.ic) + '</span>' +
    '<span class="t"><b>' + t.label + '</b><span>' + t.desc + '</span></span></label>' +
    '<div class="trg-b"' + (on ? '' : ' hidden') + '>' + body + '</div></div>'
  );
}

function openInteractionForm(existing, onSave) {
  const data = existing ? clone(existing) : blankInteraction();

  const screens = Array.from({ length: SCREEN_COUNT }, (_, i) => '<option value="' + (i + 1) + '"' + (data.screen === i + 1 ? ' selected' : '') + '>Screen ' + (i + 1) + '</option>').join('');

  const body =
    '<div class="form-err" id="if-err" role="alert" hidden></div>' +
    '<div class="fgrp" data-f="name"><label class="lbl" for="if-name">Nama Interaksi</label>' +
    '<div class="field"><input id="if-name" type="text" maxlength="60" autocomplete="off" placeholder="Contoh: Kiri dan Kanan" value="' + esc(data.name) + '"></div></div>' +

    '<div class="fgrp" data-f="trg"><span class="lbl">Action Trigger</span>' +
    '<p class="hint">Centang satu atau lebih aksi yang dijalankan saat interaksi dipicu.</p>' +
    '<div class="trgs">' + TRIGGERS.map((t) => triggerBlockHTML(t, data)).join('') + '</div>' +
    keystrokeHintHTML() +
    '</div>' +

    '<div class="fgrp"><label class="lbl" for="if-vol">Volume Media</label>' +
    '<div class="rng"><input id="if-vol" type="range" min="0" max="100" step="1" value="' + data.volume + '"><output>' + data.volume + '%</output></div></div>' +

    '<div class="fgrp" data-f="duration"><label class="lbl" for="if-dur">Durasi Tampil Screen?</label>' +
    '<div class="field short"><input id="if-dur" type="number" inputmode="numeric" min="1" max="600" step="1" value="' + data.duration + '"><span class="unit">Detik</span></div></div>' +

    '<div class="fgrp" data-f="delay"><label class="lbl" for="if-delay">Delay Muncul</label>' +
    '<p class="hint">Interaksi akan ditunda beberapa detik sebelum ditampilkan di screen.</p>' +
    '<div class="field short"><input id="if-delay" type="number" inputmode="numeric" min="0" max="60" step="0.5" value="' + (data.delay || 0) + '"><span class="unit">Detik</span></div></div>' +

    '<div class="fgrp" data-f="ksdelay"><label class="lbl" for="if-ksdelay">Delay Keystroke</label>' +
    '<p class="hint">Jeda khusus sebelum tombol ditekan. Gunakan ini kalau perlu pindah ke jendela game setelah menekan Play.</p>' +
    '<div class="field short"><input id="if-ksdelay" type="number" inputmode="numeric" min="0" max="60" step="0.5" value="' + (data.keystrokeDelay === undefined ? (data.delay || 0) : data.keystrokeDelay) + '"><span class="unit">Detik</span></div></div>' +

    '<div class="fgrp"><label class="lbl" for="if-screen">Pilih Screen</label>' +
    '<p class="hint">Pilih di screen mana interaksi ini akan dijalankan?</p>' +
    '<div class="field sel"><select id="if-screen">' + screens + '</select></div></div>' +

    '<div class="fgrp">' +
    '<label class="chk"><input type="checkbox" id="if-rep"' + (data.repeatCombo ? ' checked' : '') + '><i></i><span class="t"><b>Ulangi Sebanyak Combo Gift</b></span></label>' +
    '<label class="chk"><input type="checkbox" id="if-fade"' + (data.fade ? ' checked' : '') + '><i></i><span class="t"><b>Animasi Transisi Fade In/Out</b><span>Hanya berlaku untuk Trigger Video dan Gambar.</span></span></label></div>';

  const m = openModal({
    title: existing ? 'Ubah Interaksi' : 'Tambah Interaksi',
    size: 'lg',
    dismissible: false,
    body,
    footer: '<button type="button" class="btn" data-close>Batal</button><button type="button" class="btn primary" data-save>' + icon('save') + 'Simpan</button>'
  });

  const offs = [bindRanges(m.el), bindChoices(m.el)];
  const refreshMedia = (kind) => {
    const el = m.$('[data-up="' + kind + '"] [data-info]');
    if (el) el.innerHTML = mediaInfoHTML(kind, data);
  };
  const refreshKeys = () => {
    const el = m.$('[data-info-keys]');
    if (el) el.innerHTML = keysInfoHTML(data);
  };
  ['image', 'video', 'audio'].forEach(refreshMedia);
  refreshKeys();

  m.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ks-admin]');
    if (!btn) return;
    const ok = await confirmDialog({
      title: 'Jalankan sebagai Administrator',
      message: 'JekInteract akan ditutup lalu dibuka ulang dengan izin Administrator. Windows akan menampilkan prompt UAC — klik Ya. Setelah itu keystroke bisa masuk ke Roblox yang dijalankan sebagai Administrator.',
      okText: 'Restart Admin',
      danger: false
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await API.restartAdmin();
      toast('Menunggu konfirmasi UAC…', 'info', 4000);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'err', 6000);
    }
  });

  const showError = (msg, selector) => {
    const box = m.$('#if-err');
    box.textContent = msg;
    box.hidden = false;
    m.$$('.err').forEach((x) => x.classList.remove('err'));
    const target = selector ? m.$(selector) : null;
    if (target) {
      target.classList.add('err');
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else box.scrollIntoView({ block: 'nearest' });
    toast(msg, 'err');
  };

  /* centang trigger */
  m.body.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-trg]');
    if (!cb) return;
    const blk = cb.closest('.trg');
    data.triggers[cb.dataset.trg] = cb.checked;
    blk.classList.toggle('on', cb.checked);
    blk.querySelector('.trg-b').hidden = !cb.checked;
    m.$('#if-err').hidden = true;
  });

  /* upload file */
  m.body.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) pick.closest('.up').querySelector('input[type="file"]').click();

    const clear = e.target.closest('[data-clear]');
    if (clear) {
      data.media[clear.dataset.clear] = null;
      refreshMedia(clear.dataset.clear);
    }

    if (e.target.closest('[data-pick-sound]')) {
      openAudioPicker((audio) => {
        data.media.audio = { name: audio.name, url: audio.url, source: audio.source || 'myinstants' };
        refreshMedia('audio');
      });
    }
    if (e.target.closest('[data-pick-keys]')) {
      openKeystrokes(data.keystrokes, (lines) => {
        data.keystrokes = lines;
        refreshKeys();
      });
    }
  });

  /* reload sources saat scene untuk obsSource berubah */
  m.body.addEventListener('change', async (e) => {
    const sel = e.target.closest('#if-srcscene');
    if (sel && Sync.obs && Sync.obs.status === 'online') {
      const sc = sel.value;
      try {
        const r = await API.obsSources(sc);
        if (r && r.sources && r.sources.length) {
          const sourceEl = m.$('#if-source');
          if (sourceEl) {
            const cur = sourceEl.value;
            sourceEl.innerHTML = r.sources.map((s) => '<option' + (s === cur ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
          }
        }
      } catch (_) {}
    }
  });

  m.body.addEventListener('change', async (e) => {
    const inp = e.target.closest('.up input[type="file"]');
    if (!inp || !inp.files || !inp.files[0]) return;
    const up = inp.closest('.up');
    const kind = up.dataset.up;
    const file = inp.files[0];
    inp.value = '';
    if (!file.type.startsWith(kind + '/')) return toast('Tipe file tidak sesuai. Pilih file ' + (kind === 'image' ? 'gambar' : kind === 'video' ? 'video' : 'audio') + '.', 'err');
    if (file.size > 300 * 1024 * 1024) return toast('File terlalu besar (maks 300 MB).', 'err');
    const info = up.querySelector('[data-info]');
    info.innerHTML = '<span class="muted">Mengunggah ' + esc(file.name) + ' <b data-pct>0%</b></span>';
    try {
      const r = await API.upload(file, (p) => {
        const el = info.querySelector('[data-pct]');
        if (el) el.textContent = Math.round(p * 100) + '%';
      });
      data.media[kind] = { url: r.url, name: file.name, size: file.size };
      toast('File berhasil diunggah.', 'ok', 2400);
    } catch (err) {
      toast('Upload gagal: ' + err.message, 'err');
    }
    if (!m.closed) refreshMedia(kind);
  });

  /* simpan */
  m.$('[data-save]').addEventListener('click', () => {
    data.name = m.$('#if-name').value.trim();
    data.volume = Number(m.$('#if-vol').value);
    data.duration = Math.round(Number(m.$('#if-dur').value));
    data.delay = Math.round(Number(m.$('#if-delay').value) * 10) / 10;
    data.keystrokeDelay = Math.round(Number(m.$('#if-ksdelay').value) * 10) / 10;
    data.screen = Number(m.$('#if-screen').value);
    data.repeatCombo = m.$('#if-rep').checked;
    data.fade = m.$('#if-fade').checked;
    data.obs.scene = m.$('#if-scene').value;
    const mode = m.$('input[name="scmode"]:checked');
    data.obs.mode = mode ? mode.value : 'revert';
    data.obs.srcScene = m.$('#if-srcscene').value;
    data.obs.source = m.$('#if-source').value;
    data.obs.srcOff = m.$('#if-srcoff').checked;

    const t = data.triggers;
    if (!data.name) return showError('Nama interaksi belum diisi.', '[data-f="name"] .field');
    if (!Object.values(t).some(Boolean)) return showError('Pilih minimal satu Action Trigger.', '[data-f="trg"]');
    if (t.image && !data.media.image) return showError('Trigger Gambar aktif, tapi gambar belum diunggah.', '[data-t="image"]');
    if (t.video && !data.media.video) return showError('Trigger Video aktif, tapi video belum diunggah.', '[data-t="video"]');
    if (t.audio && !data.media.audio) return showError('Trigger Audio aktif, tapi audio belum dipilih.', '[data-t="audio"]');
    if (t.keystroke && !data.keystrokes.length) return showError('Trigger Keystroke aktif, tapi belum ada keystroke.', '[data-t="keystroke"]');
    if (!(data.duration >= 1 && data.duration <= 600)) return showError('Durasi tampil harus 1 sampai 600 detik.', '[data-f="duration"] .field');
    if (!(data.delay >= 0 && data.delay <= 60)) return showError('Delay muncul harus 0 sampai 60 detik.', '[data-f="delay"] .field');
    if (!(data.keystrokeDelay >= 0 && data.keystrokeDelay <= 60)) return showError('Delay keystroke harus 0 sampai 60 detik.', '[data-f="ksdelay"] .field');

    offs.forEach((f) => f());
    onSave(data);
    m.close();
  });
}

/* ------------------------------------------------------------------ */
/* Modal: Pilih Audio (myinstants via /api/sounds)                     */
/* ------------------------------------------------------------------ */
let _apAudio = null; // HTMLAudioElement aktif

function stopApAudio() {
  if (_apAudio) { try { _apAudio.pause(); _apAudio.src = ''; } catch (_) {} _apAudio = null; }
}

function openAudioPicker(onApply) {
  let _page = 1;
  let _query = '';
  let _loading = false;
  let _totalPages = null;

  const m = openModal({
    title: 'Pilih Audio — Soundboard myinstants.com',
    size: 'lg',
    onClose: stopApAudio,
    body:
      '<div class="row" style="gap:.5rem">' +
      '<div class="field pre snd-q" style="flex:1"><i>' + icon('search') + '</i>' +
      '<input id="ap-q" type="search" autocomplete="off" spellcheck="false" placeholder="Cari suara (kosong = trending)" aria-label="Cari soundboard"></div>' +
      '<button type="button" class="btn" id="ap-search">' + icon('search') + 'Cari</button></div>' +
      '<div id="ap-info" class="hint" style="min-height:1.2em"></div>' +
      '<ul class="snd" id="ap-list"><li class="empty">' + icon('search') + '<b>Ketik kata kunci lalu tekan Cari</b><span>Atau biarkan kosong untuk memuat suara trending.</span></li></ul>' +
      '<div id="ap-pg" class="row" style="justify-content:center;gap:.5rem;margin-top:.5rem"></div>',
    footer: '<button type="button" class="btn" data-close>Tutup</button>'
  });

  const paintInfo = (source, page, total) => {
    const src = source === 'live' ? '' : source === 'cache' ? ' (cache)' : source === 'stale' ? ' (cache lama)' : '';
    m.$('#ap-info').textContent = 'Halaman ' + page + (total ? ' dari ' + total : '') + src;
  };

  const paintPager = (page, hasNext) => {
    const pg = m.$('#ap-pg');
    if (!pg) return;
    pg.innerHTML =
      (page > 1 ? '<button type="button" class="btn sm ghost" data-pg="' + (page - 1) + '">' + icon('chevLeft') + 'Sebelumnya</button>' : '') +
      (hasNext ? '<button type="button" class="btn sm ghost" data-pg="' + (page + 1) + '">' + 'Berikutnya' + icon('chevRight') + '</button>' : '');
  };

  const load = async (q, page) => {
    if (_loading) return;
    _loading = true;
    stopApAudio();
    const list = m.$('#ap-list');
    if (list) list.innerHTML = '<li class="empty">' + icon('loader') + '<b>Memuat suara…</b></li>';
    const pg = m.$('#ap-pg');
    if (pg) pg.innerHTML = '';
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (q) params.set('q', q);
      const r = await fetch('/api/sounds?' + params.toString());
      const data = await r.json();
      if (m.closed) return;
      if (!data.ok) throw new Error(data.error || 'Gagal memuat');
      const sounds = data.sounds || [];
      _page = data.page || page;
      _totalPages = data.total_pages || null;
      paintInfo(data.source, _page, _totalPages);
      paintPager(_page, !!data.has_next);
      const listNow = m.$('#ap-list');
      if (!listNow) return;
      listNow.innerHTML = sounds.length
        ? sounds.map((s) =>
            '<li class="snd-i" data-snd-id="' + esc(s.id || '') + '">' +
            '<span class="snd-n">' + esc(s.title || s.id || '—') + '</span>' +
            '<button type="button" class="btn sm" data-play-url="' + esc(s.mp3 || '') + '" data-play-title="' + esc(s.title || '') + '" title="Preview" aria-label="Preview ' + esc(s.title || '') + '">' + icon('play') + 'Play</button>' +
            '<button type="button" class="btn sm primary" data-apply-url="' + esc(s.mp3 || '') + '" data-apply-name="' + esc(s.title || s.id || '') + '">Terapkan</button></li>'
          ).join('')
        : '<li class="empty">' + icon('search') + '<b>Suara tidak ditemukan</b></li>';
    } catch (e) {
      if (m.closed) return;
      const listNow = m.$('#ap-list');
      if (listNow) listNow.innerHTML = '<li class="empty">' + icon('wifiOff') + '<b>Gagal memuat</b><span>' + esc(e.message) + '</span></li>';
    } finally {
      _loading = false;
    }
  };

  const doSearch = () => {
    _query = m.$('#ap-q').value.trim();
    load(_query, 1);
  };

  let _searchTimer = null;
  m.$('#ap-q').addEventListener('input', (e) => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      _query = e.target.value.trim();
      load(_query, 1);
    }, 600);
  });
  m.$('#ap-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(_searchTimer); doSearch(); }
  });
  m.$('#ap-search').addEventListener('click', () => { clearTimeout(_searchTimer); doSearch(); });

  // Auto-load trending saat picker pertama kali dibuka
  load('', 1);

  m.$('#ap-list').addEventListener('click', (e) => {
    const play = e.target.closest('[data-play-url]');
    if (play) {
      const url = play.dataset.playUrl;
      if (!url) return;
      stopApAudio();
      // toggle: jika tombol ini sudah aktif, hentikan saja
      if (play.classList.contains('playing')) {
        play.classList.remove('playing');
        play.innerHTML = icon('play') + 'Play';
        return;
      }
      // tandai tombol aktif
      m.$$('[data-play-url].playing').forEach((b) => { b.classList.remove('playing'); b.innerHTML = icon('play') + 'Play'; });
      play.classList.add('playing');
      play.innerHTML = icon('stop') + 'Stop';
      _apAudio = new Audio(url);
      _apAudio.volume = 1;
      _apAudio.play().catch(() => {});
      _apAudio.addEventListener('ended', () => {
        if (!m.closed) { play.classList.remove('playing'); play.innerHTML = icon('play') + 'Play'; }
        _apAudio = null;
      });
      return;
    }
    const apply = e.target.closest('[data-apply-url]');
    if (apply) {
      stopApAudio();
      const url  = apply.dataset.applyUrl;
      const name = apply.dataset.applyName || url;
      onApply({ name, url, source: 'myinstants' });
      toast('Audio dipilih: ' + name, 'ok', 2400);
      m.close();
    }
  });

  m.$('#ap-pg').addEventListener('click', (e) => {
    const pg = e.target.closest('[data-pg]');
    if (pg) load(_query, parseInt(pg.dataset.pg, 10));
  });
}

/* ------------------------------------------------------------------ */
/* Modal: Keystroke / Hotkey (keyboard virtual lengkap)                */
/* ------------------------------------------------------------------ */
const MODS = ['CTRL', 'SHIFT', 'ALT', 'WIN'];
const KEYSETS = {
  huruf: { label: 'Huruf', keys: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((k) => [k]).concat([['SPACE'], ['ENTER'], ['TAB'], ['ESC'], ['BACKSPACE', 'BKSP']]) },
  angka: { label: 'Angka', keys: [...'1234567890'].map((k) => [k]).concat([['-'], ['='], ['['], [']'], ['\\'], [';'], ["'"], [','], ['.'], ['/'], ['`']]) },
  fungsi: { label: 'F1-F12', keys: Array.from({ length: 12 }, (_, i) => ['F' + (i + 1)]) },
  navigasi: {
    label: 'Navigasi',
    keys: [['UP', '↑'], ['DOWN', '↓'], ['LEFT', '←'], ['RIGHT', '→'], ['HOME'], ['END'], ['PAGEUP', 'PG UP'], ['PAGEDOWN', 'PG DN'], ['INSERT', 'INS'], ['DELETE', 'DEL'], ['PRINTSCREEN', 'PRTSC'], ['PAUSE'], ['CAPSLOCK', 'CAPS']]
  },
  numpad: {
    label: 'Numpad',
    keys: [...'0123456789'].map((k) => ['NUM' + k, 'NUM ' + k]).concat([['NUMADD', 'NUM +'], ['NUMSUB', 'NUM -'], ['NUMMUL', 'NUM ×'], ['NUMDIV', 'NUM ÷'], ['NUMDOT', 'NUM .'], ['NUMENTER', 'NUM ENT']])
  },
  media: { label: 'Media', keys: [['VOLUMEUP', 'VOL +'], ['VOLUMEDOWN', 'VOL -'], ['MUTE'], ['PLAYPAUSE', 'PLAY'], ['NEXTTRACK', 'NEXT'], ['PREVTRACK', 'PREV']] }
};

const CODE_MAP = {
  Space: 'SPACE', Enter: 'ENTER', Backspace: 'BACKSPACE', Delete: 'DELETE', Insert: 'INSERT', Home: 'HOME', End: 'END',
  PageUp: 'PAGEUP', PageDown: 'PAGEDOWN', ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  NumpadAdd: 'NUMADD', NumpadSubtract: 'NUMSUB', NumpadMultiply: 'NUMMUL', NumpadDivide: 'NUMDIV', NumpadDecimal: 'NUMDOT',
  NumpadEnter: 'NUMENTER', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', PrintScreen: 'PRINTSCREEN', Pause: 'PAUSE', CapsLock: 'CAPSLOCK'
};

function tokenFromEvent(e) {
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Numpad\d$/.test(c)) return 'NUM' + c.slice(6);
  if (/^F\d{1,2}$/.test(c)) return c;
  return CODE_MAP[c] || '';
}

const normLine = (s) => s.replace(/\+/g, ' ').trim().replace(/\s+/g, ' ').toUpperCase();

function openKeystrokes(initial, onSave) {
  let lines = initial.slice();
  const mods = new Set();
  let tab = 'huruf';

  const m = openModal({
    title: 'Pilih Keystroke/Hotkey',
    size: 'lg',
    dismissible: false,
    body:
      '<p class="dim">Masukkan tombol, huruf atau angka kombinasi yang ingin disimulasikan ke keyboard.</p>' +
      '<div class="kb">' +
      '<div class="kb-mods" role="group" aria-label="Tombol pengubah">' + MODS.map((k) => '<button type="button" class="key mod" data-mod="' + k + '" aria-pressed="false">' + k + '</button>').join('') + '</div>' +
      '<div class="kb-pend" id="kb-pend"></div>' +
      '<div class="seg kb-tabs" role="tablist" aria-label="Kelompok tombol">' +
      Object.keys(KEYSETS).map((k) => '<button type="button" role="tab" data-tab="' + k + '" class="' + (k === tab ? 'on' : '') + '">' + KEYSETS[k].label + '</button>').join('') + '</div>' +
      '<div class="kb-keys" id="kb-keys"></div></div>' +
      '<div class="fgrp"><label class="lbl" for="kb-text">Daftar keystroke</label>' +
      '<div class="field area"><textarea id="kb-text" rows="5" spellcheck="false" autocapitalize="characters" autocomplete="off" placeholder="CTRL W&#10;SHIFT U"></textarea></div>' +
      '<p class="hint">Pisahkan tiap tombol dengan spasi. 1 baris = 1 keystroke. Contoh: &quot;CTRL W&quot;, &quot;SHIFT U&quot;.</p>' +
      '<div class="row"><button type="button" class="btn sm ghost" data-undo>' + icon('backspace') + 'Hapus baris terakhir</button>' +
      '<button type="button" class="btn sm ghost" data-wipe>' + icon('trash') + 'Bersihkan</button></div></div>',
    footer: '<button type="button" class="btn" data-close>Batal</button><button type="button" class="btn primary" data-save>' + icon('save') + 'Simpan</button>'
  });

  const ta = m.$('#kb-text');
  const writeText = () => {
    ta.value = lines.join('\n');
    ta.scrollTop = ta.scrollHeight;
  };
  const paintPending = () => {
    const ordered = MODS.filter((k) => mods.has(k));
    m.$$('[data-mod]').forEach((b) => {
      const on = mods.has(b.dataset.mod);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    m.$('#kb-pend').innerHTML = ordered.length
      ? '<span class="muted">Kombinasi:</span> ' + ordered.map((k) => '<span class="chip c-key">' + k + '</span>').join('<span class="muted">+</span>') +
        '<span class="muted">+ tekan tombol</span> <button type="button" class="btn sm" data-addmods>Tambah ke daftar</button>'
      : '<span class="muted">Tekan tombol langsung, atau aktifkan CTRL / SHIFT / ALT / WIN dulu untuk kombinasi.</span>';
  };
  const paintKeys = () => {
    m.$('#kb-keys').innerHTML = KEYSETS[tab].keys
      .map(([k, label]) => '<button type="button" class="key' + (k.length > 3 || (label && label.length > 3) ? ' wide' : '') + '" data-k="' + esc(k) + '" aria-label="' + esc(k) + '">' + esc(label || k) + '</button>')
      .join('');
  };
  const commit = (key) => {
    const line = MODS.filter((k) => mods.has(k)).concat(key ? [key] : []).join(' ');
    if (!line) return;
    lines.push(line);
    mods.clear();
    writeText();
    paintPending();
  };

  m.body.addEventListener('click', (e) => {
    const mod = e.target.closest('[data-mod]');
    if (mod) {
      const k = mod.dataset.mod;
      if (mods.has(k)) mods.delete(k);
      else mods.add(k);
      return paintPending();
    }
    const t = e.target.closest('[data-tab]');
    if (t) {
      tab = t.dataset.tab;
      m.$$('[data-tab]').forEach((b) => b.classList.toggle('on', b === t));
      return paintKeys();
    }
    const key = e.target.closest('[data-k]');
    if (key) return commit(key.dataset.k);
    if (e.target.closest('[data-addmods]')) return commit('');
    if (e.target.closest('[data-undo]')) {
      lines.pop();
      return writeText();
    }
    if (e.target.closest('[data-wipe]')) {
      lines = [];
      mods.clear();
      writeText();
      paintPending();
    }
  });

  ta.addEventListener('input', () => {
    lines = ta.value.split('\n').map(normLine).filter(Boolean);
  });

  // keyboard fisik (di PC): tekan kombinasi langsung
  m.card.addEventListener('keydown', (e) => {
    if (e.target === ta) return;
    if (['Control', 'Shift', 'Alt', 'Meta', 'Tab', 'Escape'].includes(e.key)) return;
    const token = tokenFromEvent(e);
    if (!token) return;
    e.preventDefault();
    const parts = [];
    if (e.ctrlKey) parts.push('CTRL');
    if (e.shiftKey) parts.push('SHIFT');
    if (e.altKey) parts.push('ALT');
    if (e.metaKey) parts.push('WIN');
    lines.push(parts.concat(token).join(' '));
    writeText();
  });

  m.$('[data-save]').addEventListener('click', () => {
    lines = ta.value.split('\n').map(normLine).filter(Boolean);
    onSave(lines);
    m.close();
  });

  paintKeys();
  paintPending();
  writeText();
}

/* ------------------------------------------------------------------ */
/* Modal: Tambah / ubah aktivitas                                      */
/* ------------------------------------------------------------------ */
function openActivityForm(existing, onSave) {
  const data = existing ? clone(existing) : blankActivity();
  const ints = loadInts();
  if (!data.action.id && ints.length) data.action.id = ints[0].id;

  const whoOpts = WHO_ACT.map(([v, l]) => '<option value="' + v + '"' + (data.who === v ? ' selected' : '') + '>' + l + '</option>').join('');
  const whenOpts = Object.keys(WHEN_LABEL).map((v) => '<option value="' + v + '"' + (data.when.type === v ? ' selected' : '') + '>' + WHEN_LABEL[v] + '</option>').join('');
  const actOpts =
    ints.map((i) => '<option value="' + esc(i.id) + '"' + (data.action.mode === 'single' && data.action.id === i.id ? ' selected' : '') + '>' + esc(i.name) + '</option>').join('') +
    '<option value="__random"' + (data.action.mode === 'random' ? ' selected' : '') + '>Picu salah satu aksi secara acak</option>';
  const randomList = ints
    .map((i) => '<label class="chk"><input type="checkbox" data-rnd="' + esc(i.id) + '"' + ((data.action.ids || []).includes(i.id) ? ' checked' : '') + '><i></i><span class="t"><b>' + esc(i.name) + '</b></span></label>')
    .join('');

  const m = openModal({
    title: existing ? 'Ubah Aktivitas' : 'Tambah Aktivitas',
    dismissible: false,
    body:
      '<div class="form-err" id="af-err" role="alert" hidden></div>' +
      '<div class="fgrp"><label class="lbl" for="af-who">Siapa yang bisa menggunakan ini?</label><div class="field sel"><select id="af-who">' + whoOpts + '</select></div></div>' +

      '<div class="fgrp" data-f="when"><label class="lbl" for="af-when">Ketika apa ini dijalankan?</label><div class="field sel"><select id="af-when">' + whenOpts + '</select></div>' +
      '<div class="when-x" data-x="comment_exact" hidden><label class="lbl" for="af-text">Isi komentar yang memicu</label>' +
      '<div class="field"><input id="af-text" type="text" maxlength="120" autocomplete="off" placeholder="Contoh: gas" value="' + esc(data.when.text) + '"></div></div>' +
      '<div class="when-x" data-x="gift_min" hidden><label class="lbl" for="af-coins">Minimal coin</label>' +
      '<div class="field short"><input id="af-coins" type="number" inputmode="numeric" min="1" step="1" value="' + data.when.coins + '"><span class="unit">Coin</span></div></div>' +
      '<div class="when-x" data-x="like_min" hidden><label class="lbl" for="af-likes">Minimal jumlah like</label>' +
      '<div class="field short"><input id="af-likes" type="number" inputmode="numeric" min="1" step="1" value="' + data.when.likes + '"><span class="unit">Like</span></div></div>' +
      '<div class="when-x" data-x="gift_specific" hidden><span class="lbl">Pilih gift</span>' +
      '<div class="field pre"><i>' + icon('search') + '</i><input id="gp-q" type="search" autocomplete="off" spellcheck="false" placeholder="Cari nama gift" aria-label="Cari gift"></div>' +
      '<div class="gp" id="gp-list"></div><p class="hint" id="gp-sel"></p></div></div>' +

      '<div class="fgrp" data-f="action"><label class="lbl" for="af-action">Akan memicu aksi apa?</label><div class="field sel"><select id="af-action">' + actOpts + '</select></div>' +
      '<div id="af-int-preview"></div>' +
      '<div class="when-x" id="af-rnd" hidden>' +
      '<p class="hint">Pilih satu atau lebih interaksi. Setiap kali dipicu, salah satunya dijalankan secara acak.</p>' +
      '<div id="af-rnd-badge" class="hint"></div>' +
      randomList + '</div></div>',
    footer: '<button type="button" class="btn" data-close>Batal</button><button type="button" class="btn primary" data-save>' + icon('save') + 'Simpan</button>'
  });

  /* Preview kartu interaksi yang dipilih */
  const paintIntPreview = () => {
    const preview = m.$('#af-int-preview');
    if (!preview) return;
    const sel = m.$('#af-action').value;
    if (sel === '__random') { preview.innerHTML = ''; return; }
    const it = ints.find((i) => i.id === sel);
    if (!it) { preview.innerHTML = ''; return; }
    const kinds = TRIGGERS.filter((t) => it.triggers[t.k]).map((t) => t.short).join(', ') || 'belum dipilih';
    const p = TRIGGERS.find((t) => it.triggers[t.k]);
    preview.innerHTML =
      '<div class="act-preview">' +
      '<span class="act-preview-ico ' + (p ? p.cls : '') + '">' + icon(p ? p.ic : 'bolt') + '</span>' +
      '<span class="act-preview-txt"><b>' + esc(it.name) + '</b>' +
      '<small>Screen ' + it.screen + ' • ' + it.duration + ' detik • ' + esc(kinds) + '</small></span>' +
      '</div>';
  };

  /* Badge jumlah interaksi terpilih di random mode */
  const paintRndBadge = () => {
    const badge = m.$('#af-rnd-badge');
    if (!badge) return;
    const n = m.$$('[data-rnd]:checked').length;
    badge.textContent = n === 0 ? 'Belum ada interaksi dipilih.' : n + ' interaksi dipilih dari ' + ints.length + ' tersedia.';
  };

  const showWhenExtra = () => {
    const type = m.$('#af-when').value;
    m.$$('[data-x]').forEach((x) => (x.hidden = x.dataset.x !== type));
  };
  const showRandom = () => {
    const isRnd = m.$('#af-action').value === '__random';
    m.$('#af-rnd').hidden = !isRnd;
    paintIntPreview();
    if (isRnd) paintRndBadge();
  };
  let _gifts = [];

  const paintGifts = () => {
    const q = m.$('#gp-q').value.trim().toLowerCase();
    const list = _gifts.filter((g) => !q || g.name.toLowerCase().includes(q));
    const selList = m.$('#gp-list');
    if (!selList) return;
    selList.innerHTML = list.length
      ? list.map((g) => giftPickerHTML(g, data.when.gift, esc, icon, fmt)).join('')
      : '<div class="empty">' + icon('search') + '<b>Gift tidak ditemukan</b></div>';
    const selTxt = m.$('#gp-sel');
    if (selTxt) selTxt.textContent = data.when.gift ? 'Gift dipilih: ' + data.when.gift : 'Belum ada gift dipilih.';
  };

  // Muat gift dari API (fallback ke demo otomatis di loadGifts)
  const initGifts = async () => {
    const selList = m.$('#gp-list');
    if (selList) selList.innerHTML = '<div class="empty">' + icon('loader') + '<b>Memuat daftar gift…</b></div>';
    _gifts = await loadGifts();
    paintGifts();
  };

  m.$('#af-when').addEventListener('change', showWhenExtra);
  m.$('#af-action').addEventListener('change', showRandom);
  /* update badge saat checklist random berubah */
  m.$('#af-rnd').addEventListener('change', (e) => {
    if (e.target.closest('[data-rnd]')) paintRndBadge();
  });
  m.$('#gp-q').addEventListener('input', paintGifts);
  m.$('#gp-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-gift]');
    if (!b) return;
    data.when.gift = b.dataset.gift;
    paintGifts();
  });
  showWhenExtra();
  showRandom();
  initGifts();

  const fail = (msg, sel) => {
    const box = m.$('#af-err');
    box.textContent = msg;
    box.hidden = false;
    const t = sel ? m.$(sel) : null;
    if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast(msg, 'err');
  };

  m.$('[data-save]').addEventListener('click', () => {
    data.who = m.$('#af-who').value;
    data.when.type = m.$('#af-when').value;
    data.when.text = m.$('#af-text').value.trim();
    data.when.coins = Math.round(Number(m.$('#af-coins').value));
    data.when.likes = Math.round(Number(m.$('#af-likes').value));
    const sel = m.$('#af-action').value;
    if (sel === '__random') {
      data.action.mode = 'random';
      data.action.ids = m.$$('[data-rnd]').filter((c) => c.checked).map((c) => c.dataset.rnd);
    } else {
      data.action.mode = 'single';
      data.action.id = sel;
    }

    const w = data.when;
    if (w.type === 'comment_exact' && !w.text) return fail('Isi komentar yang memicu belum diisi.', '[data-x="comment_exact"]');
    if (w.type === 'gift_min' && !(w.coins >= 1)) return fail('Minimal coin harus 1 atau lebih.', '[data-x="gift_min"]');
    if (w.type === 'like_min' && !(w.likes >= 1)) return fail('Minimal jumlah like harus 1 atau lebih.', '[data-x="like_min"]');
    if (w.type === 'gift_specific' && !w.gift) return fail('Pilih gift yang memicu aktivitas ini.', '[data-x="gift_specific"]');
    if (data.action.mode === 'random' && data.action.ids.length < 2) return fail('Pilih minimal 2 interaksi untuk dipicu secara acak.', '#af-rnd');

    onSave(data);
    m.close();
  });
}
