@echo off
chcp 65001 >nul
title Browser with debug port - AI helper (READ ONLY mode)
cd /d "%~dp0"

rem ============================================================
rem  Launches Chrome/Edge with a debugging port so the helper can
rem  READ the quiz page (some platforms hide the question text in a
rem  closed Shadow DOM - page scripts cannot see it).
rem
rem  The helper NEVER clicks / fills / submits in this mode.
rem  It only reads the paper and writes an answer sheet for you.
rem ============================================================

set "PORT=9222"
rem  The profile goes to the user folder, NOT into the repo
rem  (it holds login cookies - never commit it)
set "PROFILE=%USERPROFILE%\.course-ai-helper-profile"
set "TARGET=https://passport.zhihuishu.com/login"

set "CHROME="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do (
  if not defined CHROME if exist %%P set "CHROME=%%~P"
)

if not defined CHROME (
  echo.
  echo   [ERROR] Chrome / Edge not found in the usual places.
  echo.
  echo   Please start your browser manually with these flags:
  echo     --remote-debugging-port=%PORT%
  echo     --user-data-dir="%PROFILE%"
  echo.
  echo   Then open the quiz page in it and click the read button
  echo   in the helper web page.
  echo.
  pause
  exit /b 1
)

echo.
echo   Browser : %CHROME%
echo   Port    : %PORT%
echo   Profile : %PROFILE%
  echo             - outside the repo on purpose, it holds login cookies
echo.
echo   1) Log in inside the new window
echo   2) Open the homework page (so you can see the questions)
echo   3) Go back to the helper web page and click "read now"
echo.
echo   NOTE: READ ONLY in this mode - nothing is clicked, filled or submitted.
  echo         For reading only (zhihuishu) you can also just use start.bat.
echo.

start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check "%TARGET%"

timeout /t 2 >nul
exit /b 0
