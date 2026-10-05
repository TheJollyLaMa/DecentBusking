import { ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, FileUploadBuilder, MessageFlags } from 'discord.js';
import { mintRequestKey } from './embed.js';
import { normalizeMediaCid } from './media.js';

const BUTTON_PREFIX = 'mint-request:';
const MODAL_PREFIX = 'mint-wallet:';
const WALLET_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function previousArtistWallet(tracks, uploaderId) {
  const wallets = new Map();
  for (const track of tracks) {
    if (track.uploaderId === uploaderId && WALLET_PATTERN.test(track.mintRecipient || '')) {
      wallets.set(track.mintRecipient.toLowerCase(), track.mintRecipient);
    }
  }
  return wallets.size === 1 ? [...wallets.values()][0] : '';
}

export function createMintRequestInteractionHandler({ getPlaylist, requestTrackMint, waitForPersistence,
  getDefaultArtwork, uploadArtwork }) {
  return async interaction => {
    const button = interaction.isButton?.() && interaction.customId?.startsWith(BUTTON_PREFIX);
    const modal = interaction.isModalSubmit?.() && interaction.customId?.startsWith(MODAL_PREFIX);
    if (!button && !modal) return false;
    const key = interaction.customId.slice((button ? BUTTON_PREFIX : MODAL_PREFIX).length);
    const tracks = getPlaylist();
    const track = tracks.find(entry => mintRequestKey(entry.trackId) === key);
    if (!track || track.uploaderId !== interaction.user.id) {
      await interaction.reply({ content: 'Only the original uploader can request this NFT.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (track.pinStatus !== 'pinned' || !track.ipfsCid || track.mintStatus === 'minted') {
      await interaction.reply({ content: 'This track is not ready for a mint request, or has already been minted.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (button) {
      const wallet = new TextInputBuilder().setCustomId('artist-wallet').setStyle(TextInputStyle.Short)
        .setRequired(true).setMinLength(42).setMaxLength(42).setPlaceholder('0x...');
      const previous = track.mintRecipient || previousArtistWallet(tracks, interaction.user.id);
      if (WALLET_PATTERN.test(previous)) wallet.setValue(previous);
      const walletLabel = new LabelBuilder().setLabel('Base artist wallet').setTextInputComponent(wallet);
      const artworkLabel = new LabelBuilder().setLabel('NFT artwork (optional, up to 10 MB)')
        .setDescription(track.artworkCid ? 'Keep existing artwork, or use the CID field for images over 10 MB.' : 'Default: Discord profile image. For images over 10 MB, use the artwork CID field.')
        .setFileUploadComponent(new FileUploadBuilder().setCustomId('nft-artwork').setMinValues(0).setMaxValues(1).setRequired(false));
      const artworkCidLabel = new LabelBuilder().setLabel('Artwork file CID (optional)')
        .setDescription('Use an already-uploaded image file CID instead of attaching an image.')
        .setTextInputComponent(new TextInputBuilder().setCustomId('artwork-cid').setStyle(TextInputStyle.Short)
          .setRequired(false).setMaxLength(160).setPlaceholder('bafy... or ipfs://...'));
      await interaction.showModal(new ModalBuilder().setCustomId(`${MODAL_PREFIX}${key}`)
        .setTitle('Request NFT').addLabelComponents(walletLabel, artworkLabel, artworkCidLabel));
      return true;
    }
    const wallet = interaction.fields.getTextInputValue('artist-wallet').trim();
    const artwork = interaction.fields.getUploadedFiles('nft-artwork')?.first();
    const rawArtworkCid = interaction.fields.getTextInputValue('artwork-cid').trim();
    if (!WALLET_PATTERN.test(wallet)) {
      await interaction.reply({ content: 'Enter a valid 0x Base wallet address, then click Request NFT again.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (artwork && rawArtworkCid) {
      await interaction.reply({ content: 'Choose one artwork source: attach an image up to 10 MB, or enter its IPFS file CID.', flags: MessageFlags.Ephemeral });
      return true;
    }
    let suppliedArtworkCid;
    if (rawArtworkCid) {
      try {
        suppliedArtworkCid = normalizeMediaCid(rawArtworkCid);
      } catch {
        await interaction.reply({ content: 'Enter a valid artwork file CID or ipfs://CID, without a directory path or gateway URL.', flags: MessageFlags.Ephemeral });
        return true;
      }
    }
    if (artwork && (!Number.isInteger(artwork.size) || artwork.size < 1 || artwork.size > 10 * 1024 * 1024 ||
        !(IMAGE_TYPES.includes(artwork.contentType) || IMAGE_EXTENSIONS.test(artwork.name || '')))) {
      await interaction.reply({ content: 'Artwork attachments must be PNG, JPEG, WebP, or GIF, up to 10 MB. For larger images, use the artwork file CID field.', flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const artworkCid = suppliedArtworkCid || (artwork ? await uploadArtwork(artwork)
        : track.artworkCid || await getDefaultArtwork(interaction.user));
      if (!artworkCid) throw new Error('Could not archive your profile image; retry or upload an artwork image');
      const queued = requestTrackMint(track.trackId, interaction.user.id, wallet, artworkCid);
      if (!queued) throw new Error('The track changed or was minted while the request was being submitted');
      await waitForPersistence();
      await interaction.editReply({ content: `Requested owner approval for **${queued.title}**.\n` +
        `Artist and royalty wallet: \`${wallet}\`\n` +
        `Artwork: ${suppliedArtworkCid ? 'your IPFS image' : artwork ? 'your uploaded image' : track.artworkCid ? 'existing image' : 'your Discord profile image'}.\nNo NFT has been minted yet.`,
      allowedMentions: { parse: [] } });
    } catch (error) {
      await interaction.editReply({ content: `Could not submit the mint request: ${error.message}`, allowedMentions: { parse: [] } });
    }
    return true;
  };
}