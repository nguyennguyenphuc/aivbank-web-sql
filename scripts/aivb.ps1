<#
.SYNOPSIS
    Chạy / dừng / xem trạng thái cả chồng dịch vụ AIV Bank — CHẠY TAY.

.DESCRIPTION
    KHÔNG cài Windows service, KHÔNG tự khởi động cùng máy, KHÔNG cần quyền
    Administrator. Ba tiến trình chạy dưới chính tài khoản của bạn và chết khi
    bạn gọi `down` (hoặc khi máy tắt). Muốn chạy thì gõ; không gõ thì không chạy.

    Đây là bản thay thế cho `Finance\deploy\windows\Aivbank.ps1`, vốn điều khiển
    ba WinSW service. Cùng thứ tự khởi động, cùng phép kiểm, khác ở chỗ không có
    gì được đăng ký với Windows.

.PARAMETER Command
    up      dựng cả ba theo đúng thứ tự, kiểm từng bước
    down    dừng cả ba
    status  xem cái nào đang chạy
    logs    xem log gần nhất

.EXAMPLE
    .\scripts\aivb.ps1 up             # ra internet qua đường hầm SSH tới VPS
    .\scripts\aivb.ps1 up -Router     # ra internet qua router + Caddy ở nhà
    .\scripts\aivb.ps1 up -NoTunnel   # chỉ chạy cục bộ, không mở gì ra ngoài
    .\scripts\aivb.ps1 status
    .\scripts\aivb.ps1 down

.NOTES
    HAI ĐƯỜNG RA INTERNET, CÙNG MỘT CỔNG NGHIỆM THU.

    Mặc định là đường hầm SSH ngược tới VPS, nơi nginx cắt TLS. `-Router` thay
    nó bằng port forwarding trên router nhà cộng Caddy cắt TLS tại chỗ — xem
    docs/DEPLOY-ROUTER.md. Cả hai đều được nghiệm thu bằng `Test-Public`, tức
    là hỏi thẳng $PublicHealthUrl và đòi 200, nên một router cấu hình sai bị
    bắt ở đúng chỗ mà một đường hầm chết từng bị bắt.

    Đường hầm giữ nguyên làm đường lùi: nếu ISP hoá ra dùng CGNAT hoặc chặn
    cổng vào thì forward cổng không bao giờ chạy được.

    THỨ TỰ KHÔNG ĐỔI CHỖ ĐƯỢC: relay → API → lớp ra internet.

      * Lớp ngoài mở cổng công khai. Bật nó trước khi relay sẵn sàng nghĩa là
        học viên nối vào một cổng chưa có gì phía sau.
      * Relay phải có trước, vì nó là thứ làm PostgreSQL nhìn thấy lưu lượng
        internet mang địa chỉ 127.0.0.2. Trỏ thẳng vào 5432 sẽ ÂM THẦM mở lại
        lỗ hổng superuser — xem Finance\deploy\windows\pg_source_relay.py.
        Điều này đúng với CẢ HAI đường: đường hầm forward vào 127.0.0.3:15433,
        và cấu hình router cũng phải đi qua relay, không được trỏ vào 5432.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'down', 'status', 'logs')]
    [string]$Command = 'status',

    # Thư mục ứng dụng. Mặc định là chính thư mục chứa script này.
    [string]$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,

    # Kho chứa `deploy/` — nơi có relay và launcher. KHÔNG chép chúng sang đây:
    # relay là mã liên quan tới bảo mật và `Finance\deploy\tests\
    # test_pg_source_relay.py` đo bản ở đó bằng kết nối thật. Hai bản sao sẽ
    # lệch nhau vào một ngày không ai để ý.
    [string]$DeployRoot = 'D:\Giang-day\Soan bai\Project DA\Finance',

    [string]$EnvFile   = 'C:\ProgramData\AIVBank\config\api.env',
    [string]$PythonExe = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path '.venv\Scripts\python.exe'),
    [string]$LogDir    = 'C:\ProgramData\AIVBank\logs',

    [string]$VmHost     = 'aivb@107.174.93.110',
    [string]$SshKeyFile = "$env:USERPROFILE\.ssh\aivb_tunnel",

    [string]$PublicHealthUrl = 'https://aivbank.duckdns.org/health',

    # Bỏ đường hầm: chạy tất cả cục bộ, không mở gì ra internet. Dùng khi soạn
    # bài hoặc thử tính năng mới.
    [switch]$NoTunnel,

    # Ra internet bằng cách forward cổng trên router thay vì bằng đường hầm SSH
    # qua VPS. Ô "tunnel" khi đó gọi scripts\Start-Edge.ps1 (cập nhật DuckDNS +
    # bảo đảm service Caddy sống) thay cho Start-Tunnel.ps1.
    #
    # Cổng nghiệm thu KHÔNG đổi: vẫn là Test-Public, vẫn hỏi $PublicHealthUrl và
    # vẫn đòi 200. Khác biệt duy nhất là Caddy ở nhà trả lời thay nginx trên VPS.
    # Nhờ vậy một cấu hình router sai vẫn bị bắt ở đúng chỗ mà một đường hầm
    # chết từng bị bắt.
    #
    # Hướng dẫn: docs/DEPLOY-ROUTER.md
    [switch]$Router
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PidDir = Join-Path $env:LOCALAPPDATA 'AIVBank\run'
New-Item -ItemType Directory -Force -Path $PidDir, $LogDir | Out-Null

