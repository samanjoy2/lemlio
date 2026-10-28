@echo off
cd /d "%~dp0"
if not exist "dist-windows\Lemlio.exe" (
  echo Build Lemlio first with: powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -ExecutableName Lemlio.exe
  pause
  exit /b 1
)
start "" "dist-windows\Lemlio.exe"
