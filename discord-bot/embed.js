// discord-bot/embed.js
// Builds the Discord EmbedBuilder reply sent after a successful IPFS upload.

import { EmbedBuilder } from 'discord.js';

// Colour for the embed left-hand stripe (green-ish guitar)
const EMBED_COLOUR = 0x00d26a;

/**
 * Build a rich Discord embed with a one-click "🎸 Mint This As A DNFT" link.
 *
 * @param {object} opts
 * @param {string} opts.title       - Track title (from filename)
 * @param {string} opts.ipfsCid     - Raw CID string (without ipfs:// prefix)
 * @param {string} opts.mintUrl     - Full pre-filled DecentBusking mint URL
 * @param {string} opts.uploaderTag - Discord username of the person who uploaded
 * @returns {EmbedBuilder}
 */
export function buildMintEmbed({ title, ipfsCid, mintUrl, uploaderTag }) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOUR)
    .setTitle('🎶 Audio pinned to IPFS!')
    .setDescription(
      `**${title}** has been uploaded to the decentralised web.\n` +
      `Click the button below to mint it as a DecentNFT — ` +
      `your wallet stays in control until you confirm in the browser.`
    )
    .addFields(
      { name: '🎵 Track',    value: title,                             inline: true  },
      { name: '📌 IPFS CID', value: `\`${ipfsCid}\``,                 inline: false },
      { name: '🔗 Mint URL', value: `[Open pre-filled mint form](${mintUrl})`, inline: false },
    )
    .setFooter({ text: `Uploaded by ${uploaderTag} · DecentBusking Jukebox Bot` })
    .setTimestamp();
}
