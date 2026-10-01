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
 * @property {'pinata'|'local'} ipfsUploadProvider - Upload backend (IPFS_UPLOAD_PROVIDER)
 * @property {string|null} pinataJwt               - Server-only Pinata JWT (PINATA_JWT)
 * @property {string}      ipfsApiUrl              - Local Kubo API URL (IPFS_API_URL)
 * @property {string[]}    allowedOrigins          - Browser origins allowed to request signed URLs
 * @property {string}      mintOwnerWallet         - Wallet allowed to authorize browser uploads
 * @property {string}      publicWorkerUrl         - Public Render service URL used in approval links
 * @property {string}      nftContractAddress      - Base DecentNFT contract address
 * @property {string}      baseRpcUrl              - Base JSON-RPC endpoint
 * @property {string}      blockExplorerUrl        - Base block explorer root URL
 * @property {string|null} jukeLoopVoiceChannelId  - JukeLoop voice channel ID (JUKE_LOOP_VOICE_CHANNEL_ID) — optional
 * @property {string|null} jukeLoopTextChannelId   - JukeLoop announcement text channel ID (JUKE_LOOP_TEXT_CHANNEL_ID) — optional
 * @property {boolean}     disableMintFlow         - Skip IPFS pinning and mint embed (DISABLE_MINT_FLOW) — optional, default false
 */

/**
 * Load and validate environment variables.
 * @returns {BotConfig}
 */
export function loadConfig() {
  const ipfsUploadProvider = process.env.IPFS_UPLOAD_PROVIDER || 'pinata';
  if (!['pinata', 'local'].includes(ipfsUploadProvider)) {
    throw new Error('IPFS_UPLOAD_PROVIDER must be pinata or local');
  }
  const required = ['DISCORD_TOKEN', 'JUKEBOX_CHANNEL_ID'];
  if (ipfsUploadProvider === 'pinata') {
    required.push('PINATA_JWT', 'IPFS_ALLOWED_ORIGINS', 'MINT_OWNER_WALLET', 'PUBLIC_WORKER_URL');
  }
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    discordToken:           process.env.DISCORD_TOKEN,
    jukeboxChannelId:       process.env.JUKEBOX_CHANNEL_ID,
    siteUrl:                (process.env.SITE_URL || 'https://thejollylama.github.io/DecentBusking').replace(/\/$/, ''),
    ipfsGateway:            (process.env.IPFS_GATEWAY || 'https://dweb.link').replace(/\/$/, ''),
    ipfsUploadProvider,
    pinataJwt:              process.env.PINATA_JWT || null,
    pinataApiUrl:           process.env.PINATA_API_URL || 'https://uploads.pinata.cloud/v3/files',
    pinataSignUrl:          process.env.PINATA_SIGN_URL || 'https://uploads.pinata.cloud/v3/files/sign',
    pinataFilesApiUrl:      process.env.PINATA_FILES_API_URL || 'https://api.pinata.cloud/v3/files/public',
    ipfsApiUrl:             process.env.IPFS_API_URL || 'http://127.0.0.1:5001',
    allowedOrigins:         (process.env.IPFS_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
    mintOwnerWallet:        process.env.MINT_OWNER_WALLET || '',
    publicWorkerUrl:        (process.env.PUBLIC_WORKER_URL || '').replace(/\/$/, ''),
    nftContractAddress:     process.env.DECENT_NFT_CONTRACT_ADDRESS || '0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B',
    baseRpcUrl:             process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    blockExplorerUrl:       (process.env.BLOCK_EXPLORER_URL || 'https://basescan.org').replace(/\/$/, ''),
    jukeLoopVoiceChannelId: process.env.JUKE_LOOP_VOICE_CHANNEL_ID || null,
    jukeLoopTextChannelId:  process.env.JUKE_LOOP_TEXT_CHANNEL_ID  || null,
    disableMintFlow:        process.env.DISABLE_MINT_FLOW === 'true',
  };
}
