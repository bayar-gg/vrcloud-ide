<#
.SYNOPSIS
    Auto-installer VRCloud IDE untuk Windows 10/11.

.DESCRIPTION
    Memasang dependency npm, membuat file .env dengan kredensial acak,
    membuat folder workspace, lalu mendaftarkan Scheduled Task agar VRCloud IDE
    berjalan otomatis saat login dan langsung dijalankan.

    Tidak butuh tmux. Terminal memakai ConPTY (node-pty) langsung, sehingga
    terminal tidak persisten melewati restart proses server.

.PARAMETER Port
    Port HTTP. Default: 1337.

.PARAMETER Workspace
    Folder kerja yang diekspos IDE. Default: %USERPROFILE%\vrcloud-workspace.

.PARAMETER Shell
    Shell terminal. Default: powershell.exe (bisa cmd.exe atau pwsh.exe).

.PARAMETER BindHost
    Alamat bind. Default: 0.0.0.0 (akses LAN). Pakai 127.0.0.1 untuk lokal saja.

.PARAMETER NoService
    Lewati pendaftaran Scheduled Task (hanya siapkan .env + dependency).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Port 8080 -Workspace C:\code
#>
[CmdletBinding()]
param(
    [int]$Port = 1337,
    [string]$Workspace = (Join-Path $env:USERPROFILE 'vrcloud-workspace'),
    [string]$Shell = 'powershell.exe',
    [string]$BindHost = '0.0.0.0',
    [switch]$NoService,
    # Remote Desktop tanpa RDP: siapkan auto-logon konsol (lihat windows-headless-desktop.ps1).
    # -Headless mengaktifkan tanpa bertanya; -NoHeadless melewati; tanpa keduanya installer bertanya.
    [switch]$Headless,
    [switch]$NoHeadless,
    [string]$AutoLogonUser,
    [string]$AutoLogonPassword,
    [string]$AutoLogonDomain,
    [switch]$Reboot
)

$ErrorActionPreference = 'Stop'
$TaskName = 'VRCloudIDE'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EnvFile = Join-Path $AppDir '.env'
$DataDir = Join-Path $AppDir 'data'
$ServerJs = Join-Path $AppDir 'server.js'
$LogFile = Join-Path $DataDir 'vrcloud-ide.log'

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }

function New-RandomHex([int]$byteCount) {
    $bytes = New-Object 'System.Byte[]' $byteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

# Set atau tambahkan sebuah key=value dalam array baris .env.
function Set-EnvLine([System.Collections.Generic.List[string]]$lines, [string]$key, [string]$value) {
    $prefix = "$key="
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].StartsWith($prefix)) { $lines[$i] = "$prefix$value"; return }
    }
    $lines.Add("$prefix$value")
}

# --- Prasyarat: Node.js + npm ---------------------------------------------
Write-Step 'Memeriksa Node.js dan npm'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Step 'Node.js tidak ditemukan. Memasang via winget (OpenJS.NodeJS.LTS)'
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [System.Environment]::GetEnvironmentVariable('Path', 'User')
        $node = Get-Command node -ErrorAction SilentlyContinue
    }
}
if (-not $node) {
    throw "Node.js tidak ditemukan. Pasang Node.js LTS dari https://nodejs.org lalu jalankan ulang skrip ini."
}
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { throw "npm tidak ditemukan meski Node.js terpasang. Perbaiki instalasi Node.js." }
$nodeVersion = (node --version).TrimStart('v')
Write-Host ("Node.js {0} terdeteksi." -f $nodeVersion)
# Agent AI (@cursor/sdk) butuh Node.js >= 22.13; node-pty 1.x butuh >= 16.
try {
    $v = [version]$nodeVersion
    if ($v -lt [version]'22.13.0') {
        throw "Node.js $nodeVersion terlalu lama. VRCloud IDE membutuhkan Node.js >= 22.13 (pasang Node LTS 22/24 dari https://nodejs.org atau 'winget install OpenJS.NodeJS.LTS')."
    }
} catch [System.FormatException] {
    Write-Warning "Tidak bisa membaca versi Node.js ($nodeVersion); pastikan >= 22.13."
}

# Peringatan opsional: tar.exe dibutuhkan untuk fitur arsip ZIP/TAR.
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    Write-Warning "tar.exe tidak ditemukan. Fitur arsip (zip/tar) butuh Windows 10 1803+ dengan bsdtar."
}

# --- Dependency npm --------------------------------------------------------
Write-Step 'Memasang dependency npm (production)'
Push-Location $AppDir
try {
    if (Test-Path (Join-Path $AppDir 'package-lock.json')) {
        npm ci --production
        if ($LASTEXITCODE -ne 0) { npm install --production }
    } else {
        npm install --production
    }
    if ($LASTEXITCODE -ne 0) { throw "npm gagal memasang dependency (exit $LASTEXITCODE)." }
} finally {
    Pop-Location
}

# --- Folder data + workspace ----------------------------------------------
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null

# --- File .env -------------------------------------------------------------
Write-Step 'Menyiapkan file .env'
$generatedPassword = $null
if (Test-Path $EnvFile) {
    $lines = [System.Collections.Generic.List[string]]::new()
    Get-Content -LiteralPath $EnvFile | ForEach-Object { $lines.Add($_) }
} else {
    $generatedPassword = New-RandomHex 24
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('AUTH_USER=admin')
    $lines.Add("AUTH_PASS=$generatedPassword")
    $lines.Add(("AUTH_SECRET=" + (New-RandomHex 32)))
    $lines.Add('SESSION_MAX_AGE=604800')
}
# Nilai runtime khusus Windows (server membaca semuanya dari .env).
Set-EnvLine $lines 'HTTPS' 'true'
Set-EnvLine $lines 'COOKIE_SECURE' 'true'
Set-EnvLine $lines 'HOST' $BindHost
Set-EnvLine $lines 'PORT' "$Port"
Set-EnvLine $lines 'WORKSPACE' $Workspace
Set-EnvLine $lines 'SHELL_BIN' $Shell
Set-Content -LiteralPath $EnvFile -Value $lines -Encoding UTF8

