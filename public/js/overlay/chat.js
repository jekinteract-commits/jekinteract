/* Overlay Komen — komentar demo bermunculan dari bawah.
 * Bila TikTok sudah terhubung, gunakan komentar live; bila belum, pakai demo. */
import { USERS, CHAT_LINES, rolesOf, pick, rand } from '../lib/demo.js';
import { avatar, avatarURL } from '../lib/avatar.js';
import { esc } from '../lib/dom.js';

export default function mount(ctx) {
  const { root, Sync } = ctx;
  root.innerHTML = '<div class="chat-wrap" id="c-wrap"><div class="chat-list" id="c-list"></div></div>';
  const wrap = root.querySelector('#c-wrap');
  const list = root.querySelector('#c-list');
  const who = () => Sync.get('chatCfg', {}).who || 'all';
  let emptyShown = false;
  let liveMode = false;
  let demoTimer = null;

  /* -------- Helpers -------- */
  function addMsg(nickname, text, avatarSrc) {
    if (emptyShown) {
      list.innerHTML = '';
      emptyShown = false;
    }
    const el = document.createElement('div');
    el.className = 'chat-msg cut in';
    const imgSrc = avatarSrc || avatarURL(nickname);
    el.innerHTML =
      '<img class="av chat-av" src="' + esc(imgSrc) + '" width="46" height="46" alt="" draggable="false" onerror="this.src=\'' + esc(avatarURL(nickname)) + '\'">' +
      '<div class="chat-txt"><b>' + esc(nickname) + '</b><p>' + esc(text) + '</p></div>';
    list.appendChild(el);

    // geser daftar agar komentar lama tidak "melompat" saat komentar baru masuk
    const h = el.offsetHeight + 10;
    list.style.transition = 'none';
    list.style.transform = 'translateY(' + h + 'px)';
    void list.offsetWidth;
    list.style.transition = 'transform .35s cubic-bezier(.2,.7,.2,1)';
    list.style.transform = 'translateY(0)';

    while (list.children.length > 1 && list.offsetHeight > wrap.clientHeight - 16) list.firstElementChild.remove();
  }

  /* -------- Demo mode -------- */
  function addDemo() {
    const w = who();
    const pool = USERS.filter((u) => w === 'all' || rolesOf(u).includes(w));
    if (!pool.length) {
      if (!emptyShown) {
        list.innerHTML = '<div class="chat-empty">Belum ada komentar dari kelompok ini</div>';
        emptyShown = true;
      }
      return;
    }
    const user = pick(pool);
    addMsg(user, pick(CHAT_LINES), null);
  }

  function startDemo() {
    stopDemo();
    liveMode = false;
    for (let i = 0; i < 3; i++) addDemo();
    const loop = () => {
      if (liveMode) return;
      addDemo();
      demoTimer = setTimeout(loop, rand(1100, 2800));
    };
    demoTimer = setTimeout(loop, 1400);
  }

  function stopDemo() {
    clearTimeout(demoTimer);
    demoTimer = null;
  }

  /* -------- Live mode -------- */
  function switchToLive() {
    stopDemo();
    liveMode = true;
    list.innerHTML = '';
    emptyShown = false;
  }

  function switchToDemo() {
    liveMode = false;
    list.innerHTML = '';
    emptyShown = false;
    startDemo();
  }

  /* -------- Init -------- */
  if (Sync.tiktok && Sync.tiktok.state === 'online') {
    switchToLive();
  } else {
    startDemo();
  }

  /* -------- Sync events -------- */
  // Terima komentar live dari TikTok
  Sync.on('tiktok', (ev) => {
    if (ev.event === 'chat' && liveMode) {
      const d = ev.data || {};
      const u = d.user || {};
      const nickname = String(u.nickname || u.uniqueId || u.id || ev.username || '').trim() || ev.username || 'viewer';
      const text = String(d.content || d.comment || '').trim();
      if (!text) return;
      const avatarSrc = (u.avatarThumb && Array.isArray(u.avatarThumb.urlList) && u.avatarThumb.urlList[0])
        ? u.avatarThumb.urlList[0]
        : null;

      // filter by who
      const w = who();
      if (w !== 'all') {
        const isFollower = !!(u.isFollower || (d.userIdentity && d.userIdentity.isFollowerOfAnchor));
        const isFriend = !!(u.isFriend || (d.userIdentity && d.userIdentity.isMutualFollowingWithAnchor));
        const isSubscriber = !!(u.isSubscriber || (d.userIdentity && d.userIdentity.isSubscriberOfAnchor));
        const isModerator = !!(u.isModerator || (u.userAttr && u.userAttr.isAdmin));
        if (w === 'follower' && !isFollower) return;
        if (w === 'friend' && !isFriend) return;
        if (w === 'subscriber' && !isSubscriber) return;
        if (w === 'moderator' && !isModerator) return;
      }

      addMsg(nickname, text, avatarSrc);
      return;
    }
    if (ev.state === 'online' || ev.event === 'connected') {
      if (!liveMode) switchToLive();
    } else if (ev.state === 'offline' || ev.event === 'disconnected') {
      if (liveMode) switchToDemo();
    }
  });

  // Fallback: saat SSE (re)connect, cek status TikTok via REST.
  // Menangani kasus hello datang terlambat (Cloudflare latency > timeout).
  Sync.on('online', (isOnline) => {
    if (!isOnline) return;
    fetch('/api/tiktok/status')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.state === 'online' && !liveMode) switchToLive();
        else if (d && d.state !== 'online' && liveMode) switchToDemo();
      })
      .catch(() => {});
  });

  // ganti filter: mulai ulang agar langsung terlihat efeknya
  Sync.on('state', (e) => {
    if (e.key !== 'chatCfg') return;
    list.innerHTML = '';
    emptyShown = false;
    if (!liveMode) {
      stopDemo();
      for (let i = 0; i < 3; i++) addDemo();
      const loop = () => {
        if (liveMode) return;
        addDemo();
        demoTimer = setTimeout(loop, rand(1100, 2800));
      };
      demoTimer = setTimeout(loop, 1400);
    }
  });
}
