// discord-bot/embed.js
// Builds the Discord EmbedBuilder reply sent after a successful IPFS upload.

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createHash } from 'node:crypto';

export function mintRequestKey(trackId) {
  return createHash('sha256').update(trackId).digest('hex');
}

export function buildMintRequestComponents(trackId) {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`mint-request:${mintRequestKey(trackId)}`)
    .setLabel('Request NFT')
    .setStyle(ButtonStyle.Primary))];
}

// Colour for the embed left-hand stripe (green-ish guitar)
const EMBED_COLOUR = 0x00d26a;

/**
 * Build the upload confirmation and point the artist to the private mint queue.
 *
 * @param {object} opts
 * @param {string} opts.title       - Track title (from filename)
 * @param {string} opts.ipfsCid     - Raw CID string (without ipfs:// prefix)
 * @param {string} opts.trackId     - Stable track ID used for a mint request
 * @param {string} opts.uploaderTag - Discord username of the person who uploaded
 * @returns {EmbedBuilder}
 */
export function buildMintEmbed({ title, ipfsCid, trackId, uploaderTag }) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOUR)
    .setTitle('🎶 Media pinned to IPFS!')
    .setDescription(
      `**${title}** has been uploaded to the decentralised web.\n` +
      'Click **Request NFT** to confirm your Base artist wallet privately. ' +
      'Upload an optional image up to 10 MB, or enter an artwork IPFS CID for larger images; otherwise your Discord profile image will be used. ' +
      'This queues owner approval; no NFT is minted yet.'
    )
    .addFields(
      { name: '🎵 Track',    value: title,                             inline: true  },
      { name: '📌 IPFS CID', value: `\`${ipfsCid}\``,                 inline: false },
      { name: '🪪 Track ID', value: `\`${trackId}\``,                  inline: false },
    )
    .setFooter({ text: `Uploaded by ${uploaderTag} · DecentBusking Jukebox Bot` })
    .setTimestamp();
}