# Ba tiến trình, và cách nhận ra từng cái còn sống hay không. `Probe` là phép
# kiểm THẬT (có ai đang nghe cổng đó không), không phải "tiến trình còn tồn
# tại" — một tiến trình treo vẫn tồn tại.
$Procs = [ordered]@{
    relay  = @{ Name = 'PgRelay'; Port = 15433; Addr = '127.0.0.3'; Probe = $null }
    api    = @{ Name = 'API';     Port = 8000;  Addr = '127.0.0.1'; Probe = $null }
    tunnel = @{ Name = 'Tunnel';  Port = $null; Addr = $null; Probe = 'public' }
}

function Test-Listening([string]$Addr, [int]$Port) {
    try {
        $c = New-Object Net.Sockets.TcpClient
        $ok = $c.ConnectAsync($Addr, $Port).Wait(1500)
        $c.Close()
        return $ok
    } catch { return $false }
}

function Get-Saved([string]$Key) {
    $f = Join-Path $PidDir "$Key.pid"
    if (-not (Test-Path $f)) { return $null }
    $procId = (Get-Content $f -Raw).Trim()
    if (-not $procId) { return $null }
    return Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
}

function Start-Piece([string]$Key, [string]$Exe, [string[]]$ArgList) {
    $out = Join-Path $LogDir "$Key.out.log"
    $err = Join-Path $LogDir "$Key.err.log"
    # Start-Process nối mảng tham số bằng dấu cách và KHÔNG tự đóng ngoặc, nên
    # mọi đường dẫn có dấu cách sẽ bị cắt làm đôi. Ở đây mọi đường dẫn đều có
    # dấu cách ("Soan bai", "Project DA"), và triệu chứng là một thông báo hoàn
    # toàn không gợi ra nguyên nhân:
    #     can't find '__main__' module in 'D:\\Giang-day\\Soan'
    $quoted = $ArgList | ForEach-Object {
        if ($_ -match '\s' -and $_ -notmatch '^".*"$') { '"' + $_ + '"' } else { $_ }
    }
    $p = Start-Process -FilePath $Exe -ArgumentList $quoted `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    $p.Id | Set-Content -Path (Join-Path $PidDir "$Key.pid") -Encoding ascii
    return $p
}

# --- AI thuc su dang giu cong -------------------------------------------
# `Test-Listening` chi tra loi "co ai do dang nghe khong". Cau hoi dung la
# "co phai TIEN TRINH CUA LENH NAY dang nghe khong". Hai cau khac nhau, va
# ban dau script nay tra loi nham cau thu nhat: mot uvicorn mo coi tu lan
# chay truoc van giu cong 8000, nen `up` in "xong" cho mot tien trinh vua
# chet vi bind truot, con `status` bao "dang chay" cho ban CU.
# Duong ham KHONG nghe cong nao tren may nay, nen "pid con song" khong chung to
# no da noi duoc. Phep kiem that la hoi chinh dia chi cong khai: nginx tren VPS
# chi tra 200 khi ca hai dau da thong. Bo qua buoc nay tung lam `up` in "xong"
# cho mot ssh dang quay vong chet-thu-lai, con web thi tra 502.
function Test-Public([int]$TimeoutSec = 6) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $r = Invoke-WebRequest -Uri $PublicHealthUrl -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Get-ListenerPid([string]$Addr, [int]$Port) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq $Addr } | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return 0
}

# API chay qua mot powershell.exe boc ngoai, nen pid ta luu la pid CUA CAI BOC
# con uvicorn la con cua no. Moi phep so pid phai tinh ca cay con, neu khong
# thi "cong nay cua ai" luon tra loi sai.
function Get-Tree([int]$RootId) {
    $seen = @($RootId)
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue)
    for ($i = 0; $i -lt $seen.Count; $i++) {
        $parent = $seen[$i]
        foreach ($p in $all) {
            if ([int]$p.ParentProcessId -eq $parent -and $seen -notcontains [int]$p.ProcessId) {
                $seen += [int]$p.ProcessId
            }
        }
    }
    return $seen
}

function Get-CmdLine([int]$TargetPid) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction SilentlyContinue
    if ($p) { return [string]$p.CommandLine }
    return '(khong doc duoc dong lenh)'
}

# 'ours'    = cong dang do cay tien trinh ta khoi dong giu
# 'foreign' = co nguoi nghe, NHUNG khong phai cua ta  <- truong hop nguy hiem
# 'none'    = khong ai nghe
function Get-PortState([string]$Key) {
    $meta = $Procs[$Key]
    if ($null -eq $meta.Port) {
        $proc = Get-Saved $Key
        if (-not $proc) { return @{ State = 'none'; Pid = 0; Cmd = '' } }
        if ($meta.Probe -eq 'public' -and -not (Test-Public)) {
            return @{ State = 'dead'; Pid = $proc.Id; Cmd = '' }
        }
        return @{ State = 'ours'; Pid = $proc.Id; Cmd = '' }
    }
    $owner = Get-ListenerPid $meta.Addr $meta.Port
    if ($owner -eq 0) { return @{ State = 'none'; Pid = 0; Cmd = '' } }
    $proc = Get-Saved $Key
    if ($proc -and ((Get-Tree $proc.Id) -contains $owner)) {
        return @{ State = 'ours'; Pid = $owner; Cmd = '' }
    }
    return @{ State = 'foreign'; Pid = $owner; Cmd = (Get-CmdLine $owner) }
}

function Format-Occupied([string]$Name, [string]$Addr, [int]$Port, $St) {
    return @"
$Name khong khoi dong duoc: $($Addr):$($Port) dang bi pid $($St.Pid) giu, va do
khong phai tien trinh do lenh nay tao ra - nhieu kha nang la ban con sot lai tu
lan chay truoc.

    $($St.Cmd)

Neu cu khoi dong de len, tien trinh moi chet ngay vi bind truot con ban CU tiep
tuc phuc vu: ma moi khong bao gio chay, va khong co gi bao loi. Don truoc:

    .\scripts\aivb.ps1 down
"@
}

# Cho den khi CHINH TIEN TRINH TA VUA TAO giu cong. Neu cai boc chet han thi
# hong ngay, khong cho het gio.
function Wait-Ours([string]$Key, [int]$Seconds) {
    for ($i = 0; $i -lt $Seconds; $i++) {
        if ((Get-PortState $Key).State -eq 'ours') { return $true }
        if (-not (Get-Saved $Key)) { return $false }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Show-Tail([string]$Key, [int]$Lines = 15) {
    foreach ($suffix in 'err', 'out') {
        $f = Join-Path $LogDir "$Key.$suffix.log"
        if ((Test-Path $f) -and (Get-Item $f).Length -gt 0) {
            Write-Host "--- $Key.$suffix.log ---" -ForegroundColor DarkGray
            Get-Content $f -Tail $Lines | ForEach-Object { Write-Host "    $_" }
        }
    }
}

function Invoke-Status {
    Write-Host ''
    Write-Host '  AIV Bank — trạng thái (chạy tay, không service)' -ForegroundColor Cyan
    Write-Host ''

    $pg = Test-Listening '127.0.0.1' 5432
    $pg2 = Test-Listening '127.0.0.2' 5432
    Write-Host ("    {0,-10} {1}" -f 'PostgreSQL', $(
        if ($pg -and $pg2) { 'đang chạy (nghe cả .1 và .2)' }
        elseif ($pg) { 'đang chạy — NHƯNG 127.0.0.2 chưa nghe; đường hầm sẽ không nối được' }
        else { 'KHÔNG chạy' }))

    foreach ($key in $Procs.Keys) {
        $meta = $Procs[$key]
        $st = Get-PortState $key
        $proc = Get-Saved $key
        $where = if ($null -eq $meta.Port) { '' } else { ", nghe $($meta.Addr):$($meta.Port)" }
        $state = switch ($st.State) {
            'ours' { "dang chay (pid $($st.Pid)$where)" }
            'foreign' { "CONG BI CHIEM boi pid $($st.Pid) - KHONG phai tien trinh cua lenh nay" }
            'dead' { "TREO - pid $($st.Pid) con song nhung $PublicHealthUrl khong tra 200" }
            default {
                if ($proc) { "TREO - pid $($proc.Id) con song nhung khong nghe $($meta.Addr):$($meta.Port)" }
                else { 'dung' }
            }
        }
        Write-Host ("    {0,-10} {1}" -f $meta.Name, $state)
        if ($st.State -eq 'foreign') {
            Write-Host "               $($st.Cmd)" -ForegroundColor DarkYellow
            Write-Host '               chay `.\scripts\aivb.ps1 down` de don' -ForegroundColor DarkYellow
        }
    }
    Write-Host ''
}

# taskkill in ra stderr khi mot tien trinh con da tu thoat ("could not be
# terminated"), va trong Windows PowerShell 5.1 stderr cua LENH GOC bi boc thanh
# ErrorRecord; voi $ErrorActionPreference = 'Stop' o dau file, no thanh loi ket
# thuc va `down` chet giua chung, bo lai nua chong dich vu dang chay.
#
# Chuyen huong PHAI do chinh cmd lam (`>nul 2>&1` ben trong chuoi), khong phai do
# PowerShell: `... 2>&1 | Out-Null` van di qua duong boc ErrorRecord va van no.
function Stop-Tree([int]$TargetPid) {
    cmd.exe /c "taskkill /PID $TargetPid /T /F >nul 2>&1"
}

function Invoke-Down {
    foreach ($key in @($Procs.Keys) | Sort-Object -Descending) {
        $proc = Get-Saved $key
        if ($proc) {
            Write-Host "  dung $($Procs[$key].Name) (pid $($proc.Id) va tien trinh con)"
            # /T: ca cay. Khong co no thi chi powershell boc ngoai chet, con
            # uvicorn con song tiep va giu cong 8000 - chinh la cach mot ban CU
            # tiep tuc phuc vu sau khi `down` da bao "da dung".
            Stop-Tree $proc.Id
        }
        Remove-Item (Join-Path $PidDir "$key.pid") -ErrorAction SilentlyContinue
    }

    # Quet lai. Chi don nhung tien trinh co dong lenh chi dung vao ung dung nay
    # - khong dung toi server cua nguoi khac tinh co dung chung cong.
    foreach ($key in $Procs.Keys) {
        $meta = $Procs[$key]
        if ($null -eq $meta.Port) { continue }
        $owner = Get-ListenerPid $meta.Addr $meta.Port
        if ($owner -eq 0) { continue }
        $cmd = Get-CmdLine $owner
        $name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
        # WMI tra dong lenh RONG cho mot so tien trinh mo coi (thay hai lan, ca hai
        # lan sau khi cha bi taskkill /T). Khi do van nhan ra duoc: 127.0.0.3:15433
        # va 127.0.0.1:8000 la cong CUA UNG DUNG NAY, va thu dang giu chung ten
        # `python`. Bo qua chung nhu truoc thi `down` bao sach trong khi cong van bi
        # chiem, va `up` sau do tu choi khoi dong.
        $unreadable = (-not $cmd) -or ($cmd -eq '(khong doc duoc dong lenh)')
        if ($cmd -match 'backend\.main|pg_source_relay|uvicorn' -or ($unreadable -and $name -match '^python')) {
            Write-Host "  don tien trinh mo coi $($meta.Name) (pid $owner)" -ForegroundColor Yellow
            Stop-Tree $owner
        } else {
            Write-Host "  CANH BAO: $($meta.Addr):$($meta.Port) van bi pid $owner giu" -ForegroundColor Red
            Write-Host "            $cmd" -ForegroundColor Red
        }
    }
    Write-Host '  da dung.' -ForegroundColor Green
}

function Invoke-Up {
    # --- điều kiện cần, kiểm TRƯỚC khi khởi động gì ---
    foreach ($pair in @(
        @{ Label = 'file môi trường'; Path = $EnvFile },
        @{ Label = 'Python';          Path = $PythonExe },
        @{ Label = 'thư mục backend'; Path = (Join-Path $AppRoot 'backend') },
        @{ Label = 'relay';           Path = (Join-Path $DeployRoot 'deploy\windows\pg_source_relay.py') }
    )) {
        if (-not (Test-Path -LiteralPath $pair.Path)) {
            throw "Không thấy $($pair.Label): $($pair.Path)"
        }
    }
    if (-not (Test-Listening '127.0.0.1' 5432)) {
        throw 'PostgreSQL không chạy. Khởi động service postgresql-x64-18 trước.'
    }
    if (-not (Test-Listening '127.0.0.2' 5432)) {
        throw @'
PostgreSQL chưa nghe trên 127.0.0.2.

`listen_addresses` chỉ đọc LÚC KHỞI ĐỘNG, reload không đủ. Chạy bằng
PowerShell Administrator:

    Restart-Service postgresql-x64-18

Đừng "sửa" bằng cách trỏ đường hầm về 127.0.0.1: làm vậy thì mọi kết nối từ
internet hiện ra với PostgreSQL y hệt kết nối cục bộ, và pg_hba mất hoàn toàn
khả năng phân biệt — superuser bị phơi ra cho cả internet dò mật khẩu.
'@
    }

    Write-Host ''
    Write-Host "  AppRoot   : $AppRoot" -ForegroundColor Cyan
    Write-Host "  EnvFile   : $EnvFile"
    Write-Host "  Python    : $PythonExe"
    Write-Host ''

    # --- 1. relay ---
    $st = Get-PortState 'relay'
    if ($st.State -eq 'foreign') { throw (Format-Occupied 'PgRelay' '127.0.0.3' 15433 $st) }
    if ($st.State -eq 'ours') {
        Write-Host '  PgRelay   da chay'
    } else {
        Write-Host '  PgRelay   dang khoi dong...' -NoNewline
        Start-Piece 'relay' $PythonExe @((Join-Path $DeployRoot 'deploy\windows\pg_source_relay.py')) | Out-Null
        if (-not (Wait-Ours 'relay' 15)) {
            Write-Host ' HONG' -ForegroundColor Red
            Show-Tail 'relay'
            throw 'Relay khong len. Dung lai - khong mo duong ham khi thieu relay.'
        }
        Write-Host ' xong' -ForegroundColor Green
    }

    # --- 2. API ---
    $st = Get-PortState 'api'
    if ($st.State -eq 'foreign') { throw (Format-Occupied 'API' '127.0.0.1' 8000 $st) }
    if ($st.State -eq 'ours') {
        Write-Host '  API       da chay'
    } else {
        Write-Host '  API       dang khoi dong...' -NoNewline
        # Dung lai Start-Api.ps1 cua deploy: no nap api.env mot cach nghiem ngat,
        # ep AIVB_COOKIE_SECURE=1 va bind loopback. Viet lai o day la tao ra mot
        # noi thu hai quyet dinh cac phep kiem do.
        Start-Piece 'api' 'powershell.exe' @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', (Join-Path $DeployRoot 'deploy\windows\Start-Api.ps1'),
            '-EnvFile', $EnvFile,
            '-PythonExe', $PythonExe,
            '-RepoRoot', $DeployRoot,
            '-AppRoot', $AppRoot
        ) | Out-Null
        if (-not (Wait-Ours 'api' 45)) {
            Write-Host ' HONG' -ForegroundColor Red
            Show-Tail 'api'
            throw 'API khong len.'
        }
        Write-Host ' xong' -ForegroundColor Green
    }

    # --- 3. lớp hướng ra internet ---
    # Hai đường, cùng một cổng nghiệm thu (Test-Public):
    #   -Router    forward cổng trên router + Caddy ở nhà cắt TLS
    #   mặc định   đường hầm SSH ngược qua VPS, nginx trên đó cắt TLS
    # Giữ cả hai vì đường thứ hai là đường lùi khi ISP hoá ra dùng CGNAT hoặc
    # chặn cổng vào — xem docs/DEPLOY-ROUTER.md bước 0.
    if ($NoTunnel) {
        Write-Host '  Edge      BỎ QUA (-NoTunnel) — chỉ chạy cục bộ' -ForegroundColor Yellow
    } elseif ($Router) {
        # Start-Edge làm xong rồi thoát — Caddy là service, sống độc lập với
        # phiên này. Vì vậy gọi thẳng, không qua Start-Piece: không có tiến
        # trình dài để theo dấu, và lỗi hiện ngay trên màn hình thay vì chui
        # vào file log.
        $edge = Join-Path $PSScriptRoot 'Start-Edge.ps1'
        if (-not (Test-Path -LiteralPath $edge)) { throw "Khong thay $edge." }
        & $edge -AppRoot $AppRoot

        Write-Host '  Cong khai dang kiem...' -NoNewline
        $ok = $false
        for ($i = 0; $i -lt 15; $i++) {
            if (Test-Public 5) { $ok = $true; break }
            Start-Sleep -Seconds 3
        }
        if ($ok) {
            Write-Host ' xong' -ForegroundColor Green
        } else {
            Write-Host ' HONG' -ForegroundColor Red
            throw @"
$PublicHealthUrl khong tra 200. Relay va API van chay - don bang: .\scripts\aivb.ps1 down

Lan theo docs/DEPLOY-ROUTER.md, bang tra loi o cuoi file. Ba nguyen nhan hay gap:
  1. Router chua forward 443, hoac ISP chan cong vao, hoac dang sau CGNAT (buoc 0)
  2. DuckDNS con tro vao VPS - kiem: nslookup <ten-mien> 8.8.8.8
  3. Caddy chua xin duoc chung chi - kiem: C:\ProgramData\AIVBank\logs\caddy.log

Va nho: KHONG kiem tu trong nha. Nhieu router khong ho tro NAT hairpin, nen goi
vao IP cong khai cua chinh minh se hong du cau hinh dung. Thu tu mang 4G.
"@
        }
    } elseif (Get-Saved 'tunnel') {
        Write-Host '  Tunnel    đã chạy'
    } elseif (-not (Test-Path -LiteralPath $SshKeyFile)) {
        Write-Host "  Tunnel    BỎ QUA — không thấy khoá $SshKeyFile" -ForegroundColor Yellow
    } else {
        Write-Host '  Tunnel    đang khởi động…' -NoNewline
        Start-Piece 'tunnel' 'powershell.exe' @(
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', (Join-Path $DeployRoot 'deploy\windows\Start-Tunnel.ps1'),
            '-VmHost', $VmHost
        ) | Out-Null
        $ok = $false
        for ($i = 0; $i -lt 15; $i++) {
            Start-Sleep -Seconds 3
            if (-not (Get-Saved 'tunnel')) { break }
            if (Test-Public 5) { $ok = $true; break }
        }
        if ($ok) {
            Write-Host ' xong' -ForegroundColor Green
        } else {
            Write-Host ' HONG' -ForegroundColor Red
            Show-Tail 'tunnel'
            throw "Duong ham khong thong: $PublicHealthUrl khong tra 200. Relay va API van chay - don bang: .\scripts\aivb.ps1 down"
        }
    }

    Invoke-Status
    Write-Host '  Kiểm nhanh:  curl http://127.0.0.1:8000/health'
    if (-not $NoTunnel) { Write-Host "  Công khai :  $PublicHealthUrl" }
    if ($Router) {
        # `down` cố ý KHÔNG dừng Caddy: nó gia hạn chứng chỉ khi còn 1/3 hạn, và
        # việc đó chỉ xảy ra nếu service chạy liên tục. Dừng nó qua đêm nhiều
        # lần là hết hạn chứng chỉ vào một ngày không ai chờ.
        Write-Host '  Caddy     chay nhu service, `down` khong dung no (chu y)' -ForegroundColor DarkGray
    }
    Write-Host '  Dừng      :  .\scripts\aivb.ps1 down'
    Write-Host ''
}

switch ($Command) {
    'up'     { Invoke-Up }
    'down'   { Invoke-Down }
    'status' { Invoke-Status }
    'logs'   { foreach ($k in $Procs.Keys) { Show-Tail $k 25 } }
}
