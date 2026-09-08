<div align="center">

# 🎛️ Spotify Control for StreamDock

**Control Spotify right from your StreamDock / Mirabox panel** — track cover on the button, play/pause, likes, seeking and volume through the official Spotify Web API.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue.svg)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#)
[![Version](https://img.shields.io/badge/version-1.0.3-orange.svg)](#)

**English** · [Русский](README.ru.md)

</div>

A plugin for **StreamDock**-compatible devices: Mirabox Stream Dock (StreamDock / HotSpot software), Ajazz StreamDock and similar. Connects to your Spotify account through the official Web API — nothing is parsed, nothing breaks when the app updates.

## ✨ Features

| Button | What it does |
| --- | --- |
| ▶ **Play/Pause** | Pause/resume + **current track cover** right on the button. Configurable: title, artist, time, font size, time color, icon and a thin green **progress bar** |
| ℹ️ **Now Playing** | Cover, title, artist, time, progress bar — pick what to show and the font size |
| ⏭ **Next / Previous** | Next switches tracks; Previous restarts the track (>3 s in), a repeated press goes to the previous track |
| ❤️ **Like** | Like/unlike, **the real state is visible on the button** (gray heart → green) |
| 🔁 **Repeat** | Off → one track → playlist; state shown on the button |
| 🔀 **Shuffle** | On/off; state shown on the button |
| 🎚 **Seek (Encoder)** | Smooth seeking inside the track (5 s per step, official `PUT /me/player/seek`); the display shows the current time |
| 🎵 **Tracks (Encoder)** | Next/previous track by rotating |
| 🔊 **Volume (Encoder)** | Volume ±2% per step; the display shows the level |
| 📋 **Playlist** | Press starts the playlist chosen in settings (incl. Liked Songs); the button shows its name |

Also:
- 🏃 **Marquee** — long titles scroll smoothly when they don't fit the button.
- 🎨 **Auto-contrast text** — the plugin analyzes the cover brightness and makes the text black or white so it never blends into the artwork.
- 🟢 Spotify-green icons (#1DB954), dark minimalist design.
- 🔐 One-click authorization: the plugin starts a local server and catches the Spotify response itself; tokens refresh automatically (~6 months between sign-ins).
- ⚡ Buttons update in 1–2 seconds and work with any device where Spotify is playing (PC, phone, speaker).
- ⏱️ **Adaptive polling** — the longer a track plays, the rarer the API polls (rate-limit friendly); near the end of a track polling speeds up so the next cover appears right away.

## 📦 Installation

1. Copy the folder of the version you need into the plugins directory:
   - **Windows:** `C:\Users\YOUR_NAME\AppData\Roaming\HotSpot\StreamDock\plugins`
   - **macOS:** `Library → Application Support → HotSpot → StreamDock → plugins`
2. Fully restart StreamDock (from the tray).
3. A **Spotify** category appears in the actions list — drag the buttons you need onto the panel.
4. In the settings of any button, paste your Spotify app's **Client ID** and **Client Secret** and press **"Sign in with Spotify"**.

<details>
<summary>🔧 How to create a Spotify app (once)</summary>

1. Open [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and sign in with your account.
2. **Create app** → any name (e.g. `StreamDock Control`), any description.
3. In the app settings (Edit settings) add to **Redirect URIs**:
   ```
   http://127.0.0.1:8888/callback
   ```
   ⚠️ Only this format (`127.0.0.1` + port) is accepted. `http://localhost:...` is no longer accepted by Spotify.
4. Copy the **Client ID** and **Client Secret** from the app card.

</details>

## 📂 Repository structure

| Folder | Language |
| --- | --- |
| `com.spotify.control.sdPlugin` | Russian |
| `com.spotify.control.en.sdPlugin` | English |

Both versions are feature-identical and differ only in language. RU and EN can be installed simultaneously (unique action UUIDs).

## 📄 License

Distributed under the [MIT License](LICENSE).
