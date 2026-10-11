@echo off
chcp 65001 >nul
title Open a browser the helper can attach to
cd /d "%~dp0"

rem ================================================================
rem  KEEP THIS FILE PURE ASCII.
rem  cmd.exe parses .bat in the OEM codepage (GBK on CN Windows);
rem  UTF-8 Chinese here gets shredded into garbage commands.
rem
rem  This just opens a browser window that cli.mjs can attach to.
rem  READ ONLY in this mode: nothing is clicked, filled or submitted.
rem ================================================================

set "NODEEXE="
if exist "runtime\node.exe" set "NODEEXE=runtime\node.exe"
if not defined NODEEXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODEEXE=node"
)
if not defined NODEEXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Install Node 18+ from https://nodejs.org/
  echo   Or run "node scripts\fetch-node.mjs" on a machine with internet
  echo   and put node.exe into the runtime folder.
  echo.
  pause
  exit /b 1
)

echo.
echo   This opens a browser window that the helper can attach to.
echo.
echo   - Usually you do NOT need this file: just run  start.bat
echo     (it launches the browser itself when needed).
echo   - Use this one if you want to log in FIRST and then run.
echo   - It reuses your normal browser login when possible. That needs
echo     Chrome/Edge to be fully closed; otherwise it falls back to a
echo     helper-only profile where you log in ONCE and it is remembered.
echo.

set "URL="
set /p URL=  Quiz page URL (optional, Enter = just open the browser): 

echo.
"%NODEEXE%" cli.mjs --login "%URL%"
echo.
pause
