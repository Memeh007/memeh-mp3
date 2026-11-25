@echo off
cd /d "%~dp0"
title Memeh MP3
echo Memeh MP3 is starting...
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node 18 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\express" (
  echo Installing npm packages...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
echo Checking yt-dlp and ffmpeg...
node install-tools.js
if errorlevel 1 (
  echo Tool setup failed. See the message above.
  pause
  exit /b 1
)
echo Opening http://127.0.0.1:5050
start "" "http://127.0.0.1:5050"
node server.js
if errorlevel 1 pause
