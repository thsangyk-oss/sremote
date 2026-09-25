@echo off
rem S-remote installer — registers auto-start at logon (Task Scheduler)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [S-remote] Node.js not found. Install Node.js 18+ from https://nodejs.org then rerun this file.
  pause
  exit /b 1
)

schtasks /create /f /tn "S-remote" /tr "\"%~dp0start.bat\"" /sc onlogon /rl limited >nul
if errorlevel 1 (
  echo [S-remote] Could not create scheduled task. Right-click install.bat -^> Run as administrator.
  pause
  exit /b 1
)

rem Optional firewall rule for TCP 2209 (needs admin; skipped silently otherwise)
net session >nul 2>&1
if not errorlevel 1 (
  netsh advfirewall firewall add rule name="S-remote" dir=in action=allow protocol=TCP localport=2209 >nul 2>&1
)

schtasks /run /tn "S-remote" >nul 2>&1
echo [S-remote] Installed. Auto-starts at logon; started now.
echo   Local:     http://localhost:2209
echo   Tailscale: http://^<this-machine-tailscale-ip^>:2209
pause
