# JekInteract

Tools interaksi TikTok Live (fase UI). Tema dark game arcade futuristik.
Tanpa dependency: cukup Node.js 16 atau lebih baru.

## Jalankan di Termux

```
pkg update
pkg install nodejs unzip
termux-setup-storage          # sekali saja, untuk akses folder Download
cd ~/storage/downloads
unzip jekinteract.zip
cd jekinteract
npm start
```

Lalu buka `http://localhost:3000` di browser HP.
Port lain: `PORT=4000 npm start`.

## Yang sudah jalan

- Dashboard, Analytics (riwayat 30 hari, hapus otomatis), Connection (simulasi), Pusat Interaksi
  (20 screen, interaksi, aktivitas, upload gambar/video/audio, keyboard virtual), TikTok Data Gift (contoh),
  YouTube Music, Baca Komentar (tester suara asli), Subathon Timer, Win Lose Bar, Like Leaderboard,
  Komen, Top Gifter Leaderboard, Goals, Pengaturan (hapus cache antrean screen 1-20).
- Semua overlay berlatar transparan. Link overlay ada di tiap halaman; tombol ikon di sebelah "Salin Link"
  membuka overlay di tab baru dengan latar kotak-kotak.
- Status Online/Offline overlay asli (hijau saat link sedang dibuka).
- Subathon Timer, Win/Lose, dan Goals sinkron langsung ke overlay. Tombol Play di Interaksi mengirim tes ke Screen.

## Masih data demo / simulasi (menyusul bertahap)

- Koneksi TikTok Live dan event asli (gift, like, komentar, follow, share)
- Daftar gift asli (streamtoearn.io), soundboard asli (myinstants.com)
- Request lagu YouTube, kontrol OBS WebSocket, simulasi keystroke ke keyboard
- Leaderboard, komentar, dan lagu di overlay masih contoh

## Struktur

```
server.js        server (file statis, SSE, antrean screen, upload)
public/          dashboard (index.html) dan overlay (overlay.html)
data/            dibuat otomatis: state.json dan uploads/
```

Overlay di OBS: Browser Source dengan link dari dashboard. Jika OBS ada di PC lain,
isi "Alamat dasar link overlay" di Pengaturan dengan IP HP (misal `http://192.168.1.5:3000`).
