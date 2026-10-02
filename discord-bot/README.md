# DecentBusking Jukebox Bot

A Node.js Discord bot with three modes:

1. **Upload → IPFS Pin → Mint Request** — watches the `#DecentJukebox` channel for audio file uploads, pins them through Pinata (or a local Kubo node), and lets the uploader request an owner-approved Base mint.

2. **IPFS Radio & Personal Jukebox** — slash commands that stream an IPFS album directory to a Discord voice channel (`/radio`) or send you a private numbered playlist via DM (`/jukebox`).

3. **JukeLoop** — 24/7 community radio that continuously plays every audio file posted in `#DecentJukebox` in the `JukeLoop` voice channel. New tracks play from their stored IPFS CID, with Discord attachment fallback for legacy records. Track order is influenced by 👍/👎 reactions so popular tracks appear more often.

The bot holds **no on-chain private key**. An authorized owner reviews the queue and confirms each mint in MetaMask. The NFT is minted directly to the artist wallet, which is also configured as the ERC-2981 royalty receiver.

---

## Quick Start

### 1. Prerequisites

- Node.js ≥ 18
- **FFmpeg** installed and available on the system `PATH` (required for `/radio` and JukeLoop voice streaming)
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Windows: download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to `PATH`
  - Or set `FFMPEG_PATH` in `.env` to point to a custom binary
- A Discord bot application with the **Message Content** privileged intent enabled
- A Pinata account and server-side JWT for production, or a local Kubo/IPFS Desktop node

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

