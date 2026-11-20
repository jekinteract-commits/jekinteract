# Siapkan Interception (driver keyboard level) untuk JekInteract.
# Jalankan: klik kanan file ini -> Run with PowerShell, atau:
#   powershell -ExecutionPolicy Bypass -File .\setup-interception.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $root 'resources\interception'
$zip = Join-Path $env:TEMP 'JekInteract-Interception.zip'
$url = 'https://github.com/oblitum/Interception/releases/download/v1.0.1/Interception.zip'

Write-Host 'Mengunduh Interception...'
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

Write-Host 'Mengekstrak ke resources\interception...'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $zip -DestinationPath $dest -Force

Write-Host ''
Write-Host 'SELESAI. Langkah berikutnya ( HARUS di PC yang menjalankan JekInteract ):'
Write-Host ' 1. Buka folder resources\interception'
Write-Host ' 2. Cari installer driver (install-interception.exe)'
Write-Host ' 3. Klik kanan -> Run as administrator'
Write-Host ' 4. Ikuti instruksi installer, lalu RESTART PC'
Write-Host ' 5. Jalankan ulang JekInteract'
Write-Host ''
Write-Host 'Kalau install-interception.exe tidak ada, buka:'
Write-Host ' https://github.com/oblitum/Interception/releases/tag/v1.0.1'
Write-Host 'lalu unduh Interception.zip dan ekstrak ke folder tersebut.'
Write-Host ''
Write-Host 'Jalankan JekInteract sebagai Administrator agar driver bisa diakses.'
