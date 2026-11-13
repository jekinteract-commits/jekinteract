/* Data demo — dipakai sampai integrasi TikTok / YouTube / myinstants selesai. */
import { startOfDay, addDays, isoDate } from './format.js';
import { hash } from './avatar.js';

/** PRNG deterministik (mulberry32). */
export function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];
export const rand = (min, max, r = Math.random) => Math.floor(min + r() * (max - min + 1));

export const USERS = [
  'rina.kece', 'bayu_gamers', 'dinda.official', 'kang.mas', 'siti.nur', 'arif_tv', 'maya.putri', 'joko_wi',
  'dewi.lestari', 'fajar.88', 'nanda.xo', 'rizky_ml', 'luna.moon', 'andi.pro', 'tasya_kamila', 'bagas.id',
  'putra.nusantara', 'sari.dewi', 'eko_prasetyo', 'vina.cantik', 'hendra.live', 'mega.star', 'yoga_pro', 'ayu.lestari'
];
export const ACCOUNTS = ['jek.interact', 'jek.gaming'];

export const LIVE_TITLES = [
  'Mabar santai bareng subscriber', 'Ngobrol malam minggu', 'Push rank sampai subuh', 'Request lagu bareng',
  'Subathon hari ke-3', 'Tebak gift challenge', 'Giveaway spesial akhir bulan', 'Nobar dan ngopi',
  'Main game hasil voting penonton', 'Tanya jawab bebas', 'Cover lagu request', 'Sparring bareng teman'
];

export const CHAT_LINES = [
  'Halo kak, salam dari Bandung! 👋', 'Gas terus bang 🔥', 'Lagunya enak banget', 'Kak, mainin lagu yang tadi dong',
  'Mantap jiwa!', 'Siapa yang nonton dari awal? 🙋', 'Bang, ajarin dong tips-nya', 'Keren abis, udah follow ya',
  'Spill dong settingan overlay-nya 😍', 'Semangat live-nya kak, jangan kendor!', 'Ini seru banget sih',
  'Wkwkwk ngakak parah', 'Mau dong request lagu', 'Rose-nya udah masuk ya kak 🌹', 'Hai semuaaa 💖',
  'Yang baru join, jangan lupa tap-tap layar!', 'Auto betah nonton ini', 'Kapan mabar lagi bang?'
];

/** Peran penonton (deterministik per nama) — dipakai filter overlay komen. */
export function rolesOf(name) {
  const h = hash(name);
  const out = [];
  if (h % 10 < 7) out.push('follower');
  if ((h >> 3) % 10 < 2) out.push('friend');
  if ((h >> 6) % 10 < 3) out.push('subscriber');
  if ((h >> 9) % 12 === 0) out.push('moderator');
  if ((h >> 12) % 10 < 2) out.push('team');
  if ((h >> 15) % 10 < 2) out.push('topgifter');
  return out;
}

/** Opsi "siapa yang bisa" — dipakai di banyak form. */
export const WHO_FULL = [
  ['all', 'Semua Orang'], ['follower', 'Follower'], ['friend', 'Teman'], ['subscriber', 'Subscriber / SuperFan'],
  ['moderator', 'Moderator'], ['team', 'Level Tim'], ['topgifter', 'Top Gifter']
];
export const WHO_ACT = [
  ['all', 'Semua Orang'], ['follower', 'Follower'], ['friend', 'Teman'], ['subscriber', 'Subscriber / SuperFan'], ['moderator', 'Moderator']
];

/* ------------------------------------------------------------------ */
/* Statistik harian (120 hari ke belakang, stabil per tanggal)         */
/* ------------------------------------------------------------------ */
let dailyCache = null;

