/* Screen overlay: menampilkan gambar / video di screen.
 * Video: play bersuara langsung setelah ada gesture pertama di halaman.
 *        Saat dibuka, overlay menampilkan banner "Tap untuk mulai" yang hilang
 *        setelah satu kali tap — setelah itu semua video trigger langsung play bersuara.
 * Audio trigger: diputar terpisah dari dashboard (app.js startAudioListener). */
import { esc } from '../lib/dom.js';

export default function mount(ctx) {
  const { root, Sync, arg } = ctx;
  root.innerHTML = '<div class="scr" id="scr"></div>';
  const scr = root.querySelector('#scr');
  let current = null;

  const rlog = (msg, warn) => {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: 'screen' + arg, msg, warn: !!warn })
    }).catch(() => {});
  };

  /* ------------------------------------------------------------------
   * Gesture unlock — Chrome Android butuh satu kali tap sebelum bisa
   * autoplay video bersuara. Banner muncul saat overlay pertama dibuka,
   * hilang setelah ditap. Setelah itu semua video langsung play bersuara.
   * ------------------------------------------------------------------ */
  let _gestured = false;
  let _pendingVideo = null; // { v, vol } — video menunggu gesture

  const _onGesture = () => {
    if (_gestured) return;
    _gestured = true;
    hideBanner();
    rlog('gesture unlocked');
    if (_pendingVideo) {
      const { v, vol } = _pendingVideo;
      _pendingVideo = null;
      v.muted = false;
      v.volume = vol;
      // Kalau video masih paused, play ulang. Kalau sudah muted-play, unmute langsung.
      if (v.paused) {
        v.play().then(() => rlog('video play OK (after gesture)')).catch((e) => rlog('video play FAILED after gesture: ' + e.message, true));
      } else {
        rlog('video unmuted after gesture');
      }
    }
  };

  // Banner fullscreen tipis — tap di mana saja untuk unlock
  let _banner = null;
  const showBanner = () => {
    if (_banner) return;
    _banner = document.createElement('div');
    _banner.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:pointer;background:rgba(0,0,0,.01)';
    const lbl = document.createElement('div');
    lbl.style.cssText = [
      'position:absolute;bottom:12px;left:50%;transform:translateX(-50%)',
      'padding:6px 16px;border-radius:6px',
      'background:rgba(0,0,0,.7);color:#fff;white-space:nowrap',
      'font:700 14px sans-serif;pointer-events:none'
    ].join(';');
    lbl.textContent = '▶ Tap untuk mulai';
    _banner.appendChild(lbl);
    _banner.addEventListener('click', _onGesture, { once: true });
    _banner.addEventListener('touchend', _onGesture, { once: true });
    document.body.appendChild(_banner);
  };
  const hideBanner = () => {
    if (_banner) { _banner.remove(); _banner = null; }
  };

  // Tampilkan banner segera saat overlay dibuka
  showBanner();
  // Kalau user sudah tap di halaman sebelum banner muncul (buka via tap link), langsung unlock
  document.addEventListener('click', _onGesture, { once: true });
  document.addEventListener('touchend', _onGesture, { once: true });

  /* ------------------------------------------------------------------ */
  function killCard(c) {
    c.nodes.forEach((n) => n.remove());
  }

  function dispose(c, immediate) {
    if (c.killTimer) clearTimeout(c.killTimer);
    if (c.fade && !immediate) {
      c.nodes.forEach((n) => {
        const media = n.querySelector ? n.querySelector('.scr-media') : null;
        if (media) {
          media.style.transition = 'opacity 1.2s ease';
          media.style.opacity = '0';
        }
      });
      c.killTimer = setTimeout(() => killCard(c), 1300);
    } else {
      killCard(c);
    }
  }

  function stop(immediate) {
    if (!current) return;
    rlog('stop uid=' + current.uid + ' immediate=' + immediate);
    const c = current;
    current = null;
    _pendingVideo = null;
    dispose(c, immediate);
  }

  function start(item) {
    const m = item.media || {};
    rlog('start uid=' + item.uid + ' name="' + item.name + '"' +
        ' video=' + (m.video || 'null') +
        ' image=' + (m.image || 'null'));

    const card = document.createElement('div');
    card.className = 'scr-card';
    const c = { uid: item.uid, nodes: [card], fade: !!item.fade };

    if (m.video) {
      const vol = Math.min(1, Math.max(0, (item.volume == null ? 100 : item.volume) / 100));
      const v = document.createElement('video');
      v.playsInline = true;
      v.volume = vol;
      v.className = 'scr-media';
      if (item.fade) {
        v.style.opacity = '0';
        let fadedIn = false;
        const doFadeIn = () => {
          if (fadedIn) return;
          fadedIn = true;
          v.style.transition = 'opacity 1.2s ease';
          v.style.opacity = '1';
        };
        v.addEventListener('loadeddata', () => {
          requestAnimationFrame(() => requestAnimationFrame(doFadeIn));
        }, { once: true });
        setTimeout(doFadeIn, 1000);
      }
      v.src = m.video;
      card.appendChild(v);
      scr.appendChild(card);
      if (item.fade) void v.offsetWidth;

      if (_gestured) {
        // Sudah ada gesture — langsung play bersuara
        v.play().then(() => rlog('video play OK')).catch((e) => rlog('video play FAILED: ' + e.message, true));
      } else {
        // Belum ada gesture — muted dulu agar tidak stuck, unmute setelah tap
        v.muted = true;
        v.play().then(() => {
          rlog('video play muted, waiting for gesture');
          _pendingVideo = { v, vol };
        }).catch((e) => {
          rlog('video muted FAILED: ' + e.message, true);
        });
      }

      v.addEventListener('stalled', () => rlog('video stalled', true));
      v.addEventListener('error', () => {
        const e = v.error;
        rlog('video error code=' + (e ? e.code : '?') + ' msg=' + (e ? e.message : '?'), true);
      });
    } else if (m.image) {
      const im = new Image();
      im.className = 'scr-media';
      im.alt = '';
      if (item.fade) {
        im.style.opacity = '0';
        let fadedIn = false;
        const doFadeIn = () => {
          if (fadedIn) return;
          fadedIn = true;
          im.style.transition = 'opacity 1.2s ease';
          im.style.opacity = '1';
        };
        im.addEventListener('load', () => {
          requestAnimationFrame(() => requestAnimationFrame(doFadeIn));
        }, { once: true });
        setTimeout(doFadeIn, 1000);
      }
      im.src = m.image;
      card.appendChild(im);
      scr.appendChild(card);
      if (item.fade) void im.offsetWidth;
    } else {
      if (item.test) {
        card.innerHTML = '<div class="scr-test cut"><span>Tes interaksi</span><b>' + esc(item.name) + '</b></div>';
      }
      scr.appendChild(card);
    }

    current = c;
  }

  Sync.on('play', ({ screen, item }) => {
    const match = String(screen) === String(Number(arg));
    rlog('SSE play screen=' + screen + ' arg=' + arg + ' match=' + match);
    if (!match) return;
    stop(true);
    start(item);
  });
  Sync.on('stop', ({ uid }) => {
    if (current && current.uid === uid) stop(false);
  });
  Sync.on('clear', () => stop(true));

  rlog('mounted arg=' + arg);
}