# --- Scheduled Task (auto-start) ------------------------------------------
if (-not $NoService) {
    Write-Step "Mendaftarkan Scheduled Task '$TaskName' (auto-start saat login)"
    $nodePath = $node.Source
    $innerCmd = "Set-Location -LiteralPath '$AppDir'; & '$nodePath' '$ServerJs' *>> '$LogFile'"
    $argument = "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$innerCmd`""

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $AppDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null

    Write-Step 'Menjalankan VRCloud IDE'
    Start-ScheduledTask -TaskName $TaskName

    # Tunggu sampai halaman login siap.
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            & curl.exe -kfsS -o NUL --max-time 2 "https://127.0.0.1:$Port/login"
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            & curl.exe -fsS -o NUL --max-time 2 "http://127.0.0.1:$Port/login"
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        } catch {}
    }
    if (-not $ready) {
        Write-Warning "Server belum merespons. Cek log: $LogFile"
    }
}

# --- Firewall + URL publik (sama seperti Linux: https://IP:port) ----------
. (Join-Path $PSScriptRoot 'windows-access.ps1')
Open-VrcloudFirewall -Port $Port | Out-Null

# --- Ringkasan -------------------------------------------------------------
$authUser = ($lines | Where-Object { $_ -like 'AUTH_USER=*' } | Select-Object -First 1) -replace '^AUTH_USER=', ''
Write-Host ''
Write-Host 'VRCloud IDE siap.' -ForegroundColor Green
Write-Host 'URL:'
Get-VrcloudAccessUrls -Port $Port -Scheme 'https' | ForEach-Object { Write-Host ("  {0}" -f $_) }
Write-Host 'Sertifikat self-signed: browser meminta konfirmasi sekali.'
Write-Host ("Workspace : {0}" -f $Workspace)
Write-Host ("Shell     : {0}" -f $Shell)
Write-Host ("Username  : {0}" -f $authUser)
if ($generatedPassword) {
    Write-Host ("Password  : {0}" -f $generatedPassword) -ForegroundColor Yellow
    Write-Host 'Simpan password ini; tersimpan juga di .env.'
} else {
    Write-Host 'Password  : tidak berubah (lihat .env). Ganti: scripts\vrcloud.ps1 newpassword'
}
Write-Host ''
if (-not $NoService) {
    Write-Host 'Kelola service:'
    Write-Host '  powershell -File scripts\vrcloud.ps1 start|stop|restart|status|logs|password|newpassword'
} else {
    Write-Host 'Jalankan manual: powershell -File scripts\start.ps1'
}

# --- Remote Desktop tanpa RDP (opsional) ----------------------------------
# Di Windows Server, sesi jadi "disconnected" saat RDP ditutup -> Remote Desktop layar hitam.
# Installer ini sudah elevated, jadi tawarkan sekalian setup auto-logon konsol di sini.
function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}
$HeadlessScript = Join-Path $PSScriptRoot 'windows-headless-desktop.ps1'
$wantHeadless = $false
if ($Headless) {
    $wantHeadless = $true
} elseif (-not $NoHeadless -and [Environment]::UserInteractive) {
    Write-Host ''
    Write-Host 'Remote Desktop tanpa login RDP' -ForegroundColor Cyan
    Write-Host 'Agar Remote Desktop / computer use tetap jalan walau tidak ada sesi RDP, server bisa'
    Write-Host 'diatur auto-logon ke konsol (perlu akun + password Windows, dan reboot sekali).'
    $ans = Read-Host 'Aktifkan sekarang? (y/N)'
    if ($ans -match '^(y|yes)$') { $wantHeadless = $true }
}
if ($wantHeadless) {
    if (-not (Test-Path $HeadlessScript)) {
        Write-Warning "Skrip tidak ditemukan: $HeadlessScript"
    } elseif (-not (Test-IsAdmin)) {
        Write-Warning "Setup auto-logon butuh Administrator. Jalankan ulang installer sebagai Administrator, atau: powershell -File scripts\vrcloud.ps1 headless"
    } else {
        $hlArgs = @{ NoPrompt = $true }
        if ($AutoLogonUser) { $hlArgs.User = $AutoLogonUser }
        if ($AutoLogonDomain) { $hlArgs.Domain = $AutoLogonDomain }
        if ($AutoLogonPassword) { $hlArgs.Password = $AutoLogonPassword }
        try {
            & $HeadlessScript @hlArgs
        } catch {
            Write-Warning "Setup Remote Desktop tanpa RDP gagal: $($_.Exception.Message)"
        }
        # Reboot diperlukan agar auto-logon aktif penuh.
        $doReboot = [bool]$Reboot
        if (-not $doReboot -and [Environment]::UserInteractive) {
            $r = Read-Host 'Reboot sekarang untuk menerapkan auto-logon konsol? (y/N)'
            if ($r -match '^(y|yes)$') { $doReboot = $true }
        }
        if ($doReboot) { Write-Host 'Reboot dalam 5 detik... (Ctrl+C untuk batal)' -ForegroundColor Yellow; Start-Sleep -Seconds 5; Restart-Computer -Force }
        else { Write-Host 'Reboot server nanti untuk menyelesaikan auto-logon konsol.' }
    }
} else {
    Write-Host ''
    Write-Host 'Remote Desktop tanpa RDP bisa diaktifkan kapan saja: powershell -File scripts\vrcloud.ps1 headless'
}
