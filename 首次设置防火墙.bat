@echo off
chcp 65001 >nul
REM Allow inbound TCP 3001 so LAN PCs and the phone can reach this host relay. Auto-elevates.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall show rule name=PCRelay3001 >nul 2>&1 || netsh advfirewall firewall add rule name=PCRelay3001 dir=in action=allow protocol=TCP localport=3001
echo.
echo Done. Inbound TCP 3001 is now allowed.
echo To remove: netsh advfirewall firewall delete rule name=PCRelay3001
pause
