import { audioCid } from './nft-loader.js?v=20261025-song-identity';

export const MAX_CREATOR_RECIPIENTS = 16;
export const MAX_CREDIT_TITLE_LENGTH = 80;

export async function resolveNftSongId(nft, { config, fetchImpl = globalThis.fetch }) {
  if (/^0x[0-9a-fA-F]{64}$/.test(nft.djukeSongId || '')) return nft.djukeSongId;
  const cid = audioCid(nft.videoUrl || nft.audioUrl || nft.animation_url);
  if (!cid) throw new Error('This NFT has no IPFS recording to match to DJuke');
  const service = String(config.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  if (!service || !/^0x[0-9a-fA-F]{40}$/.test(config.djukeContractAddress || '')) {
    throw new Error('DJuke is not configured for this page');
  }
  const response = await fetchImpl(`${service}/api/djuke`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`DJuke song lookup unavailable (${response.status})`);
  const snapshot = await response.json();
  if (snapshot.chainId !== (config.chainId || 8453) ||
      String(snapshot.contractAddress || '').toLowerCase() !== config.djukeContractAddress.toLowerCase() ||
      !Array.isArray(snapshot.tracks)) {
    throw new Error("DJuke catalog does not match this page's configured contract");
  }
  const matches = snapshot.tracks.filter(track => track.ipfsCid === cid);
  if (matches.length !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(matches[0].songId || '')) {
    if (!matches.length && snapshot.catalogReadErrors > 0) {
      throw new Error('DJuke could not verify every registration; try again when the catalog is available');
    }
    throw new Error(matches.length > 1 ? 'This recording has multiple DJuke registrations; its song identity must be reconciled first'
      : 'This recording is not registered in DJuke. It must be registered before payment splits can be changed.');
  }
  return matches[0].songId;
}

export function buildAlbumTrackRemovalAuthorizationMessage({ address, origin, albumId, songId, txHash, issuedAt }) {
  return [
    'DecentBusking album track removal reconciliation',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Album: ${albumId.toLowerCase()}`,
    `Song: ${songId.toLowerCase()}`,
    `Transaction: ${txHash.toLowerCase()}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export function validateCreatorSplitRows(rows, { maxRecipients = MAX_CREATOR_RECIPIENTS } = {}) {
  if (!Array.isArray(rows) || !rows.length || rows.length > maxRecipients) {
    throw new Error(`Use 1-${maxRecipients} collaborator wallets`);
  }
  let total = 0;
  const seen = new Set();
  const normalized = rows.map(({ wallet, shareBps, position = '' }) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || '') || /^0x0{40}$/i.test(wallet)) {
      throw new Error('Enter a valid nonzero wallet for every collaborator');
    }
    const key = wallet.toLowerCase();
    if (seen.has(key)) throw new Error('Each collaborator wallet must be distinct');
    seen.add(key);
    if (!Number.isInteger(shareBps) || shareBps < 1 || shareBps > 10000) {
      throw new Error('Each share must be between 0.01% and 100%');
    }
    if (typeof position !== 'string' || position.length > MAX_CREDIT_TITLE_LENGTH) {
      throw new Error(`Credit titles must be ${MAX_CREDIT_TITLE_LENGTH} characters or fewer`);
    }
    total += shareBps;
    return { wallet, shareBps, position };
  });
  if (total !== 10000) throw new Error('Collaborator shares must total exactly 100%');
  return normalized;
}

export function parseCreatorSplitLines(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [wallet, percent, ...creditParts] = line.split(',').map(value => value.trim());
    if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(percent || '')) {
      throw new Error('Enter wallet or ENS, percentage, and credit title on each line');
    }
    const [whole, fraction = ''] = percent.split('.');
    const shareBps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    return { input: wallet, shareBps, position: creditParts.join(', ') };
  });
}

export async function resolveCreatorSplitLines(text, resolveName) {
  const rows = parseCreatorSplitLines(text);
  const resolved = await Promise.all(rows.map(async ({ input, shareBps, position }) => {
    const wallet = /^0x[0-9a-fA-F]{40}$/.test(input || '') ? input : await resolveName(input);
    if (!wallet) throw new Error(`Could not resolve collaborator "${input}" to a wallet`);
    return { wallet, shareBps, position };
  }));
  return validateCreatorSplitRows(resolved);
}

