@echo off
REM Wrapper: prefer PowerShell 7 (pwsh) when present, fall back to Windows PowerShell.
setlocal
set SCRIPT=%~dp0check-plugin.ps1
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
endlocal
