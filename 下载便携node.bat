@echo off
chcp 65001 >nul
title Download portable Node (no Node required)
cd /d "%~dp0"

rem ================================================================
rem  KEEP THIS FILE PURE ASCII (cmd.exe reads .bat in the OEM codepage).
rem
rem  Downloads a portable node.exe into runtime\ using Windows PowerShell.
rem  This is the NO-NODE-NEEDED path - the "fetch-node.mjs" script needs
rem  Node to run, which you may not have yet.
rem ================================================================

set "VER=v22.14.0"
set "URL=https://nodejs.org/dist/%VER%/win-x64/node.exe"
set "DIR=%~dp0runtime"
set "OUT=%DIR%\node.exe"

if not exist "%DIR%" mkdir "%DIR%"
if exist "%OUT%" (
  echo.
  echo   Already present: %OUT%
  echo   Delete it first if you want to re-download.
  echo.
  pause
  exit /b 0
)

echo.
echo   Downloading Node %VER% ^(about 80 MB^) ...
echo   From: %URL%
echo   To  : %OUT%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%URL%' -OutFile '%OUT%' -UseBasicParsing; exit 0 } catch { Write-Host ('  FAILED: ' + $_.Exception.Message); exit 1 }"

if exist "%OUT%" (
  echo.
  echo   Done. You can now run  start.bat
  echo.
) else (
  echo.
  echo   Download failed. You can also download it manually:
  echo     %URL%
  echo   and save it as:  %OUT%
  echo.
)
pause
