// discord-bot/index.js
// DecentBusking Discord Bot — entry point
//
// Features:
//  • Watches #jukebox for audio file uploads, pins them to IPFS via w3up, and
//    replies with a rich embed containing a one-click "🎸 Mint This As A DNFT"
//    deep-link into the DecentBusking UI with the mint form pre-filled.
//  • /radio play <cid>  — bot joins your voice channel and streams all tracks
//                         from an IPFS album directory; announces each track.
//  • /radio skip|pause|stop — playback controls for the active radio session.
//  • /jukebox play <cid> — bot DMs you a numbered playlist of stream links.
//
// The bot does NOT mint on-chain.  The user still connects MetaMask and
// confirms the transaction in the browser.

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';
import { loadConfig }    from './config.js';
import { uploadToIPFS }  from './ipfs.js';
import { buildMintEmbed } from './embed.js';
import { fetchTrackList, createSession, getSession } from './radio.js';

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

// ── Slash command definitions ─────────────────────────────────────────────────

// Discord embed description max is 4 096 chars; use 3 900 to leave formatting headroom.
const MAX_EMBED_CHUNK_SIZE = 3900;

// Error message shown when no audio tracks are found in an IPFS directory.
const NO_TRACKS_MSG =
  '❌ No audio tracks found in that IPFS directory. Make sure the CID points to a directory containing `.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`, `.aac`, or `.opus` files.';

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Community radio — stream an IPFS album to a Discord voice channel')
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Join your voice channel and stream an IPFS album directory')
        .addStringOption((opt) =>
          opt
            .setName('cid')
            .setDescription('IPFS CID or ipfs:// URL of the album directory')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('skip').setDescription('Skip to the next track'),
    )
    .addSubcommand((sub) =>
      sub.setName('pause').setDescription('Pause or resume playback'),
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Stop the radio and disconnect from voice'),
    ),

  new SlashCommandBuilder()
    .setName('jukebox')
    .setDescription('Personal jukebox — receive a private IPFS playlist via DM')
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Get a private numbered playlist for an IPFS album directory')
        .addStringOption((opt) =>
          opt
            .setName('cid')
            .setDescription('IPFS CID or ipfs:// URL of the album directory')
            .setRequired(true),
        ),
    ),
].map((cmd) => cmd.toJSON());

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[jukebox-bot] Logged in as ${readyClient.user.tag}`);
    console.log(`[jukebox-bot] Watching channel ID: ${config.jukeboxChannelId}`);

    // Register global slash commands
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    try {
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: SLASH_COMMANDS });
      console.log('[jukebox-bot] Slash commands registered globally.');
    } catch (err) {
      console.error('[jukebox-bot] Failed to register slash commands:', err.message);
    }
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

  // ── Slash command interactions ───────────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'radio') {
      await handleRadioCommand(interaction, config);
    } else if (interaction.commandName === 'jukebox') {
      await handleJukeboxCommand(interaction, config);
    }
  });

  await client.login(config.discordToken);
}

// ── /radio command handler ────────────────────────────────────────────────────

/**
 * Handle all `/radio` subcommands.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {ReturnType<typeof loadConfig>} config
 */
async function handleRadioCommand(interaction, config) {
  const sub = interaction.options.getSubcommand();

  // Controls that require an already-active session
  if (sub === 'skip' || sub === 'pause' || sub === 'stop') {
    const session = getSession(interaction.guildId);
    if (!session) {
      await interaction.reply({ content: '📻 No radio session is active right now.', ephemeral: true });
      return;
    }
    if (sub === 'skip') {
      session.skip();
      await interaction.reply('⏭️ Skipping to the next track…');
    } else if (sub === 'pause') {
      const nowPaused = session.togglePause();
      await interaction.reply(nowPaused ? '⏸️ Radio paused.' : '▶️ Radio resumed.');
    } else {
      session.stop();
      await interaction.reply('⏹️ Radio stopped and disconnected.');
    }
    return;
  }

  // /radio play <cid>
  const cid = interaction.options.getString('cid', true).trim();

  // The caller must be in a voice channel
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply({
      content: '🎙️ You must be in a voice channel to start the radio.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const tracks = await fetchTrackList(cid, config.ipfsGateway);
    if (tracks.length === 0) {
      await interaction.editReply(NO_TRACKS_MSG);
      return;
    }

    const session = createSession(interaction.guildId, {
      voiceChannel,
      textChannel: interaction.channel,
    });

    await session.connect();
    await interaction.editReply(
      `📻 Radio starting — found **${tracks.length}** track(s) from \`${cid}\`. Joining <#${voiceChannel.id}>…`,
    );
    await session.start(tracks);
  } catch (err) {
    console.error('[radio] Error starting radio:', err);
    await interaction.editReply(`❌ Failed to start radio: ${err.message}`);
  }
}

