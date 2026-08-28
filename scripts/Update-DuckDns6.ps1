<#
.SYNOPSIS
    Cap nhat ban ghi AAAA cua DuckDNS ve dia chi IPv6 toan cuc cua may nay.

.DESCRIPTION
    `Update-DuckDns.ps1` chi lam ban ghi A (dong 129 hardcode `&ip=`, dong 90 chi hoi
    cac dich vu IPv4). Script nay la doi trong IPv6 cua no.

    VI SAO CAN: mang nha dang sau CGNAT (WAN IP cua PPPoE la 10.171.232.127) nen
    khong forward duoc cong IPv4. IPv6 thi KHONG qua NAT, moi may trong nha co dia
    chi toan cuc that - do la duong duy nhat con lai neu khong dung VPS.

    CHON DIA CHI NAO - day la cho de sai nhat:
    Windows giu HAI dia chi toan cuc tren cung mot giao dien:
      - SuffixOrigin 'Random'  -> dia chi TAM THOI (privacy), tu xoay vong moi ngay.
                                  Dung no cho DNS thi ten mien chet sau vai gio.
      - SuffixOrigin 'Link'    -> dia chi ON DINH. Day la dia chi may chu.
    Script chi lay loai thu hai.

    TIEN TO CUNG DONG: ValidLifetime cua tien to /64 khoang 23 gio, khop voi lease
    PPPoE. Khi phien PPPoE noi lai, ca tien to lan dia chi doi. Vi vay script nay
    phai chay dinh ky y het ban IPv4.

.PARAMETER Ipv4
    Gia tri giu cho ban ghi A. Mac dinh lay AIVB_VPS_IP trong duckdns.env.

    QUAN TRONG: DuckDNS dat A ve IP cua NGUOI GOI neu khong truyen `ip=`. Goi tu may
    nay ma bo trong thi A se bi ghi de bang IP CGNAT 171.225.x - tuc la tu tay pha
    duong hau VPS ma khong ai nhan ra. Vi vay luon truyen `ip=` tuong minh.

.EXAMPLE
    .\Update-DuckDns6.ps1 -WhatIf     # xem truoc, khong doi gi
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$EnvFile   = 'C:\ProgramData\AIVBank\config\duckdns.env',
    [string]$LogFile   = 'C:\ProgramData\AIVBank\logs\duckdns.log',
    [string]$StateFile = 'C:\ProgramData\AIVBank\config\duckdns6.last',
    [string]$Ipv6,
    [string]$Ipv4,
    [string]$InterfaceAlias = 'Ethernet',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Log([string]$Message) {
    $line = '{0}  [v6] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Verbose $line
    try {
        $dir = Split-Path -Parent $LogFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch { }
}

# --- Doc cau hinh ------------------------------------------------------
if (-not (Test-Path $EnvFile)) {
    Write-Log "HONG: khong thay $EnvFile"
    throw "Khong thay $EnvFile. Xem docs/MIGRATION.md muc 1, dong 7."
}
$cfg = @{}
foreach ($line in (Get-Content -LiteralPath $EnvFile -Encoding UTF8)) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $cfg[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
}
foreach ($k in @('AIVB_DUCKDNS_DOMAIN', 'AIVB_DUCKDNS_TOKEN')) {
    if (-not $cfg.ContainsKey($k) -or -not $cfg[$k]) {
        Write-Log "HONG: thieu $k trong $EnvFile"
        throw "Thieu $k trong $EnvFile."
    }
}
$domain = $cfg['AIVB_DUCKDNS_DOMAIN'] -replace '\.duckdns\.org$', ''
$token  = $cfg['AIVB_DUCKDNS_TOKEN']

if (-not $Ipv4) {
    if ($cfg.ContainsKey('AIVB_VPS_IP') -and $cfg['AIVB_VPS_IP']) { $Ipv4 = $cfg['AIVB_VPS_IP'] }
    else {
        Write-Log 'HONG: khong co AIVB_VPS_IP va khong truyen -Ipv4'
        throw 'Phai truyen -Ipv4 hoac dat AIVB_VPS_IP. Bo trong se lam DuckDNS ghi de ban ghi A bang IP CGNAT.'
    }
}

# --- Tim dia chi IPv6 --------------------------------------------------
if ($Ipv6) {
    $target = $Ipv6
    Write-Log "dung IPv6 truyen vao: $target"
} else {
    $cand = Get-NetIPAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv6 -ErrorAction SilentlyContinue |
            Where-Object {
                $_.AddressState  -eq 'Preferred' -and
                $_.SuffixOrigin  -eq 'Link' -and          # ON DINH, khong phai 'Random'
                $_.PrefixOrigin  -ne 'WellKnown' -and     # loai fe80::
                $_.IPAddress -notlike 'fe80*'
            } | Select-Object -First 1
    if (-not $cand) {
        Write-Log "HONG: khong thay dia chi IPv6 toan cuc ON DINH tren '$InterfaceAlias'"
        throw "Khong thay IPv6 toan cuc on dinh tren '$InterfaceAlias'. Kiem `Get-NetIPAddress -AddressFamily IPv6`."
    }
    $target = $cand.IPAddress
    Write-Log "dia chi on dinh phat hien duoc: $target"
}

# Global unicast la 2000::/3 -> chu so hex dau tien phai la 2 hoac 3.
if ($target -notmatch '^[23]') {
    Write-Log "HONG: $target khong phai global unicast (2000::/3)"
    throw "IPv6 '$target' khong phai dia chi toan cuc."
}

# --- Bo qua neu khong doi ---------------------------------------------
$last = $null
if ((Test-Path $StateFile) -and -not $Force) {
    try { $last = (Get-Content -LiteralPath $StateFile -Raw).Trim() } catch { $last = $null }
}
if ($last -eq $target -and -not $Force) {
    Write-Log "khong doi ($target)"
    return
}

# --- Goi DuckDNS -------------------------------------------------------
if (-not $PSCmdlet.ShouldProcess("$domain.duckdns.org", "dat AAAA -> $target (giu A = $Ipv4)")) {
    Write-Host "  se dat AAAA $domain.duckdns.org -> $target"
    Write-Host "  se giu  A    $domain.duckdns.org -> $Ipv4"
    Write-Host "  (hien tai da luu: $last)"
    return
}

$uri = 'https://www.duckdns.org/update?domains={0}&token={1}&ip={2}&ipv6={3}' -f $domain, $token, $Ipv4, $target
try {
    $resp = (Invoke-RestMethod -Uri $uri -TimeoutSec 20 -ErrorAction Stop).ToString().Trim()
} catch {
    Write-Log "HONG: goi DuckDNS that bai - $($_.Exception.Message)"
    throw
}
if ($resp -ne 'OK') {
    Write-Log "HONG: DuckDNS tra '$resp' cho $domain"
    throw "DuckDNS tra '$resp'. Kiem AIVB_DUCKDNS_DOMAIN va AIVB_DUCKDNS_TOKEN trong $EnvFile."
}

Write-Log "da dat AAAA $domain.duckdns.org -> $target (A giu nguyen $Ipv4)"
try {
    $dir = Split-Path -Parent $StateFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Set-Content -LiteralPath $StateFile -Value $target -Encoding UTF8 -NoNewline
} catch {
    Write-Log 'canh bao: khong ghi duoc StateFile - lan sau se goi lai du khong doi'
}
