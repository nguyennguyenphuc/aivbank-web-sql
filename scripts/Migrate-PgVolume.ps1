<#
.SYNOPSIS
    Doi PGDATA tu layout postgres:16/17 sang layout postgres:18, TAI CHO.

.DESCRIPTION
    Chi can chay tren may ma `Check-PgVolume.ps1` bao "CON O LAYOUT CU".
    Tren may da o layout moi, script nay tu dung lai - dung ep no chay, no se di
    doi mot cum dang khoe.

    Moi buoc deu KHONG PHA HUY cho toi buoc di chuyen, va buoc di chuyen chi la
    `mv` trong cung mot volume.

    ⚠ KHONG BAO GIO dung `docker compose down -v` de "lam sach" - `-v` xoa volume,
    tuc xoa dung thu ta dang cuu.

.EXAMPLE
    .\Migrate-PgVolume.ps1 -WhatIf        # chi soi, khong doi gi
    .\Migrate-PgVolume.ps1 -Backup        # sao luu sang docker_pgdata_backup roi doi
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$VolumeName = 'docker_pgdata',
    [switch]$Backup
)

$ErrorActionPreference = 'Stop'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$DockerDir = Join-Path $RepoRoot 'docker'

function Say ([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok  ([string]$m) { Write-Host '  [ OK ] ' -ForegroundColor Green  -NoNewline; Write-Host $m }
function Bad ([string]$m) { Write-Host '  [HONG] ' -ForegroundColor Red    -NoNewline; Write-Host $m }

function Get-ProbeImage {
    <#
      Anh dung de SOI volume. Yeu cau duy nhat: KHONG duoc co entrypoint cua
      postgres - chinh entrypoint do la thu chay `initdb` va lam cum cu vo hinh,
      tuc dung cai ta dang di ngan.

      Uu tien anh da co san tren may, vi script nay hay duoc chay o cho khong co
      mang. `postgres:18` van dung duoc, nhung CHI khi ep `--entrypoint sh`.
    #>
    # `docker images -q` chu KHONG `docker image inspect`: khi anh vang mat,
    # `inspect` viet ra STDERR, va WinPS 5.1 boc tung dong stderr cua mot exe
    # thanh ErrorRecord - duoi `$ErrorActionPreference='Stop'` thi do la mot loi
    # KET THUC script, ngay ca khi ta da `*> $null`. `images -q` chi im lang va
    # tra ve chuoi rong.
    # `--entrypoint sh` cho MOI anh, khong rieng postgres. Hai cai loi:
    #   - voi `postgres:18` no vo hieu hoa `docker-entrypoint.sh`, tuc khong co
    #     `initdb` nao chay - dung cai ta di ngan;
    #   - loi goi tro thanh dong nhat (`... $img -c <script>`), khong con token
    #     `sh` thua tuy theo anh.
    foreach ($img in @('alpine:latest', 'busybox:latest', 'postgres:18',
                       'docker-backend:latest')) {
        if ((& docker images -q $img | Out-String).Trim()) {
            return @($img, @('--entrypoint', 'sh'))
        }
    }
    # Khong co gi san - keo alpine ve. Loi keo ve KHONG duoc lam script chet
    # bang NativeCommandError, nen ha ErrorActionPreference quanh lenh nay.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & docker pull -q alpine:latest | Out-Null } finally { $ErrorActionPreference = $old }
    if (-not (& docker images -q 'alpine:latest' | Out-String).Trim()) {
        throw 'khong co anh nao de soi volume, va khong keo duoc alpine ve'
    }
    return @('alpine:latest', @('--entrypoint', 'sh'))
}

# MOT DONG, va co y KHONG co dau nhay kep lan `$(...)`. WinPS 5.1 rap lai dong
# lenh cho mot exe bang cach noi chuoi, va no lam hong dau nhay kep long ben
# trong mot doi so - `sh` nhan duoc mot chuoi cut va bao
# `Syntax error: end of file unexpected`. `ls -A | grep -q .` thay cho
# `[ -z "$(ls -A /v)" ]` chinh vi the.
$PROBE_SH = 'if [ -f /v/PG_VERSION ]; then printf OLD:; cat /v/PG_VERSION; elif [ -f /v/18/docker/PG_VERSION ]; then printf NEW:; cat /v/18/docker/PG_VERSION; elif ls -A /v | grep -q .; then echo UNKNOWN; else echo EMPTY; fi'

function Invoke-VolumeProbe([string]$Volume, [switch]$Writable) {
    $img, $extra = Get-ProbeImage
    $mount = if ($Writable) { "${Volume}:/v" } else { "${Volume}:/v:ro" }
    $out = & docker run --rm -v $mount @extra $img -c $PROBE_SH
    return ($out | Out-String).Trim()
}

Say "`n=== DOI LAYOUT PGDATA: $VolumeName ===" 'Cyan'

# --- 1. soi, chi doc -------------------------------------------------------
$probe = Invoke-VolumeProbe -Volume $VolumeName

if ($probe -match '^NEW:') { Ok "da o layout moi ($probe) - KHONG lam gi"; exit 0 }
if ($probe -match '^EMPTY') { Ok 'volume rong - KHONG lam gi'; exit 0 }
if ($probe -notmatch '^OLD:(\d+)') { throw "khong doc duoc trang thai volume: $probe" }

$major = $Matches[1]
Ok "layout cu, PG_VERSION = $major"

if ($major -ne '18') {
    Bad "cum nay la PostgreSQL $major, con image la 18 - postgres:18 KHONG khoi dong noi tren no."
    Say ''
    Say 'Duong di dung la dump/restore, va CO Y khong dung pg_dumpall:' 'Yellow'
    Say '  `02_databases.sql` phai so huu CREATE DATABASE ... BUILTIN_LOCALE ''C''.'
    Say '  Mot ban pg_dumpall se dung lai database voi collation CU, va phep kiem'
    Say '  `SELECT ''a'' < ''B''` cua restore.py ton tai chinh vi loi do vo hinh.'
    Say ''
    Say '  Chi `aivb_app` la khong dung lai duoc; ba database kia nap tu database/dumps/:' 'Yellow'
    Say "    docker run --rm -d --name pgold -v ${VolumeName}:/var/lib/postgresql/data ``"
    Say "      -e POSTGRES_PASSWORD=throwaway -p 55432:5432 postgres:$major"
    Say '    pg_dump -h 127.0.0.1 -p 55432 -U postgres -d aivb_app -Fc -f aivb_app.dump'
    Say '    docker rm -f pgold'
    Say '    # volume moi, docker compose up postgres, chay lai 15 + 16, roi:'
    Say '    pg_restore -h 127.0.0.1 -p 5433 -U postgres -d aivb_app --no-owner --clean --if-exists aivb_app.dump'
    Say '    python database/restore.py restore'
    exit 1
}

if ($WhatIfPreference) { Ok 'WhatIf: dung o day, khong doi gi'; exit 0 }

# --- 2. dung moi ben ghi ---------------------------------------------------
Push-Location $DockerDir
try {
    if ($PSCmdlet.ShouldProcess('docker compose', 'stop backend restore restore-scm postgres')) {
        & docker compose stop backend restore restore-scm postgres | Out-Null
        Ok 'da dung backend + postgres'
    }
} finally { Pop-Location }

# --- 3. sao luu (tuy chon) -------------------------------------------------
if ($Backup) {
    $backupName = "${VolumeName}_backup"
    if ($PSCmdlet.ShouldProcess($backupName, 'sao luu toan bo volume')) {
        & docker volume create $backupName | Out-Null
        $img, $extra = Get-ProbeImage
        & docker run --rm -v "${VolumeName}:/from:ro" -v "${backupName}:/to" @extra $img `
            -c 'cp -a /from/. /to/'
        Ok "da sao luu sang volume '$backupName'"
    }
}

# --- 4. di chuyen ----------------------------------------------------------
# `find -maxdepth 1` chu KHONG `mv /v/* ...`: glob cua sh khong bat file an, va
# PGDATA co ca `.s.PGSQL.*`. Quyen lay dung nhu mot cum khoe:
#   /var/lib/postgresql            999:999  1777
#   /var/lib/postgresql/18         0:0       755
#   /var/lib/postgresql/18/docker  999:0     700
if ($PSCmdlet.ShouldProcess($VolumeName, 'doi PGDATA vao 18/docker')) {
    # Mot dong, khong dau nhay kep - xem chu thich o `$PROBE_SH`.
    # `find -maxdepth 1` chu KHONG `mv /v/*`: glob cua sh khong bat file an.
    $moveSh = @(
        'set -e',
        'test -f /v/PG_VERSION',
        'mkdir -p /v/18/docker',
        'cd /v && find . -maxdepth 1 -mindepth 1 ! -name 18 -exec mv -t /v/18/docker {} +',
        'rm -f /v/18/docker/postmaster.pid /v/18/docker/.s.PGSQL.*',
        'chown 999:999 /v && chmod 1777 /v',
        'chown 0:0 /v/18 && chmod 755 /v/18',
        'chown -R 999:0 /v/18/docker && chmod 700 /v/18/docker'
    ) -join '; '
    $img, $extra = Get-ProbeImage
    & docker run --rm -v "${VolumeName}:/v" @extra $img -c $moveSh
    Ok 'da doi PGDATA sang /var/lib/postgresql/18/docker'
}

# --- 5. nghiem thu ---------------------------------------------------------
Push-Location $DockerDir
try {
    & docker compose up -d postgres | Out-Null
    Start-Sleep -Seconds 3
    $dataDir = (& docker compose exec -T postgres psql -U postgres -Atc 'SHOW data_directory' | Out-String).Trim()
    $dbs     = (& docker compose exec -T postgres psql -U postgres -Atc 'SELECT datname FROM pg_database ORDER BY 1' | Out-String).Trim()
} finally { Pop-Location }

Say "`n=== NGHIEM THU ===" 'Cyan'
if ($dataDir -eq '/var/lib/postgresql/18/docker') { Ok "data_directory = $dataDir" }
else { Bad "data_directory = $dataDir (mong doi /var/lib/postgresql/18/docker)"; exit 1 }

Say '  database:'
$dbs -split "`r?`n" | ForEach-Object { Say "    $_" }

# Danh sach database va so hang `user_rewards` moi la phep do THAT. Collation
# thi khong: mot lan initdb nho van cho ra cum dung collation nhung RONG.
if ($dbs -match 'aivb_app') {
    Push-Location $DockerDir
    try {
        $rewards = (& docker compose exec -T postgres psql -U postgres -d aivb_app -Atc 'SELECT count(*) FROM app.user_rewards' | Out-String).Trim()
    } finally { Pop-Location }
    Ok "app.user_rewards giu duoc $rewards hang"
} else {
    Bad 'KHONG thay aivb_app - lich su co the da mat. Dung lai va kiem ban sao luu.'
    exit 1
}

Say "`nXong. Bat phan con lai:  .\aivb.cmd up" 'Green'
