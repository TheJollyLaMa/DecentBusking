import { Contract, JsonRpcProvider, isAddress } from 'ethers';

const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;
const MAX_WEEKLY_CAMPAIGNS = 1000;
const READ_CONCURRENCY = 20;
const ZERO_ADDRESS = /^0x0{40}$/i;

export const DEVERT_ABI = [
  'function campaignWeek(uint256 timestamp) pure returns (uint64)',
  'function getWeekCampaignIds(uint64 weekId) view returns (uint256[])',
  'function getCampaign(uint256 campaignId) view returns ((address advertiser,string title,string audioURI,uint64 startedAt,uint64 expiresAt,uint64 weekId,uint128 offerUnits,uint128 paidUnits,uint32 djukeBoosts,uint32 mainRadioPlays,uint32 devertPlays))',
  'function mainRadioMarket(uint64 weekId) view returns (uint32 slots,uint32 seated,uint128 lowestSeatedOfferUnits)',
  'function recordCampaignPlay(uint256 campaignId,bool mainRadio)',
];

function asSafeNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid DeVert ${label}`);
  return number;
}

function normalizeCampaign(campaignId, raw, weekId) {
  if (!raw || typeof raw !== 'object' || !isAddress(raw.advertiser) || ZERO_ADDRESS.test(raw.advertiser) ||
    typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 160 ||
    typeof raw.audioURI !== 'string' || !raw.audioURI.startsWith('ipfs://')) {
    throw new Error('Invalid DeVert campaign');
  }
  const startedAt = asSafeNumber(raw.startedAt, 'campaign start');
  const expiresAt = asSafeNumber(raw.expiresAt, 'campaign expiry');
  const recordWeek = asSafeNumber(raw.weekId, 'campaign week');
  if (expiresAt <= startedAt || expiresAt - startedAt > SECONDS_PER_WEEK || recordWeek !== weekId) {
    throw new Error('Invalid DeVert campaign terms');
  }
  const offerUnits = BigInt(raw.offerUnits);
  const paidUnits = BigInt(raw.paidUnits);
  if (offerUnits < 5_000_000n || paidUnits < 5_000_000n) throw new Error('Invalid DeVert campaign payment');
  return {
    campaignId: BigInt(campaignId).toString(),
    advertiser: raw.advertiser,
    title: raw.title,
    audioURI: raw.audioURI,
    startedAt: new Date(startedAt * 1000).toISOString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    weekId: recordWeek,
    offerUnits: offerUnits.toString(),
    paidUnits: paidUnits.toString(),
    djukeBoosts: asSafeNumber(raw.djukeBoosts, 'DJuke boost count'),
    mainRadioPlays: asSafeNumber(raw.mainRadioPlays, 'main-radio play count'),
    devertPlays: asSafeNumber(raw.devertPlays, 'DeVert play count'),
  };
}

function normalizeMarket(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid DeVert market snapshot');
  const slots = asSafeNumber(raw.slots, 'market slot count');
  const seated = asSafeNumber(raw.seated, 'seated campaign count');
  const lowest = BigInt(raw.lowestSeatedOfferUnits);
  if (slots > MAX_WEEKLY_CAMPAIGNS || seated > slots || (seated > 0 && lowest < 5_000_000n)) {
    throw new Error('Invalid DeVert market snapshot');
  }
  return { slots, seated, lowestSeatedOfferUnits: lowest.toString() };
}

export function createDevertCampaignReader({ contractAddress, provider, contract, rpcUrl, confirmations = 2 }) {
  if (!isAddress(contractAddress) || ZERO_ADDRESS.test(contractAddress)) throw new Error('Invalid DeVert contract address');
  if (!Number.isSafeInteger(confirmations) || confirmations < 2) throw new Error('DeVert reads need at least two confirmations');
  const rpc = provider || new JsonRpcProvider(rpcUrl);
  const devert = contract || new Contract(contractAddress, DEVERT_ABI, rpc);
  let task = null;

  async function readSnapshot() {
    if (Number((await rpc.getNetwork()).chainId) !== 8453) throw new Error('DeVert is Base-only');
    const blockNumber = await rpc.getBlockNumber() - confirmations + 1;
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error('DeVert confirmation block unavailable');
    const before = await rpc.getBlock(blockNumber);
    if (!before?.hash) throw new Error('DeVert confirmation block unavailable');
    const timestamp = asSafeNumber(before.timestamp, 'snapshot timestamp');
    const options = { blockTag: blockNumber };
    const weekId = asSafeNumber(await devert.campaignWeek(timestamp, options), 'week ID');
    const [ids, marketRaw] = await Promise.all([
      devert.getWeekCampaignIds(weekId, options),
      devert.mainRadioMarket(weekId, options),
    ]);
    if (!Array.isArray(ids) || ids.length > MAX_WEEKLY_CAMPAIGNS) throw new Error('Invalid or oversized DeVert campaign list');
    const uniqueIds = new Set(ids.map(id => BigInt(id).toString()));
    if (uniqueIds.size !== ids.length) throw new Error('Duplicate DeVert campaign ID');
    const campaigns = [];
    for (let offset = 0; offset < ids.length; offset += READ_CONCURRENCY) {
      const batch = await Promise.all(ids.slice(offset, offset + READ_CONCURRENCY).map(async id =>
        normalizeCampaign(id, await devert.getCampaign(id, options), weekId)));
      campaigns.push(...batch);
    }
    const market = normalizeMarket(marketRaw);
    if ((await rpc.getBlock(blockNumber))?.hash !== before.hash) throw new Error('DeVert snapshot is not canonical');
    return {
      chainId: 8453,
      contractAddress,
      blockNumber,
      blockHash: before.hash,
      snapshotAt: new Date(timestamp * 1000).toISOString(),
      weekId,
      campaigns,
      market,
    };
  }

  return () => {
    task ||= readSnapshot().finally(() => { task = null; });
    return task;
  };
}
