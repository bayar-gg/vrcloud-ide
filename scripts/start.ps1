<#
.SYNOPSIS
    Jalankan VRCloud IDE di foreground (Windows).
.DESCRIPTION
    Memasang dependency bila belum ada, lalu menjalankan server.js.
    Konfigurasi (PORT/WORKSPACE/login) dibaca dari .env.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $AppDir

if (-not (Test-Path (Join-Path $AppDir 'node_modules'))) {
    Write-Host 'Memasang dependency dulu...' -ForegroundColor Cyan
    npm install --production
    if ($LASTEXITCODE -ne 0) { throw "npm gagal (exit $LASTEXITCODE)." }
}

node (Join-Path $AppDir 'server.js')
