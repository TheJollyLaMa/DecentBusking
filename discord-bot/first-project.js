import { Contract, Interface, id, isAddress, verifyMessage } from 'ethers';
import { createRequire } from 'node:module';

const Records = createRequire(import.meta.url)('../vendor/decent-canopy/e9fceef0/scripts/creator-records.js');

export const FIRST_PROJECT_VERSION = 'canopy-first-project-v1';
export const FIRST_PROJECT_FUND = 'decentcanopy-promotionals';
export const FIRST_PROJECT_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const REPOSITORY = 'TheJollyLaMa/DecentCanopy';
const transactionHash = /^0x[0-9a-f]{64}$/i;
const validAddress = value => isAddress(value) && !/^0x0{40}$/i.test(value);
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const NFT_ABI = [
  'function productCreator(uint256) view returns(address)',
  'function productProject(uint256) view returns(bytes32)',
  'function isCreatorProjectApproved(address,bytes32) view returns(bool)',
  'function hasRole(bytes32,address) view returns(bool)',
  'function uri(uint256) view returns(string)',
  'function supportsInterface(bytes4) view returns(bool)',
  'event CreatorProjectLinked(uint256 indexed tokenId,address indexed creator,bytes32 indexed projectHash)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
];
const LISTINGS_ABI = [
  'function getListing(uint256) view returns(tuple(address seller,address creator,address collection,uint256 tokenId,address payToken,uint256 unitPrice,uint256 quantity,uint16 feeBps,uint16 royaltyBps,bool active))',
  'function allowedCollection(address) view returns(bool)',
  'function allowedPayToken(address) view returns(bool)',
  'function paused() view returns(bool)',
  'function feesConfigured() view returns(bool)',
  'function useProductCreator(address) view returns(bool)',
];

export function validateFirstProjectCampaign(campaign) {
  if (campaign.application !== 'decentcanopy' || campaign.qualificationVersion !== FIRST_PROJECT_VERSION ||
      campaign.fund !== FIRST_PROJECT_FUND || campaign.asset !== 'usdc' ||
      campaign.rewardUnits !== '5000000' || campaign.maxAwards !== 12 || campaign.budgetUnits !== '60000000') {
    throw new Error('First Project requires the reviewed Canopy policy: 12 rewards of 5 Base USDC from its separate 60-USDC allocation');
  }
}

export function signedPublicProject(index, wallet, key) {
  if (!validAddress(wallet) || !/^[a-zA-Z0-9_-]{1,50}$/.test(key || '')) throw new Error('Valid creator wallet and Canopy project key required');
  if (index?.version !== 1 || !Array.isArray(index.creators)) throw new Error('Public Canopy creator index is unavailable');
  const entries = index.creators.filter(entry => equal(entry.record?.wallet, wallet));
  if (entries.length !== 1) throw new Error('Exactly one published creator profile is required; local drafts do not qualify');
  const entry = entries[0], record = Records.verify(entry, verifyMessage);
  if (Records.message(entry.record) !== entry.message ||
      !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{20,100})$/.test(entry.cid || '') ||
      !Number.isFinite(Date.parse(entry.publishedAt))) throw new Error('Public Canopy profile signature or publication evidence is invalid');
  const projects = record.projects.filter(project => project.key === key);
  if (projects.length !== 1 || !projects[0].name?.trim()) throw new Error("Project is not in this wallet's published Canopy profile");
  return { entry, projectId: `decent-project:${wallet.toLowerCase()}:${key}` };
}

