#!/usr/bin/env node
// Owner-only CLI that mints the pending JukeLoop queue from this machine.
// Mirrors the Admin panel: same metadata, registerToken + mintProduct, and the
// same /api/mint-complete report so the live bot announces each NFT.
//
//   node mint-queue.js            dry run: list what would be minted
//   node mint-queue.js --mint     mint every pending request
//   node mint-queue.js --mint --limit 5
//
// Requires MINT_OWNER_PRIVATE_KEY in the local discord-bot/.env (never on Render).

import 'dotenv/config';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { loadConfig } from './config.js';
import { uploadToIPFS } from './ipfs.js';
import { buildAdminAuthorizationMessage } from './ipfs-worker.js';
import { readMintedAudioCids, audioCidFromMetadata, withRetry } from './mint-sync.js';
import { mediaTypeFor } from './media.js';

const NFT_ABI = [
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function nextTokenId() view returns (uint256)',
  'function totalMinted(uint256 tokenId) view returns (uint256)',
  'function uri(uint256 tokenId) view returns (string)',
  'function registerToken(uint256 maxSupply_, string calldata tokenURI_, uint8 kind_, address royaltyReceiver, uint96 royaltyFeeBps) external returns (uint256 tokenId)',
  'function mintProduct(address to, uint256 tokenId, uint256 amount) external',
  'event TokenRegistered(uint256 indexed tokenId, address indexed creator, uint256 maxSupply, uint8 kind, string uri)',
];
const ROYALTY_BPS = 500;

export function buildTrackMetadata(track, registeredBy, now = new Date()) {
  return {
    name: track.title,
    description: `Shared through DecentJukebox by ${track.uploader}`,
    animation_url: `ipfs://${track.ipfsCid}`,
    audioUrl: `ipfs://${track.ipfsCid}`,
    ...(mediaTypeFor(track.filename, track.mediaType) ? { mediaType: mediaTypeFor(track.filename, track.mediaType) } : {}),
    ...(mediaTypeFor(track.filename, track.mediaType) === 'video/mp4' ? { videoUrl: `ipfs://${track.ipfsCid}` } : {}),
    ...(track.artworkCid ? { image: `ipfs://${track.artworkCid}` } : {}),
    artist: track.recipient,
    creator: track.recipient,
    tipWallet: track.tipWallet || track.recipient,
    ...(track.parentTokenId > 0 ? { parentTokenId: track.parentTokenId, royaltyChain: { parentTokenId: track.parentTokenId } } : {}),
    registeredBy,
    mintedAt: now.toISOString(),
  };
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track';
}