export function dailyData() {
  const today = startOfDay(new Date());
  const stamp = isoDate(today);
  if (dailyCache && dailyCache.stamp === stamp) return dailyCache.list;
  const list = [];
  for (let i = 119; i >= 0; i--) {
    const d = addDays(today, -i);
    const r = mulberry32(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
    const day = { date: d, iso: isoDate(d), sessions: [], lives: 0, minutes: 0, peak: 0, likes: 0, coins: 0, followers: 0, shares: 0, comments: 0, gifters: [] };
    if (r() < 0.78) {
      const n = r() < 0.25 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const dur = 35 + Math.floor(r() * 190);
        day.sessions.push({
          hour: 8 + Math.floor(r() * 15),
          minute: Math.floor(r() * 12) * 5,
          title: LIVE_TITLES[Math.floor(r() * LIVE_TITLES.length)],
          account: ACCOUNTS[r() < 0.8 ? 0 : 1],
          minutes: dur
        });
        day.lives++;
        day.minutes += dur;
        day.peak = Math.max(day.peak, 90 + Math.floor(r() * 1700));
        day.likes += Math.floor(dur * (30 + r() * 260));
        day.coins += Math.floor(dur * (4 + r() * 70));
        day.followers += Math.floor(dur * (0.05 + r() * 1.2));
        day.shares += Math.floor(dur * (0.1 + r() * 0.9));
        day.comments += Math.floor(dur * (6 + r() * 55));
      }
      day.sessions.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
      const gn = 5 + Math.floor(r() * 5);
      let left = day.coins;
      for (let g = 0; g < gn; g++) {
        const share = g === gn - 1 ? left : Math.floor(left * (0.15 + r() * 0.35));
        left -= share;
        day.gifters.push({ user: USERS[Math.floor(r() * USERS.length)], coins: Math.max(1, share) });
      }
    }
    list.push(day);
  }
  dailyCache = { stamp, list };
  return list;
}

/** Hari-hari di dalam rentang [from, to] (Date, inklusif). */
export function daysBetween(from, to) {
  const a = isoDate(from);
  const b = isoDate(to);
  return dailyData().filter((d) => d.iso >= a && d.iso <= b);
}

export function aggregate(days) {
  const t = { lives: 0, minutes: 0, peak: 0, likes: 0, coins: 0, followers: 0, shares: 0, comments: 0 };
  days.forEach((d) => {
    t.lives += d.lives;
    t.minutes += d.minutes;
    t.peak = Math.max(t.peak, d.peak);
    t.likes += d.likes;
    t.coins += d.coins;
    t.followers += d.followers;
    t.shares += d.shares;
    t.comments += d.comments;
  });
  return t;
}

export function topGifters(days, limit = 10) {
  const m = new Map();
  days.forEach((d) => d.gifters.forEach((g) => m.set(g.user, (m.get(g.user) || 0) + g.coins)));
  return Array.from(m, ([user, coins]) => ({ user, coins })).sort((a, b) => b.coins - a.coins).slice(0, limit);
}

/** Riwayat awal untuk Analytics: 30 hari + beberapa yang lebih lama (untuk memperlihatkan hapus otomatis). */
export function seedHistory() {
  const now = Date.now();
  const out = [];
  dailyData()
    .slice(-42)
    .forEach((day) =>
      day.sessions.forEach((s, i) => {
        const ts = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate(), s.hour, s.minute).getTime();
        if (ts <= now) out.push({ id: 'h_' + day.iso + '_' + i, account: s.account, title: s.title, ts, demo: true });
      })
    );
  return out;
}

