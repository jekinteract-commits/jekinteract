# JekInteract — Panduan Auth Key / Lisensi

Fitur ini bikin `.exe` minta **Auth Key** sebelum aplikasi jalan.

- Key di-generate **owner dari Termux**, tersimpan di database **Cloudflare D1**.
- `.exe` menanyakan key ke server itu tiap kali dibuka.
- **1 key = 1 perangkat (HWID)**. Key kedua di PC lain ditolak sampai di-unbind.
- Prompt muncul **cuma pas aktivasi pertama & pas key expired / dicabut**.
- Kalau internet putus, app masih jalan **7 hari** (grace period). Habis itu minta key lagi / koneksi internet.
- Key habis → muncul warning + form masukin key baru.

> ⚠️ Generate dari Termux **tetap ngaruh ke PC client** karena dua-duanya bicara ke Worker + D1 yang sama. HP lu boleh mati setelah key di-generate.

## Biaya

**Gratis** untuk skala normal. Yang dipakai cuma Cloudflare **Workers Free** + **D1 Free**:

| Kuota gratis (per hari) | Limit | Estimasi pemakaian lisensi ini |
|---|---|---|
| Workers request | 100.000 | ~1 request per buka exe + request generate/revoke |
| D1 rows read | 5.000.000 | beberapa baris per cek key |
| D1 rows written | 100.000 | cuma pas generate/aktivasi/unbind |
| D1 storage | 5 GB total | key + device itu kecil banget |
| Database | 10 | cukup 1 |

Contoh: 500 user buka exe 5× sehari = 2.500 request/hari — masih jauh di bawah kuota gratis.
Nggak perlu domain sendiri (URL `*.workers.dev` gratis) dan nggak perlu VPS.
Paket berbayar baru perlu kalau kuota di atas terlampaui.

Yang **opsional dan berbayar**: code signing certificate kalau mau hilangkan peringatan SmartScreen Windows. Itu nggak ada hubungannya dengan sistem lisensi.

---

## 0. Backup

Backup sudah dibuat sebelum perubahan:
```
~/JekInteractUpdate 1.0.26.zip
```
Bisa dipulihkan kapan saja kalau mau balik ke versi sebelum lisensi.

---

## 1. Daftar Cloudflare (gratis)

Belum punya akun? Daftar dulu di <https://dash.cloudflare.com/sign-up>.
Tidak perlu kartu kredit, tidak perlu domain sendiri. Cukup akun gratis.

---

## 2. Siapkan Wrangler di Termux

```bash
pkg update && pkg install nodejs
npm install -g wrangler
wrangler login
```

`wrangler login` bakal kasih link untuk login via browser (bisa dibuka di HP/PC lu).
Kalau lebih nyaman pakai API token:

```bash
export CLOUDFLARE_API_TOKEN="token_dari_dashboard"
```

---

## 3. Buat database D1

Dari folder project:

```bash
cd license-server
npx wrangler d1 create jek-license
```

Outputnya ada `database_id`. **Copy** nilai itu ke `license-server/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "jek-license"
database_id = "paste_database_id_di_sini"
```

Lalu jalankan schema:

```bash
npx wrangler d1 execute jek-license --file=schema.sql
```

---

## 4. Pasang ADMIN_TOKEN (rahasia owner)

Bikin token random panjang:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Lalu daftarkan sebagai Worker secret:

```bash
npx wrangler secret put ADMIN_TOKEN
# paste token tadi, Enter
```

> Token ini **hanya ada di Cloudflare + file tools/.env di HP lu**. Jangan pernah ditaruh di `electron/`, `.exe`, atau repo publik. Siapa pun yang punya token ini bisa generate key.

---

## 5. Deploy Worker

```bash
npx wrangler deploy
```

Akan keluar URL seperti:

```
https://jek-license.<subdomain-kamu>.workers.dev
```

Cek cepat:

```bash
curl https://jek-license.<subdomain-kamu>.workers.dev/api/health
# {"ok":true,"serverTime":"...","service":"jek-license","version":1}
```

---

## 6. Hubungkan project ke server lu

**a.** Balik ke folder project, lalu copy `.env` untuk CLI owner:

```bash
cd ..
cp tools/.env.example tools/.env
nano tools/.env
```

Isi:

```
LICENSE_URL=https://jek-license.<subdomain-kamu>.workers.dev
ADMIN_TOKEN=token_panjang_dari_langkah_4
```

**b.** Edit `electron/license-config.json`:

```json
{
  "licenseUrl": "https://jek-license.<subdomain-kamu>.workers.dev",
  "graceDays": 7,
  "requireLicense": true
}
```

