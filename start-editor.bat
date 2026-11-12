@echo off
rem teapot-agent: start the hub and open the editor.
rem Keep this file ASCII-only. Non-ASCII text (with chcp 65001) makes cmd stop reading the file when double-clicked.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [teapot-agent] Node.js is not installed.
  echo Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\ws\package.json" (
  echo [teapot-agent] First run: installing required packages. Please wait...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [teapot-agent] Package installation failed. Check the messages above.
    pause
    exit /b 1
  )
)

rem If the hub is already running, hub.js only opens the editor window and exits.
rem On failure the window stays open so the error message can be read.
start "teapot-hub" /min cmd /c "node server\hub.js --open || pause"