/* ------------------------------------------------------------------ */
/* Gift TikTok (contoh — sumber asli: streamtoearn.io/gifts?region=ID)  */
/* ------------------------------------------------------------------ */
export const GIFTS = [
  ['Rose', 1, '🌹'], ['TikTok', 1, '🎵'], ['Heart Me', 1, '💗'], ['GG', 1, '🎮'], ['Ice Cream', 1, '🍦'],
  ['Finger Heart', 5, '💖'], ['Lollipop', 10, '🍭'], ['Perfume', 20, '🧴'], ['Doughnut', 30, '🍩'],
  ['Sunflower', 49, '🌻'], ['Teddy Bear', 99, '🧸'], ['Cap', 99, '🧢'], ['Balloon', 99, '🎈'],
  ['Hand Hearts', 100, '💞'], ['Confetti', 100, '🎉'], ['Love Bouquet', 149, '💐'], ['Headphones', 199, '🎧'],
  ['Guitar', 299, '🎸'], ['Corgi', 299, '🐶'], ['Lucky Cat', 299, '🐱'], ['Money Gun', 500, '💸'],
  ['Rocket', 500, '🚀'], ['Medal', 599, '🏅'], ['Swan', 699, '🦢'], ['Diamond Ring', 799, '💍'],
  ['Train', 899, '🚆'], ['Galaxy', 1000, '🌌'], ['Trophy', 1200, '🏆'], ['Crown', 1500, '👑'],
  ['Diamond', 1999, '💎'], ['Rainbow', 1999, '🌈'], ['Fireworks', 2999, '🎆'], ['Unicorn', 2999, '🦄'],
  ['UFO', 3999, '🛸'], ['Dragon', 4999, '🐉'], ['Castle', 5999, '🏰'], ['Helicopter', 6999, '🚁'],
  ['Sports Car', 7000, '🏎️'], ['Yacht', 9999, '🛥️'], ['Private Jet', 12999, '✈️'], ['Lion', 29999, '🦁'],
  ['Planet', 34999, '🪐']
].map(([name, coins, emoji]) => ({ name, coins, emoji }));

/* ------------------------------------------------------------------ */
/* Soundboard (contoh — sumber asli: myinstants.com)                    */
/* ------------------------------------------------------------------ */
export const SOUNDS = [
  'Vine Boom', 'Airhorn', 'Sad Violin', 'Bruh', 'Wow Anime', 'Oh No No No', 'Sheesh', 'Windows Startup',
  'Nokia Ringtone', 'Mario Coin', 'Dun Dun Dunnn', 'Crowd Cheer', 'Drum Roll', 'Rimshot', 'Ding Dong',
  'Level Up', 'Game Over', 'Suara Tepuk Tangan'
];

let actx = null;
/** Bunyi pendek ala arcade sebagai pengganti suara asli (belum ada integrasi myinstants). */
export function playBlip(name) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const h = hash(name);
    const base = 220 + (h % 440);
    const type = ['square', 'sawtooth', 'triangle', 'sine'][h % 4];
    const t0 = actx.currentTime;
    [0, 4, 7, 12].forEach((semi, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      const t = t0 + i * 0.09;
      o.type = type;
      o.frequency.value = base * Math.pow(2, semi / 12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g);
      g.connect(actx.destination);
      o.start(t);
      o.stop(t + 0.16);
    });
  } catch (_) {
    /* audio tidak tersedia */
  }
}

/* ------------------------------------------------------------------ */
/* OBS & musik (contoh)                                                */
/* ------------------------------------------------------------------ */
export const OBS_SCENES = ['Gameplay', 'Just Chatting', 'BRB', 'Intro', 'Outro', 'Kamera Penuh'];
export const OBS_SOURCES = ['Alert Gift', 'Webcam', 'Efek Confetti', 'Lower Third', 'Meme Overlay'];

export const SONGS = [
  { user: 'rina.kece', title: 'Sial - Mahalini', dur: 232 },
  { user: 'bayu_gamers', title: 'Komang - Raim Laode', dur: 247 },
  { user: 'dinda.official', title: 'Nina - Feast', dur: 215 },
  { user: 'maya.putri', title: 'Bergema Sampai Selamanya - Nadhif Basalamah', dur: 258 },
  { user: 'arif_tv', title: 'Tak Ingin Usai - Keisya Levronka', dur: 229 },
  { user: 'luna.moon', title: 'Lathi - Weird Genius ft. Sara Fajira', dur: 268 }
];
