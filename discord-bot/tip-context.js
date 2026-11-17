import { Contract, id } from 'ethers';
import { isMusicNft, nftArtistLabel } from '../js/nft-loader.js';
import { fetchMintMetadata } from './mint-sync.js';
import { LIVE_ESCROW_ABI, LIVE_ASSET_ESCROW_ABI } from '../js/live-bookings.mjs';

const NFT_ABI = ['function uri(uint256) view returns(string)', 'function totalMinted(uint256) view returns(uint256)'];
export const LIVE_ASSETS_ESCROW_ABI = LIVE_ASSET_ESCROW_ABI;
function exactUnsigned(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'bigint' && value >= 0n) return value;
  throw new Error('Invalid booking integer');
}

export function createHistoricalTipBookingReader({ provider, escrowAddress, contract,
  assetEscrowAddress, assetContract, resolveBookingIdentity }) {
  if ((assetEscrowAddress || assetContract) && !resolveBookingIdentity) {
    throw new Error('Asset booking verification requires canonical booking contract identities');
  }
  const escrow = contract || (escrowAddress ? new Contract(escrowAddress, LIVE_ESCROW_ABI, provider) : null);
  const assetEscrow = assetContract || (assetEscrowAddress ? new Contract(assetEscrowAddress, LIVE_ASSETS_ESCROW_ABI, provider) : null);
  return async (bookingId, blockNumber) => {
    const identity = resolveBookingIdentity ? await resolveBookingIdentity(bookingId) : null;
    if (resolveBookingIdentity && !identity) throw new Error('Booking contract identity is unavailable');
    if (identity && (identity.bookingId !== bookingId || identity.chainId !== 8453)) {
      throw new Error('Booking contract identity is mismatched');
    }
    if (identity?.version === 'assets-v1') {
      if (!assetEscrow || !assetEscrowAddress || identity.chainId !== 8453 ||
          String(identity.escrowAddress || '').toLowerCase() !== assetEscrowAddress.toLowerCase() ||
          (await provider.getNetwork()).chainId !== 8453n || !identity.terms) {
        throw new Error('Asset booking contract identity is unavailable or mismatched');
      }
      const booking = await assetEscrow.bookings(id(bookingId), { blockTag: blockNumber });
      if (Number(booking.feeStatus) === 0) return { verified: true, exists: false, title: bookingId };
      const fields = ['performer', 'asset', 'termsHash', 'collection', 'giftTreasury'];
      const numbers = ['amount', 'showStart', 'showEnd', 'reviewWindow', 'tokenId', 'quantity'];
      if (fields.some(field => typeof identity.terms[field] !== 'string' ||
          String(booking.terms[field]).toLowerCase() !== identity.terms[field].toLowerCase()) ||
          numbers.some(field => {
            try { return exactUnsigned(booking.terms[field]) !== exactUnsigned(identity.terms[field]); }
            catch { return true; }
          })) throw new Error('Asset booking terms do not match historical escrow');
      return { verified: true, exists: true, eligible:[1,2,3].includes(Number(booking.feeStatus)), performer: booking.terms.performer, title: bookingId };
    }
    if (identity && (identity.version !== 'legacy-usdc-v1' ||
        String(identity.escrowAddress || '').toLowerCase() !== String(escrowAddress || '').toLowerCase())) {
      throw new Error('Unknown or mismatched booking contract identity');
    }
    if (!escrow) throw new Error('Live escrow verification is not configured');
    const booking = await escrow.bookings(id(bookingId), { blockTag: blockNumber });
    return { verified: true, exists: Number(booking.status) !== 0, performer: booking.performer, title: bookingId };
  };
}

export function createTipContextResolver({ provider, collections, readLiveBooking,
  readNft = async ({ collection, tokenId, blockNumber }) => {
    const contract = new Contract(collection, NFT_ABI, provider);
    const [uri, supply] = await Promise.all([
      contract.uri(tokenId, { blockTag: blockNumber }), contract.totalMinted(tokenId, { blockTag: blockNumber }),
    ]);
    return { uri, supply };
  },
  fetchMetadata = uri => fetchMintMetadata(uri, fetch, { attempts: 1 }) }) {
  const allowed = new Set(collections.map(address => address.toLowerCase()));
  const metadataCache = new Map();
  const metadataFor = async uri => {
    if (!metadataCache.has(uri)) {
      metadataCache.set(uri, Promise.resolve().then(() => fetchMetadata(uri)));
      if (metadataCache.size > 128) metadataCache.delete(metadataCache.keys().next().value);
    }
    const pending = metadataCache.get(uri);
    try { return await pending; }
    catch (error) {
      if (metadataCache.get(uri) === pending) metadataCache.delete(uri);
      throw error;
    }
  };
  return async ({ context, recipient, blockNumber }) => {
    if (context.source === 'live') {
      const booking = await readLiveBooking(context.bookingId, blockNumber);
      if (!booking || booking.verified !== true) return { status: 'unavailable', error: 'Booking chain verification is unavailable' };
      if (booking.exists === false) return { status: 'mismatch', error: 'Booking did not exist at the tip block' };
      if (booking.eligible === false) return { status: 'mismatch', error: 'Booking fee was refunded or recovered at the tip block' };
      if (booking.performer?.toLowerCase() !== recipient) return { status: 'mismatch', error: 'Tip recipient does not match the booked performer' };
      return { status: 'verified', label: booking.title || context.bookingId };
    }
    const [chainId, collection, tokenId] = context.nftId.split(':');
    if (chainId !== '8453' || !allowed.has(collection)) return { status: 'mismatch', error: 'Recording is not in a configured Base collection' };
    const nft = await readNft({ collection, tokenId, blockNumber });
    if (BigInt(nft.supply) <= 0n) return { status: 'mismatch', error: 'Recording was not minted at the tip block' };
    if (!/^ipfs:\/\//.test(nft.uri)) return { status: 'unavailable', error: 'Historical recording attribution requires content-addressed IPFS metadata' };
    const metadata = await metadataFor(nft.uri);
    if (!isMusicNft(metadata) || metadata.tipWallet?.toLowerCase() !== recipient) {
      return { status: 'mismatch', error: 'Tip recipient does not match the recording metadata at the tip block' };
    }
    return { status: 'verified', label: `${nftArtistLabel(metadata)} - ${metadata.name || metadata.title || `Recording #${tokenId}`}` };
  };
}
