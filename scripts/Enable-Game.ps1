<#
.SYNOPSIS
    Bat tab Tro choi (game match-3 trong thu muc game/) tren server dang chay.
    Idempotent.

.DESCRIPTION
        .\scripts\Enable-Game.ps1              # xem truoc, khong doi gi
        .\scripts\Enable-Game.ps1 -Apply       # lam that

    NO LAM GI, THEO THU TU:
    1. khoa `pw_candy_app` trong config\pg_secrets.env (sinh neu chua co)
    2. config\game.env: DATABASE_URL, REDIS_URL, SESSION_SECRET,
       TELEMETRY_HASH_SECRET, AIVB_SSO_SECRET, WEB_ORIGIN (sinh neu chua co)
    3. database/schema/18_game_database.sql: vai tro candy_app + database candy_game
    4. AIVB_GAME_API_URL=http://game-api:3001 vao config\app.env
    5. COMPOSE_PROFILES=game vao docker\.env
    6. docker compose build + up -d (redis, game-migrate, game-api, backend moi)
    7. admin_cli game-sync: dua moi tai khoan AIV Bank sang candy_game

    Tat game: xoa dong AIVB_GAME_API_URL trong config\app.env va dong
    COMPOSE_PROFILES trong docker\.env, roi `docker compose up -d`. Database
    candy_game duoc giu nguyen (tien do choi cua lop).
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
$GameEnv   = Join-Path $RepoRoot 'config\game.env'
$AppEnv    = Join-Path $RepoRoot 'config\app.env'
$ComposeEnv = Join-Path $DockerDir '.env'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Say ([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Ok  ([string]$m) { Write-Host '  [ OK ] ' -ForegroundColor Green  -NoNewline; Write-Host $m }
function Bad ([string]$m) { Write-Host '  [HONG] ' -ForegroundColor Red    -NoNewline; Write-Host $m }
function Warn([string]$m) { Write-Host '  [ ?  ] ' -ForegroundColor Yellow -NoNewline; Write-Host $m }

# Cung thuat toan voi New-PgSecret trong Apply-PgAuth.ps1: chu + so, phan bo
# deu, an toan de dat thang vao URL `postgres://candy_app:<pw>@...`.
function New-Secret([int]$Length = 40) {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $out = New-Object char[] $Length
        $buf = New-Object byte[] 1
        for ($i = 0; $i -lt $Length; $i++) {
            do { $rng.GetBytes($buf) } while ($buf[0] -ge 248)
            $out[$i] = $alphabet[$buf[0] % 62]
        }
        -join $out
    } finally { $rng.Dispose() }
}

function Get-KeyValue([string]$Path, [string]$Key) {
    if (-not (Test-Path $Path)) { return $null }
    $esc = [regex]::Escape($Key)
    # @(...) bat buoc: mot dong khop thi Where-Object tra ve CHUOI, va [0] lay ky tu dau.
    $matched = @([IO.File]::ReadAllText($Path) -split "`r?`n" | Where-Object { $_ -match "^$esc=" })
    if ($matched.Count -eq 0) { return $null }
    if ($matched.Count -gt 1) { throw "$Path co $($matched.Count) dong $Key, mong doi dung 1" }
    ($matched[0] -replace "^$esc=", '').Trim().Split(' ')[0]
}

function Add-Line([string]$Path, [string]$Line) {
    # Them newline truoc neu file cu khong ket thuc bang newline - khong thi
    # khoa moi dinh vao duoi dong truoc va ca hai ben doc deu khong thay no.
    $existing = if (Test-Path $Path) { [IO.File]::ReadAllText($Path) } else { '' }
    $prefix   = if ($existing.Length -gt 0 -and -not $existing.EndsWith("`n")) { "`r`n" } else { '' }
    [IO.File]::AppendAllText($Path, "$prefix$Line`r`n", $Utf8NoBom)
}

Say "`n=== BAT TAB TRO CHOI ===" 'Cyan'

# --- tien de -----------------------------------------------------------
foreach ($p in @($Secrets, $AppEnv, (Join-Path $SchemaDir '18_game_database.sql'), (Join-Path $RepoRoot 'game\package.json'))) {
    if (-not (Test-Path $p)) { throw "Khong thay $p" }
}
Ok 'du file can thiet'

Push-Location $DockerDir
try { $running = (& docker compose ps --status running --services 2>$null) -join ' ' } finally { Pop-Location }
if ($running -notmatch 'postgres') { throw 'Container postgres khong chay. Bat truoc: .\aivb.cmd up' }
Ok 'container postgres dang chay'

# --- 1. pw_candy_app ---------------------------------------------------
$pwCandy = Get-KeyValue $Secrets 'pw_candy_app'
if ($pwCandy) {
    Ok "da co khoa pw_candy_app ($($pwCandy.Length) ky tu)"
} elseif ($Apply) {
    Add-Line $Secrets "pw_candy_app=$(New-Secret 32)"
    $pwCandy = Get-KeyValue $Secrets 'pw_candy_app'
    Ok "da sinh pw_candy_app ($($pwCandy.Length) ky tu) vao config\pg_secrets.env"
} else {
    Warn 'chua co pw_candy_app - se sinh khi chay voi -Apply'
}

# --- 2. config\game.env ------------------------------------------------
if (Test-Path $GameEnv) {
    $url = Get-KeyValue $GameEnv 'DATABASE_URL'
    if ($pwCandy -and $url -and ($url -notmatch [regex]::Escape(":$pwCandy@"))) {
        throw 'config\game.env: DATABASE_URL khong mang pw_candy_app hien tai - sua tay hoac xoa file roi chay lai'
    }
    foreach ($k in 'SESSION_SECRET', 'TELEMETRY_HASH_SECRET', 'AIVB_SSO_SECRET', 'WEB_ORIGIN') {
        if (-not (Get-KeyValue $GameEnv $k)) { throw "config\game.env thieu $k" }
    }
    Ok 'da co config\game.env'
} elseif ($Apply) {
    $origins = @()
    $cors = Get-KeyValue $AppEnv 'AIVB_CORS_ORIGINS'
    if ($cors) { $origins += ($cors -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^https?://' }) }
    $origins += 'http://127.0.0.1:8000', 'http://localhost:8000'
    $lines = @(
        '# Sinh boi scripts/Enable-Game.ps1. Khong viet chu thich sau gia tri.',
        "DATABASE_URL=postgres://candy_app:$pwCandy@postgres:5432/candy_game",
        'REDIS_URL=redis://redis:6379',
        "SESSION_SECRET=$(New-Secret 48)",
        "TELEMETRY_HASH_SECRET=$(New-Secret 48)",
        "AIVB_SSO_SECRET=$(New-Secret 48)",
        "WEB_ORIGIN=$(($origins | Select-Object -Unique) -join ',')"
    )
    [IO.File]::WriteAllText($GameEnv, (($lines -join "`r`n") + "`r`n"), $Utf8NoBom)
    Ok "da sinh config\game.env (WEB_ORIGIN=$(Get-KeyValue $GameEnv 'WEB_ORIGIN'))"
} else {
    Warn 'chua co config\game.env - se sinh khi chay voi -Apply'
}

if (-not $Apply) {
    Say "`nXEM TRUOC - khong doi gi. Se chay:" 'Yellow'
    Say '  3. database/schema/18_game_database.sql (candy_app + candy_game)'
    Say '  4. AIVB_GAME_API_URL vao config\app.env'
    Say '  5. COMPOSE_PROFILES=game vao docker\.env'
    Say '  6. docker compose build + up -d'
    Say '  7. admin_cli game-sync'
    Say "`nChay lai voi -Apply de lam that.`n" 'Yellow'
    exit 0
}

# PowerShell 5.1 bien moi dong stderr cua exe goc (psql NOTICE, tien trinh
# build cua docker) thanh loi ket thuc khi EAP=Stop. Kiem $LASTEXITCODE thay vao.
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location $DockerDir
try {
    # --- 3. database -----------------------------------------------------
    Say "`n[3/7] 18_game_database.sql"
    Get-Content (Join-Path $SchemaDir '18_game_database.sql') -Raw |
        & docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -v pw_candy_app="$pwCandy" 2>&1 |
        Where-Object { $_ -match 'NOTICE:  OK|ERROR' } | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { throw '18_game_database.sql that bai' }
    Ok 'vai tro candy_app + database candy_game'

    # --- 4 & 5. bat cau hinh ---------------------------------------------
    Say "`n[4/7] config\app.env"
    if (Get-KeyValue $AppEnv 'AIVB_GAME_API_URL') { Ok 'da co AIVB_GAME_API_URL' }
    else { Add-Line $AppEnv 'AIVB_GAME_API_URL=http://game-api:3001'; Ok 'da them AIVB_GAME_API_URL' }

    Say "`n[5/7] docker\.env"
    $profiles = Get-KeyValue $ComposeEnv 'COMPOSE_PROFILES'
    if (-not $profiles) { Add-Line $ComposeEnv 'COMPOSE_PROFILES=game'; Ok 'da them COMPOSE_PROFILES=game' }
    elseif ($profiles -split ',' -contains 'game') { Ok "da co COMPOSE_PROFILES=$profiles" }
    else { throw "docker\.env da co COMPOSE_PROFILES=$profiles - them ',game' bang tay" }

    # --- 6. dung va chay ---------------------------------------------------
    Say "`n[6/7] docker compose build + up -d (lan dau mat vai phut: npm ci)"
    & docker compose build backend game-migrate game-api 2>&1 | Select-Object -Last 3 | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { throw 'docker compose build that bai' }
    & docker compose up -d 2>&1 | Where-Object { $_ -match 'Start|Recreat|Creat|Error' } | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up that bai - xem: docker compose logs game-migrate game-api' }
} finally {
    Pop-Location
    $ErrorActionPreference = $savedEAP
}

# --- nghiem thu --------------------------------------------------------
Say "`n=== NGHIEM THU ===" 'Cyan'
$status = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 3
    try {
        $status = (Invoke-WebRequest -Uri 'http://127.0.0.1:8000/game-sso/status' -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json
        $health = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/game/api/health' -TimeoutSec 5 -UseBasicParsing
        if ($status.enabled -and $health.StatusCode -eq 200) { break }
    } catch { }
}
if ($status -and $status.enabled) { Ok 'backend bao game da bat (/game-sso/status)' } else { Bad 'backend chua bat game - xem: docker compose logs backend'; exit 1 }
try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:8000/game/api/health' -TimeoutSec 8 -UseBasicParsing | Out-Null
    Ok 'game-api tra loi qua proxy /game/api/health'
} catch { Bad 'game-api khong tra loi - xem: docker compose logs game-api'; exit 1 }

Say "`n[7/7] dong bo tai khoan"
$ErrorActionPreference = 'Continue'
Push-Location $DockerDir
try {
    & docker compose exec -T backend python -m backend.admin_cli game-sync 2>&1 | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { Bad 'game-sync that bai (SSO luc mo tab van tu tao tai khoan)'; exit 1 }
} finally { Pop-Location }
Ok 'xong. Dang nhap AIV Bank -> tab "Tro choi".'
