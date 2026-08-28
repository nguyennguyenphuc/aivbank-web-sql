<#
.SYNOPSIS
    Chuyển kho chứng chỉ của Caddy sang chỗ đọc được, KHÔNG xin chứng chỉ mới.

.DESCRIPTION
    Chạy trong PowerShell có quyền Administrator:

        .\scripts\Migrate-CaddyStorage.ps1

    VÌ SAO CẦN:
    Service `caddy` chạy dưới LocalSystem, nên mặc định nó lưu chứng chỉ vào
    C:\Windows\System32\config\systemprofile\AppData\Roaming\Caddy — thư mục mà
    tài khoản thường không đọc được.

    Lane Power BI cần chính chứng chỉ Let's Encrypt đó để PostgreSQL bật TLS mà
    Power BI tin (tick "Encrypt connection" không bị lỗi). Và Caddy GIA HẠN
    khoảng 60 ngày một lần, nên chép tay một lần là hỏng sau hai tháng — phải
    đọc được liên tục, tự động.

    VÌ SAO CHÉP CHỨ KHÔNG ĐỂ CADDY TỰ XIN LẠI:
    Let's Encrypt giới hạn 5 chứng chỉ trùng tên mỗi tuần. Kho rỗng thì Caddy coi
    như chưa có gì và xin mới, tiêu một suất. Chép kho cũ sang thì nó nhận ra
    chứng chỉ còn hạn và không gọi ACME lần nào.

    Caddyfile đã được trỏ sang chỗ mới bằng khối `storage file_system`.
#>
[CmdletBinding()]
param(
    [string]$OldRoot = 'C:\Windows\System32\config\systemprofile\AppData\Roaming\Caddy',
    [string]$NewRoot = 'C:\ProgramData\AIVBank\caddy-data',
    [string]$Domain  = 'aivbank.duckdns.org'
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Phải chạy trong PowerShell có quyền Administrator.'
}

if (-not (Test-Path $OldRoot)) {
    throw "Không thấy kho cũ: $OldRoot"
}

Write-Host 'Dừng service caddy...' -ForegroundColor Cyan
if ((Get-Service caddy -ErrorAction SilentlyContinue).Status -eq 'Running') {
    Stop-Service caddy
}

Write-Host "Chép $OldRoot -> $NewRoot" -ForegroundColor Cyan
New-Item -ItemType Directory -Force $NewRoot | Out-Null
Copy-Item (Join-Path $OldRoot '*') $NewRoot -Recurse -Force

# Dấu ':' ngay sau $env:USERNAME làm PowerShell nuốt luôn vào tên biến.
# Phải bọc $( ) — cùng cái bẫy với "$s:" trong Server.ps1.
$acl = '{0}:(OI)(CI)R' -f $env:USERNAME
Write-Host "Cấp quyền đọc cho $env:USERNAME" -ForegroundColor Cyan
& icacls $NewRoot /grant $acl /T | Out-Null

Write-Host 'Bật lại service caddy...' -ForegroundColor Cyan
Start-Service caddy
Start-Sleep -Seconds 6

$svc = Get-Service caddy
Write-Host ('  service caddy : ' + $svc.Status)

$crt = Get-ChildItem $NewRoot -Recurse -Filter "$Domain.crt" -ErrorAction SilentlyContinue |
       Select-Object -First 1
$key = Get-ChildItem $NewRoot -Recurse -Filter "$Domain.key" -ErrorAction SilentlyContinue |
       Select-Object -First 1

if ($crt -and $key) {
    Write-Host '  chung chi     : OK' -ForegroundColor Green
    Write-Host ('    crt : ' + $crt.FullName)
    Write-Host ('    key : ' + $key.FullName)
} else {
    Write-Warning "Chua thay $Domain.crt / .key trong $NewRoot."
    Write-Warning 'Doi them 30-60s roi chay lai lenh nay, hoac xem C:\ProgramData\AIVBank\logs\caddy.log'
}

# Kiểm rằng Caddy KHÔNG phải xin chứng chỉ mới — nếu có, log sẽ nhắc tới ACME.
$log = 'C:\ProgramData\AIVBank\logs\caddy.log'
if (Test-Path $log) {
    $recent = Get-Content $log -Tail 40 -ErrorAction SilentlyContinue
    if ($recent -match 'obtain') {
        Write-Warning 'Log co dau hieu Caddy XIN chung chi moi (ton mot suat trong han muc 5/tuan).'
    }
}

Write-Host ''
Write-Host 'Xong. Bao lai duong dan .crt/.key o tren.' -ForegroundColor Cyan
