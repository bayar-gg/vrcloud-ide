<#
.SYNOPSIS
    Manajer service VRCloud IDE untuk Windows (via Scheduled Task).

.DESCRIPTION
    Membungkus Scheduled Task 'VRCloudIDE' yang dibuat oleh install-windows.ps1.

    Perintah:
      start        Jalankan service dan tunggu sampai siap
      stop         Hentikan service
      restart      Restart service
      status       Tampilkan status service
      firewall     Buka port inbound agar https://IP:port bisa diakses (Administrator)
      update       Ambil kode terbaru dari GitHub dan restart bila sedang berjalan
      logs         Ikuti log (data\vrcloud-ide.log)
      password     Tampilkan username dan password login
      newpassword  Buat password baru (acak) dan rotasi AUTH_SECRET
      help         Tampilkan bantuan ini

.EXAMPLE
    powershell -File scripts\vrcloud.ps1 start
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'help',
    [Parameter(Position = 1)]
    [string]$Option = ''
)

$ErrorActionPreference = 'Stop'
$TaskName = 'VRCloudIDE'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EnvFile = Join-Path $AppDir '.env'
$LogFile = Join-Path $AppDir 'data\vrcloud-ide.log'

function Get-EnvValue([string]$key) {
    if (-not (Test-Path $EnvFile)) { return $null }
    $prefix = "$key="
    $line = Get-Content -LiteralPath $EnvFile | Where-Object { $_.StartsWith($prefix) } | Select-Object -First 1
    if ($null -eq $line) { return $null }
    return $line.Substring($prefix.Length)
}

function Get-Port { $p = Get-EnvValue 'PORT'; if ($p) { return [int]$p } else { return 1337 } }

. (Join-Path $PSScriptRoot 'windows-access.ps1')

function Show-AccessUrls([string]$scheme) {
    $port = Get-Port
    if (-not $scheme) {
        $https = Get-EnvValue 'HTTPS'
        $scheme = $(if ($https -eq 'false') { 'http' } else { 'https' })
    }
    Write-Host 'URL:'
    Get-VrcloudAccessUrls -Port $port -Scheme $scheme | ForEach-Object { Write-Host ("  {0}" -f $_) }
}

function Require-Task {
    if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
        throw "Scheduled Task '$TaskName' belum ada. Jalankan: powershell -File scripts\install-windows.ps1"
    }
}

function Wait-Ready {
    $port = Get-Port
    for ($i = 0; $i -lt 30; $i++) {
        try {
            & curl.exe -kfsS -o NUL --max-time 2 "https://127.0.0.1:$port/login"
            if ($LASTEXITCODE -eq 0) {
                Write-Host 'VRCloud IDE berjalan.' -ForegroundColor Green
                Show-AccessUrls 'https'
                return
            }
            & curl.exe -fsS -o NUL --max-time 2 "http://127.0.0.1:$port/login"
            if ($LASTEXITCODE -eq 0) {
                Write-Host 'VRCloud IDE berjalan.' -ForegroundColor Green
                Show-AccessUrls 'http'
                return
            }
        } catch {}
        Start-Sleep -Seconds 1
    }
    Write-Warning "VRCloud IDE belum siap. Cek log: powershell -File scripts\vrcloud.ps1 logs"
}

