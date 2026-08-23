<#
.SYNOPSIS
    Giữ bản ghi A của tên miền DuckDNS trỏ đúng vào IP công khai của nhà.

.DESCRIPTION
    Khi hệ thống ra Internet qua đường hầm SSH, tên miền trỏ vào VPS và địa chỉ
    đó là tĩnh — không cần script này. Khi chuyển sang forward cổng trên router,
    tên miền phải trỏ vào IP nhà, mà IP nhà là IP ĐỘNG: ISP đổi nó sau khi mất
    điện hoặc sau khi router khởi động lại.

    Lúc đó tên miền trỏ vào địa chỉ của người khác, cả lớp mất truy cập, và
    KHÔNG có cảnh báo nào. Trang web chỉ đơn giản là không mở được.

    Vì vậy script này phải chạy nền theo lịch, không phải chạy tay một lần.
    Cách đăng ký Scheduled Task: docs/DEPLOY-ROUTER.md bước 2.

.PARAMETER Ip
    Ép dùng đúng địa chỉ này thay vì tự dò. Dùng khi muốn trỏ tên miền về lại
    VPS để quay về đường hầm cũ (xem AIVB_VPS_IP trong duckdns.env).

.PARAMETER Force
    Gọi DuckDNS kể cả khi IP không đổi so với lần chạy trước.

.EXAMPLE
    .\Update-DuckDns.ps1
    .\Update-DuckDns.ps1 -WhatIf
    .\Update-DuckDns.ps1 -Ip 107.174.93.110      # quay về VPS
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$EnvFile  = 'C:\ProgramData\AIVBank\config\duckdns.env',
    [string]$LogFile  = 'C:\ProgramData\AIVBank\logs\duckdns.log',
    [string]$StateFile = 'C:\ProgramData\AIVBank\config\duckdns.last',
    [string]$Ip,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Log([string]$Message) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Verbose $line
    try {
        $dir = Split-Path -Parent $LogFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch {
        # Nhật ký hỏng không được làm hỏng việc cập nhật. Task chạy dưới SYSTEM
        # nên đường dẫn log luôn ghi được; nếu không thì vẫn phải đi tiếp.
    }
}

# --- Đọc cấu hình ------------------------------------------------------
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

# DuckDNS nhan TEN CON, khong nhan ten day du. Cau hinh co the ghi kieu nao
# cung duoc, nen cat duoi ".duckdns.org" neu co.
$domain = $cfg['AIVB_DUCKDNS_DOMAIN'] -replace '\.duckdns\.org$', ''
$token  = $cfg['AIVB_DUCKDNS_TOKEN']

# --- Xac dinh IP can dat ----------------------------------------------
if ($Ip) {
    $target = $Ip
    Write-Log "dung IP truyen vao: $target"
} else {
    # Hai nguon doc lap: mot nguon chet thi con nguon kia. Neu ca hai chet thi
    # KHONG doan bua — de nguyen ban ghi cu con dung hon la ghi de bang rac.
    $target = $null
    foreach ($url in @('https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com')) {
        try {
            $r = Invoke-RestMethod -Uri $url -TimeoutSec 10 -ErrorAction Stop
            $candidate = ("$r").Trim()
            if ($candidate -match '^\d{1,3}(\.\d{1,3}){3}$') {
                $target = $candidate
                break
            }
        } catch {
            Write-Log "khong hoi duoc $url"
        }
    }
    if (-not $target) {
        Write-Log 'HONG: khong xac dinh duoc IP cong khai — giu nguyen ban ghi cu'
        throw 'Khong xac dinh duoc IP cong khai.'
    }
}

if ($target -match '^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)') {
    Write-Log "HONG: $target la dia chi rieng, khong phai IP cong khai"
    throw "IP '$target' la dia chi rieng. Xem docs/DEPLOY-ROUTER.md buoc 0 (CGNAT)."
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
if (-not $PSCmdlet.ShouldProcess("$domain.duckdns.org", "dat ban ghi A -> $target")) {
    Write-Host "  se dat $domain.duckdns.org -> $target (hien tai da luu: $last)"
    return
}

$uri = 'https://www.duckdns.org/update?domains={0}&token={1}&ip={2}' -f $domain, $token, $target

try {
    $resp = (Invoke-RestMethod -Uri $uri -TimeoutSec 20 -ErrorAction Stop).ToString().Trim()
} catch {
    Write-Log "HONG: goi DuckDNS that bai — $($_.Exception.Message)"
    throw
}

# DuckDNS tra dung mot tu: "OK" hoac "KO". "KO" gan nhu luon la token sai hoac
# ten con sai; no KHONG kem theo ly do nao.
if ($resp -ne 'OK') {
    Write-Log "HONG: DuckDNS tra '$resp' cho $domain"
    throw "DuckDNS tra '$resp'. Kiem AIVB_DUCKDNS_DOMAIN va AIVB_DUCKDNS_TOKEN trong $EnvFile."
}

try {
    $dir = Split-Path -Parent $StateFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Set-Content -Path $StateFile -Value $target -Encoding ascii
} catch {
    Write-Log 'canh bao: khong ghi duoc file trang thai, lan sau se goi lai du IP khong doi'
}

if ($last) {
    Write-Log "DOI: $last -> $target"
} else {
    Write-Log "DAT: $domain.duckdns.org -> $target"
}
Write-Host "  DuckDNS: $domain.duckdns.org -> $target" -ForegroundColor Green
