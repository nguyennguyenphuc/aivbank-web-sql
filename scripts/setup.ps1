<#
.SYNOPSIS
    Dung AIV Bank tren may Windows DA CO PostgreSQL 18 va Python, khong dung
    Docker.

.DESCRIPTION
    Ban Windows cua `setup.sh`. Tu kiem tung buoc va DUNG NGAY khi mot buoc
    truot - chay tiep sau mot buoc hong chi tao ra he thong chay duoc nhung
    sai, kieu hong ton thoi gian nhat.

.EXAMPLE
    .\app\scripts\setup.ps1
#>
[CmdletBinding()]
param(
    [string]$Python = "$env:USERPROFILE\anaconda3\envs\aivbank\python.exe"
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location $AppRoot

function Die($msg) { Write-Error "LOI: $msg"; exit 1 }

# --- 1. Dieu kien can -------------------------------------------------------
if (-not (Test-Path $Python)) {
    $Python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $Python) { Die "khong thay Python" }
}
$psql = (Get-Command psql -ErrorAction SilentlyContinue).Source
if (-not $psql) {
    $guess = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
    if (Test-Path $guess) { $psql = $guess } else { Die "khong thay psql. Cai PostgreSQL 18." }
}
Write-Output "==> Python : $(& $Python --version)"
Write-Output "==> psql   : $(& $psql --version)"

# --- 2. Cau hinh ------------------------------------------------------------
if (-not (Test-Path 'config\app.env')) {
    Copy-Item 'config\.env.example' 'config\app.env'
    Write-Output ""
    Write-Output "Da tao config\app.env tu mau. SUA NO TRUOC KHI CHAY TIEP:"
    Write-Output "  - AIVB_CORS_ORIGINS  = dia chi web that (bo trong = hoc vien tu xa"
    Write-Output "                         khong dang nhap duoc, va KHONG co loi ro rang)"
    Write-Output "  - AIVB_COOKIE_SECURE = 1 neu phuc vu qua HTTPS"
    exit 1
}
if (-not (Test-Path 'config\pg_secrets.env')) { Die "thieu config\pg_secrets.env" }

# --- 3. Thu vien ------------------------------------------------------------
Write-Output "==> cai phu thuoc"
& $Python -m pip install --quiet -r 'docker\requirements.txt'

# --- 4. Database ------------------------------------------------------------
if (Test-Path 'database\dumps\aivb_student.dump') {
    Write-Output "==> phuc hoi database tu ban dump"
    & $Python 'database\restore.py' restore
    if ($LASTEXITCODE -ne 0) { Die "phuc hoi database khong dat nghiem thu" }
} else {
    Write-Output ""
    Write-Output "Khong thay database\dumps\aivb_student.dump."
    Write-Output "Ban dump khong nam trong git (moi file ~1,5-2 GB). Lay tu may cu:"
    Write-Output "    python qa\verify_pg_parity.py --target student   # BAT BUOC truoc"
    Write-Output "    python app\database\restore.py dump"
    Write-Output "roi chep hai file .dump sang day."
    exit 1
}

# --- 5. Chay ----------------------------------------------------------------
Write-Output ""
Write-Output "==> Xong. Chay backend bang:"
Write-Output ""
Write-Output "    cd $AppRoot"
Write-Output "    uvicorn backend.main:app --host 127.0.0.1 --port 8000"
Write-Output ""
Write-Output "Chua co tai khoan nao thi tao truoc, neu khong khong ai dang nhap duoc:"
Write-Output "    python -m backend.admin_cli create-user --username gv001 --role INSTRUCTOR"
