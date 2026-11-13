import { $, $$, esc, disposer } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { Store, DEFAULTS } from '../lib/store.js';
import { WHO_FULL } from '../lib/demo.js';
import { toast, bindRanges } from '../lib/ui.js';
import { speak, stopSpeaking } from '../lib/tts.js';

const whoOptions = (sel) => WHO_FULL.map(([v, l]) => '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + l + '</option>').join('');

export default {
  id: 'tts',
  title: 'Baca Komentar',
  icon: 'volume',

  render() {
    const c = Object.assign({}, DEFAULTS.tts, Store.get('tts', {}));
    return (
      '<div class="ph"><h1>Baca Komentar Live (TikTok)</h1><p>Komentar TikTok live dibacakan otomatis — suara tetap berbunyi walau kamu pindah menu atau aplikasi lain.</p></div>' +
      '<div class="stack">' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Setingan</h2></div></div>' +
      '<div class="sw-row"><div class="t"><b>Enabled</b><span>Aktifkan pembacaan komentar.</span></div>' +
      '<label class="sw"><input type="checkbox" id="tt-on"' + (c.enabled ? ' checked' : '') + ' aria-label="Aktifkan baca komentar"><i></i></label></div>' +
      '<div class="tt-voice" id="tt-voice"><div class="g2">' +
      '<div class="fgrp"><label class="lbl" for="tt-lang">Bahasa</label><div class="field sel"><select id="tt-lang">' +
      '<option value="id"' + (c.lang === 'id' ? ' selected' : '') + '>Bahasa Indonesia</option>' +
      '<option value="en"' + (c.lang === 'en' ? ' selected' : '') + '>English</option></select></div></div>' +
      '<div class="fgrp"><span class="lbl" id="tt-glbl">Suara</span><div class="seg" id="tt-gender" role="group" aria-labelledby="tt-glbl">' +
      '<button type="button" data-g="male" class="' + (c.gender === 'male' ? 'on' : '') + '">Laki-laki</button>' +
      '<button type="button" data-g="female" class="' + (c.gender === 'female' ? 'on' : '') + '">Perempuan</button></div></div>' +
      '</div></div>' +
      '<div class="sw-row"><div class="t"><b>Random Voice</b><span>Jika aktif, pilihan bahasa dan suara di atas tidak berlaku.</span></div>' +
      '<label class="sw"><input type="checkbox" id="tt-rand"' + (c.random ? ' checked' : '') + ' aria-label="Random voice"><i></i></label></div>' +
      '<div class="g2 tt-nums">' +
      '<div class="fgrp"><label class="lbl" for="tt-speed">Speed</label><div class="field short"><input id="tt-speed" type="number" inputmode="numeric" min="1" max="100" step="1" value="' + c.speed + '"></div><p class="hint">Bawaan 50.</p></div>' +
      '<div class="fgrp"><label class="lbl" for="tt-vol">Volume</label><div class="rng"><input id="tt-vol" type="range" min="0" max="100" step="1" value="' + c.volume + '"><output>' + c.volume + '%</output></div></div>' +
      '</div>' +
      '<div class="row"><button type="button" class="btn primary" id="tt-save1">' + icon('save') + 'Simpan</button></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Siapa yang bisa menggunakan?</h2><div class="sub">Komentar dari kelompok ini yang akan dibacakan.</div></div></div>' +
      '<div class="fgrp"><label class="lbl" for="tt-who">Pembatasan</label><div class="field sel"><select id="tt-who">' + whoOptions(c.who) + '</select></div></div>' +
      '<div class="row"><button type="button" class="btn primary" id="tt-save2">' + icon('save') + 'Simpan</button></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Tester Suara</h2><div class="sub">Dengarkan suara sesuai setingan di atas.</div></div></div>' +
      '<div class="fgrp"><label class="lbl" for="tt-text">Teks uji</label><div class="field area"><textarea id="tt-text" rows="3" placeholder="Tulis kalimat untuk dites">Halo semuanya, selamat datang di live JekInteract!</textarea></div></div>' +
      '<div class="row"><button type="button" class="btn primary" id="tt-play">' + icon('play') + 'Play</button>' +
      '<button type="button" class="btn ghost" id="tt-stop">' + icon('x') + 'Berhenti</button></div>' +
      '</section>' +

      '<section class="panel">' +
      '<div class="fh"><div class="fh-t"><h2>Filter Kata</h2><div class="sub">Komentar yang mengandung kata, emote, atau simbol ini tidak dibacakan.</div></div></div>' +
      '<div class="fgrp"><label class="lbl" for="tt-filter">Kata, emote, atau simbol yang difilter</label>' +
      '<div class="field area"><textarea id="tt-filter" rows="3" placeholder="Contoh: kata1, kata2, 😡, #, !!!">' + esc(c.filter) + '</textarea></div>' +
      '<p class="hint">Pisahkan dengan tanda koma. Mendukung kata, emoji/emote, dan simbol.</p>' +
      '<div class="chips" id="tt-chips"></div></div>' +
      '<div class="row"><button type="button" class="btn primary" id="tt-save3">' + icon('save') + 'Simpan</button></div>' +
      '</section>' +
      '</div>'
    );
  },

  mount(root) {
    const d = disposer();
    d(bindRanges(root));

    const cur = () => Object.assign({}, DEFAULTS.tts, Store.get('tts', {}));
    const gender = () => ($('#tt-gender .on', root) || { dataset: { g: 'female' } }).dataset.g;
    const voiceCfg = () => ({
      lang: $('#tt-lang', root).value,
      gender: gender(),
      random: $('#tt-rand', root).checked,
      speed: Number($('#tt-speed', root).value),
      volume: Number($('#tt-vol', root).value)
    });

    // Random Voice menonaktifkan pilihan bahasa & suara
    const paintRandom = () => {
      const r = $('#tt-rand', root).checked;
      $('#tt-voice', root).classList.toggle('is-off', r);
      $$('#tt-voice select, #tt-voice button', root).forEach((el) => (el.disabled = r));
    };
    $('#tt-rand', root).addEventListener('change', paintRandom);
    paintRandom();

    $('#tt-gender', root).addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      $$('#tt-gender button', root).forEach((x) => x.classList.toggle('on', x === b));
    });

    $('#tt-save1', root).addEventListener('click', () => {
      const v = voiceCfg();
      if (!(v.speed >= 1 && v.speed <= 100)) {
        toast('Speed harus antara 1 sampai 100.', 'err');
        return $('#tt-speed', root).focus();
      }
      Store.set('tts', Object.assign(cur(), v, { enabled: $('#tt-on', root).checked, speed: Math.round(v.speed) }));
      toast('Setingan suara disimpan.', 'ok');
    });

    $('#tt-save2', root).addEventListener('click', () => {
      Store.set('tts', Object.assign(cur(), { who: $('#tt-who', root).value }));
      toast('Pembatasan pengguna disimpan.', 'ok');
    });

    // tester
    $('#tt-play', root).addEventListener('click', () => {
      const text = $('#tt-text', root).value.trim();
      if (!text) return toast('Isi teks uji dulu.', 'warn');
      speak(text, voiceCfg());
    });
    $('#tt-stop', root).addEventListener('click', () => stopSpeaking());

    // filter kata
    const words = () =>
      Array.from(new Set($('#tt-filter', root).value.split(',').map((w) => w.trim()).filter(Boolean)));
    const paintChips = () => {
      const w = words();
      $('#tt-chips', root).innerHTML = w.map((x) => '<span class="chip">' + esc(x) + '</span>').join('');
    };
    $('#tt-filter', root).addEventListener('input', paintChips);
    paintChips();
    $('#tt-save3', root).addEventListener('click', () => {
      Store.set('tts', Object.assign(cur(), { filter: words().join(', ') }));
      toast(words().length ? words().length + ' kata difilter dan disimpan.' : 'Filter kata dikosongkan.', 'ok');
    });

    return () => d.run();
  }
};