`requireLicense` harus `true` sebelum lo build `.exe`.
(Sebelum deploy, nilai default-nya `false` biar aplikasi masih bisa dijalankan buat testing.)

---

## 7. Generate key dari Termux

```bash
node tools/license.js gen --days 30 --username "nobita_1940"
```

Atau lewat npm script:

```bash
npm run license:gen -- --days 30 --username "nobita_1940"
```

`--note "..."` masih didukung sebagai alias lama dari `--username`.

Contoh output:

```
  KEY BARU:  JEKK-7QX4-9K2M-4P8T-6R2W
  Berlaku            : 30 hari, sampai 2026-12-21 09:30
  Device             : maksimal 1 PC
  Username Tiktok    : nobita_1940
  Kirim key ini ke user. Setelah generate, HP lu boleh mati.
```

Kirim key itu ke user. Di PC user, buka `.exe` → masukin key → langsung jalan.

---

## 8. Build `.exe`

```bash
npm run build:win
```

Hasil: `dist/JekInteractUpdate-1.0.26.exe`.

Yang **tidak** ikut ke exe: `tools/`, `license-server/`, `tools/.env`, `ADMIN_TOKEN`.
Yang **ikut**: `electron/license-config.json` (berisi URL server, bukan rahasia).

---

## 9. Operasional sehari-hari

```bash
# Lihat semua key (waktu generate + waktu expired + username TikTok)
node tools/license.js list

# Cek detail 1 key + device yang terikat
node tools/license.js info --key JEKK-XXXX-XXXX-XXXX-XXXX

# Cabut key (user langsung diminta key baru saat buka exe)
node tools/license.js revoke --key JEKK-XXXX-XXXX-XXXX-XXXX

# User ganti PC / format → lepas ikatan device lama
node tools/license.js info --key JEKK-XXXX-XXXX-XXXX-XXXX   # lihat HWID-nya
node tools/license.js unbind --key JEKK-XXXX-XXXX-XXXX-XXXX --hwid W-ABC123...

# Lepas semua device dari key itu (user bisa aktivasi di PC baru)
node tools/license.js unbind --key JEKK-XXXX-XXXX-XXXX-XXXX
```

---

## 10. Yang dilihat user

| Kondisi | Yang muncul |
|---|---|
| Pertama kali buka exe | Form Auth Key |
| Key salah | Pesan "Key tidak dikenal" |
| Key sudah dipakai PC lain | "Key sudah terikat di 1 perangkat. Hubungi owner." |
| Buka exe lagi (masih aktif) | Langsung masuk dashboard, tanpa prompt |
| Internet mati ≤ 7 hari | Langsung masuk, ada status grace di log |
| Internet mati > 7 hari | Form Auth Key + pesan grace habis |
| Key expired / dicabut | Warning + form key baru |
| Jam PC dimundurin | Ditolak (ada proteksi clock rollback) |

---

## 11. Catatan keamanan (jujur)

- Proteksi ini **mengunci user awam**, bukan cracker serius. Karena `asar: false` di `package.json`, file JS di dalam exe masih plaintext dan bisa di-patch oleh orang yang paham.
- Kalau mau lebih kuat: fitur inti (koneksi TikTok / overlay) baru jalan kalau server kasih token — tapi itu berarti **internet wajib terus**.
- Simpan `ADMIN_TOKEN` dan backup `tools/.env` di tempat aman. Kalau hilang, bikin token baru pakai `wrangler secret put ADMIN_TOKEN`, lalu update `tools/.env`.
- Key yang sudah di-generate tetap tersimpan di D1 walaupun HP lu mati / Worker di-redeploy.

---

## 12. Troubleshooting

**"Server lisensi tidak bisa dihubungi"**
- Cek `curl <LICENSE_URL>/api/health` dari Termux.
- Cek `wrangler tail` buat lihat log Worker.
- Pastikan `wrangler.toml` punya `database_id` yang benar dan schema sudah dijalankan.

**"Admin token salah"**
- `tools/.env` beda dengan secret di Worker. Cek `wrangler secret list`, lalu `wrangler secret put ADMIN_TOKEN` ulang.

**Aplikasi tetap jalan tanpa key**
- `requireLicense` di `electron/license-config.json` masih `false`, atau lu jalankan `npm start` / `electron .` langsung dari source (mode dev sengaja dilewati). Build ulang `.exe` setelah set `true`.

**Log lengkap** ada di samping `.exe` → `jekinteract.log` (sesuai mekanisme logging yang sudah ada).
