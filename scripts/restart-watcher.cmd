@echo off
REM Usage: scripts\restart-watcher.cmd -OldPid 1234 -ExecutablePath "C:\path\to\DSH NEXT\DSH NEXT.exe"
REM Wait for normal exit; never kill processes.
powershell.exe -NoProfile -File "%~dp0restart-watcher.ps1" %*
exit /b %errorlevel%
