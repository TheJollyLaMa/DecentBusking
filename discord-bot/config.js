// discord-bot/config.js
// Reads all required environment variables.
// Call loadConfig() once at startup; it will throw if any required var is missing.

import 'dotenv/config';

/**
 * @typedef {Object} BotConfig
 * @property {string} discordToken       - Discord bot token (DISCORD_TOKEN)
 * @property {string} jukeboxChannelId   - Discord channel ID to watch (JUKEBOX_CHANNEL_ID)
 * @property {string} siteUrl            - DecentBusking site URL (SITE_URL)
 * @property {string} w3upKey            - w3up agent key – base64-encoded UCAN delegation (W3UP_KEY)
 * @property {string} w3upProof          - w3up space proof – base64-encoded UCAN delegation (W3UP_PROOF)
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
    discordToken:     process.env.DISCORD_TOKEN,
    jukeboxChannelId: process.env.JUKEBOX_CHANNEL_ID,
    siteUrl:          (process.env.SITE_URL || 'https://thejollylama.github.io/DecentBusking').replace(/\/$/, ''),
    w3upKey:          process.env.W3UP_KEY,
    w3upProof:        process.env.W3UP_PROOF,
  };
}
