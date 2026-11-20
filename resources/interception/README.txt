Folder ini berisi file Interception: interception.dll + install-interception.exe
(di dalam subfolder "command line installer" dari zip rilis).

Build .exe otomatis mengunduh dan mengekstrak rilis v1.0.1 ke folder ini
(.github/workflows/build.yml), lalu package.json mem-bundelnya ke resources/interception/.

Saat .exe pertama kali dijalankan, electron/main.js otomatis:
 - mendeteksi driver belum terpasang,
 - meminta UAC sekali,
 - menjalankan "install-interception.exe /install" tanpa membuka CMD,
 - meminta restart PC sekali.

Setelah itu, server.js memakai interception.dll untuk keystroke setara keyboard fisik.
Kalau driver/DLL tidak ada, keystroke otomatis kembali ke helper PowerShell lama.

Rilis: https://github.com/oblitum/Interception/releases/tag/v1.0.1