// ── /jukebox command handler ──────────────────────────────────────────────────

/**
 * Handle all `/jukebox` subcommands.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {ReturnType<typeof loadConfig>} config
 */
async function handleJukeboxCommand(interaction, config) {
  const sub = interaction.options.getSubcommand();
  if (sub !== 'play') return;

  const cid = interaction.options.getString('cid', true).trim();

  await interaction.deferReply({ ephemeral: true });

  try {
    const tracks = await fetchTrackList(cid, config.ipfsGateway);
    if (tracks.length === 0) {
      await interaction.editReply(NO_TRACKS_MSG);
      return;
    }

    // Build a numbered playlist with clickable stream links
    const listLines = tracks.map((url, i) => {
      const filename = url.split('/').pop();
      const name     = filename ? decodeURIComponent(filename) : `Track ${i + 1}`;
      return `**${i + 1}.** [${name}](${url})`;
    });

    // Chunk into blocks ≤ MAX_EMBED_CHUNK_SIZE chars to stay within Discord's embed limit
    const chunks = [];
    let current  = '';
    for (const line of listLines) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length > MAX_EMBED_CHUNK_SIZE) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);

    const buildEmbed = (description, isFirst) => {
      const embed = new EmbedBuilder().setColor(0x9b59b6).setDescription(description);
      if (isFirst) {
        embed
          .setTitle('🎧 Your Personal IPFS Playlist')
          .setFooter({ text: `CID: ${cid} · DecentBusking Jukebox` })
          .setTimestamp(new Date());
      }
      return embed;
    };

    // Try to DM the user; fall back to ephemeral channel replies if DMs are closed
    try {
      await interaction.user.send({ embeds: [buildEmbed(chunks[0], true)] });
      for (const chunk of chunks.slice(1)) {
        await interaction.user.send({ embeds: [buildEmbed(chunk, false)] });
      }
      await interaction.editReply('📬 Your private playlist has been sent to your DMs!');
    } catch {
      // DMs disabled — reply ephemerally in the channel
      await interaction.editReply({ embeds: [buildEmbed(chunks[0], true)] });
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ embeds: [buildEmbed(chunk, false)], ephemeral: true });
      }
    }
  } catch (err) {
    console.error('[jukebox] Error fetching playlist:', err);
    await interaction.editReply(`❌ Failed to fetch playlist: ${err.message}`);
  }
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
    const mintUrl = buildMintUrl(config.siteUrl, title, ipfsCid, uploaderTag);

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
 * @param {string} [artist] - Discord uploader tag (optional)
 * @returns {string}
 */
export function buildMintUrl(siteUrl, title, ipfsCid, artist) {
  const params = new URLSearchParams({ title, ipfs: ipfsCid });
  if (artist) params.set('artist', artist);
  return `${siteUrl}/?${params.toString()}`;
}

main().catch((err) => {
  console.error('[jukebox-bot] Fatal error:', err);
  process.exit(1);
});
