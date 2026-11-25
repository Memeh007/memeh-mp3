# Memeh MP3

Paste a YouTube link, get an MP3 or MP4. Memeh MP3 is a small desktop app for Windows and Mac. It runs on your own computer and your own internet, so there is no server, no account, and no password.

Only download content you have the rights to, or that is licensed for reuse.

![Memeh MP3](docs/screenshot.png)

## Download

Grab the installer for your computer from the [latest release](https://github.com/Memeh007/memeh-mp3/releases/latest):

| Computer | File |
| --- | --- |
| Windows 10 or 11 | `Memeh.MP3_2.0.0_x64-setup.exe` (recommended, no admin needed) or `Memeh.MP3_2.0.0_x64_en-US.msi` |
| Mac (Apple Silicon or Intel) | `Memeh.MP3_2.0.0_universal.dmg` |

### Windows install

1. Double-click the setup file.
2. If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**. This shows up because the app is not code signed. It is safe to continue.
3. When it finishes you get a Memeh MP3 shortcut on your Desktop and in the Start menu.

### Mac install

1. Open the `.dmg` and drag **Memeh MP3** into **Applications**.
2. The first time, right-click (or Control-click) the app and choose **Open**, then click **Open** again. If macOS still blocks it, go to **System Settings > Privacy & Security**, scroll down, and click **Open Anyway**. This shows up because the app is not notarized by Apple.

### First launch

The first time you open the app it downloads the YouTube engine (yt-dlp) into the app's own folder. On Windows that is about 24 MB and takes a few seconds. On Mac it is about 95 MB because it also grabs ffmpeg. This happens once. After that the engine checks for updates by itself every couple of days, since YouTube changes often.

## How to use it

1. Paste a YouTube link. It scans the link right away (or click **Scan link**).
2. Choose **MP3** or **MP4**.
3. For MP3, pick 128, 192, or 320 kbps. For MP4, pick 360p, 720p, 1080p, or Best.
4. Click **Extract MP3** or **Extract MP4** and watch the progress bar.
5. Files save to `Downloads\Memeh MP3` (Windows) or `Downloads/Memeh MP3` (Mac). Click **Open folder** to jump there, or **Change** to pick a different folder.
6. Optional: turn on **Include playlist** to grab up to 25 items from a playlist.

Your recent files show up in the download log with **Play** and **Show** buttons. Removing a row from the log does not delete the file.

## Size

The Windows installer is about 4 MB (the .msi is about 7 MB) and the Mac .dmg is about 5 MB. On Windows the app takes about 40 MB once the engine is downloaded. It uses the WebView2 runtime that already comes with Windows 10 and 11, and a tiny custom ffmpeg build that only includes what MP3 and MP4 need.

## Troubleshooting

- **A video fails that used to work:** close and reopen the app. It updates the engine every couple of days. To force an update, delete the `tools` folder in `%LOCALAPPDATA%\com.memeh007.memehmp3` (Windows) or `~/Library/Application Support/com.memeh007.memehmp3` (Mac) and reopen the app.
- **Private, age restricted, or region locked videos** show an error instead of a file.
- **Uninstall:** Windows Settings > Apps > Memeh MP3 > Uninstall. On Mac, drag the app to the Trash.

## Build it yourself

The desktop app lives in `desktop/`. It is a [Tauri 2](https://tauri.app) app: a small Rust backend that drives yt-dlp and ffmpeg, plus the Memeh MP3 web UI.

```
cd desktop
npm install
npx tauri dev      # run it
npx tauri build    # make an installer
```

Pushing a tag like `desktop-v2.0.0` runs `.github/workflows/desktop-release.yml`, which builds the Windows and Mac installers and attaches them to a GitHub release.

The bundled Windows ffmpeg in `desktop/src-tauri/resources/win` was built with `desktop/scripts/build-ffmpeg-min.sh` (FFmpeg 7.1.1 with LAME, LGPL). QuickJS-NG (`qjs.exe`, MIT) is bundled so yt-dlp can solve YouTube's JavaScript checks.

## Old web version

The original browser version (Node.js server, optional private share link) is still in this repo: `server.js`, `start.bat`, and `share.bat`. Run `start.bat` on Windows, or `npm install` then `npm start` elsewhere, and open http://127.0.0.1:5050. The desktop app is the easier way to use Memeh MP3 now.
