<#
.SYNOPSIS
    Make VRCloud Remote Desktop / computer use work on a Windows Server WITHOUT
    keeping an RDP session open.

.DESCRIPTION
    VRCloud captures and controls the desktop of the Windows session it runs in.
    On a server you normally reach over RDP, that session becomes "Disconnected"
    the moment you close the RDP window (and there is no session at all before
    the first login). A disconnected session renders no desktop: screenshots come
    back black and clicks go nowhere. That is why remote desktop "stops working"
    when you are not logged in over RDP.

    The fix is a persistent, interactive CONSOLE session that exists with no RDP:

      1. Console auto-logon  - a chosen account is logged into the physical
         console (session 1) automatically at boot, so there is always a real,
         rendered desktop for VRCloud to see and drive.
      2. Keep it awake/unlocked - never blank or sleep the display, no idle lock.
      3. (Optional) Reconnect-to-console on RDP disconnect - if you DO connect
         over RDP and then close the window, the session is redirected back to the
         console with tscon so the desktop keeps rendering instead of going dark.

    Run this ONCE, elevated (Administrator). Reboot afterwards. After that,
    VRCloud's remote desktop and the agent's desktop_* tools work with nobody
    logged in over RDP.

.PARAMETER User
    Account to auto-logon at the console. Default: the current user. Use a
    dedicated, low-privilege local account for an unattended server.

.PARAMETER Password
    Password for -User. If omitted you are prompted securely. Required to enable
    auto-logon (Windows needs it to sign in unattended).

.PARAMETER Domain
    Logon domain. Default: this computer's name (i.e. a local account). For a
    domain account, pass the NetBIOS domain.

.PARAMETER SkipAutoLogon
    Do not touch auto-logon (only apply keep-awake / disconnect-redirect).

.PARAMETER SkipDisconnectRedirect
    Do not install the "redirect RDP back to console on disconnect" task.

.PARAMETER Remove
    Undo everything this script configures (disable auto-logon, clear the stored
    password, remove the disconnect task, restore the idle lock timeout).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\windows-headless-desktop.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\windows-headless-desktop.ps1 -User vrcloud -Domain SERVER01

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\windows-headless-desktop.ps1 -Remove

.NOTES
    SECURITY: enabling auto-logon stores the account password. By default Windows
    keeps it in the registry (HKLM\...\Winlogon\DefaultPassword) in clear text.
    Prefer a dedicated account with the least privilege it needs. For stronger
    storage, Sysinternals Autologon (https://learn.microsoft.com/sysinternals/downloads/autologon)
    keeps the password as an LSA secret instead; if autologon.exe/Autologon64.exe
    is on PATH this script will use it automatically.
#>
[CmdletBinding()]
param(
    [string]$User = $env:USERNAME,
    [string]$Password,
    [string]$Domain = $env:COMPUTERNAME,
    [switch]$SkipAutoLogon,
    [switch]$SkipDisconnectRedirect,
    [switch]$Reboot,
    [switch]$NoPrompt,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$WinlogonKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$SystemPolicyKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DataDir = Join-Path $AppDir 'data'
$ReconnectScript = Join-Path $DataDir 'reconnect-console.ps1'
$DisconnectTask = 'VRCloudReconnectConsole'

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Warn($m) { Write-Warning $m }

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
        throw "Run this elevated: right-click PowerShell -> Run as Administrator, then re-run this script."
    }
}

# ---------------------------------------------------------------- remove mode
function Invoke-Remove {
    Write-Step 'Disabling console auto-logon'
    Set-ItemProperty -Path $WinlogonKey -Name 'AutoAdminLogon' -Value '0' -ErrorAction SilentlyContinue
    foreach ($n in 'DefaultPassword', 'AutoLogonCount') {
        Remove-ItemProperty -Path $WinlogonKey -Name $n -ErrorAction SilentlyContinue
    }
    Write-Step 'Restoring idle lock timeout (default)'
    Remove-ItemProperty -Path $SystemPolicyKey -Name 'InactivityTimeoutSecs' -ErrorAction SilentlyContinue
    Write-Step "Removing scheduled task '$DisconnectTask'"
    schtasks.exe /Delete /TN $DisconnectTask /F 2>$null | Out-Null
    if (Test-Path $ReconnectScript) { Remove-Item -LiteralPath $ReconnectScript -Force -ErrorAction SilentlyContinue }
    Write-Host ''
    Write-Host 'Reverted. Auto-logon is off and the stored password is cleared.' -ForegroundColor Green
    Write-Host 'Reboot to apply.'
}