export function buildAlbumSplitTypedData({ ethers, contractAddress, albumId, revision, recipients, sharesBps, positions }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const domain = { name: 'DecentJukeBox', version: DJUKE_SIGNING_DOMAIN_VERSION, chainId: 8453, verifyingContract: contractAddress };
  const types = { AlbumSplit: [
    { name: 'albumId', type: 'bytes32' },
    { name: 'revision', type: 'uint256' },
    { name: 'recipientsHash', type: 'bytes32' },
    { name: 'sharesHash', type: 'bytes32' },
    { name: 'positionsHash', type: 'bytes32' },
  ] };
  const value = {
    albumId,
    revision,
    recipientsHash: ethers.keccak256(coder.encode(['address[]'], [recipients])),
    sharesHash: ethers.keccak256(coder.encode(['uint16[]'], [sharesBps])),
    positionsHash: ethers.keccak256(coder.encode(['string[]'], [positions])),
  };
  return { domain, types, value };
}

export function buildSongSplitTypedData({
  ethers, contractAddress, songId, audioURI, currentRecipients, currentSharesBps, recipients, sharesBps, positions,
}) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const domain = { name: 'DecentJukeBox', version: DJUKE_SIGNING_DOMAIN_VERSION, chainId: 8453, verifyingContract: contractAddress };
  const types = { SongSplit: [
    { name: 'songId', type: 'bytes32' },
    { name: 'audioURIHash', type: 'bytes32' },
    { name: 'currentRecipientsHash', type: 'bytes32' },
    { name: 'currentSharesHash', type: 'bytes32' },
    { name: 'recipientsHash', type: 'bytes32' },
    { name: 'sharesHash', type: 'bytes32' },
    { name: 'positionsHash', type: 'bytes32' },
  ] };
  const value = {
    songId,
    audioURIHash: ethers.keccak256(ethers.toUtf8Bytes(audioURI)),
    currentRecipientsHash: ethers.keccak256(coder.encode(['address[]'], [currentRecipients])),
    currentSharesHash: ethers.keccak256(coder.encode(['uint16[]'], [currentSharesBps])),
    recipientsHash: ethers.keccak256(coder.encode(['address[]'], [recipients])),
    sharesHash: ethers.keccak256(coder.encode(['uint16[]'], [sharesBps])),
    positionsHash: ethers.keccak256(coder.encode(['string[]'], [positions])),
  };
  return { domain, types, value };
}

export function buildSongAlbumMigrationTypedData({
  ethers, contractAddress, albumId, songId, albumRevision, audioURI,
  currentRecipients, currentSharesBps, albumRecipients, albumSharesBps, albumPositions, useAlbumDefault,
}) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const domain = {
    name: 'DecentJukeBox',
    version: DJUKE_SIGNING_DOMAIN_VERSION,
    chainId: 8453,
    verifyingContract: contractAddress,
  };
  const types = { SongAlbumMigration: [
    { name: 'albumId', type: 'bytes32' },
    { name: 'songId', type: 'bytes32' },
    { name: 'albumRevision', type: 'uint256' },
    { name: 'audioURIHash', type: 'bytes32' },
    { name: 'currentRecipientsHash', type: 'bytes32' },
    { name: 'currentSharesHash', type: 'bytes32' },
    { name: 'albumRecipientsHash', type: 'bytes32' },
    { name: 'albumSharesHash', type: 'bytes32' },
    { name: 'albumPositionsHash', type: 'bytes32' },
    { name: 'useAlbumDefault', type: 'bool' },
  ] };
  const value = {
    albumId,
    songId,
    albumRevision,
    audioURIHash: ethers.keccak256(ethers.toUtf8Bytes(audioURI)),
    currentRecipientsHash: ethers.keccak256(coder.encode(['address[]'], [currentRecipients])),
    currentSharesHash: ethers.keccak256(coder.encode(['uint16[]'], [currentSharesBps])),
    albumRecipientsHash: ethers.keccak256(coder.encode(['address[]'], [albumRecipients])),
    albumSharesHash: ethers.keccak256(coder.encode(['uint16[]'], [albumSharesBps])),
    albumPositionsHash: ethers.keccak256(coder.encode(['string[]'], [albumPositions])),
    useAlbumDefault,
  };
  return { domain, types, value };
}
import { DJUKE_SIGNING_DOMAIN_VERSION } from './djuke-version.mjs';
