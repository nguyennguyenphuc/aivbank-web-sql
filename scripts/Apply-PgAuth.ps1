<#
.SYNOPSIS
    Áp kiến trúc xác thực PostgreSQL lên một server đang chạy. Idempotent.

.DESCRIPTION
        .\scripts\Apply-PgAuth.ps1              # xem trước, không đổi gì
        .\scripts\Apply-PgAuth.ps1 -Apply       # làm thật

    KHÔNG cần quyền Administrator: mọi thứ chạy qua Docker, không đụng service
    Windows nào.

    ---------------------------------------------------------------------
    NÓ LÀM GÌ, THEO ĐÚNG THỨ TỰ NÀY
    ---------------------------------------------------------------------
    1. `15_class_roles.sql`   hai nhóm lớp, trần kết nối database, và
                              `scram_iterations = 100000`
    2. `16_app_database.sql`  database `aivb_app`: phiên, chặn đăng nhập sai,
                              gamification, và vai trò ghi `aivb_app_rw`
    3. `14_pg_hba_docker.conf` nạp vào container rồi reload
    4. dựng lại image + tạo lại container

    THỨ TỰ KHÔNG ĐẢO ĐƯỢC. Bước 1 đặt `scram_iterations`, mà giá trị đó chỉ áp
    LÚC ĐẶT MẬT KHẨU — chạy bước 2 trước thì `aivb_app_rw` có mật khẩu băm bằng
    4096 vòng PBKDF2 thay vì 100000, và không có gì báo.

    ---------------------------------------------------------------------
    CÁI NÓ KHÔNG LÀM
    ---------------------------------------------------------------------
    Di trú tài khoản từ SQLite. Đó là việc CHẠY MỘT LẦN và nó đổi mật khẩu của
    cả lớp, nên nó không được nằm trong một script idempotent mà người ta chạy
    lại cho chắc:

        docker compose exec backend python database/migrate_auth_to_pg.py
        docker compose exec backend python database/migrate_auth_to_pg.py --apply
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$DockerDir = Join-Path $RepoRoot 'docker'
$SchemaDir = Join-Path $RepoRoot 'database\schema'
$Secrets   = Join-Path $RepoRoot 'config\pg_secrets.env'
# Suy ra thay vi hardcode: duong dan nay dich chuyen theo layout PGDATA (tu
# postgres:18 la `/var/lib/postgresql/<major>/docker`). Hoi chinh may chu.
$HbaPath   = $null   # dat sau khi da xac nhan container chay - xem duoi