# ---------------------------------------------------------------- auto-logon
function Enable-AutoLogon {
    Write-Step "Configuring console auto-logon for '$Domain\$User'"
    if (-not $Password) {
        $sec = Read-Host "Password for $Domain\$User (needed for unattended sign-in)" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if (-not $Password) { throw "A password is required to enable auto-logon (or pass -SkipAutoLogon)." }

    # Prefer Sysinternals Autologon (stores the password as an LSA secret, not clear text).
    $autologon = Get-Command 'autologon64.exe' -ErrorAction SilentlyContinue
    if (-not $autologon) { $autologon = Get-Command 'autologon.exe' -ErrorAction SilentlyContinue }
    if ($autologon) {
        Write-Step "Using Sysinternals Autologon ($($autologon.Source)) - password stored as an LSA secret"
        & $autologon.Source /accepteula $User $Domain $Password | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Sysinternals Autologon failed (exit $LASTEXITCODE)." }
    } else {
        Write-Warn 'Sysinternals Autologon not found; using the registry method. The password will be stored in clear text in the registry (HKLM Winlogon\DefaultPassword). Use a dedicated low-privilege account, or install Sysinternals Autologon for LSA-secret storage.'
        Set-ItemProperty -Path $WinlogonKey -Name 'AutoAdminLogon' -Value '1' -Type String
        Set-ItemProperty -Path $WinlogonKey -Name 'DefaultUserName' -Value $User -Type String
        Set-ItemProperty -Path $WinlogonKey -Name 'DefaultDomainName' -Value $Domain -Type String
        Set-ItemProperty -Path $WinlogonKey -Name 'DefaultPassword' -Value $Password -Type String
        # Remove any count that would make auto-logon expire after N reboots.
        Remove-ItemProperty -Path $WinlogonKey -Name 'AutoLogonCount' -ErrorAction SilentlyContinue
    }
    Write-Host "Auto-logon enabled for $Domain\$User." -ForegroundColor Green
}

# ---------------------------------------------------------------- keep awake
function Set-KeepAwake {
    Write-Step 'Keeping the display on and the session unlocked'
    # Never blank the monitor or sleep (AC and DC), so the captured desktop is always rendered.
    foreach ($a in @('monitor-timeout-ac 0','monitor-timeout-dc 0','standby-timeout-ac 0','standby-timeout-dc 0','disk-timeout-ac 0','hibernate-timeout-ac 0')) {
        & powercfg.exe /change $a.Split(' ')[0] $a.Split(' ')[1] 2>$null | Out-Null
    }
    # Do not auto-lock the console after idle (0 = never). Applies machine-wide.
    New-Item -Path $SystemPolicyKey -Force | Out-Null
    Set-ItemProperty -Path $SystemPolicyKey -Name 'InactivityTimeoutSecs' -Value 0 -Type DWord
    Write-Host 'Display will stay on; the console will not auto-lock.' -ForegroundColor Green
}

# ---------------------------------------------------------------- disconnect -> console
function Install-DisconnectRedirect {
    Write-Step 'Installing reconnect-to-console on RDP disconnect'
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    # Redirect every disconnected RDP session back to the physical console so the
    # desktop keeps rendering after you close the RDP window. Safe to run repeatedly.
    $body = @'
# Auto-generated by VRCloud windows-headless-desktop.ps1
# On RDP disconnect, return the session to the console so the desktop keeps rendering.
$ErrorActionPreference = 'SilentlyContinue'
$lines = (qwinsta.exe) -split "`r?`n"
foreach ($l in $lines) {
  if ($l -match '^\s*rdp-tcp#\S+\s+\S+\s+(\d+)\s+Disc') {
    $id = $Matches[1]
    tscon.exe $id /dest:console
  }
}
'@
    Set-Content -LiteralPath $ReconnectScript -Value $body -Encoding UTF8

    $exec = "powershell.exe"
    $argline = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ReconnectScript`""
    # Trigger on the TerminalServices disconnect event (LocalSessionManager/Operational, ID 24).
    $trigQuery = "*[System[Provider[@Name='Microsoft-Windows-TerminalServices-LocalSessionManager'] and EventID=24]]"
    $xml = @"
<QueryList><Query Id='0' Path='Microsoft-Windows-TerminalServices-LocalSessionManager/Operational'><Select Path='Microsoft-Windows-TerminalServices-LocalSessionManager/Operational'>$trigQuery</Select></Query></QueryList>
"@
    $class = Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger
    $trigger = New-CimInstance -CimClass $class -ClientOnly
    $trigger.Enabled = $true
    $trigger.Subscription = $xml
    $action = New-ScheduledTaskAction -Execute $exec -Argument $argline
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $DisconnectTask -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host "Task '$DisconnectTask' installed; RDP disconnect now returns the session to the console." -ForegroundColor Green
}

# ---------------------------------------------------------------- run
Assert-Admin
if ($Remove) { Invoke-Remove; return }

Write-Host 'VRCloud - make Remote Desktop work without an RDP login' -ForegroundColor Cyan
Write-Host ''

if (-not $SkipAutoLogon) { Enable-AutoLogon } else { Write-Step 'Skipping auto-logon (-SkipAutoLogon)' }
Set-KeepAwake
if (-not $SkipDisconnectRedirect) {
    try { Install-DisconnectRedirect }
    catch { Write-Warn "Could not install the disconnect-redirect task: $($_.Exception.Message). Auto-logon alone already covers the 'no RDP login' case." }
} else { Write-Step 'Skipping disconnect redirect (-SkipDisconnectRedirect)' }

# Make sure VRCloud starts for the auto-logon user.
$task = Get-ScheduledTask -TaskName 'VRCloudIDE' -ErrorAction SilentlyContinue
Write-Host ''
if ($task) {
    $principalUser = $task.Principal.UserId
    Write-Host "VRCloud auto-start task 'VRCloudIDE' runs at logon of: $principalUser"
    if ($principalUser -and ($principalUser -notmatch [regex]::Escape($User))) {
        Write-Warn "That task starts for '$principalUser', but auto-logon signs in '$User'. Re-run scripts\install-windows.ps1 while logged in as '$User' so VRCloud starts in the auto-logon session."
    }
} else {
    Write-Warn "VRCloud auto-start task not found. Run scripts\install-windows.ps1 (as '$User') so the IDE starts automatically in the console session."
}

Write-Host ''
Write-Host 'Done. A reboot applies console auto-logon.' -ForegroundColor Green
Write-Host 'After reboot, the console logs in automatically and stays active, so VRCloud'
Write-Host 'Remote Desktop and the agent''s desktop_* tools work with no RDP session open.'
Write-Host ''
Write-Host 'Undo any time with:  powershell -ExecutionPolicy Bypass -File scripts\windows-headless-desktop.ps1 -Remove'

# Offer a reboot (auto-logon only takes full effect after restart). -Reboot forces it;
# -NoPrompt (used when called from the installer) leaves rebooting to the caller.
$doReboot = [bool]$Reboot
if (-not $doReboot -and -not $NoPrompt) {
    $ans = Read-Host 'Reboot now to finish enabling console auto-logon? (y/N)'
    if ($ans -match '^(y|yes)$') { $doReboot = $true }
}
if ($doReboot) {
    Write-Host 'Rebooting in 5 seconds... (Ctrl+C to cancel)' -ForegroundColor Yellow
    Start-Sleep -Seconds 5
    Restart-Computer -Force
} elseif ($NoPrompt) {
    Write-Host 'Reboot the server when convenient to finish enabling console auto-logon.'
}
