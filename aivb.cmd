@echo off
REM Shortcut for scripts\Server.ps1
REM
REM   aivb up        start everything
REM   aivb down      stop everything
REM   aivb status    show status (default)
REM   aivb logs      show logs
REM   aivb restart   stop then start
REM   aivb up -Build   rebuild the image first (after code changes)
REM
REM up/down/restart need Administrator. Server.ps1 re-launches itself
REM elevated, so you do not have to start an admin prompt yourself.
setlocal
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=status"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Server.ps1" %ACTION% %2 %3 %4
endlocal
