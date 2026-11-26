/* Registry overlay: dipakai dashboard (link, preview, status) dan halaman overlay (ukuran kanvas). */
export const SCREEN_COUNT = 20;

export const OVERLAYS = {
  music: { id: 'music', label: 'YouTube Music', path: '/overlay/music', w: 640, h: 170 },
  subathon: { id: 'subathon', label: 'Subathon Timer', path: '/overlay/subathon', w: 600, h: 210 },
  winlose: { id: 'winlose', label: 'Win Lose Bar', path: '/overlay/winlose', w: 780, h: 170 },
  likes: { id: 'likes', label: 'Like Leaderboard', path: '/overlay/likes', w: 480, h: 760 },
  chat: { id: 'chat', label: 'Komen', path: '/overlay/chat', w: 560, h: 720 },
  joinalert: { id: 'joinalert', label: 'Join Alert', path: '/overlay/joinalert', w: 640, h: 200 },
  followalert: { id: 'followalert', label: 'Follow Alert', path: '/overlay/followalert', w: 640, h: 200 },
  gifters: { id: 'gifters', label: 'Top Gifter Leaderboard', path: '/overlay/gifters', w: 480, h: 760 },
  'goal-like': { id: 'goal-like', label: 'Target Like', path: '/overlay/goal/like', w: 640, h: 150 },
  'goal-share': { id: 'goal-share', label: 'Target Share', path: '/overlay/goal/share', w: 640, h: 150 },
  'goal-follower': { id: 'goal-follower', label: 'Target Follower', path: '/overlay/goal/follower', w: 640, h: 150 },
  'goal-coin': { id: 'goal-coin', label: 'Target Coin', path: '/overlay/goal/coin', w: 640, h: 150 }
};

export function screenOverlay(n) {
  return { id: 'screen-' + n, label: 'Screen ' + n, path: '/overlay/screen/' + n, w: 1920, h: 1080 };
}

export const OVERLAY_TOTAL = Object.keys(OVERLAYS).length + SCREEN_COUNT;

/** Cari definisi overlay dari id ("screen-3", "goal-like", "likes", ...). */
export function overlayById(id) {
  if (OVERLAYS[id]) return OVERLAYS[id];
  const m = /^screen-(\d+)$/.exec(id || '');
  return m ? screenOverlay(+m[1]) : null;
}
