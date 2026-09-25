# URL dan firewall Windows agar IDE bisa dibuka lewat https://IP:port, sama seperti di Linux.
# Dipakai install-windows.ps1 dan vrcloud.ps1. Jangan dijalankan langsung.

function Get-VrcloudAccessUrls {
    param(
        [int]$Port = 1337,
        [string]$Scheme = 'https'
    )
    $ips = New-Object System.Collections.Generic.List[string]
    try {
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | ForEach-Object {
            $ip = $_.IPAddress
            if ($ip -and $ip -notlike '127.*' -and $ip -notlike '169.254.*' -and -not $ips.Contains($ip)) {
                $ips.Add($ip)
            }
        }
    } catch {
        try {
            [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | ForEach-Object {
                if ($_.AddressFamily -eq 'InterNetwork') {
                    $ip = $_.IPAddressToString
                    if ($ip -notlike '127.*' -and $ip -notlike '169.254.*' -and -not $ips.Contains($ip)) { $ips.Add($ip) }
                }
            }
        } catch {}
    }
    $pub = ''
    try {
        $pub = (& curl.exe -4 -fsS --max-time 5 'https://ip.me' 2>$null)
        if ($pub) { $pub = $pub.Trim() }
        if ($pub -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { $pub = '' }
    } catch { $pub = '' }
    $ordered = New-Object System.Collections.Generic.List[string]
    if ($pub) { $ordered.Add($pub) }
    foreach ($ip in $ips) { if (-not $ordered.Contains($ip)) { $ordered.Add($ip) } }
    if (-not $ordered.Contains('127.0.0.1')) { $ordered.Add('127.0.0.1') }
    return @($ordered | ForEach-Object { '{0}://{1}:{2}/' -f $Scheme, $_, $Port })
}

function Open-VrcloudFirewall {
    param([int]$Port)
    $name = 'VRCloud IDE'
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Warning "Firewall Windows belum dibuka (butuh Administrator). Jalankan: powershell -File scripts\vrcloud.ps1 firewall"
        return $false
    }
    $rules = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)
    if ($rules.Count -gt 0) {
        Set-NetFirewallRule -DisplayName $name -Enabled True -Profile Any -Action Allow -Direction Inbound | Out-Null
        Get-NetFirewallRule -DisplayName $name | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port | Out-Null
    } else {
        New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
    }
    Write-Host ("Firewall: TCP {0} inbound diizinkan, sehingga https://IP:{0}/ bisa dibuka dari luar." -f $Port)
    return $true
}