switch ($Command.ToLower()) {
    'start' {
        Require-Task
        Open-VrcloudFirewall -Port (Get-Port) | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        Wait-Ready
    }
    'stop' {
        Require-Task
        Stop-ScheduledTask -TaskName $TaskName
        Write-Host 'VRCloud IDE dihentikan.'
    }
    'restart' {
        Require-Task
        Open-VrcloudFirewall -Port (Get-Port) | Out-Null
        Stop-ScheduledTask -TaskName $TaskName
        Start-Sleep -Seconds 1
        Start-ScheduledTask -TaskName $TaskName
        Wait-Ready
    }
    'status' {
        Require-Task
        Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo |
            Format-List TaskName, LastRunTime, LastTaskResult, NextRunTime
        $state = (Get-ScheduledTask -TaskName $TaskName).State
        Write-Host "State: $state"
        if ($state -eq 'Running') { Show-AccessUrls }
    }
    'firewall' {
        if (-not (Open-VrcloudFirewall -Port (Get-Port))) { exit 1 }
    }
    'update' {
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            throw "git tidak ditemukan. Pasang Git for Windows, lalu jalankan ulang."
        }
        $repo = if ($env:VRCLOUD_REPOSITORY) { $env:VRCLOUD_REPOSITORY } else { 'https://github.com/bayar-gg/vrcloud-ide.git' }
        $branch = if ($env:VRCLOUD_BRANCH) { $env:VRCLOUD_BRANCH } else { 'main' }
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $wasRunning = [bool]($task -and $task.State -eq 'Running')
        Write-Host "Memperbarui VRCloud IDE dari $branch..."
        Push-Location $AppDir
        try {
            $hadGit = Test-Path (Join-Path $AppDir '.git')
            if (-not $hadGit) {
                Write-Host 'Folder ini belum punya Git (biasanya hasil ZIP). Menyiapkan checkout...'
                & git -c safe.directory=* init -b $branch
                if ($LASTEXITCODE -ne 0) { throw "git init gagal (exit $LASTEXITCODE)." }
                & git -c safe.directory=* remote add origin $repo
                if ($LASTEXITCODE -ne 0) { throw "git remote add gagal (exit $LASTEXITCODE)." }
            }
            $old = ''
            if ($hadGit) { $old = (& git -c safe.directory=* rev-parse HEAD 2>$null) }
            if ($old) { $old = $old.Trim() }
            & git -c safe.directory=* fetch --depth 1 origin $branch
            if ($LASTEXITCODE -ne 0) { throw "git fetch gagal (exit $LASTEXITCODE). Server tidak diubah." }
            if ($hadGit) {
                & git -c safe.directory=* reset --hard FETCH_HEAD
            } else {
                & git -c safe.directory=* checkout -f -B $branch FETCH_HEAD
            }
            if ($LASTEXITCODE -ne 0) { throw "git checkout gagal (exit $LASTEXITCODE)." }
            $new = (& git -c safe.directory=* rev-parse HEAD).Trim()
        } finally {
            Pop-Location
        }
        if ($wasRunning) {
            Stop-ScheduledTask -TaskName $TaskName
            Start-Sleep -Seconds 2
        }
        if (Test-Path (Join-Path $AppDir 'package-lock.json')) {
            Write-Host 'Memasang dependency production...'
            Push-Location $AppDir
            try {
                & npm ci --omit=dev --no-audit --no-fund
                if ($LASTEXITCODE -ne 0) { Write-Warning "npm ci gagal (exit $LASTEXITCODE). Server dijalankan dengan dependency yang ada." }
            } finally {
                Pop-Location
            }
        }
        $oldShort = if ($old) { $old.Substring(0, [Math]::Min(7, $old.Length)) } else { 'ZIP' }
        $newShort = $new.Substring(0, [Math]::Min(7, $new.Length))
        if ($old -and $old -eq $new) { Write-Host "Sudah versi terbaru ($newShort)." }
        else { Write-Host "Diperbarui $oldShort -> $newShort." -ForegroundColor Green }
        if ($wasRunning) {
            Start-ScheduledTask -TaskName $TaskName
            Wait-Ready
        } else {
            Write-Host 'Service sedang berhenti. Jalankan: powershell -File scripts\vrcloud.ps1 start'
        }
    }
    'logs' {
        if (-not (Test-Path $LogFile)) { throw "Log belum ada: $LogFile" }
        Get-Content -LiteralPath $LogFile -Tail 100 -Wait
    }
    'password' {
        Write-Host ("Username: {0}" -f (Get-EnvValue 'AUTH_USER'))
        Write-Host ("Password: {0}" -f (Get-EnvValue 'AUTH_PASS'))
    }
    'newpassword' {
        if (-not (Test-Path $EnvFile)) { throw "File .env tidak ditemukan: $EnvFile" }
        function New-Hex([int]$n) {
            $b = New-Object 'System.Byte[]' $n
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($b) } finally { $rng.Dispose() }
            return -join ($b | ForEach-Object { $_.ToString('x2') })
        }
        $newPass = New-Hex 24
        $newSecret = New-Hex 32
        $lines = [System.Collections.Generic.List[string]]::new()
        Get-Content -LiteralPath $EnvFile | ForEach-Object { $lines.Add($_) }
        function Set-Line([string]$key, [string]$value) {
            $prefix = "$key="
            for ($i = 0; $i -lt $lines.Count; $i++) {
                if ($lines[$i].StartsWith($prefix)) { $lines[$i] = "$prefix$value"; return }
            }
            $lines.Add("$prefix$value")
        }
        Set-Line 'AUTH_PASS' $newPass
        Set-Line 'AUTH_SECRET' $newSecret
        Set-Content -LiteralPath $EnvFile -Value $lines -Encoding UTF8
        Write-Host 'Password diperbarui. Semua sesi login lama dibatalkan.'
        Write-Host ("Username: {0}" -f (Get-EnvValue 'AUTH_USER'))
        Write-Host ("Password: {0}" -f $newPass) -ForegroundColor Yellow
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') {
                Stop-ScheduledTask -TaskName $TaskName
                Start-Sleep -Seconds 1
                Start-ScheduledTask -TaskName $TaskName
                Write-Host 'Service di-restart untuk menerapkan password baru.'
            }
        }
    }
    default {
        Get-Help $PSCommandPath -Detailed | Out-String | Write-Host
    }
}
