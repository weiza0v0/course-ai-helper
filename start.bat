@echo off
chcp 65001 >nul
title AI 答题助手（Terminal edition）
cd /d "%~dp0"

set "NODEEXE="
if exist "runtime\node.exe" set "NODEEXE=runtime\node.exe"
if not defined NODEEXE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODEEXE=node"
)
if not defined NODEEXE (
  echo.
  echo   [ERROR] Node.js not found. Install Node 18+ from https://nodejs.org/
  echo   Or put a portable node.exe into the "runtime" folder
  echo   (run:  node scripts\fetch-node.mjs  on another machine).
  echo.
  pause
  exit /b 1
)

echo.
echo   在线课程 AI 答题助手 - Terminal edition
echo   ------------------------------------------------
echo   Platform: mooc = 中国大学MOOC / chaoxing = 超星 / zhihuishu = 智慧树
echo.
set "PLAT="
set /p PLAT=  Platform [mooc/chaoxing/zhihuishu]: 
if "%PLAT%"=="" set "PLAT=mooc"
echo.
set "URL="
set /p URL=  Page URL: 
if "%URL%"=="" (
  echo   No URL given - listing open tabs instead...
  "%NODEEXE%" cli.mjs %PLAT% --list
  echo.
  pause
  exit /b 0
)

"%NODEEXE%" cli.mjs %PLAT% "%URL%"
echo.
pause
