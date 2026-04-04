// discord-bot/index.js
// DecentBusking Jukebox Discord Bot — entry point
//
// Watches #jukebox for audio file uploads, pins them to IPFS via w3up, and
// replies with a rich embed containing a one-click "🎸 Mint This As A DNFT"
// deep-link into the DecentBusking UI with the mint form pre-filled.
//
// The bot does NOT mint on-chain.  The user still connects MetaMask and
// confirms the transaction in the browser.

import { Client, GatewayIntentBits, Events } from 'discord.js';
import { loadConfig }    from './config.js';
import { uploadToIPFS }  from './ipfs.js';
import { buildMintEmbed } from './embed.js';

// ── Audio MIME-type detection ─────────────────────────────────────────────────
const AUDIO_MIME_PREFIXES  = ['audio/'];
const AUDIO_EXTENSIONS_RE  = /\.(mp3|wav|ogg|flac|m4a|aac|opus|weba)$/i;

// Maximum audio file size the bot will download (50 MB).
// Discord's own upload cap for non-nitro servers is 25 MB, but allow some
// headroom for boosted servers (up to 100 MB) while still preventing abuse.
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Return true if the attachment looks like an audio file.
 * Discord reports contentType as null for some uploads, so we also
 * fall back to the filename extension.
 *
 * @param {import('discord.js').Attachment} attachment
 */
function isAudioAttachment(attachment) {
  const mime = attachment.contentType || '';
  if (AUDIO_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  return AUDIO_EXTENSIONS_RE.test(attachment.name || '');
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[jukebox-bot] Logged in as ${readyClient.user.tag}`);
    console.log(`[jukebox-bot] Watching channel ID: ${config.jukeboxChannelId}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bots and messages outside the configured channel
    if (message.author.bot) return;
    if (message.channelId !== config.jukeboxChannelId) return;

    const audioAttachments = [...message.attachments.values()].filter(isAudioAttachment);
    if (!audioAttachments.length) return;

    for (const attachment of audioAttachments) {
      await handleAudioAttachment(message, attachment, config);
    }
  });

  await client.login(config.discordToken);
}

// ── Per-attachment handler ────────────────────────────────────────────────────

/**
 * Download an audio attachment, pin it to IPFS, and reply with the mint embed.
 *
 * @param {import('discord.js').Message}    message
 * @param {import('discord.js').Attachment} attachment
 * @param {ReturnType<typeof loadConfig>}   config
 */
async function handleAudioAttachment(message, attachment, config) {
  const filename = attachment.name || 'track.mp3';
  const mimeType = attachment.contentType || 'audio/mpeg';

  // Derive a human-readable title from the filename (strip extension)
  const title = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || filename;

  const uploaderTag = message.author.tag || message.author.username || 'Unknown User';

  console.log(`[jukebox-bot] Audio detected: "${filename}" from ${uploaderTag}`);

  // Acknowledge immediately so the user knows something is happening
  let workingMsg;
  try {
    workingMsg = await message.reply(`⏳ Pinning **${title}** to IPFS…`);
  } catch (err) {
    console.error('[jukebox-bot] Could not send acknowledgement:', err.message);
  }

  try {
    // 1. Guard against oversized files before downloading
    if (attachment.size > MAX_FILE_BYTES) {
      throw new Error(
        `File is too large (${(attachment.size / 1024 / 1024).toFixed(1)} MB). ` +
        `Maximum allowed size is ${MAX_FILE_BYTES / 1024 / 1024} MB.`
      );
    }

    // 2. Download the file
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading attachment`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`[jukebox-bot] Downloaded ${buffer.length} bytes for "${filename}"`);

    // 2. Upload to IPFS
    const ipfsUri = await uploadToIPFS(
      buffer,
      filename,
      mimeType,
      config.w3upKey,
      config.w3upProof,
    );
    // ipfsUri is "ipfs://<CID>"
    const ipfsCid = ipfsUri.replace('ipfs://', '');
    console.log(`[jukebox-bot] Pinned to IPFS: ${ipfsCid}`);

    // 3. Build pre-filled mint URL
    const mintUrl = buildMintUrl(config.siteUrl, title, ipfsCid);

    // 4. Reply with rich embed
    const embed = buildMintEmbed({ title, ipfsCid, mintUrl, uploaderTag });
    await message.reply({ embeds: [embed] });

    // 5. Clean up the working message
    if (workingMsg) await workingMsg.delete().catch(() => {});

  } catch (err) {
    console.error(`[jukebox-bot] Error processing "${filename}":`, err);
    const errText = `❌ Failed to pin **${title}** to IPFS: ${err.message}`;
    try {
      if (workingMsg) {
        await workingMsg.edit(errText);
      } else {
        await message.reply(errText);
      }
    } catch (_) {}
  }
}

// ── URL builder ───────────────────────────────────────────────────────────────

/**
 * Build the DecentBusking pre-filled mint URL.
 *
 * @param {string} siteUrl  - e.g. "https://thejollylama.github.io/DecentBusking"
 * @param {string} title    - Track title
 * @param {string} ipfsCid  - Raw CID (no ipfs:// prefix)
 * @returns {string}
 */
export function buildMintUrl(siteUrl, title, ipfsCid) {
  const params = new URLSearchParams({ title, ipfs: ipfsCid });
  return `${siteUrl}/?${params.toString()}`;
}

main().catch((err) => {
  console.error('[jukebox-bot] Fatal error:', err);
  process.exit(1);
});
