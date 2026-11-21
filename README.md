# MediaHub – a web player for your directory-listing media server

Your media lives on a plain web/FTP-style server (e.g. `http://172.16.50.4`) where you can only download files.
**MediaHub** puts a simple website in front of it so you can browse, search and *watch* them in the browser.

- Menu built from the top-level folders of your server (Movies, Series, …)
- Folder browsing with breadcrumbs, search bar with instant results
- Simple player: play/pause, seek, volume, **subtitles on/off**, **speed**, fullscreen
- Subtitles: picks up `.srt` / `.vtt` files next to the video (or in a `Subs` folder), can read subtitles embedded in mkv files, and lets you load a subtitle file from your computer; subtitle sync (± 0.5 s)
- Series friendly: sidebar with the other episodes, previous / next, auto-play next episode
- Remembers where you stopped ("Continue watching" on the home page)
- Optional ffmpeg support converts formats browsers can't play (mkv with AC3/DTS audio, HEVC, avi, …) on the fly

No database and no build step – just Node.js.

## How it works

```
Browser  ──►  MediaHub (Node.js)  ──►  http://172.16.50.4  (your file server)
```

The Node server reads the file server's directory pages, builds a search index, and streams videos
(with HTTP Range support so seeking works). Because it runs next to your file server, **it must be
hosted on a machine that can reach `172.16.50.4`** (a PC/Raspberry Pi/NAS/VM on the same network).
GitHub only stores the code – it cannot run the site, and cloud hosts (Vercel, Netlify, …) cannot reach a private `172.16.x.x` address.

## Run it

Requirements: **Node.js 18+** (and optionally **ffmpeg**).

```bash
git clone <your-repo-url> mediahub
cd mediahub
npm install
cp .env.example .env        # edit FTP_BASE_URL if needed
npm start
```

Open `http://localhost:3000` (or `http://<server-ip>:3000` from other devices on the network).

### Docker

```bash
docker compose up -d --build
```

Edit `FTP_BASE_URL` in `docker-compose.yml` first. The image already includes ffmpeg.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `FTP_BASE_URL` | `http://172.16.50.4` | Root URL of the file server |
| `FTP_USER` / `FTP_PASS` | – | Only if the file server needs a login (HTTP Basic) |
| `PORT` | `3000` | Port of this website |
| `SITE_NAME` | `MediaHub` | Name shown in the header |
| `INDEX_DEPTH` | `6` | How many folder levels the search index crawls |
| `INDEX_CONCURRENCY` | `6` | Parallel requests during indexing |
| `INDEX_REFRESH_MINUTES` | `360` | Automatic re-scan interval |

The first start crawls the library in the background (a few seconds to a few minutes depending on its size);
search works as soon as it finishes. Use **Rescan library** on the home page after adding new files.

## About format support

| Situation | Without ffmpeg | With ffmpeg |
|---|---|---|
| mp4 (H.264 + AAC), webm | plays | plays |
| mkv (H.264 + AAC) | plays in Chrome / Edge | plays everywhere |
| mkv with AC3/DTS audio | no/!sound | audio converted to AAC automatically |
| HEVC/H.265, avi, wmv, flv, mpg | not playable | converted to H.264 (CPU heavy) |
| Subtitles embedded in mkv | – | extracted automatically |

The player chooses the right mode by itself and shows a short message when it switches.
Converted streams use the server's CPU, so a Raspberry Pi will struggle with H.264 re-encoding of large files.

Install ffmpeg: `sudo apt install ffmpeg` (Debian/Ubuntu), `brew install ffmpeg` (macOS), `winget install ffmpeg` (Windows).

## Keyboard shortcuts

`Space`/`K` play-pause · `←` `→` ±5 s · `J` `L` ±10 s · `↑` `↓` volume · `M` mute · `F` fullscreen ·
`C` subtitles on/off · `<` `>` speed · `N` next episode · `0`–`9` jump to 0–90 % · `/` focus search

## Project layout

```
src/
  server.js     HTTP routes (API, /stream proxy, /transcode)
  listing.js    reads the file server's directory pages, safe URL building
  indexer.js    background crawler + search
  subtitles.js  finds .srt/.vtt files for a video
  ffmpeg.js     optional probe / convert / embedded-subtitle helpers
  config.js     environment settings
public/
  index.html  style.css  app.js (pages, menu, search)  player.js (video player)
```

## Security notes

- Meant for a trusted local network. There is **no login** on MediaHub itself; do not expose it to the internet as is
  (put it behind a reverse proxy with authentication if you need that).
- The server only requests paths below `FTP_BASE_URL`; `..` segments are rejected.

## Troubleshooting

- **"Cannot reach the file server"** – the machine running MediaHub can't open `FTP_BASE_URL`. Test with `curl http://172.16.50.4/`.
- **Folders look empty** – the file server must show normal HTML directory listings (Apache, nginx `autoindex`, lighttpd, Caddy `browse`, `python -m http.server`, …).
- **Seeking doesn't work** – the file server must support HTTP Range requests (most do).
- **No sound / black screen** – install ffmpeg (see above).
- Set `DEBUG_FFMPEG=1` to print ffmpeg errors in the server console.

## License

MIT