export async function validateResumeToken({ contract, tokenId, track, owner, fetchImpl = fetch, retry = {} }) {
  const read = async (method) => {
    try {
      return await withRetry(() => contract[method](tokenId), retry);
    } catch (error) {
      const detail = error.info?.error?.message || error.shortMessage || error.message;
      throw new Error(`Resume token #${tokenId}: ${method} lookup failed after retries: ${detail}. No mint was sent.`);
    }
  };
  if (Number(await read('totalMinted')) !== 0) throw new Error('Resume token is already minted');
  const uri = await read('uri');
  const response = await fetchImpl(uri.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/'));
  if (!response.ok) throw new Error('Could not verify resume token metadata');
  const metadata = await response.json();
  if (audioCidFromMetadata(metadata) !== track.ipfsCid ||
      metadata.artist?.toLowerCase() !== track.recipient.toLowerCase() ||
      metadata.registeredBy?.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('Resume token does not match this queued track, recipient, and owner');
  }
}

export async function estimateRegisteredMint({ contract, recipient, tokenId, blockNumber, delayMs = 1000 }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await contract.mintProduct.estimateGas(recipient, tokenId, 1, { blockTag: blockNumber });
    } catch (error) {
      if (attempt >= 4 || !/token not registered|rate limit|header not found|unknown block/i.test(
        `${error.shortMessage || ''} ${error.message || ''} ${error.info?.error?.message || ''}`,
      )) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

async function postJson(url, body, origin) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `${url} failed (${response.status})`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldMint = args.includes('--mint');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
  const resumeArg = args.indexOf('--resume-token');
  const resumeToken = resumeArg >= 0 ? args[resumeArg + 1] : null;
  if (resumeArg >= 0 && !/^\d+$/.test(resumeToken || '')) throw new Error('--resume-token requires a token ID');

  const privateKey = process.env.MINT_OWNER_PRIVATE_KEY;
  if (!privateKey) throw new Error('Set MINT_OWNER_PRIVATE_KEY in discord-bot/.env (local only).');
  const config = loadConfig();
  const origin = config.allowedOrigins?.[0];
  const serviceUrl = (config.publicWorkerUrl || '').replace(/\/$/, '');
  if (!origin || !serviceUrl) throw new Error('IPFS_ALLOWED_ORIGINS and PUBLIC_WORKER_URL must be set.');

  const provider = new JsonRpcProvider(config.baseRpcUrl);
  const wallet = new Wallet(privateKey, provider);
  if (wallet.address.toLowerCase() !== config.mintOwnerWallet.toLowerCase()) {
    throw new Error(`The key's address ${wallet.address} is not MINT_OWNER_WALLET.`);
  }
  const contract = new Contract(config.nftContractAddress, NFT_ABI, wallet);
  if (!(await contract.hasRole(await contract.DEFAULT_ADMIN_ROLE(), wallet.address))) {
    throw new Error(`${wallet.address} does not hold DEFAULT_ADMIN_ROLE on DecentNFT.`);
  }

  const issuedAt = new Date().toISOString();
  const signature = await wallet.signMessage(buildAdminAuthorizationMessage({ address: wallet.address, origin, issuedAt }));
  const { requests = [] } = await postJson(`${serviceUrl}/api/mint-queue`, { address: wallet.address, signature, issuedAt }, origin);

  console.log('Checking Base for audio that is already minted…');
  const alreadyMinted = await readMintedAudioCids({ contract });
  const duplicates = requests.filter((track) => alreadyMinted.has(track.ipfsCid));
  const pending = requests.filter((track) => !alreadyMinted.has(track.ipfsCid)).slice(0, limit);

  console.log(`Queue: ${requests.length} request(s) · ${duplicates.length} already minted (skipped) · ${pending.length} to mint`);
  for (const track of duplicates) console.log(`  skip  ${track.title} — already token #${alreadyMinted.get(track.ipfsCid)}`);
  for (const track of pending) console.log(`  mint  ${track.title} → ${track.recipient}`);
  const balance = await provider.getBalance(wallet.address);
  console.log(`Owner ETH balance on Base: ${Number(balance) / 1e18}`);
  if (!shouldMint) {
    console.log('\nDry run only. Re-run with --mint to send transactions.');
    return;
  }

  let minted = 0;
  for (const [index, track] of pending.entries()) {
    const label = `[${index + 1}/${pending.length}] ${track.title}`;
    let tokenId;
    let registrationBlock;
    if (index === 0 && resumeToken !== null) {
      await validateResumeToken({ contract, tokenId: resumeToken, track, owner: wallet.address });
      tokenId = resumeToken;
      registrationBlock = await provider.getBlockNumber();
      console.log(`${label}: reusing registered token #${tokenId}`);
    } else {
    const metadata = buildTrackMetadata(track, wallet.address);
    const metadataUri = await uploadToIPFS(
      Buffer.from(JSON.stringify(metadata, null, 2)),
      `${slugify(track.title)}.json`,
      'application/json',
      { provider: 'pinata', pinataJwt: config.pinataJwt, pinataApiUrl: config.pinataApiUrl },
    );

    const registration = await (await contract.registerToken(0, metadataUri, 0, track.recipient, ROYALTY_BPS)).wait();
    const registered = registration.logs
      .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
      .find((event) => event?.name === 'TokenRegistered');
    if (!registered) throw new Error(`${label}: could not read the registered token ID`);
    tokenId = registered.args.tokenId.toString();
    registrationBlock = registration.blockNumber;
    console.log(`${label}: registered token #${tokenId} in block ${registrationBlock}`);
    }

    let mintReceipt;
    try {
      const estimate = await estimateRegisteredMint({ contract, recipient: track.recipient, tokenId, blockNumber: registrationBlock });
      mintReceipt = await (await contract.mintProduct(track.recipient, tokenId, 1, {
        gasLimit: estimate * 120n / 100n,
      })).wait();
    } catch (error) {
      throw new Error(`${label}: token #${tokenId} is registered; mint failed: ${error.shortMessage || error.message}. ` +
        `Do not register it again. Resume with --mint --resume-token ${tokenId} --limit 1.`);
    }
    minted++;
    try {
      await postJson(`${serviceUrl}/api/mint-complete`, { trackId: track.trackId, tokenId, txHash: mintReceipt.hash }, origin);
      console.log(`✅ ${label} → token #${tokenId} (announced)`);
    } catch (err) {
      console.warn(`⚠️ ${label} → token #${tokenId} minted, but sync failed: ${err.message}`);
      console.warn(`   /jukeloop mark-minted track_id:${track.trackId} token_id:${tokenId} tx_hash:${mintReceipt.hash}`);
    }
  }
  console.log(`\nDone — minted ${minted} of ${pending.length}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`❌ ${err.shortMessage || err.message}`);
    process.exit(1);
  });
}
