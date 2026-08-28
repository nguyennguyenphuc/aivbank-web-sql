<#
.SYNOPSIS
    Đăng ký Scheduled Task chạy Sync-PgCert.ps1 hằng ngày.

.DESCRIPTION
    Chạy trong PowerShell có quyền Administrator:

        .\scripts\Install-CertTask.ps1

    VÌ SAO CẦN:
    Caddy gia hạn chứng chỉ Let's Encrypt khi còn 1/3 hạn — khoảng 60 ngày một
    lần. PostgreSQL giữ một BẢN SAO của chứng chỉ đó trong thư mục dữ liệu, và
    bản sao không tự cập nhật.

    Không có task này thì đúng 90 ngày nữa Power BI đứt với lỗi chứng chỉ hết
    hạn, trong khi console web VẪN CHẠY BÌNH THƯỜNG (Caddy dùng bản mới). Không
    có gì báo, và triệu chứng nằm ở một lane khác hẳn nơi nguyên nhân — đúng kiểu
    hỏng tốn nhiều giờ để lần ra.

    Sync-PgCert.ps1 idempotent: so vân tay trước, không có gì đổi thì thoát ngay
    và không reload PostgreSQL. Chạy hằng ngày là rẻ.

    LƯU Ý VỀ TÀI KHOẢN CHẠY: task cần nói chuyện được với Docker. Đăng ký dưới
    SYSTEM vì nó cũng phải đọc kho chứng chỉ; nếu Docker Desktop từ chối SYSTEM
    thì lần chạy thử ở cuối sẽ báo kết quả khác 0 — khi đó đăng ký lại dưới tài
    khoản của bạn bằng -RunAsUser.
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'AIVBank-SyncPgCert',
    [string]$AtTime   = '03:30',
    # Đổi sang tài khoản hiện tại nếu SYSTEM không dùng được Docker.
    [switch]$RunAsUser
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Phải chạy trong PowerShell có quyền Administrator.'
}

$script = Join-Path $PSScriptRoot 'Sync-PgCert.ps1'
if (-not (Test-Path $script)) { throw "Không thấy $script" }

$argRaw = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"'
$argEsc = $argRaw.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')

$start = (Get-Date).ToString('yyyy-MM-dd') + 'T' + $AtTime + ':00'

if ($RunAsUser) {
    $principal = @"
    <Principal id="Author">
      <UserId>$($id.Name)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
"@
} else {
    # S-1-5-18 = NT AUTHORITY\SYSTEM, dùng SID để không phụ thuộc ngôn ngữ Windows.
    $principal = @"
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
"@
}

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>AIV Bank - dong bo chung chi Let's Encrypt tu Caddy sang PostgreSQL (lane Power BI).</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
$principal
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$argEsc</Arguments>
    </Exec>
  </Actions>
</Task>
"@

Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null
Write-Host "Da dang ky '$TaskName' - chay hang ngay luc $AtTime." -ForegroundColor Green

# Chạy thử ngay: đây là cách duy nhất biết tài khoản chạy có dùng được Docker không.
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 20
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ('  lan chay gan nhat  : ' + $info.LastRunTime)
Write-Host ('  ket qua            : ' + $info.LastTaskResult + '   (0 = thanh cong)')
Write-Host ('  lan chay ke tiep   : ' + $info.NextRunTime)
if ($info.LastTaskResult -ne 0) {
    Write-Warning 'Ket qua khac 0 - nhieu kha nang SYSTEM khong noi duoc voi Docker Desktop.'
    Write-Warning 'Dang ky lai duoi tai khoan cua ban:  .\scripts\Install-CertTask.ps1 -RunAsUser'
}
