<#
.SYNOPSIS
    Bật / tắt / xem trạng thái toàn bộ hệ thống AIV Bank bằng MỘT lệnh.

.DESCRIPTION
    KHÁC `scripts\aivb.ps1`: file đó viết cho bản cài bare-metal (relay + uvicorn
    chạy thẳng trên Windows + đường hầm). Nó hard-fail vì không có
    `pg_source_relay.py`, và còn cố dựng một uvicorn THỨ HAI tranh cổng 8000 với
    container. Đừng dùng nó cho bản triển khai này.

    Bản triển khai thật có bốn tầng, và thứ tự BẬT không đảo được:

        1. Docker Desktop         nền
        2. docker compose         postgres:18 + backend  ->  127.0.0.1:8000
        3. DuckDNS AAAA           tiền tố IPv6 đổi theo lease 23h
        4. service `caddy`        HTTPS cho IPv6  :443      -> 127.0.0.1:8000
           service `aivb-tunnel`  HTTPS cho IPv4  VPS:18000 -> 127.0.0.1:8000

    Tầng 4 trỏ vào cổng 8000. Bật nó trước khi backend lên thì học viên nhận 502
    thay vì một trang chờ — hỏng theo hướng khó hiểu hơn. Vì vậy `up` ĐỢI backend
    healthy rồi mới đụng tới hai service.

    TẮT thì ngược lại: cắt lối vào trước, rồi mới hạ backend.

.PARAMETER Action
    up | down | restart | status | logs

.EXAMPLE
    .\scripts\Server.ps1 up
    .\scripts\Server.ps1 status
    .\scripts\Server.ps1 down
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'down', 'restart', 'status', 'logs')]
    [string]$Action = 'status',

    # Bỏ qua bước cập nhật DuckDNS (khi chỉ muốn chạy trong LAN).
    [switch]$NoDns,

    # Dựng lại image trước khi bật. BẮT BUỘC sau khi sửa mã trong `backend/`
    # hoặc `database/`: `docker compose up` KHÔNG tự dựng lại, nên thiếu cờ này
    # là container vẫn chạy mã cũ trong khi file trên đĩa đã đổi — và không có
    # gì báo, chỉ là hành vi không khớp với mã bạn vừa đọc.
    [switch]$Build,

    # `logs` lấy bao nhiêu dòng cuối.
    [int]$Tail = 60
)

$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$DockerDir  = Join-Path $RepoRoot 'docker'
$Dns6Script = Join-Path $PSScriptRoot 'Update-DuckDns6.ps1'
$LogDir     = 'C:\ProgramData\AIVBank\logs'
$Domain     = 'aivbank.duckdns.org'
$Services   = @('caddy', 'aivb-tunnel')
$DockerExe  = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok  ([string]$m) { Write-Host '  [ OK ] ' -ForegroundColor Green  -NoNewline; Write-Host $m }
function Bad ([string]$m) { Write-Host '  [HONG] ' -ForegroundColor Red    -NoNewline; Write-Host $m }
function Warn([string]$m) { Write-Host '  [ ?  ] ' -ForegroundColor Yellow -NoNewline; Write-Host $m }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Start-Service / Stop-Service đòi quyền quản trị. Tự mở lại cửa sổ nâng quyền
# thay vì báo lỗi rồi bắt gõ lại — nhưng CHỈ khi thật sự cần (up/down/restart).
function Assert-Admin([string]$forAction) {
    if (Test-Admin) { return }
    Say 'Cần quyền Administrator để bật/tắt service. Đang mở lại...' 'Yellow'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), $forAction)
    if ($NoDns) { $argList += '-NoDns' }
    if ($Build) { $argList += '-Build' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
    exit 0
}

function Test-DockerUp {
    try {
        $null = & docker info --format '{{.ServerVersion}}' 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Start-DockerDesktop {
    if (Test-DockerUp) { Ok 'Docker đã chạy'; return }
    if (-not (Test-Path $DockerExe)) { throw "Không thấy $DockerExe" }
    Say '  đang khởi động Docker Desktop (có thể mất 1-2 phút)...'
    Start-Process $DockerExe | Out-Null
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 2
        if (Test-DockerUp) { Ok 'Docker đã sẵn sàng'; return }
    }
    throw 'Docker Desktop không lên sau 3 phút.'
}

function Get-BackendHealth {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 8 -UseBasicParsing
        return ($r.Content | ConvertFrom-Json)
    } catch { return $null }
}

function Wait-Backend([int]$Seconds = 300) {
    Say '  đợi backend healthy...'
    $rounds = [int]($Seconds / 3)
    for ($i = 0; $i -lt $rounds; $i++) {
        $h = Get-BackendHealth
        if ($h -and $h.ok) {
            Ok ('backend healthy — ' + $h.table_count + ' bảng, v' + $h.version)
            return $true
        }
        Start-Sleep -Seconds 3
    }
    Bad "backend chưa healthy sau ${Seconds}s — xem: .\scripts\Server.ps1 logs"
    return $false
}

