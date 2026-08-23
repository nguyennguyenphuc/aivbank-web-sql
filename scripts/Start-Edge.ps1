<#
.SYNOPSIS
    Lớp ngoài cùng khi chạy qua router: cập nhật DuckDNS rồi bảo đảm Caddy sống.

.DESCRIPTION
    Đây là thứ thay chỗ `Start-Tunnel.ps1` khi `aivb.ps1` chạy với `-Router`.

    Khác biệt quan trọng so với đường hầm: script này LÀM XONG RỒI THOÁT, nó
    không phải một tiến trình chạy dài. Đường hầm là một tiến trình ssh phải
    sống suốt buổi; Caddy thì là Windows service, và service sống độc lập với
    phiên PowerShell nào.

    Đó là một cải thiện thật, không phải chi tiết kỹ thuật: đường hầm chết mỗi
    lần khởi động máy, còn Caddy tự lên. Chuyện `aivb.ps1` mất dấu PID của
    script này không sao cả — ô `tunnel` trong aivb.ps1 vốn đã được nghiệm thu
    bằng `Test-Public` (hỏi thẳng địa chỉ công khai), chứ không bằng "PID còn
    sống hay không".

    Hướng dẫn đầy đủ: docs/DEPLOY-ROUTER.md

.PARAMETER SkipDuckDns
    Bỏ qua bước cập nhật DNS. Dùng khi tên miền được quản lý ở nơi khác.
#>
[CmdletBinding()]
param(
    [string]$AppRoot      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$CaddyService = 'caddy',
    [string]$CaddyExe     = 'C:\ProgramData\AIVBank\bin\caddy.exe',
    [string]$CaddyConfig  = 'C:\ProgramData\AIVBank\config\Caddyfile',
    [switch]$SkipDuckDns
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --- 1. DNS phải đúng trước khi nói tới TLS ----------------------------
# Thứ tự này không đảo được. Caddy xin chứng chỉ bằng DNS-01, tức là nó đặt
# một bản ghi TXT rồi chờ Let's Encrypt đọc. Việc đó không phụ thuộc bản ghi A.
# Nhưng nếu bản ghi A còn trỏ vào VPS thì học viên vẫn tới VPS, và ở đó không
# còn đầu kia của đường hầm nữa — họ nhận 502 từ nginx, trong khi mọi thứ ở nhà
# đều xanh. Triệu chứng đó rất tốn thời gian để lần ra.
if (-not $SkipDuckDns) {
    $ddns = Join-Path $PSScriptRoot 'Update-DuckDns.ps1'
    if (-not (Test-Path $ddns)) {
        throw "Khong thay $ddns."
    }
    Write-Host '  DuckDNS   dang cap nhat...' -NoNewline
    try {
        & $ddns
        Write-Host ' xong' -ForegroundColor Green
    } catch {
        Write-Host ' HONG' -ForegroundColor Red
        throw "Cap nhat DuckDNS that bai: $($_.Exception.Message)"
    }
}

# --- 2. Caddy ----------------------------------------------------------
$svc = Get-Service -Name $CaddyService -ErrorAction SilentlyContinue

if (-not $svc) {
    # Chua cai service. Khong tu cai o day: viec do can quyen Administrator va
    # can dat DUCKDNS_TOKEN o pham vi Machine truoc. Chi ra dung cho de doc.
    throw @"
Khong thay service '$CaddyService'.

Caddy phai duoc cai lam Windows service truoc. Xem docs/DEPLOY-ROUTER.md buoc 3:
  - tai ban Caddy CO module github.com/caddy-dns/duckdns (ban mac dinh khong co)
  - chep deploy\Caddyfile.template -> $CaddyConfig
  - dat bien moi truong DUCKDNS_TOKEN o pham vi Machine
  - cai service bang WinSW (deploy\caddy-svc.xml.template)

Chi muon chay cuc bo, khong mo ra Internet:  .\scripts\aivb.ps1 up -NoTunnel
"@
}

if ($svc.Status -ne 'Running') {
    Write-Host '  Caddy     dang khoi dong...' -NoNewline
    try {
        Start-Service -Name $CaddyService -ErrorAction Stop
        (Get-Service -Name $CaddyService).WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
        Write-Host ' xong' -ForegroundColor Green
    } catch {
        Write-Host ' HONG' -ForegroundColor Red
        throw @"
Khong khoi dong duoc service '$CaddyService': $($_.Exception.Message)

Xem nhat ky:  Get-Content C:\ProgramData\AIVBank\logs\caddy.log -Tail 40
Kiem cu phap: $CaddyExe validate --config $CaddyConfig
"@
    }
} else {
    Write-Host '  Caddy     da chay' -ForegroundColor DarkGray
}

# --- 3. Cảnh báo sớm về chứng chỉ --------------------------------------
# Caddy tu gia han khi con 1/3 han, nhung viec do chi xay ra neu service duoc
# chay lien tuc VA API DuckDNS con nhan token. Token bi thu hoi la gia han
# that bai am tham, va trieu chung xuat hien dung 30 ngay sau do.
$certRoot = Join-Path $env:ProgramData 'Caddy\certificates'
if (Test-Path $certRoot) {
    $newest = Get-ChildItem -Path $certRoot -Filter '*.crt' -Recurse -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) {
        $age = (Get-Date) - $newest.LastWriteTime
        if ($age.TotalDays -gt 75) {
            Write-Host ("  CANH BAO: chung chi cap cach day {0:N0} ngay, chua thay gia han." -f $age.TotalDays) -ForegroundColor Yellow
            Write-Host '            Kiem C:\ProgramData\AIVBank\logs\caddy.log va token DuckDNS.' -ForegroundColor Yellow
        }
    }
}

# `aivb.ps1` se tu nghiem thu bang Test-Public sau khi script nay thoat.
# Khong tu kiem o day de tranh hai cho cung tra loi mot cau hoi.
