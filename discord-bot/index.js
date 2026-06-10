// discord-bot/index.js
// DecentBusking Discord Bot — entry point
//
// Features:
//  • Watches #DecentJukebox for audio file uploads, pins them to IPFS via w3up,
//    replies with a rich embed containing a "🎸 Mint This As A DNFT" deep-link,
//    AND adds the track to the JukeLoop playlist.
//  • JukeLoop: 24/7 audio stream in the JukeLoop voice channel, sourced from
//    #DecentJukebox uploads, ordered by 👍/👎 weighted ratings.
//  • /radio play <cid>  — bot joins your voice channel and streams all tracks
//                         from an IPFS album directory; announces each track.
//  • /radio skip|pause|stop — playback controls for the active radio session.
//  • /jukebox play <cid> — bot DMs you a numbered playlist of stream links.
//  • /jukeloop remove <title> — admin: remove a track from the JukeLoop playlist.
//  • /jukeloop stats          — show the top-rated JukeLoop tracks.
//  • /jukeloop volume <level> — (currently informational; voice volume is fixed).
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
import {
  loadPlaylist,
  addTrack,
  getPlaylist,
  getTopTracks,
  removeTrack,
} from './playlist-store.js';
import {
  createJukeLoopSession,
  backfillFromChannel,
} from './jukeloop.js';

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

  new SlashCommandBuilder()
    .setName('jukeloop')
    .setDescription('JukeLoop admin commands — manage the community radio playlist')
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('Show the top-rated tracks in the JukeLoop playlist'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('(Admin) Remove a track from the JukeLoop playlist by title')
        .addStringOption((opt) =>
          opt
            .setName('title')
            .setDescription('Part of the track title to search for (case-insensitive)')
            .setRequired(true),
        ),
    ),
].map((cmd) => cmd.toJSON());

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const config = loadConfig();

  // Load the persisted JukeLoop playlist before the client connects
  loadPlaylist();

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

    // ── JukeLoop startup ───────────────────────────────────────────────────────
    if (config.jukeLoopVoiceChannelId && config.jukeLoopTextChannelId) {
      await startJukeLoop(readyClient, config);
    } else {
      console.log(
        '[jukeloop] JUKE_LOOP_VOICE_CHANNEL_ID or JUKE_LOOP_TEXT_CHANNEL_ID not set — ' +
        'JukeLoop disabled.',
      );
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bots and messages outside the configured channel
    if (message.author.bot) return;
    if (message.channelId !== config.jukeboxChannelId) return;

    const audioAttachments = [...message.attachments.values()].filter(isAudioAttachment);
    if (!audioAttachments.length) return;

    for (const attachment of audioAttachments) {
      // ── JukeLoop: queue the new upload ──────────────────────────────────────
      if (config.jukeLoopVoiceChannelId) {
        const filename = attachment.name || 'track.mp3';
        const title    = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || filename;
        addTrack({
          messageId:  message.id,
          channelId:  message.channelId,
          filename,
          title,
          uploader:   message.author.tag ?? message.author.username ?? 'Unknown',
          uploaderId: message.author.id,
        });
      }

      // ── Existing IPFS / mint flow ────────────────────────────────────────────
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
    } else if (interaction.commandName === 'jukeloop') {
      await handleJukeLoopCommand(interaction, config);
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

// ── JukeLoop startup helper ───────────────────────────────────────────────────

/**
 * Resolve JukeLoop channels, backfill historic tracks, and start the session.
 *
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof loadConfig>} config
 */
async function startJukeLoop(client, config) {
  try {
    const voiceChannel = await client.channels.fetch(config.jukeLoopVoiceChannelId).catch(() => null);
    const textChannel  = await client.channels.fetch(config.jukeLoopTextChannelId).catch(() => null);
    const jukeboxCh    = await client.channels.fetch(config.jukeboxChannelId).catch(() => null);

    if (!voiceChannel) {
      console.error('[jukeloop] Could not find voice channel:', config.jukeLoopVoiceChannelId);
      return;
    }
    if (!textChannel) {
      console.error('[jukeloop] Could not find text channel:', config.jukeLoopTextChannelId);
      return;
    }

    // Backfill all historic uploads from #DecentJukebox
    if (jukeboxCh) {
      await backfillFromChannel(jukeboxCh);
    } else {
      console.warn('[jukeloop] Could not access #DecentJukebox for backfill:', config.jukeboxChannelId);
    }

    const session = createJukeLoopSession(voiceChannel.guild.id, {
      voiceChannel,
      textChannel,
      client,
    });

    await session.connect();
    console.log('[jukeloop] Connected to voice channel, starting playback…');
    await textChannel
      .send('📻 **JukeLoop is live!** The community radio is starting up — tracks from #DecentJukebox are on the way.')
      .catch(() => {});
    await session.start();
  } catch (err) {
    console.error('[jukeloop] Failed to start JukeLoop:', err.message);
  }
}

// ── /jukeloop command handler ─────────────────────────────────────────────────

/**
 * Handle all `/jukeloop` subcommands.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {ReturnType<typeof loadConfig>} config
 */
async function handleJukeLoopCommand(interaction, config) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'stats') {
    const top = getTopTracks(10);
    if (top.length === 0) {
      await interaction.reply({ content: '📭 The JukeLoop playlist is empty.', ephemeral: true });
      return;
    }

    const lines = top.map((t, i) => {
      const score  = (t.likes - t.dislikes * 0.5).toFixed(1);
      const rating = `👍 ${t.likes}  👎 ${t.dislikes}  ▶️ ${t.plays}`;
      return `**${i + 1}.** ${t.title} — *${t.uploader}*\n  ${rating}  (score: ${score})`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('📊 JukeLoop — Top Tracks')
      .setDescription(lines.join('\n\n'))
      .setFooter({ text: `${getPlaylist().length} track(s) total · DecentBusking JukeLoop` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'remove') {
    // Admin-only: requires ManageMessages permission
    if (!interaction.memberPermissions?.has('ManageMessages')) {
      await interaction.reply({
        content: '🔒 You need the **Manage Messages** permission to remove JukeLoop tracks.',
        ephemeral: true,
      });
      return;
    }

    const query   = interaction.options.getString('title', true).toLowerCase();
    const matches = getPlaylist().filter((t) => t.title.toLowerCase().includes(query));

    if (matches.length === 0) {
      await interaction.reply({
        content: `❌ No JukeLoop tracks found matching **"${query}"**.`,
        ephemeral: true,
      });
      return;
    }

    if (matches.length > 1) {
      const list = matches.slice(0, 5).map((t) => `• **${t.title}** by ${t.uploader}`).join('\n');
      await interaction.reply({
        content: `⚠️ Multiple tracks match **"${query}"** — please be more specific:\n${list}`,
        ephemeral: true,
      });
      return;
    }

    const removed = removeTrack(matches[0].messageId);
    if (removed) {
      await interaction.reply({
        content: `🗑️ Removed **${removed.title}** by *${removed.uploader}* from the JukeLoop playlist.`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({ content: '❌ Track could not be removed.', ephemeral: true });
    }
    return;
  }
}

main().catch((err) => {
  console.error('[jukebox-bot] Fatal error:', err);
  process.exit(1);
});