# Đo bằng curl.exe vì nó ép được -4 / -6. Invoke-WebRequest không chọn được họ
# địa chỉ, nên không phân biệt được đường VPS với đường Caddy — mà đó chính là
# thứ cần phân biệt: hai đường hỏng độc lập với nhau.
function Test-Public([string]$family) {
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (-not (Test-Path $curl)) { return $null }
    $out = & $curl $family '-s' '--max-time' '20' "https://$Domain/health" 2>$null
    if ($out -and (($out -join '') -match '"ok"\s*:\s*true')) { return $true }
    return $false
}

# ------------------------------------------------------------------ up
function Invoke-Up {
    Assert-Admin 'up'
    Say "`n=== BAT AIV Bank ===" 'Cyan'

    Say "`n[1/4] Docker"
    Start-DockerDesktop

    # Chan mot lan `up` lang le xoa lich su. Day la dieu kien DUY NHAT khien
    # `docker compose up` chay `initdb` de len mot cum dang co du lieu: volume
    # con o layout postgres:16/17 (PGDATA o goc) trong khi image la 18 (PGDATA o
    # `<major>/docker`). Xem scripts\Check-PgVolume.ps1.
    $volumeGuard = Join-Path $PSScriptRoot 'Check-PgVolume.ps1'
    if (Test-Path $volumeGuard) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $volumeGuard
        if ($LASTEXITCODE -eq 1) {
            throw 'volume PostgreSQL con o layout cu - chay scripts\Migrate-PgVolume.ps1 truoc'
        }
    }

    Say "`n[2/4] Ứng dụng + PostgreSQL"
    Push-Location $DockerDir
    try {
        $composeArgs = @('compose', 'up', '-d')
        if ($Build) { $composeArgs += '--build'; Say '  dung lai image...' }
        & docker @composeArgs 2>&1 |
            Where-Object { $_ -match 'Creat|Start|Recreat|Error' } |
            ForEach-Object { Say "  $_" }
        if ($LASTEXITCODE -ne 0) { throw 'docker compose up thất bại' }
    } finally { Pop-Location }
    if (-not (Wait-Backend)) { return }

    Say "`n[3/4] DuckDNS (bản ghi AAAA)"
    if ($NoDns) {
        Warn 'bỏ qua theo -NoDns'
    } elseif (Test-Path $Dns6Script) {
        try { & $Dns6Script | Out-Null; Ok 'AAAA đã cập nhật' }
        catch { Warn ('cập nhật AAAA thất bại: ' + $_.Exception.Message) }
    } else {
        Warn "không thấy $Dns6Script"
    }

    Say "`n[4/4] Lối vào từ Internet"
    foreach ($s in $Services) {
        $svc = Get-Service $s -ErrorAction SilentlyContinue
        if (-not $svc) { Warn "$s chưa được cài"; continue }
        if ($svc.Status -ne 'Running') { Start-Service $s; Start-Sleep -Seconds 3 }
        $svc.Refresh()
        if ($svc.Status -eq 'Running') { Ok "$s đang chạy" } else { Bad ("${s}: " + $svc.Status) }
    }

    Invoke-Status
}

# ---------------------------------------------------------------- down
function Invoke-Down {
    Assert-Admin 'down'
    Say "`n=== TAT AIV Bank ===" 'Cyan'

    # Cắt lối vào TRƯỚC. Hạ backend trước thì trong vài giây đó học viên đang
    # truy cập sẽ thấy 502 thay vì mất kết nối — khó chẩn đoán hơn hẳn.
    Say "`n[1/2] Đóng lối vào từ Internet"
    foreach ($s in $Services) {
        $svc = Get-Service $s -ErrorAction SilentlyContinue
        if (-not $svc) { continue }
        if ($svc.Status -eq 'Running') { Stop-Service $s -Force; Ok "$s đã dừng" }
        else { Ok "$s vốn đã dừng" }
    }

    Say "`n[2/2] Ứng dụng + PostgreSQL"
    if (Test-DockerUp) {
        Push-Location $DockerDir
        try {
            # `stop` chứ KHÔNG phải `down`: giữ nguyên container và volume, lần bật
            # sau không phải dựng lại. Dữ liệu ~36 GB nằm trong volume
            # `docker_pgdata`, và `down -v` sẽ XOÁ nó.
            & docker compose stop 2>&1 |
                Where-Object { $_ -match 'Stopp|Error' } |
                ForEach-Object { Say "  $_" }
            Ok 'container đã dừng (dữ liệu giữ nguyên)'
        } finally { Pop-Location }
    } else {
        Warn 'Docker không chạy — bỏ qua'
    }

    Say "`nĐã tắt. Bật lại: .\scripts\Server.ps1 up`n" 'Cyan'
}