| Variable                     | Required | Description |
|------------------------------|----------|-------------|
| `DISCORD_TOKEN`              | ✅        | Bot token from the [Discord Developer Portal](https://discord.com/developers/applications) |
| `JUKEBOX_CHANNEL_ID`         | ✅        | Numeric ID of the `#DecentJukebox` channel to watch for uploads |
| `IPFS_UPLOAD_PROVIDER`       | ✅        | `pinata` on Render or `local` with Kubo/IPFS Desktop |
| `PINATA_JWT`                 | Pinata    | Server-only Pinata JWT; never expose it in browser code |
| `PUBLIC_WORKER_URL`          | Pinata    | Public URL of this Render service |
| `IPFS_ALLOWED_ORIGINS`       | Pinata    | Comma-separated browser origins allowed to request upload URLs |
| `MINT_OWNER_WALLET`          | Pinata    | Base admin wallet allowed to authorize browser uploads |
| `PINATA_API_URL`             | ❌        | Direct upload API; defaults to Pinata v3 |
| `PINATA_SIGN_URL`            | ❌        | Signed upload API; defaults to Pinata v3 |
| `PINATA_FILES_API_URL`       | ❌        | Files API used to discover the latest JukeLoop state snapshot |
| `IPFS_API_URL`               | Local     | Kubo RPC API; defaults to `http://127.0.0.1:5001` |
| `SITE_URL`                   | ❌        | DecentBusking site URL (default: `https://thejollylama.github.io/DecentBusking`) |
| `IPFS_GATEWAY`               | ❌        | IPFS HTTP gateway base URL (default: `https://w3s.link`) |
| `FFMPEG_PATH`                | ❌        | Path to `ffmpeg` binary (default: `ffmpeg` from `PATH`) |
| `JUKE_LOOP_VOICE_CHANNEL_ID` | ❌        | Numeric ID of the `JukeLoop` **voice** channel — enables 24/7 radio |
| `JUKE_LOOP_TEXT_CHANNEL_ID`  | ❌        | Numeric ID of the `JukeLoop` **text** channel — where "Now Playing" posts go |
| `DISABLE_MINT_FLOW`          | ❌        | Set to `true` to skip IPFS pinning and the Mint embed (JukeLoop-only mode). Default: `false` |

> JukeLoop is **opt-in**: omit `JUKE_LOOP_VOICE_CHANNEL_ID` / `JUKE_LOOP_TEXT_CHANNEL_ID` (or leave them blank) to keep the bot running without it.

### 4. Configure IPFS uploads

```bash
# Render / production
IPFS_UPLOAD_PROVIDER=pinata
PINATA_JWT=<server-only JWT from Pinata>
PUBLIC_WORKER_URL=https://<service>.onrender.com
IPFS_ALLOWED_ORIGINS=https://thejollylama.github.io
MINT_OWNER_WALLET=0x...

# Local alternative
IPFS_UPLOAD_PROVIDER=local
IPFS_API_URL=http://127.0.0.1:5001
```

In Pinata mode, the playlist, ratings, IPFS CIDs, and mint queue are checkpointed as tagged JSON on IPFS. On startup the bot discovers and restores the newest snapshot through Pinata's Files API. The newest three snapshots are retained, so Render's persistent disk is not required and `JUKELOOP_PLAYLIST_PATH` should be omitted on the free tier.

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
| `/jukebox backlog` | Privately list your tracked uploads that have not been minted yet. |
| `/jukebox request-mint <track_id> <wallet> [artwork]` | Queue one of your pinned tracks with optional NFT artwork for owner approval. |

**Example:**
```
/jukebox play bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
```

The CID must point to an **IPFS directory** containing audio files (`.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.aac`, `.opus`).

### 📻 `/jukeloop` — JukeLoop Admin Commands

Manage the 24/7 community radio playlist.  Most subcommands are available to everyone; `remove` requires the **Manage Messages** permission.

| Command | Permission | Description |
|---------|------------|-------------|
| `/jukeloop stats` | Everyone | Show the top 10 rated tracks (likes, dislikes, plays, score). |
| `/jukeloop remove <title>` | Manage Messages | Remove a track from the JukeLoop playlist by searching its title. |
| `/jukeloop mint-queue` | Manage Messages | Show pending requests and owner approval links. |
| `/jukeloop mark-minted <track_id> <token_id> <tx_hash>` | Manage Messages | Reconcile a completed Base mint with the playlist. |
| `/jukeloop restart` | Manage Messages | Reconnect and restart JukeLoop without redeploying the bot. |

Wallet addresses submitted in Discord are community claims, not cryptographic proof of wallet ownership. During this manual bootstrap phase, the owner must verify unexpected or disputed addresses before approving a mint.

`/jukebox request-mint` only queues a request; it does not submit a blockchain transaction. Artists may attach PNG, JPEG, WebP, or GIF artwork up to 10 MB; the bot pins it immediately and stores its CID with the request. The contract owner opens **Admin** in the DecentBusking dapp, connects the `DEFAULT_ADMIN_ROLE` wallet, and signs once to load the private queue. Artist artwork is previewed and preloaded, with an optional replacement control. Each request has an individual Mint action. Multiple selected requests can be processed sequentially; the current contract has no batch registration method, so MetaMask still requires two Base transaction confirmations per track. The browser reports each confirmed mint to the Render worker. After the worker verifies the owner, contract, recipient, token ID, and `EditionMinted` event on Base, the bot removes the item from the backlog and announces the NFT in both configured public text channels. `/jukeloop mint-queue` and `/jukeloop mark-minted` remain recovery tools.

A true one-confirmation batch is possible through a separately deployed `BatchProductMinter` helper contract holding `DEFAULT_ADMIN_ROLE`: it can loop over requests and use each `registerToken` return value immediately in `mintProduct`. That privileged helper requires its own Solidity project, review, deployment, and explicit role grant before the dapp should use it.

---

## JukeLoop — 24/7 Community Radio

JukeLoop automatically streams every audio file posted in `#DecentJukebox` to the `JukeLoop` voice channel, non-stop.

### How it works

```
Bot starts up
    ↓
Loads playlist from jukeloop-playlist.json (persisted across restarts)
    ↓
Scans ALL historic messages in #DecentJukebox for audio attachments (backfill)
    ↓
Joins the JukeLoop voice channel
    ↓
Builds a weighted-random playlist (higher-rated tracks play sooner/more often)
    ↓
Plays each track, announces it in the JukeLoop text channel, adds 👍 / 👎 buttons
    ↓
When the next track starts, reads the reaction counts and updates ratings
    ↓
After each full loop, reshuffles using fresh weights → repeat forever
```

### Rating system

| Reaction | Effect |
|----------|--------|
| 👍 | +1 to the track's score |
| 👎 | −0.5 to the track's score |

Track weight = `max(0.1, 1 + likes − dislikes × 0.5)`.  A brand-new track has weight 1.0.  Higher weight = higher probability of appearing earlier in each loop pass.  Even heavily down-voted tracks still appear occasionally (weight floor: 0.1).

Ratings **accumulate** across plays and **persist to disk** (`jukeloop-playlist.json`) so they survive bot restarts.

Each Now Playing message displays cumulative likes, dislikes, and playback announcements. Reactions on the current message are per-play inputs; when the next track begins, the bot adds them to the cumulative totals, edits the message with the updated totals, and removes the closed reaction buttons. Discord announcement IDs are persisted as idempotency keys. On startup, JukeLoop scans up to 500 recent announcements and reconciles any that were abandoned by a restart, then writes one Pinata-backed checkpoint without double-counting previously processed messages.

### Setting up JukeLoop

1. Create a `JukeLoop` voice channel and a `JukeLoop` text channel in your server.
2. Copy both channel IDs (Developer Mode → right-click → Copy Channel ID).
3. Add to `.env`:
   ```
   JUKE_LOOP_VOICE_CHANNEL_ID=<voice-channel-id>
   JUKE_LOOP_TEXT_CHANNEL_ID=<text-channel-id>
   ```
4. Restart the bot — it will backfill existing tracks automatically.

---

## Upload → IPFS Pin Flow

```
User posts audio in #DecentJukebox
    ↓
Bot detects message attachments with audio MIME type or extension
    ↓
Track is immediately added to the JukeLoop playlist (if JukeLoop is enabled)
    ↓
Bot downloads the file buffer via fetch
    ↓
Bot uploads through Pinata or local Kubo → receives CID
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
fly secrets set DISCORD_TOKEN=... JUKEBOX_CHANNEL_ID=... PINATA_JWT=... MINT_OWNER_WALLET=...
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
  index.js                 ← bot entry point (message handler + slash command router)
  radio.js                 ← IPFS track fetcher + per-guild RadioSession (voice streaming)
  jukeloop.js              ← JukeLoopSession (24/7 radio) + channel backfill helper
  playlist-store.js        ← persistent playlist with 👍/👎 ratings and weighted shuffle
  jukeloop-playlist.json   ← runtime data: playlist + ratings (auto-created, gitignored)
    ipfs.js                  ← Pinata/local Kubo upload adapters
    ipfs-worker.js           ← owner-authenticated Pinata upload URL endpoint
  embed.js                 ← Discord EmbedBuilder for mint-link replies
  config.js                ← environment variable loader with validation
  package.json             ← Node.js manifest
  .env.example             ← template for required environment variables
  README.md                ← this file
```