async function publicJson(url, fetchImpl) {
  const response = await fetchImpl(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Public Canopy evidence unavailable (HTTP ${response.status})`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 5_000_000) throw new Error('Public Canopy evidence exceeds its response limit');
  return JSON.parse(text);
}

export function createFirstProjectVerifier({ provider, collectionAddress, listingsAddress, fetchImpl = fetch }) {
  if (!collectionAddress && !listingsAddress) return null;
  if (!validAddress(collectionAddress) || !validAddress(listingsAddress)) throw new Error('Both First Project deployment addresses must be valid nonzero Base contracts');
  const nft = new Contract(collectionAddress, NFT_ABI, provider);
  const listings = new Contract(listingsAddress, LISTINGS_ABI, provider);
  const events = new Interface(NFT_ABI);
  async function verifyFirstProject({ wallet, projectKey, mintTxHash, listingId, campaign, joinedAt }) {
    validateFirstProjectCampaign(campaign);
    if (!transactionHash.test(mintTxHash || '') || !/^(0|[1-9]\d{0,77})$/.test(String(listingId)) ||
        BigInt(listingId) >= 2n ** 256n) throw new Error('Mint receipt and a valid listing ID are required');
    if ((await provider.getNetwork()).chainId !== 8453n) throw new Error('First Project evidence must be on Base');
    const head = await publicJson(`https://api.github.com/repos/${REPOSITORY}/commits/main`, fetchImpl);
    if (!/^[0-9a-f]{40}$/.test(head.sha || '')) throw new Error('Public Canopy source revision unavailable');
    const source = `https://raw.githubusercontent.com/${REPOSITORY}/${head.sha}/data/decent-creators.json`;
    const { entry, projectId } = signedPublicProject(await publicJson(source, fetchImpl), wallet, projectKey);
    const projectHash = id(projectId);
    const receipt = await provider.getTransactionReceipt(mintTxHash);
    const block = await provider.getBlockNumber();
    if (!receipt || Number(receipt.status) !== 1 || block - receipt.blockNumber + 1 < 2 ||
        !equal(receipt.to, collectionAddress)) throw new Error('Mint needs two successful Base confirmations on the configured creator collection');
    const mintBlock = await provider.getBlock(receipt.blockNumber);
    if (!Number.isFinite(Date.parse(joinedAt)) || mintBlock?.hash !== receipt.blockHash ||
        mintBlock.timestamp * 1000 < Math.max(Date.parse(joinedAt), Date.parse(campaign.startsAt)) ||
        mintBlock.timestamp * 1000 >= Date.parse(campaign.endsAt)) throw new Error('Mint must be canonical and occur after joining, inside this campaign');
    const parsed = receipt.logs.filter(log => equal(log.address, collectionAddress))
      .map(log => events.parseLog(log)).filter(Boolean);
    const linked = parsed.find(event => event.name === 'CreatorProjectLinked' &&
      equal(event.args.creator, wallet) && event.args.projectHash === projectHash);
    const tokenId = linked?.args.tokenId;
    if (tokenId === undefined || !parsed.some(event => event.name === 'TransferSingle' &&
        equal(event.args.from, '0x0000000000000000000000000000000000000000') &&
        equal(event.args.to, wallet) && event.args.id === tokenId && event.args.value > 0n)) {
      throw new Error("Mint receipt does not register and mint this creator's approved Canopy project");
    }
    const overrides = { blockTag: block };
    const [creator, boundProject, approved, authorized, listing, allowed, paused, metadataURI] = await Promise.all([
      nft.productCreator(tokenId, overrides), nft.productProject(tokenId, overrides),
      nft.isCreatorProjectApproved(wallet, projectHash, overrides), nft.hasRole(id('CREATOR_ROLE'), wallet, overrides),
      listings.getListing(listingId, overrides), listings.allowedCollection(collectionAddress, overrides),
      listings.paused(overrides), nft.uri(tokenId, overrides),
    ]);
    if (!equal(creator, wallet) || boundProject !== projectHash || !approved || !authorized) {
      throw new Error('Creator or project approval is missing or revoked');
    }
    if (!allowed || paused || !listing.active || listing.quantity < 1n || listing.unitPrice < 1n ||
        !equal(listing.seller, wallet) || !equal(listing.creator, wallet) ||
        !equal(listing.collection, collectionAddress) || listing.tokenId !== tokenId ||
        !await listings.allowedPayToken(listing.payToken, overrides)) throw new Error("A currently active, approved sale listing for this creator's minted series is required");
    const latestHead = await publicJson(`https://api.github.com/repos/${REPOSITORY}/commits/main`, fetchImpl);
    if (latestHead.sha !== head.sha) throw new Error('Public Canopy source changed during verification; retry with its current publication');
    return {
      version: FIRST_PROJECT_VERSION, wallet: wallet.toLowerCase(), projectKey, projectId, projectHash,
      sourceRevision: head.sha, profileCid: entry.cid, profileRevision: entry.record.revision,
      mintTxHash: mintTxHash.toLowerCase(), mintBlockNumber: receipt.blockNumber, mintBlockHash: receipt.blockHash,
      collection: collectionAddress.toLowerCase(), tokenId: tokenId.toString(), listings: listingsAddress.toLowerCase(),
      listingId: String(listingId), metadataURI, checkedBlock: block,
    };
  }
  verifyFirstProject.ready = async () => {
    if ((await provider.getNetwork()).chainId !== 8453n ||
        await provider.getCode(collectionAddress) === '0x' || await provider.getCode(listingsAddress) === '0x' ||
        !await nft.supportsInterface('0xd9b67a26') ||
        !await listings.allowedCollection(collectionAddress) || !await listings.useProductCreator(collectionAddress) ||
        !await listings.feesConfigured() || await listings.paused()) {
      throw new Error('First Project requires deployed Base creator contracts and configured, unpaused seller listings');
    }
  };
  verifyFirstProject.deployment = { chainId: 8453, collectionAddress: collectionAddress.toLowerCase(),
    listingsAddress: listingsAddress.toLowerCase() };
  return verifyFirstProject;
}
