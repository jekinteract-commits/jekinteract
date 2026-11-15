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
- Win Lose Bar: Numpad `+` menambah Win dan Numpad `-` menambah Lose. Di aplikasi
  Electron hotkey bersifat **global** (tetap jalan walau fokus di OBS, TikTok Studio,
  atau game). Di browser biasa hotkey hanya aktif saat halaman Win Lose Bar fokus.

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

## Kenapa Windows menampilkan peringatan saat membuka `.exe`?

Munculnya **"Windows protected your PC"** / **"Unknown publisher"** biasanya berasal
dari Windows SmartScreen, bukan berarti file-nya virus. Penyebab utamanya: file `.exe`
belum ditandatangani secara digital dan belum punya reputasi di Microsoft, sehingga
Windows memilih berhati-hati untuk file baru.

Yang bisa dilakukan pengguna:

1. Unduh hanya dari halaman **Releases** repo GitHub ini.
2. Cocokkan nilai **SHA-256** file dengan `SHA256SUMS.txt` di release yang sama.
3. Kalau cocok dan yakin, klik **More info → Run anyway**.
4. Kalau Windows Defender salah mendeteksi (false positive), laporkan file-nya ke
   Microsoft lewat <https://www.microsoft.com/en-us/wdsi/filesubmission>.

Untuk menghilangkan peringatan SmartScreen sepenuhnya, `.exe` harus
**ditandatangani dengan code signing certificate** (OV/EV, atau layanan seperti
Azure Trusted Signing). Workflow build sudah menyiapkan dua secret opsional:

- `CSC_LINK` — isi file sertifikat `.pfx` yang sudah di-base64.
- `CSC_KEY_PASSWORD` — password sertifikat.

Jika kedua secret itu diisi di **Settings → Secrets and variables → Actions**,
electron-builder akan otomatis menandatangani `.exe` saat build. Tanpa sertifikat,
build tetap berjalan, tetapi Windows akan tetap menampilkan "Unknown publisher".

Untuk proyek open source, layanan seperti SignPath.io juga menyediakan code signing
gratis. Setelah terdaftar, integrasikan ke workflow GitHub Actions.

## Aplikasi tidak terbuka / seolah tidak terjadi apa-apa

Beberapa hal yang perlu dicek, urut dari yang paling sering:

1. **Windows 10/11 64-bit.** Electron 31 tidak lagi mendukung Windows 7/8/8.1,
   jadi di versi Windows lama aplikasi tidak bisa jalan.
2. **SmartScreen / antivirus.** Kalau muncul "Windows protected your PC", klik
   **More info → Run anyway**. Kalau file langsung hilang setelah diunduh,
   kemungkinan diblokir antivirus (file belum ditandatangani).
3. **Aplikasi masih hidup di tray.** Menutup window **tidak** mematikan aplikasi;
   JekInteract tetap berjalan di background agar overlay tetap hidup. Klik ikon
   JekInteract di tray (pojok kanan bawah) untuk membuka lagi, atau klik kanan →
   **Keluar**. Kalau proses lama masih berjalan, membuka `.exe` lagi hanya akan
   memunculkan window yang sama (tidak membuat instance baru).
4. **Cek file log.** Log ditulis ke beberapa lokasi:
   - samping file `.exe` → `jekinteract.log` (mode portable)
   - `%APPDATA%\JekInteract\jekinteract.log`
   - `%TEMP%\jekinteract.log`

   Kirim isi file log tersebut kalau masih gagal.

Data aplikasi (pengaturan, upload, riwayat) disimpan di folder `data\` **di samping
file `.exe`** saat memakai versi portable, jadi tidak hilang saat aplikasi ditutup.
Kalau folder itu tidak bisa ditulis (misalnya `.exe` ditaruh di `Program Files`),
aplikasi otomatis memakai `%APPDATA%\JekInteract\data`.

