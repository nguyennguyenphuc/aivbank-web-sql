<#
.SYNOPSIS
    Chan mot `docker compose up` lang le xoa lich su cua cum PostgreSQL.

.DESCRIPTION
    Tu postgres:18, image luu du lieu theo thu muc rieng cho tung major version
    (`/var/lib/postgresql/<major>/docker`), va `docker/docker-compose.yml` vi the
    mount volume vao `/var/lib/postgresql` chu khong vao `.../data` nhu quy uoc
    cua postgres:16/17.

    Hau qua tren mot may CON GIU LAYOUT CU: file PGDATA nam o GOC volume, nen khi
    mount vao diem moi chung roi vao `/var/lib/postgresql/PG_VERSION`, trong khi
    entrypoint nhin vao `/var/lib/postgresql/18/docker`, thay trong, va chay
    `initdb`. Cum cu tro thanh VO HINH - ke ca database `aivb_app` (phien,
    throttle, va toan bo lich su luyen tap ma `16_app_database.sql` sinh ra de
    bao ve).

    Do la dieu kien DUY NHAT khien `docker compose up` xoa lich su ma khong noi
    mot loi nao. Script nay bat dung no, va chi no.

    ⚠ Collation KHONG dung lam phep do duoc: mot lan `initdb` nho se ap
    `POSTGRES_INITDB_ARGS` va cho ra mot cum DUNG collation, RONG HOAN TOAN -
    van qua duoc phep kiem `SELECT 'a' < 'B'` cua `restore.py`.

.EXAMPLE
    .\Check-PgVolume.ps1
    .\Check-PgVolume.ps1 -VolumeName docker_pgdata
#>
[CmdletBinding()]
param(
    [string]$VolumeName = 'docker_pgdata'
)

$ErrorActionPreference = 'Stop'

function Ok  ([string]$m) { Write-Host '  [ OK ] ' -ForegroundColor Green  -NoNewline; Write-Host $m }
function Bad ([string]$m) { Write-Host '  [HONG] ' -ForegroundColor Red    -NoNewline; Write-Host $m }
function Warn([string]$m) { Write-Host '  [ ?  ] ' -ForegroundColor Yellow -NoNewline; Write-Host $m }

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

$exists = (& docker volume ls --format '{{.Name}}') -split "`r?`n" | Where-Object { $_ -eq $VolumeName }
if (-not $exists) {
    Ok "volume '$VolumeName' chua ton tai - lan `up` dau se initdb, dung nhu mong doi"
    exit 0
}

$probe = Invoke-VolumeProbe -Volume $VolumeName

switch -Regex ($probe) {
    '^NEW:(\d+)' {
        Ok "volume '$VolumeName' da o layout moi (PGDATA = /var/lib/postgresql/$($Matches[1])/docker)"
        exit 0
    }
    '^EMPTY' {
        Ok "volume '$VolumeName' rong - lan `up` dau se initdb"
        exit 0
    }
    '^OLD:(\d+)' {
        $major = $Matches[1]
        Bad "volume '$VolumeName' CON O LAYOUT CU (PG_VERSION = $major o goc volume)."
        Write-Host ''
        Write-Host '  `docker compose up` bay gio se chay initdb va lam cum cu VO HINH,' -ForegroundColor Red
        Write-Host '  ke ca database aivb_app (phien, throttle, toan bo lich su diem).' -ForegroundColor Red
        Write-Host ''
        Write-Host '  Di chuyen truoc:  .\scripts\Migrate-PgVolume.ps1 -VolumeName ' -NoNewline
        Write-Host $VolumeName
        Write-Host '  KHONG chay `docker compose down -v`.' -ForegroundColor Yellow
        exit 1
    }
    default {
        Warn "khong doc duoc trang thai volume '$VolumeName': $probe"
        Warn 'Kiem bang tay truoc khi `up`.'
        exit 2
    }
}
