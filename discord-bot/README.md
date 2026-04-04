# DecentBusking Jukebox Bot

A Node.js Discord bot that watches the `#jukebox` channel for audio file uploads, pins them to IPFS via [w3up (web3.storage / Storacha)](https://web3.storage), and replies with a rich embed containing a one-click **🎸 Mint This As A DNFT** link pre-filled with the track title and IPFS CID.

The bot does **not** mint on-chain — the artist still connects MetaMask and confirms the transaction in the browser.

---

## Quick Start

### 1. Prerequisites

- Node.js ≥ 18
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
| `JUKEBOX_CHANNEL_ID` | ✅        | Numeric ID of the `#jukebox` channel |
| `W3UP_KEY`           | ✅        | ed25519 agent private key (`w3 key create`) |
| `W3UP_PROOF`         | ✅        | Base64-encoded UCAN delegation (`w3 delegation create … | base64`) |
| `SITE_URL`           | ❌        | DecentBusking site URL (default: `https://thejollylama.github.io/DecentBusking`) |

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
w3 delegation create <agent-did> --can 'store/add' --can 'upload/add' | base64 -w0
# Copy the output into W3UP_PROOF
```

### 5. Run the bot

```bash
npm start
```

---

## Bot Flow

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

## Deployment (Railway — recommended)

1. Push this repository to GitHub.
2. Create a new [Railway](https://railway.app) project and connect the repo.
3. Set the **Root Directory** to `discord-bot`.
4. Add the environment variables (`DISCORD_TOKEN`, `JUKEBOX_CHANNEL_ID`, `W3UP_KEY`, `W3UP_PROOF`, `SITE_URL`) in the Railway dashboard under *Variables*.
5. Railway will run `npm start` automatically.

### Alternative: fly.io

```bash
cd discord-bot
fly launch --name decentbusking-jukebox-bot
fly secrets set DISCORD_TOKEN=... JUKEBOX_CHANNEL_ID=... W3UP_KEY=... W3UP_PROOF=...
fly deploy
```

### Alternative: PM2 on a VPS

```bash
npm install -g pm2
pm2 start index.js --name jukebox-bot
pm2 save && pm2 startup
```

---

## Discord Developer Portal Setup

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, click *Add Bot* and copy the **Token** → `DISCORD_TOKEN`.
3. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
4. Under **OAuth2 → URL Generator**, select scopes `bot` + permissions `Send Messages`, `Read Message History`, `Embed Links`.
5. Use the generated URL to invite the bot to your server.
6. Enable Discord **Developer Mode** (Settings → Advanced), right-click `#jukebox`, and choose **Copy Channel ID** → `JUKEBOX_CHANNEL_ID`.

---

## File Structure

```
discord-bot/
  index.js       ← bot entry point (discord.js client + message handler)
  ipfs.js        ← w3up Node.js upload helper
  embed.js       ← Discord EmbedBuilder for mint-link replies
  config.js      ← environment variable loader with validation
  package.json   ← Node.js manifest (discord.js, @web3-storage/w3up-client, dotenv)
  .env.example   ← template for required environment variables
  README.md      ← this file
```
