/* Overlay Join Alert — kartu muncul sebentar saat ada viewer join.
 * Event 'joinalert' dikirim server (filter sudah diterapkan di server), dan
 * juga dipakai oleh tombol Tes Alert di dashboard. Alert diputar berurutan
 * lewat antrian FIFO: tidak ada yang saling ngeskip. Di luar kartu, kanvas
 * tetap transparan supaya aman dipakai sebagai Browser Source OBS. */
import { avatarURL } from '../lib/avatar.js';

const DEFAULT_SHOW_MS = 5000;
const OUT_MS = 420;

export default function mount(ctx) {
  const { root, Sync } = ctx;

  root.innerHTML =
    '<div class="ja">' +
    '<div class="ja-card cut" id="ja-card">' +
    '<img class="ja-av av" id="ja-av" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="76" height="76" alt="" draggable="false">' +
    '<div class="ja-body">' +
    '<span class="ja-kicker"><i></i>BARU BERGABUNG</span>' +
    '<b class="ja-name" id="ja-name"></b>' +
    '<span class="ja-sub" id="ja-sub">Selamat datang di live!</span>' +
    '</div>' +
    '<i class="ja-glitch" aria-hidden="true"></i>' +
    '</div></div>' +
    '<audio id="ja-audio" preload="auto"></audio>';

  const card = root.querySelector('#ja-card');
  const nameEl = root.querySelector('#ja-name');
  const subEl = root.querySelector('#ja-sub');
  const img = root.querySelector('#ja-av');
  const audio = root.querySelector('#ja-audio');

  const queue = [];
  let active = false;
  let hideTimer = null;
  let outTimer = null;

  function playSound(d) {
    // Suara diputar dari overlay asli (Browser Source OBS). Preview tidak
    // menyuarakan supaya tidak dobel dengan pemutar global di dashboard.
    try {
      audio.pause();
      audio.currentTime = 0;
      if (d.sound && d.sound.url) {
        audio.src = d.sound.url;
        const v = Number(d.volume);
        audio.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 1;
        audio.play().catch(() => {});
      } else {
        audio.removeAttribute('src');
      }
    } catch (_) {}
  }

  function show(d, done) {
    const raw = String(d.name || d.nickname || d.username || 'viewer').trim().slice(0, 60) || 'viewer';
    const name = raw.charAt(0) === '@' ? raw : '@' + raw;
    const fallback = avatarURL(name);
    const src = String(d.avatar || '').trim();

    nameEl.textContent = name;
    subEl.textContent = d.test ? 'Tes tampilan alert' : 'Selamat datang di live!';
    img.onerror = () => {
      img.onerror = null;
      img.src = fallback;
    };
    img.src = src || fallback;
    if (!ctx.preview) playSound(d);

    card.classList.remove('show', 'out');
    void card.offsetWidth; // restart animasi untuk tiap item antrian
    card.classList.add('show');

    const ms = Number(d && d.durationMs);
    const duration = Number.isFinite(ms) && ms > 0
      ? Math.min(60000, Math.max(500, ms))
      : DEFAULT_SHOW_MS;

    hideTimer = setTimeout(() => {
      card.classList.remove('show');
      card.classList.add('out');
      outTimer = setTimeout(() => {
        card.classList.remove('out');
        done();
      }, OUT_MS);
    }, duration);
  }

  // Antrian FIFO: satu alert selesai (termasuk fade out) baru lanjut ke berikutnya.
  function pump() {
    if (active) return;
    const next = queue.shift();
    if (!next) return;
    active = true;
    clearTimeout(hideTimer);
    clearTimeout(outTimer);
    show(next, () => {
      active = false;
      pump();
    });
  }

  Sync.on('joinalert', (d) => {
    if (!d || typeof d !== 'object') return;
    queue.push(d);
    pump();
  });
}
