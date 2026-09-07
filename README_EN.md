<div align="center">

# HiFi-DL · Music Downloader

[简体中文](README.md) | **English**

A local, journal-style batch music downloader: LX multi-source aggregated search & download · Qobuz lossless / Hi-Res downloads · online playlist parsing · lyrics & cover embedding · download history

</div>

> [!WARNING]
> ### Disclaimer
> - This project is built upon the open-source code of [qobuz-dlp](https://github.com/infojunkie/qobuz-dlp.py) and [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop). It **does not include, provide, or distribute any music source scripts or download links**. All content comes from the internet and must be configured by the user.
> - This project is for learning and research purposes only. Commercial use is strictly prohibited. Copyright of downloaded content belongs to the original platforms and rights holders. Please delete everything within 24 hours. Any legal liability arising from the use of this project is borne by the user.
> - By using this project you acknowledge that you have read and agreed to the terms above. Contact us for removal in case of infringement.

---

## ✨ Features

### My Playlist
- Parse public playlist links: Kugou / Netease / QQ Music / Apple Music
- Drag in or select Apple Music-exported .txt playlists
- **Multi-playlist management**: save any number of playlists by name, persisted across restarts, click to open

### Playlist Downloads
- Dual engines (LX & Qobuz) with configurable priority and automatic fallback
- Per-track live progress, failure list, one-click retry

### LX Search
- Parallel aggregation across Kuwo / Kugou / QQ Music / Netease / Migu, or single-channel precise search
- Multi-threaded segmented downloading (large files automatically split into 4 parts)
- Optional: .lrc lyric files, cover & lyrics embedded into audio, save grouped by playlist, filename templates, download proxy

### Qobuz Search & Download
- Track / album search; paste Qobuz album, playlist, track, artist, label links or last.fm playlists for batch queuing
- Four quality tiers: MP3 320k / 16bit lossless / 24bit Hi-Res ≤96kHz / Hi-Res Max
- Album cover embedded into every track; local dedup; configurable save layout (album folders / flat) and file naming

### Others
- Three independent download queues (Playlist / LX / Qobuz) with pause, resume and cancel
- **Download history**: filter by source, one-click clear (can be disabled in settings)
- **Bilingual UI** (Chinese / English), follows system language on first launch
- Journal-style interface with bundled handwriting fonts — works fully offline

## 🖥 Requirements

| Platform | LX Search/Download | Qobuz Download |
|---|---|---|
| macOS | ✅ | ✅ |
| Windows | ✅ | ✅ |

- **Node.js ≥ 20** (required): install from [nodejs.org](https://nodejs.org/), no `npm install` needed
- **Python 3.10+** (only for Qobuz): install from [python.org](https://www.python.org/downloads/) with *Add to PATH*; all other Python dependencies are bundled — no pip install
- Qobuz downloads require your own **Qobuz Studio subscription**

## 🚀 Quick Start

```bash
# macOS: double-click 「start.command」, or:
node server.js          # opens http://127.0.0.1:8978 automatically

# Windows: double-click 「start.bat」; stop with 「stop.bat」
```

Stop the service: double-click 「stop.command」 (or use "Exit Service" in the top-right corner).

## 📖 Usage

### First Run: Add Your Own Sources (Important)

For copyright reasons, this project **does not bundle any music sources**. Before using LX downloads, obtain LX Music source scripts yourself and import them under **Settings → LX Music → Music Sources** (one source script URL per line).

- Without sources: search works, downloads will report missing sources
- Source scripts can be found via search engines using keywords like "LX Music source"

### Qobuz First Run

1. Make sure your network can reach Qobuz (the app reads the macOS system proxy automatically; Windows users can configure a proxy in settings)
2. Settings → Qobuz → "Open Qobuz Login", complete the login in your browser (credentials are stored locally only)
3. Then search, or paste links for batch downloads

The Qobuz app config (config.ini, containing only app registration info — no account credentials) is bundled and auto-installed to your user directory on first use.

### Tabs

| Tab | Description |
|---|---|
| My Playlist | Import / save / open playlists, select and batch download |
| Downloading | Live progress of all three queues, pause / resume / cancel selected |
| LX Search | Optional channel filter, download results directly |
| Qobuz Search | Track / album toggle, paste links for batch queuing |
| Retry | Aggregated failed songs, one-click retry |
| History | Full download history, filterable by source |
| Settings | Language, save location, priority, quality, concurrency, pagination, LX / Qobuz details |

## ⚙️ Settings Overview

- **General**: save location, playlist priority, audio quality, parallel downloads, rows per list page (20/50/100), history toggle, UI language
- **LX Music**: source management, filename template (`{歌手}` `{歌名}` `{专辑}` `{序号}`), group by playlist, .lrc lyrics, cover / lyrics embedding, download proxy
- **Qobuz**: login, quality, save layout (album folders / flat), file naming, cover embedding, dedup

## 📁 Directory Structure

```
HiFi-DL/
├─ server.js / main.js           server / CLI entry (zero npm dependencies)
├─ web/                          frontend (bundled fonts + i18n dictionaries)
├─ lib/                          downloader, matcher, search SDK, Qobuz bridge, tag writer
├─ vendor/qobuz-dl/
│   ├─ pylibs/                   bundled pure-Python dependencies (cross-platform, no pip)
│   └─ config.ini                Qobuz app config (auto-installed to user directory)
├─ cache/                        runtime cache (source scripts, saved playlists, history)
├─ start.command / start.bat     one-click start
└─ stop.command / stop.bat       one-click stop
```

All settings and data are stored locally and never uploaded to any server.

## 🙏 Credits

- [qobuz-dlp](https://github.com/infojunkie/qobuz-dlp.py) (based on [vitiko98/qobuz-dl](https://github.com/vitiko98/qobuz-dl)) — Qobuz download core
- [lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) — origin of the ported multi-platform search logic
- Fonts: [Yozai Font](https://github.com/lxgw/yozai-font) · [Kalam](https://fonts.google.com/specimen/Kalam) · [Patrick Hand](https://fonts.google.com/specimen/Patrick+Hand) (all open-source licensed)

## 📄 License

Built upon upstream open-source projects, for learning purposes only. Please comply with the laws of your region and the open-source licenses of the upstream projects.

<div align="center">

[简体中文](README.md) | **English**

</div>
