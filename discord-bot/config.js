// discord-bot/config.js
// Reads all required environment variables.
// Call loadConfig() once at startup; it will throw if any required var is missing.

import 'dotenv/config';

/**
 * @typedef {Object} BotConfig
 * @property {string}      discordToken            - Discord bot token (DISCORD_TOKEN)
 * @property {string}      jukeboxChannelId        - #DecentJukebox channel ID (JUKEBOX_CHANNEL_ID)
 * @property {string}      siteUrl                 - DecentBusking site URL (SITE_URL)
 * @property {string}      ipfsGateway             - IPFS HTTP gateway base URL (IPFS_GATEWAY)
 * @property {string}      w3upKey                 - w3up agent key (W3UP_KEY)
 * @property {string}      w3upProof               - w3up space proof (W3UP_PROOF)
 * @property {string|null} jukeLoopVoiceChannelId  - JukeLoop voice channel ID (JUKE_LOOP_VOICE_CHANNEL_ID) — optional
 * @property {string|null} jukeLoopTextChannelId   - JukeLoop announcement text channel ID (JUKE_LOOP_TEXT_CHANNEL_ID) — optional
 */

/**
 * Load and validate environment variables.
 * @returns {BotConfig}
 */
export function loadConfig() {
  const required = ['DISCORD_TOKEN', 'JUKEBOX_CHANNEL_ID', 'W3UP_KEY', 'W3UP_PROOF'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    discordToken:           process.env.DISCORD_TOKEN,
    jukeboxChannelId:       process.env.JUKEBOX_CHANNEL_ID,
    siteUrl:                (process.env.SITE_URL || 'https://thejollylama.github.io/DecentBusking').replace(/\/$/, ''),
    ipfsGateway:            (process.env.IPFS_GATEWAY || 'https://w3s.link').replace(/\/$/, ''),
    w3upKey:                process.env.W3UP_KEY,
    w3upProof:              process.env.W3UP_PROOF,
    jukeLoopVoiceChannelId: process.env.JUKE_LOOP_VOICE_CHANNEL_ID || null,
    jukeLoopTextChannelId:  process.env.JUKE_LOOP_TEXT_CHANNEL_ID  || null,
  };
}
