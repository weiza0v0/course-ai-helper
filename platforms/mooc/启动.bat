@echo off
chcp 65001 >nul
title MOOC AI Helper
cd /d "%~dp0"

set "NODEEXE="
if exist "runtime\node.exe" set "NODEEXE=runtime\node.exe"

if not defined NODEEXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODEEXE=node"
)

if not defined NODEEXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Please install Node.js 18 or newer from https://nodejs.org/
  echo   Or put a portable node.exe into the "runtime" folder.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting MOOC AI Helper ... a browser window will open.
echo   Keep this window open. Press Ctrl+C or close it to stop.
echo.
"%NODEEXE%" server.mjs
pause
