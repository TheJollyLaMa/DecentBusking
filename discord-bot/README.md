# DecentBusking Jukebox Bot

A Node.js Discord bot with two modes:

1. **Upload → IPFS Pin** — watches the `#jukebox` channel for audio file uploads, pins them to IPFS via [w3up (web3.storage / Storacha)](https://web3.storage), and replies with a rich embed containing a one-click **🎸 Mint This As A DNFT** link pre-filled with the track title and IPFS CID.

2. **IPFS Radio & Personal Jukebox** — slash commands that stream an IPFS album directory to a Discord voice channel (`/radio`) or send you a private numbered playlist via DM (`/jukebox`).

The bot does **not** mint on-chain — the artist still connects MetaMask and confirms the transaction in the browser.

---

## Quick Start

### 1. Prerequisites

- Node.js ≥ 18
- **FFmpeg** installed and available on the system `PATH` (required for `/radio` voice streaming)
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to `PATH`
  - Or set `FFMPEG_PATH` in `.env` to point to a custom binary
- A Discord bot application with the **Message Content** privileged intent enabled
- A [web3.storage](https://console.web3.storage) account with a space and a server-side delegation

### 2. Install dependencies

```bash
cd discord-bot
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
# Edit .env with your values
```

| Variable             | Required | Description |
|----------------------|----------|-------------|
| `DISCORD_TOKEN`      | ✅        | Bot token from the [Discord Developer Portal](https://discord.com/developers/applications) |
| `JUKEBOX_CHANNEL_ID` | ✅        | Numeric ID of the `#jukebox` channel to watch for uploads |
| `W3UP_KEY`           | ✅        | ed25519 agent private key (`w3 key create`) |
| `W3UP_PROOF`         | ✅        | Base64-encoded UCAN delegation (`w3 delegation create … | base64`) |
| `SITE_URL`           | ❌        | DecentBusking site URL (default: `https://thejollylama.github.io/DecentBusking`) |
| `IPFS_GATEWAY`       | ❌        | IPFS HTTP gateway base URL (default: `https://w3s.link`) |
| `FFMPEG_PATH`        | ❌        | Path to `ffmpeg` binary (default: `ffmpeg` from `PATH`) |

### 4. Generate w3up credentials

```bash
# Install the w3 CLI (one-time)
npm install -g @web3-storage/w3cli

# Create a new agent key — copy the "key" field into W3UP_KEY
w3 key create

# Log in and create / select a space
w3 login your@email.com
w3 space create my-jukebox-space   # or: w3 space use <existing-did>

# Create a delegated proof for the agent key above and base64-encode it
# Replace <agent-did> with the "did" field from `w3 key create`
# Linux:
w3 delegation create <agent-did> --can 'store/add' --can 'upload/add' | base64 -w0
# macOS:
w3 delegation create <agent-did> --can 'store/add' --can 'upload/add' | base64
# Cross-platform alternative:
w3 delegation create <agent-did> --can 'store/add' --can 'upload/add' | base64 | tr -d '\n'
# Copy the output into W3UP_PROOF
```

### 5. Run the bot

```bash
npm start
```

---

## Slash Commands

### 🎙️ `/radio` — Community Radio (shared voice channel)

Stream an entire IPFS album directory to a Discord voice channel. Only one radio session per server at a time.

| Command | Description |
|---------|-------------|
| `/radio play <cid>` | Join your current voice channel and stream all audio tracks from the IPFS directory CID. Posts "🎵 Now Playing" in the text channel for each track. |
| `/radio skip` | Skip to the next track. |
| `/radio pause` | Pause or resume playback (toggle). |
| `/radio stop` | Stop the radio and disconnect from the voice channel. |

**Example:**
```
/radio play bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
```

### 🎧 `/jukebox` — Personal Playlist (private)

Fetch a numbered playlist of direct stream links from an IPFS album directory and send it to your DMs (or as an ephemeral reply if your DMs are closed).

| Command | Description |
|---------|-------------|
| `/jukebox play <cid>` | Receive a private numbered playlist with clickable gateway stream links. |

**Example:**
```
/jukebox play bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
```

The CID must point to an **IPFS directory** containing audio files (`.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.aac`, `.opus`).

---

## Upload → IPFS Pin Flow

```
User posts audio in #jukebox
    ↓
Bot detects message attachments with audio MIME type or extension
    ↓
Bot downloads the file buffer via fetch
    ↓
Bot uploads to IPFS via w3up → receives CID
    ↓
Bot builds mint URL:
  https://thejollylama.github.io/DecentBusking/?title=<track>&ipfs=<CID>
    ↓
Bot replies with a rich embed containing the "🎸 Mint This As A DNFT" link
```

Supported audio formats: `mp3`, `wav`, `ogg`, `flac`, `m4a`, `aac`, `opus`, `weba`

---

## Discord Developer Portal Setup

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, click *Add Bot* and copy the **Token** → `DISCORD_TOKEN`.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
   (Voice channel support uses the non-privileged `GuildVoiceStates` intent — no extra toggle needed.)
4. Under **OAuth2 → URL Generator**, select scopes:
   - `bot`
   - `applications.commands`
   
   And permissions:
   - `Send Messages`
   - `Read Message History`
   - `Embed Links`
   - `Connect` (voice)
   - `Speak` (voice)
5. Use the generated URL to invite the bot to your server.
6. Enable Discord **Developer Mode** (Settings → Advanced), right-click `#jukebox`, and choose **Copy Channel ID** → `JUKEBOX_CHANNEL_ID`.

> **Note:** Global slash commands can take up to 1 hour to propagate after first registration. For faster iteration during development, register commands to a specific guild by replacing `Routes.applicationCommands(clientId)` with `Routes.applicationGuildCommands(clientId, guildId)` in `index.js` — guild commands update instantly.

---

## Deployment (Railway — recommended)

1. Push this repository to GitHub.
2. Create a new [Railway](https://railway.app) project and connect the repo.
3. Set the **Root Directory** to `discord-bot`.
4. Add the environment variables in the Railway dashboard under *Variables*.
5. Add a `NIXPACKS_PKGS=ffmpeg` variable so Railway installs FFmpeg automatically.
6. Railway will run `npm start` automatically.

### Alternative: fly.io

```bash
cd discord-bot
fly launch --name decentbusking-jukebox-bot
fly secrets set DISCORD_TOKEN=... JUKEBOX_CHANNEL_ID=... W3UP_KEY=... W3UP_PROOF=...
fly deploy
```

Add `ffmpeg` to your `Dockerfile` or `fly.toml` build configuration.

### Alternative: PM2 on a VPS

```bash
# Install FFmpeg first
sudo apt install ffmpeg

npm install -g pm2
pm2 start index.js --name jukebox-bot
pm2 save && pm2 startup
```

---

## File Structure

```
discord-bot/
  index.js       ← bot entry point (message handler + slash command router)
  radio.js       ← IPFS track fetcher + per-guild RadioSession (voice streaming)
  ipfs.js        ← w3up Node.js upload helper
  embed.js       ← Discord EmbedBuilder for mint-link replies
  config.js      ← environment variable loader with validation
  package.json   ← Node.js manifest
  .env.example   ← template for required environment variables
  README.md      ← this file
```
