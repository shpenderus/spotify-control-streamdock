# Spotify Control — StreamDock / Mirabox plugin

A plugin to control **Spotify** through the official Web API.
Compatible with Mirabox Stream Dock (StreamDock / HotSpot software), Ajazz StreamDock and other devices that support StreamDock plugins.

## Features

| Button | What it does |
| --- | --- |
| **Play/Pause** | Pause/resume playback. Shows the **current track cover**. You can enable a caption (title, artist, time), adjust the font size, **time color**, the **play/pause icon** (off by default, green like the other buttons) and a **progress bar** (thin green bar at the bottom) |
| **Now Playing** | Shows the cover, title, artist and time of the current track. In the button settings you can choose **exactly what to display** (cover / title / artist / time / progress bar), the **font size** (6–30) and the **time color**. Pressing toggles play/pause |
| **Next Track** | Skips to the next track |
| **Previous Track** | Goes back to the previous track |
| **Like** | Likes/unlikes the current track; the state is shown on the button (gray heart → green). While the status is unknown or the token lacks the scopes, a heart with a question mark is shown |
| **Repeat** | Cycles repeat mode: **off → one track → playlist**; the state is shown on the button |
| **Shuffle** | Toggles shuffle; the state is shown on the button |
| **Seek (Encoder)** | For devices with an encoder: rotate — smooth seeking within the track (1 step = 5 seconds, via the official `PUT /me/player/seek` API), press — play/pause. Shows the current track time on the encoder display |
| **Tracks (Encoder)** | For devices with an encoder: rotate — next/previous track, press — play/pause |
| **Volume (Encoder)** | For devices with an encoder: rotate — volume ±2% per step (official `PUT /me/player/volume` API), press — play/pause. Shows the current volume level |

- Icons in the Spotify green style (#1DB954), dark minimalist design.
- Long titles and artists **scroll as a marquee** when they don't fit on the button.
- Text is drawn directly over the cover (no dark panel).
- The time text color is configurable (default Spotify green), applied with the "Apply" button.
- **Auto-contrast text** (enabled by default): the plugin analyzes the cover brightness and makes the text black or white so it never blends into the artwork. Turn it off to return to the classic colors.
- On press the button content briefly scales down ("sinks in") — a subtle press effect without changing the color.
- Fully automatic authorization: the plugin starts a local server and catches the Spotify response itself — nothing to copy.
- Tokens refresh automatically; you only sign in once (~every 6 months).

## Installation

1. Copy the `com.spotify.control.en.sdPlugin` folder into the plugins directory:
   - **Windows:** `C:\Users\YOUR_NAME\AppData\Roaming\HotSpot\StreamDock\plugins`
   - **macOS:** `Library → Application Support → HotSpot → StreamDock → plugins`
2. Fully restart StreamDock (from the tray).
3. In the actions list a **Spotify** category appears — drag the buttons you need onto the panel.

## Spotify app setup (once)

1. Open [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and sign in with your account.
2. **Create app** → any name (e.g. `StreamDock Control`), any description.
3. In the app settings (Edit settings) add to **Redirect URIs**:
   ```
   http://127.0.0.1:8888/callback
   ```
   ⚠️ Only this format (`127.0.0.1` + port) is accepted. The address `http://localhost:...` is no longer accepted by Spotify.
   Save. The app can stay in Development Mode.
4. Copy the **Client ID** and **Client Secret** from the app card.

## Connecting your account

1. Open the settings of any plugin button (right-click → settings).
2. Paste the **Client ID** and **Client Secret**. Keep the Redirect URI as is (if you changed it, use the same one you added in Spotify).
3. Press **"Sign in with Spotify"** — the browser opens. Confirm access; the tab closes by itself ("Signed in!" is shown).
4. The status changes to "Connected" and the buttons start working.

> If Spotify returns "Invalid redirect URI", make sure the address in the plugin field **exactly matches** the one in your Spotify app settings (including the port).

## Notes

- Playback control (play/pause, next/previous, repeat, seek, volume) requires **Spotify Premium**.
- Seeking works through the official Spotify API (`PUT /v1/me/player/seek`) — unlike the Yandex plugin, which has to drag a slider inside the web player.
- Likes work on the free tier too. The like status is cached: when StreamDock starts, the button immediately shows the correct state.
- **Likes use the legacy `/v1/me/library` endpoints** (like the official MiraBox plugin): on some accounts the modern `/v1/me/tracks` endpoints return 403 even with the scopes in place. The plugin tries the modern endpoints first and automatically switches to the legacy ones on error, remembering them.
- The like status is always confirmed against the real Spotify response (requests are serialized, no races), and when pressing with an unknown status the plugin first fetches the real status and only then toggles — the button no longer "lies" or unlikes blindly.
- **If the like button shows a heart with a question mark** — the status is unknown: either it's still loading, or both library endpoints return 403 (no `user-library-read` scope). The log (`[like] 403: … token scopes: …`) shows what scopes the token actually has. Press "Sign out", then "Sign in with Spotify" again and confirm access — the scope will appear. An old refresh token permanently keeps the scopes granted on the first sign-in, so a re-login is required.
- "Plugin Log", "Sign in" and "Sign out" work in the settings of **any** plugin button.
- Every button's settings are stored separately, change **one field at a time** (without resetting the others) and apply to the exact button whose panel you opened (even when several identical buttons exist).
- Buttons update automatically (~1–2 s). Track info comes from your account: it works on any device where Spotify is playing (PC, phone, speaker).
- When nothing is playing, buttons show a dimmed icon; pressing shows an alert.
- Account and tokens are stored in the StreamDock global settings and in `%USERPROFILE%\.spotify-control-streamdock.json`. "Sign out" deletes the tokens.

## Troubleshooting

The plugin writes a detailed log (all StreamDock messages with payload contents, login steps, errors, a state summary every 30 s, the token's real scopes `[scopes]`).
You can view the log right in the settings panel: the **"Plugin Log"** button at the bottom → "Copy".
When asking for help, send the recent lines with the `[scopes]`, `[summary]`, `[like]` and `[settings]` tags — they show both the cause and what the plugin actually received.

- **The "Sign in" button doesn't react** — press "Plugin Log":
  - the log shows "Plugin started…" and messages — the plugin is running, send the log contents;
  - "No connection to the plugin" or an empty log — the plugin isn't starting. Make sure the folder is in `%APPDATA%\HotSpot\StreamDock\plugins`, fully restart StreamDock (from the tray). If that doesn't help, send the log from `%TEMP%\spotify-control-plugin.log`.
- **The log is empty or the file doesn't exist** — StreamDock doesn't run Node plugins (possibly an old software version). Update StreamDock.
- **"Invalid redirect URI"** — the address in the plugin field must exactly match the one in the Spotify app settings (including the port): `http://127.0.0.1:8888/callback`.
- **Port 8888 is busy** — change the port in both places (the Redirect URI field in the plugin and the Spotify app settings), e.g. to `8899`.

## Building a ZIP (if you need an archive)

On Windows: select the `com.spotify.control.en.sdPlugin` folder → right-click → **Compress to ZIP file**.