function Say ([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok  ([string]$m) { Write-Host '  [ OK ] ' -ForegroundColor Green  -NoNewline; Write-Host $m }
function Bad ([string]$m) { Write-Host '  [HONG] ' -ForegroundColor Red    -NoNewline; Write-Host $m }
function Warn([string]$m) { Write-Host '  [ ?  ] ' -ForegroundColor Yellow -NoNewline; Write-Host $m }

function New-PgSecret([int]$Length = 32) {
    # Boc TUNG ky tu tu bang 62 ky tu. KHONG dung base64 roi loc:
    # 24 byte -> DUNG 32 ky tu base64, va viec bo `+`/`/` (moi cai 2/64 mot ky
    # tu) de lai it hon 32 ky tu voi xac suat 1-(62/64)^32 ~ 64%. Luc do
    # `.Substring(0, 32)` nem ArgumentOutOfRangeException va ca lan `-Apply`
    # chet - HAI LAN TRONG BA LAN CHAY.
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $out = New-Object char[] $Length
        $buf = New-Object byte[] 1
        for ($i = 0; $i -lt $Length; $i++) {
            # 256 khong chia het cho 62. Bo 248..255 roi boc lai thi phan bo deu
            # tuyet doi; trung binh ton 1,03 byte moi ky tu.
            # (`RandomNumberGenerator::GetInt32` la .NET Core 3.0+, KHONG co
            #  trong Windows PowerShell 5.1 - no chay .NET Framework 4.8.)
            do { $rng.GetBytes($buf) } while ($buf[0] -ge 248)
            $out[$i] = $alphabet[$buf[0] % 62]
        }
        -join $out
    } finally { $rng.Dispose() }
}

function Add-PgSecretLine([string]$Path, [string]$Line) {
    # `Add-Content` chi them noi dung + newline O CUOI. Neu file cu khong ket
    # thuc bang newline thi khoa moi dinh vao duoi dong truoc:
    #     pw_bi_i=xyz pw_app_rw=abc
    # va CA HAI ben doc deu khong thay no: `restore.py` va `config.py` lay phan
    # TRUOC dau cach dau tien (nen pw_bi_i van dung, con pw_app_rw bien mat), va
    # regex `(?m)^pw_app_rw=` cung khong khop - nen lan chay sau lai sinh them
    # mot khoa nua, mai mai.
    #
    # `UTF8Encoding($false)` = KHONG BOM. Python doc file nay, va mot BOM se lam
    # khoa DAU TIEN cua file thanh "﻿pw_loader".
    $existing = if (Test-Path $Path) { [IO.File]::ReadAllText($Path) } else { '' }
    $prefix   = if ($existing.Length -gt 0 -and -not $existing.EndsWith("`n")) { "`r`n" } else { '' }
    [IO.File]::AppendAllText($Path, "$prefix$Line`r`n", (New-Object System.Text.UTF8Encoding($false)))
}

function Get-PgSecretValue([string]$Path, [string]$Key) {
    # @(...) BAT BUOC. `Where-Object` tra ve mot CHUOI khi chi khop mot dong, va
    # `[0]` tren mot chuoi lay KY TU DAU TIEN - tuc la 'p' cua 'pw_app_rw='.
    # Da mac dung bay nay: mat khau cua aivb_app_rw bi dat thanh mot chu 'p',
    # backend mat ket noi toi aivb_app, va trieu chung la DANG NHAP WEB HONG
    # trong khi /health van tra 200 (no chi doc dataset). Mat mot luc moi lan ra.
    $text    = [IO.File]::ReadAllText($Path)
    $esc     = [regex]::Escape($Key)
    $matched = @($text -split "`r?`n" | Where-Object { $_ -match "^$esc=" })
    if ($matched.Count -ne 1) { throw "pg_secrets.env co $($matched.Count) dong $Key, mong doi dung 1" }
    $value = ($matched[0] -replace "^$esc=", '').Trim().Split(' ')[0]
    if ($value.Length -lt 8) { throw "gia tri $Key doc duoc chi $($value.Length) ky tu - doc sai file" }
    $value
}

# --- kiểm tiền đề ------------------------------------------------------
Say "`n=== AP KIEN TRUC XAC THUC PostgreSQL ===" 'Cyan'
Push-Location $DockerDir
try {
    $running = (& docker compose ps --status running --services 2>$null) -join ' '
} finally { Pop-Location }
if ($running -notmatch 'postgres') {
    throw "Container postgres khong chay. Bat truoc: .\aivb.cmd up"
}
Ok 'container postgres dang chay'

Push-Location $DockerDir
try {
    $HbaPath = (& docker compose exec -T postgres psql -U postgres -Atc 'SHOW hba_file').Trim()
} finally { Pop-Location }
if ([string]::IsNullOrWhiteSpace($HbaPath)) { throw 'Khong hoi duoc hba_file tu may chu' }
Ok "pg_hba.conf o $HbaPath"

foreach ($f in @('15_class_roles.sql', '16_app_database.sql', '14_pg_hba_docker.conf')) {
    if (-not (Test-Path (Join-Path $SchemaDir $f))) { throw "Khong thay database\schema\$f" }
}
Ok 'du ba file lo do'

# `pw_app_rw` la khoa MOI so voi ban SQLite. Sinh neu chua co - nhung chi khi
# -Apply: xem truoc thi khong duoc ghi vao file bi mat.
# `[IO.File]::ReadAllText` chu khong `Get-Content -Raw`: khong co `-Encoding`,
# WinPS 5.1 giai ma file khong BOM bang ANSI codepage, khac voi Python.
$secretText = [IO.File]::ReadAllText($Secrets)
if ($secretText -notmatch '(?m)^pw_app_rw=') {
    if (-not $Apply) {
        Warn 'chua co khoa pw_app_rw - se sinh moi khi chay voi -Apply'
        $pwAppRw = '<se-sinh>'
    } else {
        Add-PgSecretLine -Path $Secrets -Line "pw_app_rw=$(New-PgSecret 32)"
        # DOC LAI tu file thay vi dung bien vua sinh: phep doc nay nghiem thu
        # luon buoc ghi (newline, ma hoa, trung dong), va cho gia tri vua sinh
        # di qua dung phep kiem do dai ma nhanh kia dung. Hong thi hong O DAY,
        # khong phai o lan chay sau khi khoa da bi sinh trung hai lan.
        $pwAppRw = Get-PgSecretValue -Path $Secrets -Key 'pw_app_rw'
        Ok "da sinh khoa pw_app_rw ($($pwAppRw.Length) ky tu) va ghi vao config\pg_secrets.env"
    }
} else {
    $pwAppRw = Get-PgSecretValue -Path $Secrets -Key 'pw_app_rw'
    Ok "da co khoa pw_app_rw ($($pwAppRw.Length) ky tu)"
}

if (-not $Apply) {
    Say "`nXEM TRUOC - khong doi gi. Se chay theo thu tu:" 'Yellow'
    Say '  1. database/schema/15_class_roles.sql    (nhom lop, tran ket noi, scram_iterations)'
    Say '  2. database/schema/16_app_database.sql   (database aivb_app + vai tro ghi)'
    Say '  3. nap 14_pg_hba_docker.conf roi reload'
    Say '  4. docker compose build + up -d'
    Say "`nChay lai voi -Apply de lam that.`n" 'Yellow'
    exit 0
}

# PowerShell 5.1 bien MOI DONG stderr cua mot exe goc thanh loi ket thuc khi
# `$ErrorActionPreference = 'Stop'`. `psql` in NOTICE ra stderr, nen cac lenh
# duoi day se "that bai" ngay o dong NOTICE dau tien du chung chay dung.
# Ha xuong 'Continue' va kiem $LASTEXITCODE tuong minh thay vi tin vao ngoai le.
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

Push-Location $DockerDir
try {
    # --- 1 & 2: lược đồ ------------------------------------------------
    Say "`n[1/4] 15_class_roles.sql"
    Get-Content (Join-Path $SchemaDir '15_class_roles.sql') -Raw |
        & docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 2>&1 |
        Where-Object { $_ -match 'NOTICE:|ERROR' } | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { throw '15_class_roles.sql that bai' }
    Ok 'nhom lop + tran ket noi + scram_iterations'

    Say "`n[2/4] 16_app_database.sql"
    Get-Content (Join-Path $SchemaDir '16_app_database.sql') -Raw |
        & docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -v pw_app_rw="$pwAppRw" 2>&1 |
        Where-Object { $_ -match 'NOTICE:  OK|ERROR' } | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { throw '16_app_database.sql that bai' }
    Ok 'database aivb_app + vai tro aivb_app_rw'

    # --- 3: pg_hba -----------------------------------------------------
    Say "`n[3/4] pg_hba.conf"
    # `docker cp` chu KHONG phai `Get-Content | docker exec`: ong cua PowerShell
    # ma hoa lai noi dung va them BOM UTF-8 vao dau file. PostgreSQL doc BOM do
    # thanh mot kieu ket noi rac -> `invalid connection type` ngay dong 1.
    # `docker cp` chuyen nguyen byte.
    $cid = (& docker compose ps -q postgres).Trim()
    & docker cp (Join-Path $SchemaDir '14_pg_hba_docker.conf') "${cid}:$HbaPath" | Out-Null
    & docker compose exec -T postgres sh -c "chown postgres:postgres $HbaPath && chmod 600 $HbaPath"
    & docker compose exec -T postgres psql -U postgres -Atc 'SELECT pg_reload_conf()' | Out-Null
    Start-Sleep -Seconds 2
    $bad = (& docker compose exec -T postgres psql -U postgres -Atc `
        'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL' 2>$null) -join ''
    if ($bad -ne '0') { throw "pg_hba co $bad dong loi - PostgreSQL van dung luat CU" }
    Ok 'pg_hba nap sach, 0 dong loi'

    # --- 4: ứng dụng ---------------------------------------------------
    Say "`n[4/4] dung lai image va tao lai container"
    & docker compose build backend restore 2>&1 | Select-Object -Last 1 | ForEach-Object { Say "  $_" }
    & docker compose up -d 2>&1 | Where-Object { $_ -match 'Start|Recreat|Error' } | ForEach-Object { Say "  $_" }
} finally {
    Pop-Location
    $ErrorActionPreference = $savedEAP
}

# --- nghiệm thu --------------------------------------------------------
Say "`n=== NGHIEM THU ===" 'Cyan'
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 3
    try {
        $h = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 5 -UseBasicParsing
        if (($h.Content | ConvertFrom-Json).ok) { break }
    } catch { }
}
try {
    $h = (Invoke-WebRequest -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 8 -UseBasicParsing).Content | ConvertFrom-Json
    Ok "backend healthy - $($h.table_count) bang, v$($h.version)"
} catch { Bad 'backend khong tra loi - xem: .\aivb.cmd logs'; exit 1 }

$ErrorActionPreference = 'Continue'
Push-Location $DockerDir
try {
    $iter = (& docker compose exec -T postgres psql -U postgres -Atc 'SHOW scram_iterations' 2>$null) -join ''
    if ([int]$iter -ge 100000) { Ok "scram_iterations = $iter" }
    else { Bad "scram_iterations = $iter (mong doi >= 100000)" }

    # Bat doi xung chong ro dap an - phep kiem quan trong nhat.
    $leak = (& docker compose exec -T postgres psql -U postgres -Atc `
        "SELECT has_database_privilege('aivb_class_student','aivb_instructor','CONNECT')" 2>$null) -join ''
    if ($leak -eq 'f') { Ok 'hoc vien KHONG co CONNECT tren aivb_instructor' }
    else { Bad 'DUNG LAI: hoc vien co CONNECT tren aivb_instructor - ro ri dap an cham bai'; exit 1 }

    # /health CHI doc dataset - no van tra 200 khi backend mat ket noi toi
    # aivb_app, va khi do dang nhap hong trong im lang. Phai kiem rieng.
    $poolErr = (& docker compose logs --tail 40 backend 2>$null) -join "`n"
    if ($poolErr -match 'password authentication failed for user "aivb_app_rw"|PoolTimeout') {
        Bad 'backend KHONG noi duoc toi aivb_app - dang nhap web se hong'
        Say '    kiem: docker compose logs --tail 30 backend'
        exit 1
    }
    Ok 'backend noi duoc toi aivb_app'

    $n = (& docker compose exec -T postgres psql -U postgres -d aivb_app -Atc `
        'SELECT count(*) FROM pg_roles r WHERE app.role_of(r.rolname) IS NOT NULL' 2>$null) -join ''
    Ok "$n tai khoan cua lop trong pg_authid"
    if ($n -eq '0') {
        Warn 'chua co tai khoan nao. Neu den tu ban SQLite thi chay:'
        Say  '    docker compose exec backend python database/migrate_auth_to_pg.py --apply'
    }
} finally { Pop-Location }

Say "`nXong. Kiem tong the: .\aivb.cmd status`n" 'Cyan'
