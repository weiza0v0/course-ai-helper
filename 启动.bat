@echo off
chcp 65001 >nul
title Online Course AI Helper (Terminal)
cd /d "%~dp0"

rem ============================================================
rem  NOTE: keep this file PURE ASCII.
rem  cmd.exe reads .bat in the OEM codepage (GBK on CN Windows),
rem  so UTF-8 Chinese here would be shredded into garbage commands.
rem ============================================================

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
  echo   Or put a portable node.exe into the "runtime" folder
  echo   - run  node scripts\fetch-node.mjs  on a machine with internet.
  echo.
  pause
  exit /b 1
)

echo.
echo   Online Course AI Helper - Terminal
echo   --------------------------------------------------------
echo   [1] China University MOOC    icourse163.org
echo   [2] Chaoxing / Xuexitong     chaoxing.com
echo   [3] Zhihuishu                zhihuishu.com
echo.
set "PLAT="
set /p PLAT=  Choose platform [1-3, Enter = 1]: 
if "%PLAT%"=="" set "PLAT=1"

echo.
set "URL="
echo   Paste the quiz page URL - OR just press Enter.
echo   If you press Enter, a browser window opens and YOU click into the
echo   quiz page there; the helper finds it by itself. No copy-paste needed.
echo.
set /p URL=  Quiz page URL (Enter = let me open the browser for you): 

echo.
if "%URL%"=="" (
  "%NODEEXE%" cli.mjs %PLAT%
) else (
  "%NODEEXE%" cli.mjs %PLAT% "%URL%"
)
echo.
pause
