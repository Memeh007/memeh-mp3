# Memeh MP3

A localhost app that turns a YouTube link into an MP3 or MP4 on your computer. You can keep it to yourself, or share a private web link with friends. The link is password protected and hidden from search engines. It only works while this computer is on.

Only download content you have the rights to, or that is licensed for reuse.

![Memeh MP3](docs/screenshot.png)

## Requirements

- Node.js 18 or newer

## Windows

1. Download the ZIP from this repo and unzip it.
2. Double-click `start.bat`.
3. Your browser should open http://127.0.0.1:5050

The first run may take a minute while it installs packages and, if needed, yt-dlp and ffmpeg into the app's bin folder. Admin rights are not required. Leave the window open while you use the app.

## macOS and Linux

```
npm install
node install-tools.js
npm start
```

Then open http://127.0.0.1:5050

If you prefer system packages on macOS, you can install the tools with Homebrew instead of `install-tools.js`:

```
brew install yt-dlp ffmpeg
npm install
npm start
```

## How to use it

1. Paste a YouTube URL.
2. Choose MP3 or MP4.
3. For MP3, pick 128, 192, or 320 kbps. For MP4, pick 360p, 720p, 1080p, or best.
4. Click Scan link to see the title, artwork, and length.
5. Click Extract MP3 or Extract MP4. Watch the progress bar fill, then save the file.
6. Optional: turn on Include playlist to convert up to 25 items from a playlist.

Recent files appear in the download log. They stay available for a couple of hours, then they are removed.

Use SOUND ON in the corner if you want sound effects. The setting is remembered.

## Share a private web link

Friends can use the app in a browser with nothing to install. The app still runs on your computer, and a Cloudflare quick tunnel gives them a temporary public URL. There is no cloud server to pay for.

On Windows, double-click `share.bat`. It starts the local server and the tunnel, then prints a `trycloudflare.com` URL. The URL changes each time you restart. Leave the minimized server and tunnel windows open while friends are using it.

The share password is saved in `SHARE_PASSWORD.txt` in the app folder (and in a local `.env` file, which is not committed). Send friends the URL and the password in a private message. Do not post them in a public place.

The login page and the app send `noindex` headers and a `robots.txt` that blocks crawlers, so the link should not show up in search results. Anyone who has the URL still needs the password.

On macOS or Linux, start the app with `npm start`, set `MEMEH_PASSWORD` in a local `.env` file, then run a Cloudflare quick tunnel pointed at http://127.0.0.1:5050. The quick tunnel URL changes each time you restart.

This only works while your computer is on and the server and tunnel are running.

## Notes

The server binds only to 127.0.0.1 on port 5050. The tunnel connects to that local address, so the app is not opened on your network by itself.

If port 5050 is already in use, close the other Memeh MP3 window and try again.

If a video is private, age restricted, or region locked, the app will show an error instead of a file.

Press Ctrl+C in the server window to stop a local session. To stop a share session, close the Memeh MP3 server and tunnel windows.

