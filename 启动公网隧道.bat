@echo off
cd /d "%~dp0"
title Campus Bell
if not exist "bin\node.exe" (
  echo [ERROR] Missing bin\node.exe. Extract the complete package first.
  pause
  exit /b 1
)
"bin\node.exe" "runtime\launcher.mjs" relay "."
if errorlevel 1 (
  echo [ERROR] Startup failed. This build requires Windows 10/11 x64.
  echo For runtime errors, run install-runtime.bat. Windows 7 needs a separate compatible agent.
  pause
)
