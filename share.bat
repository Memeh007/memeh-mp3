@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Memeh MP3 Share
echo Memeh MP3 share is starting...

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

echo Checking yt-dlp, ffmpeg, and cloudflared...
node install-tools.js --cloudflared
if errorlevel 1 (
  echo Tool setup failed. See the message above.
  pause
  exit /b 1
)

if not exist ".env" (
  echo Creating a local share password...
  node -e "const fs=require('fs'); const p=require('crypto').randomBytes(16).toString('hex'); fs.writeFileSync('.env','MEMEH_PASSWORD='+p+'\n'); fs.writeFileSync('SHARE_PASSWORD.txt','Memeh MP3 share password\r\n\r\n'+p+'\r\n\r\nKeep this file private. Share the password only with people you trust.\r\n');"
  if errorlevel 1 (
    echo Could not create a share password.
    pause
    exit /b 1
  )
  echo Password saved to SHARE_PASSWORD.txt
)

set "CF=bin\cloudflared.exe"
if not exist "%CF%" (
  where cloudflared >nul 2>&1
  if errorlevel 1 (
    echo cloudflared was not found. Run node install-tools.js with the cloudflared option.
    pause
    exit /b 1
  )
  set "CF=cloudflared"
)

echo Starting the local server...
start "Memeh MP3 server" /min /d "%~dp0" cmd /c "title Memeh MP3 && node server.js"
timeout /t 3 /nobreak >nul

echo Starting a Cloudflare quick tunnel. The public URL changes each time you restart.
echo The share password is in SHARE_PASSWORD.txt. Do not post it in public.
echo.
if exist "tunnel.log" del /q "tunnel.log" >nul 2>&1
if exist "SHARE_URL.txt" del /q "SHARE_URL.txt" >nul 2>&1

start "Memeh MP3 tunnel" /min /d "%~dp0" cmd /c "title Memeh MP3 tunnel && %CF% tunnel --url http://127.0.0.1:5050 --no-autoupdate >> tunnel.log 2>&1"

echo Waiting for the public URL...
node wait-tunnel.js
if errorlevel 1 (
  pause
  exit /b 1
)

echo Updating the GitHub Pages link...
node publish-link.js
if errorlevel 1 (
  echo The tunnel is up, but the GitHub page was not updated. Friends can still use the URL below for now.
) else (
  echo Friends can use: https://memeh007.github.io/memeh-mp3/
)
echo.
echo Public tunnel URL:
type SHARE_URL.txt
echo.
echo Password file: SHARE_PASSWORD.txt
echo Leave the minimized server and tunnel windows open while friends use the link.
echo The tunnel URL changes each time you restart, but the GitHub link stays the same.
echo.
pause
