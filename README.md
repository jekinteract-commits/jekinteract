# JekInteract

Tools interaksi TikTok Live (fase UI). Tema dark game arcade futuristik.
Butuh Node.js **20 atau lebih baru** (karena `tiktok-live-connector` v2 adalah modul ESM).

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

- Daftar gift asli (streamtoearn.io), soundboard asli (myinstants.com)
- Request lagu YouTube
- Leaderboard, komentar, dan lagu di overlay masih contoh

> Koneksi TikTok Live, event asli (gift/like/komentar/follow/share), dan keystroke
> asli sudah didukung. Lihat catatan penting di bawah.

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

## Trigger keystroke jalan di Chrome, tapi tidak di Roblox

Ini bukan bug JavaScript, tapi pembatasan keamanan Windows (UIPI): **proses yang
tidak elevated tidak boleh mengirim keyboard sintetis ke aplikasi yang dijalankan
sebagai Administrator.** Jadi kalau Roblox di-*Run as administrator* sementara
JekInteract tidak, keystroke-nya pasti dibuang Windows.

Solusi (pilih salah satu):

1. **Jalankan JekInteract sebagai Administrator** — klik kanan `JekInteract.exe`
   → *Run as administrator*, atau buka **Pengaturan → Jalankan sebagai Administrator**
   (akan muncul prompt UAC, lalu aplikasi restart sendiri). Kalau pakai `npm start`,
   jalankan **terminal/CMD sebagai Administrator** dulu. Build `.exe` memakai
   `asInvoker`, jadi pemakaian biasa **tidak memunculkan UAC** dan tidak perlu
   klik kanan — Administrator hanya dipakai kalau targetnya memang elevated.
2. **Jalankan Roblox tanpa administrator** (klik kanan → hapus centang *Run as
   administrator* / buka lewat Roblox Client biasa).

Catatan tambahan:

- Keystroke dikirim ke **jendela depan (foreground)**, bukan ke aplikasi tertentu.
  Kalau menekan **Play** lalu baru pindah ke game, tombol sudah keburu masuk ke
  browser. Isi **Delay Keystroke** di form Interaksi (mis. 3 detik) supaya sempat
  pindah ke aplikasi tujuan sebelum tombol ditekan.
- Tombol dikirim memakai *scan code* asli (`MapVirtualKey` + `keybd_event`),
  bukan cuma virtual-key. Ini penting supaya game yang membaca input mentah
  (bukan cuma kolom teks/chat) ikut merespons.
- Opsional: buka **Pengaturan → Keluar & Hak Administrator**, isi **Jendela
  target keystroke** (mis. `RobloxPlayerBeta,RobloxPlayer`) lalu centang **Fokus
  otomatis sebelum kirim keystroke** kalau ingin jendela game ditarik ke depan
  otomatis. Kosongkan kalau mau keystroke jalan di aplikasi apa pun yang sedang
  fokus.
- Cek **Pengaturan → Keluar & Hak Administrator** atau form Interaksi → Trigger
  Keystroke untuk melihat status mesin keystroke secara real-time.
- Shortcut global untuk keluar: **Ctrl+Alt+Shift+Q**.

## Keystroke setara keyboard fisik (jalur driver — opsional)

Secara default keystroke dikirim lewat helper PowerShell (`keybd_event`). Untuk
aplikasi/game biasa (mis. Roblox yang dibuka normal) input ini sudah diterima,
**tanpa driver dan tanpa Administrator** — tidak ada dialog, UAC, atau restart.

Kalau `interception.dll` tersedia, JekInteract otomatis memakai **driver keyboard
Interception** — tombol dikirim lewat driver filter sehingga tampak seperti keyboard
fisik. Jalur lama tetap dipakai kalau driver tidak ada, jadi fitur lain tidak berubah.

Driver bersifat opsional dan **tidak dipasang otomatis saat startup**. Kalau mau
memasangnya, buka menu tray → **Pasang ulang driver keyboard…**, lalu setujui UAC.
Setelah install selesai, restart PC sekali supaya driver aktif.

Catatan:
- `.exe` tidak meminta UAC saat dibuka (`asInvoker`). Keystroke biasa langsung jalan.
- Administrator tetap dibutuhkan kalau targetnya di-*Run as administrator* —
  gunakan tombol **Jalankan sebagai Administrator** di Pengaturan.
- Kalau install gagal (mis. sebagian Windows 11 menolak driver lama), aplikasi tetap
  berjalan memakai keystroke mode lama — fitur lain tidak berubah.
- Cek log (`jekinteract.log`): harus ada `[keystroke-driver] helper dimulai (...interception.dll)`.
  Kalau yang muncul `[keystroke] helper PowerShell dimulai`, berarti driver belum aktif.

## Connection: "Gagal — Library tiktok-live-connector tidak tersedia"

Pada build lama, `server.js` memakai `require('tiktok-live-connector')`. Padahal
`tiktok-live-connector` v2 adalah modul **ESM**, dan Electron 31 (Node 20) belum
bisa `require()` modul ESM. Di browser/Node 22+ bisa, di `.exe` tidak — makanya
muncul pesan itu.

Versi terbaru sudah memperbaikinya dengan `import()` dinamis, dan detail error
aslinya sekarang ditampilkan di halaman Connection. Pastikan Anda memakai build
**v1.0.24 ke atas**. Kalau menjalankan dari source:

```
npm install
npm start
```

## File `JekInteract.exe` tidak bisa dihapus ("File in Use")

Menutup jendela **tidak** mematikan aplikasi — JekInteract sengaja tetap hidup di
tray supaya overlay di OBS tetap jalan. Selama proses itu hidup, Windows mengunci
`.exe` dan Explorer menolak menghapusnya.

Cara keluar total (pilih salah satu):

- Klik kanan ikon **JekInteract** di area tray (pojok kanan bawah) → **Keluar
  (tutup server & helper)**;
- Buka **Pengaturan → Keluar JekInteract**;
- Tekan **Ctrl+Alt+Shift+Q** (shortcut global, tetap jalan walau jendela
  disembunyikan);
- Atau jalankan ulang `.exe` lalu pilih menu tray tersebut.

Semua helper (PowerShell keyboard, cloudflared, koneksi TikTok) sekarang ikut
dimatikan saat keluar, jadi tidak ada proses yatim yang mengunci file. Tunggu
1–2 detik setelah keluar, lalu hapus folder/portable `.exe`-nya dengan aman.

