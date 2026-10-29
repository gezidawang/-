@echo off
cd /d "%~dp0"
if not exist "prerequisites\VC_redist.x64.exe" (
  echo Download the Microsoft x64 Visual C++ v14 Redistributable from:
  echo https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist
  echo Save it as prerequisites\VC_redist.x64.exe and run this file again.
  pause
  exit /b 1
)
"prerequisites\VC_redist.x64.exe" /install /passive /norestart
echo Installer exit code: %errorlevel%. 0=success, 3010=restart required.
pause
