<#
.SYNOPSIS
    Đăng ký Scheduled Task chạy Update-DuckDns6.ps1 mỗi 5 phút, dưới SYSTEM.

.DESCRIPTION
    Chạy trong PowerShell có quyền Administrator:

        .\scripts\Install-DnsTask.ps1

    VÌ SAO ĐĂNG KÝ BẰNG XML, KHÔNG DÙNG New-ScheduledTaskTrigger:

    Đường cmdlet đã trượt ba lần, mỗi lần một kiểu khác nhau:

      1. `-RepetitionInterval` mà không kèm `-RepetitionDuration`
         -> Windows ÂM THẦM bỏ phần lặp. Task tạo ra, trông như thành công,
            nhưng chỉ chạy đúng MỘT lần. Đây là kiểu hỏng tệ nhất.

      2. `-RepetitionDuration ([TimeSpan]::MaxValue)`
         -> sinh ra `P99999999DT23H59M59S`, Task Scheduler từ chối:
            "The task XML contains a value which is incorrectly formatted
            or out of range". Task không được tạo.

      3. Gán thẳng `$trigger.Repetition.Interval`
         -> `.Repetition` là $null khi trigger dựng ra không có phần lặp,
            nên không có thuộc tính nào để gán.

    Trong lược đồ XML gốc của Task Scheduler thì việc này tầm thường: BỎ TRỐNG
    thẻ <Duration> bên trong <Repetition> nghĩa là lặp VÔ HẠN. Không có cách nào
    diễn đạt điều đó qua tham số của cmdlet, nên dùng thẳng XML.

    VÌ SAO TASK NÀY QUAN TRỌNG: tiền tố IPv6 của nhà mạng gắn với lease PPPoE
    khoảng 23 giờ. Hết lease, tiền tố đổi, bản ghi AAAA trỏ vào địa chỉ không còn
    tồn tại. Học viên dùng IPv6 mất truy cập; học viên IPv4 vẫn vào được qua VPS
    nên bạn KHÔNG nhận ra ngay — đó mới là chỗ khó chịu.
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'AIVBank-DuckDNS6',
    [int]$Minutes = 5
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Phải chạy trong PowerShell có quyền Administrator.'
}

$script = Join-Path $PSScriptRoot 'Update-DuckDns6.ps1'
if (-not (Test-Path $script)) { throw "Không thấy $script" }

# XML không cho phép & < > nằm trần trong nội dung thẻ.
$argRaw = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"'
$argEsc = $argRaw.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')

# StartBoundary lùi về quá khứ một phút để nhịp lặp bắt đầu ngay, không phải chờ.
$start = (Get-Date).AddMinutes(-1).ToString('yyyy-MM-ddTHH:mm:ss')

# S-1-5-18 = NT AUTHORITY\SYSTEM. Dùng SID chứ không dùng tên, để không phụ thuộc
# ngôn ngữ của Windows.
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>AIV Bank - cap nhat ban ghi AAAA cua DuckDNS moi $Minutes phut.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${Minutes}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
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
Write-Host "Da dang ky '$TaskName' - chay moi $Minutes phut duoi SYSTEM." -ForegroundColor Green

# Xác nhận phần lặp THẬT SỰ vào được. Đây đúng là chỗ hai lần trước hỏng im lặng,
# nên kiểm chứ không tin.
$t = Get-ScheduledTask -TaskName $TaskName
$rep = ($t.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } |
        Select-Object -First 1).Repetition
if ($rep) {
    $d = $rep.Duration
    if (-not $d) { $d = '(vo han)' }
    Write-Host ('  nhip lap           : ' + $rep.Interval + '   thoi luong ' + $d)
} else {
    Write-Warning 'KHONG thay nhip lap - task se chi chay mot lan. Dung lai va bao.'
}

# Chạy thử ngay, thay vì chờ 5 phút rồi mới phát hiện hỏng.
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 10
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ('  lan chay gan nhat   : ' + $info.LastRunTime)
Write-Host ('  ket qua             : ' + $info.LastTaskResult + '   (0 = thanh cong)')
Write-Host ('  lan chay ke tiep    : ' + $info.NextRunTime)
if ($info.LastTaskResult -ne 0) {
    Write-Warning 'Ket qua khac 0. Xem nhat ky: C:\ProgramData\AIVBank\logs\duckdns.log'
}