# -------------------------------------------------------------- status
function Invoke-Status {
    Say "`n=== TRANG THAI ===" 'Cyan'

    if (Test-DockerUp) { Ok 'Docker đang chạy' } else { Bad 'Docker KHÔNG chạy'; return }

    Say "`nContainer:"
    Push-Location $DockerDir
    try {
        # Khong dung --format: chuoi Go template chua `	` bi truyen nguyen van
        # sang docker, va docker tra loi "format value ... could not be parsed".
        & docker compose ps 2>$null | ForEach-Object { Say "  $_" }
    } finally { Pop-Location }

    Say "`nService Windows:"
    foreach ($s in $Services) {
        $svc = Get-Service $s -ErrorAction SilentlyContinue
        if (-not $svc) { Bad "$s chưa cài" }
        elseif ($svc.Status -eq 'Running') { Ok ("$s (" + $svc.StartType + ')') }
        else { Bad ("${s}: " + $svc.Status) }
    }

    Say "`nTruy cập:"
    $h = Get-BackendHealth
    if ($h -and $h.ok) { Ok ('cục bộ  http://127.0.0.1:8000  — ' + $h.table_count + ' bảng') }
    else { Bad 'cục bộ  http://127.0.0.1:8000 không trả lời' }

    if ((Test-Public '-6') -eq $true) { Ok "IPv6    https://$Domain  (qua Caddy)" }
    else { Bad "IPv6    https://$Domain không trả lời" }

    if ((Test-Public '-4') -eq $true) { Ok "IPv4    https://$Domain  (qua VPS + đường hầm)" }
    else { Bad "IPv4    https://$Domain không trả lời" }

    Say "`nDNS:"
    try {
        $aaaa = (Resolve-DnsName $Domain -Type AAAA -Server 8.8.8.8 -ErrorAction Stop |
                 Where-Object { $_.IPAddress }).IPAddress
        $now = (Get-NetIPAddress -InterfaceAlias Ethernet -AddressFamily IPv6 -ErrorAction SilentlyContinue |
                Where-Object { $_.SuffixOrigin -eq 'Link' -and $_.IPAddress -notlike 'fe80*' } |
                Select-Object -First 1).IPAddress
        if ($aaaa -and $now -and ($aaaa -contains $now)) { Ok "AAAA khớp địa chỉ hiện tại ($now)" }
        elseif ($aaaa) { Bad "AAAA = $aaaa nhưng máy đang là $now — chạy scripts\Update-DuckDns6.ps1" }
        else { Warn 'chưa có bản ghi AAAA' }
    } catch { Warn 'không tra được AAAA' }

    # Task chay duoi SYSTEM voi HighestAvailable, nen ACL cua no chi cho quan tri
    # vien doc. Phien khong nang quyen thay RONG chu khong bao loi - dung suy ra
    # 'task khong ton tai' tu do, vi day la duong `status` chay thuong xuyen nhat.
    $task = Get-ScheduledTask -TaskName 'AIVBank-DuckDNS6' -ErrorAction SilentlyContinue
    if ($task) { Ok ('Scheduled Task AIVBank-DuckDNS6 (' + $task.State + ')') }
    elseif (-not (Test-Admin)) { Warn 'Scheduled Task: khong doc duoc khi chua nang quyen - chay `aivb status` trong cua so Administrator de kiem' }
    else { Bad 'CHUA co Scheduled Task AIVBank-DuckDNS6 - AAAA se chet sau ~23h' }

    Write-Host ''
}

# ---------------------------------------------------------------- logs
function Invoke-Logs {
    Say "`n=== LOG backend ($Tail dòng cuối) ===" 'Cyan'
    Push-Location $DockerDir
    try { & docker compose logs --tail $Tail backend 2>&1 | ForEach-Object { Say "  $_" } }
    finally { Pop-Location }

    foreach ($f in @('caddy.log', 'aivb-tunnel.err.log', 'duckdns.log')) {
        $p = Join-Path $LogDir $f
        if (-not (Test-Path $p)) { continue }
        Say "`n=== $f (10 dòng cuối) ===" 'Cyan'
        Get-Content $p -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Say "  $_" }
    }
    Write-Host ''
}

switch ($Action) {
    'up'      { Invoke-Up }
    'down'    { Invoke-Down }
    'restart' { Invoke-Down; Start-Sleep -Seconds 3; Invoke-Up }
    'status'  { Invoke-Status }
    'logs'    { Invoke-Logs }
}
