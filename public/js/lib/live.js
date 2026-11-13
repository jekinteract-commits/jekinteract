/* Statistik live asli dari server (sesi berjalan + riwayat 30 hari). */
import { Sync } from './sync.js';
import { startOfDay, addDays, isoDate } from './format.js';

const sessionTime = (s) => Number((s && (s.startedAt || s.ts)) || 0);

/** Sesi live berjalan + riwayat yang dikirim server lewat SSE. */
export function allSessions() {
  const stats = Sync.liveStats || {};
  const list = Array.isArray(stats.sessions) ? stats.sessions.slice() : [];
  if (stats.current) list.push(stats.current);
  return list;
}

export function sessionsBetween(from, to) {
  const a = isoDate(from);
  const b = isoDate(to);
  return allSessions().filter((s) => {
    const t = sessionTime(s);
    if (!t) return false;
    const iso = isoDate(new Date(t));
    return iso >= a && iso <= b;
  });
}

/**
 * Bentuk data harian dari sesi live asli, kompatibel dengan tampilan Dashboard.
 * Hari tanpa live tetap disertakan agar grafik batang tidak bolong.
 */
export function dailyFromSessions(from, to) {
  const start = startOfDay(from);
  const end = startOfDay(to);
  const days = [];
  const byIso = new Map();

  for (let d = start; d <= end; d = addDays(d, 1)) {
    const day = {
      date: new Date(d),
      iso: isoDate(d),
      sessions: [],
      lives: 0,
      minutes: 0,
      peak: 0,
      likes: 0,
      coins: 0,
      followers: 0,
      shares: 0,
      comments: 0,
      gifters: []
    };
    days.push(day);
    byIso.set(day.iso, day);
  }

  sessionsBetween(from, to).forEach((s) => {
    const day = byIso.get(isoDate(new Date(sessionTime(s))));
    if (!day) return;
    day.sessions.push(s);
    day.lives += 1;
    day.minutes += (Number(s.durationSec) || 0) / 60;
    day.peak = Math.max(day.peak, Number(s.peakViewers) || 0);
    day.likes += Number(s.likes) || 0;
    day.coins += Number(s.coins) || 0;
    day.followers += Number(s.followers) || 0;
    day.shares += Number(s.shares) || 0;
    day.comments += Number(s.comments) || 0;
    (s.gifters || []).forEach((g) => day.gifters.push(g));
  });

  return days;
}

export function aggregateDays(days) {
  const total = { lives: 0, minutes: 0, peak: 0, likes: 0, coins: 0, followers: 0, shares: 0, comments: 0 };
  days.forEach((d) => {
    total.lives += d.lives;
    total.minutes += d.minutes;
    total.peak = Math.max(total.peak, d.peak);
    total.likes += d.likes;
    total.coins += d.coins;
    total.followers += d.followers;
    total.shares += d.shares;
    total.comments += d.comments;
  });
  return total;
}

export function topGiftersFromSessions(sessions, limit = 10) {
  const map = new Map();
  sessions.forEach((s) => {
    (s.gifters || []).forEach((g) => {
      const key = g.id || g.user || g.nickname;
      if (!key) return;
      const prev = map.get(key) || {
        id: g.id || null,
        user: g.user || g.nickname || 'Anonim',
        nickname: g.nickname || g.user || 'Anonim',
        avatarUrl: g.avatarUrl || null,
        coins: 0
      };
      prev.coins += Number(g.coins) || 0;
      prev.user = g.user || prev.user;
      prev.nickname = g.nickname || prev.nickname;
      prev.avatarUrl = g.avatarUrl || prev.avatarUrl;
      map.set(key, prev);
    });
  });
  return Array.from(map.values())
    .filter((g) => g.coins > 0)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, limit);
}
