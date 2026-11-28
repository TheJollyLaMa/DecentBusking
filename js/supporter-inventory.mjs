import { SUPPORTER_REWARD } from './promotions.mjs?v=20261126-pinner-dashboard';

// DecentNFT v0.2 (DecentMarket/contracts/DecentNFT_v0.2.sol) is not enumerable per owner, but token IDs are
// sequential: read every balance in one call, then keep capped tokens whose metadata names a Supporter DNFT.
const INVENTORY_ABI = [
  'function nextTokenId() view returns(uint256)',
  'function balanceOfBatch(address[] accounts,uint256[] ids) view returns(uint256[])',
  'function maxSupply(uint256 tokenId) view returns(uint256)',
  'function uri(uint256 tokenId) view returns(string)',
];
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL_ABI = ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns((bool success,bytes returnData)[])'];
const GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'];
const cache = new Map();

async function metadata(uri, fetchJson) {
  if (!uri.startsWith('ipfs://')) return fetchJson(uri);
  for (const gateway of GATEWAYS) {
    try { return await fetchJson(gateway + uri.slice(7)); } catch {}
  }
  return null;
}
const defaultFetchJson = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

export function isSupporterMetadata(meta) {
  return /supporter/i.test(String(meta?.name || '')) ||
    (meta?.attributes || []).some(a => /^repo$/i.test(a?.trait_type || '') && a.value);
}

export async function loadSupporterInventory({ owner, ethers, provider, contract = SUPPORTER_REWARD.contract,
  fetchJson = defaultFetchJson, refresh = false } = {}) {
  if (!ethers?.Contract || !provider) throw new Error('Base reader unavailable');
  if (!/^0x[0-9a-f]{40}$/i.test(owner || '')) throw new Error('Connect the admin wallet');
  const key = `${contract.toLowerCase()}:${owner.toLowerCase()}`;
  if (!refresh && cache.has(key)) return cache.get(key);
  const load = (async () => {
    const nft = new ethers.Contract(contract, INVENTORY_ABI, provider);
    const ids = Array.from({ length: Number(await nft.nextTokenId()) }, (_, id) => id);
    const balances = ids.length ? await nft.balanceOfBatch(ids.map(() => owner), ids) : [];
    const held = ids.filter((_, i) => BigInt(balances[i]) > 0n);
    // One Multicall3 read keeps public Base RPCs under their per-second limits.
    const reads = await new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider).aggregate3(held.flatMap(id => [
      { target: contract, allowFailure: true, callData: nft.interface.encodeFunctionData('maxSupply', [id]) },
      { target: contract, allowFailure: true, callData: nft.interface.encodeFunctionData('uri', [id]) },
    ]));
    const decoded = (index, fn) => reads[index]?.success ? nft.interface.decodeFunctionResult(fn, reads[index].returnData)[0] : null;
    const tokens = await Promise.all(held.map(async (id, i) => {
      const cap = decoded(i * 2, 'maxSupply'), uri = decoded(i * 2 + 1, 'uri');
      if (!cap || BigInt(cap) === 0n || !uri) return null;
      const meta = await metadata(uri, fetchJson).catch(() => null);
      if (meta && !isSupporterMetadata(meta)) return null;
      return { chainId: 8453, contract: contract.toLowerCase(), tokenId: String(id),
        balance: BigInt(balances[id]).toString(), name: String(meta?.name || `Supporter #${id}`) };
    }));
    return tokens.filter(Boolean).sort((a, b) => Number(b.tokenId) - Number(a.tokenId));
  })();
  cache.set(key, load);
  load.catch(() => cache.delete(key));
  return load;
}
