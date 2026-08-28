<#
.SYNOPSIS
    Cấp chứng chỉ Let's Encrypt của Caddy cho PostgreSQL trong container.

.DESCRIPTION
        .\scripts\Sync-PgCert.ps1

    Không cần quyền Administrator (kho chứng chỉ đã chuyển sang chỗ đọc được
    bằng Migrate-CaddyStorage.ps1), nhưng cần nói chuyện được với Docker.

    VÌ SAO CẦN:
    Power BI có ô "Encrypt connection". Bật nó lên thì Power BI đòi TLS VÀ kiểm
    chứng chỉ theo kho tin cậy của Windows. Hai cách hỏng thường gặp:

      - `ssl = off`  -> "server does not support SSL"  (mặc định của image
        postgres:18 — nó không sinh chứng chỉ nào cả)
      - chứng chỉ tự ký -> lỗi không kiểm chứng được

    Dùng chính chứng chỉ Let's Encrypt mà Caddy đã xin cho aivbank.duckdns.org
    thì cả hai biến mất: LE nằm sẵn trong kho tin cậy của mọi máy Windows.

    HỆ QUẢ CHO HỌC VIÊN: phải nối tới ĐÚNG tên `aivbank.duckdns.org`, không
    phải IP. Chứng chỉ cấp cho tên đó; nối bằng IP sẽ lỗi sai tên.

    IDEMPOTENT: so vân tay trước khi chép. Chạy lại nhiều lần không sao, và
    không reload PostgreSQL vô cớ.

    LỊCH CHẠY: Caddy gia hạn khi chứng chỉ còn 1/3 hạn (khoảng 60 ngày một lần).
    Đăng ký task chạy hằng ngày thì chậm nhất một ngày sau khi gia hạn là
    PostgreSQL có bản mới. Không có nó thì đúng 90 ngày nữa Power BI đứt, và
    console web vẫn chạy bình thường nên không ai nhận ra.
#>
[CmdletBinding()]
param(
    [string]$Domain    = 'aivbank.duckdns.org',
    [string]$CaddyRoot = 'C:\ProgramData\AIVBank\caddy-data',
    [string]$Container = 'docker-postgres-1',
    # Đặt trong thư mục dữ liệu: postgresql.conf mặc định trỏ ssl_cert_file vào
    # 'server.crt' tương đối so với data dir, nên chỉ còn phải bật ssl = on.
    [string]$DataDir   = '/var/lib/postgresql/18/docker',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }

$crt = Get-ChildItem $CaddyRoot -Recurse -Filter "$Domain.crt" -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
$key = Get-ChildItem $CaddyRoot -Recurse -Filter "$Domain.key" -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $crt -or -not $key) {
    throw "Khong thay $Domain.crt / .key trong $CaddyRoot. Chay Migrate-CaddyStorage.ps1 truoc."
}

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($crt.FullName)
$fp   = $cert.Thumbprint
Say ("chung chi Caddy : " + $cert.Subject + "  het han " + $cert.NotAfter.ToString('yyyy-MM-dd'))
Say ("van tay         : " + $fp)

if ((& docker inspect -f '{{.State.Running}}' $Container 2>$null) -ne 'true') {
    throw "Container $Container khong chay."
}

# Vân tay của bản PostgreSQL đang dùng, nếu có.
$inside = & docker exec $Container sh -c "test -f $DataDir/server.crt && openssl x509 -in $DataDir/server.crt -noout -fingerprint -sha1 2>/dev/null || echo none" 2>$null
$insideFp = ''
if ($inside -match '=([0-9A-Fa-f:]+)') { $insideFp = ($matches[1] -replace ':', '').ToUpper() }

if ($insideFp -eq $fp -and -not $Force) {
    Say 'PostgreSQL da dung dung chung chi nay — khong lam gi.' 'Green'
    exit 0
}

Say 'chep chung chi vao container...' 'Cyan'
& docker cp $crt.FullName "${Container}:$DataDir/server.crt" | Out-Null
& docker cp $key.FullName "${Container}:$DataDir/server.key" | Out-Null

# PostgreSQL TU CHOI KHOI DONG neu khoa rieng bi nguoi khac doc duoc. Day la
# kiem tra co that trong ma nguon, khong phai khuyen nghi.
& docker exec $Container sh -c "chown postgres:postgres $DataDir/server.crt $DataDir/server.key && chmod 600 $DataDir/server.key && chmod 644 $DataDir/server.crt" | Out-Null

# `ssl` thuoc nhom SIGHUP nen bat duoc bang reload, khong phai restart.
& docker exec $Container psql -U postgres -Atc "ALTER SYSTEM SET ssl = 'on'" | Out-Null
& docker exec $Container psql -U postgres -Atc "ALTER SYSTEM SET ssl_cert_file = 'server.crt'" | Out-Null
& docker exec $Container psql -U postgres -Atc "ALTER SYSTEM SET ssl_key_file = 'server.key'" | Out-Null
& docker exec $Container psql -U postgres -Atc "SELECT pg_reload_conf()" | Out-Null
Start-Sleep -Seconds 3

$ssl = (& docker exec $Container psql -U postgres -Atc "show ssl" 2>$null) -join ''
if ($ssl -eq 'on') {
    Say 'PostgreSQL: ssl = on' 'Green'
} else {
    Write-Warning "ssl van la '$ssl'. Xem: docker compose logs --tail 30 postgres"
    exit 1
}

# Chứng minh bằng HÀNH VI, không chỉ đọc tham số: mở một kết nối TLS thật.
$probe = (& docker exec $Container psql "host=127.0.0.1 port=5432 dbname=postgres user=postgres sslmode=require" -Atc "select ssl, version, cipher from pg_stat_ssl where pid = pg_backend_pid()" 2>&1) -join ''
Say ("kiem bang ket noi that (pg_stat_ssl) : " + $probe)
