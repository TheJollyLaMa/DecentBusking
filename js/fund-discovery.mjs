import { fetchIpfsJson } from './ipfs-gateway.js?v=20261003-coins-radio-votes';
import { isSettlementFundSlug } from './settlement-funds.mjs?v=20261124-fund-bunny';

export function discoveredFund(metadata, { fundId, routerAddress, ethers }) {
  if (metadata?.schema !== 'decentbusking/settlement-fund/v1' &&
      !(typeof metadata?.fundSlug === 'string' && metadata.fundSlug.startsWith('dbusk-'))) return null;
  const slug = metadata.fundSlug;
  if (metadata.schema !== 'decentbusking/settlement-fund/v1' || !isSettlementFundSlug(slug) ||
      metadata.chainId !== 8453 || typeof metadata.routerAddress !== 'string' || metadata.routerAddress.toLowerCase() !== routerAddress.toLowerCase() ||
      typeof metadata.fundId !== 'string' || metadata.fundId.toLowerCase() !== fundId.toLowerCase() || ethers.id(slug).toLowerCase() !== fundId.toLowerCase() ||
      typeof metadata.name !== 'string' || !metadata.name.trim() || metadata.name.length > 120 ||
      typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 2000) {
    throw new Error('DecentBusking fund metadata does not match its Base registry identity');
  }
  if (metadata.earningRules != null && (typeof metadata.earningRules !== 'string' || metadata.earningRules.length > 2000)) {
    throw new Error('Fund earning rules must be text of at most 2000 characters');
  }
  return { slug, label: metadata.name.trim(), description: metadata.description.trim(),
    earningRules: metadata.earningRules?.trim() || '' };
}

export async function discoverAdditionalFunds({ records, knownIds, routerAddress, ethers, includeInactive = false,
  readMetadata = uri => fetchIpfsJson(uri, {
    primaryGateway: globalThis.window?.DecentConfig?.ipfsGateway,
    timeoutMs: 2000,
    fetchImpl: (url, options) => fetch(url, { ...options, credentials: 'omit', referrerPolicy: 'no-referrer' }),
  }), onWarning = message => console.warn('[fund-discovery]', message) }) {
  const reads = new Map();
  const funds = await Promise.all(records.filter(record => record.exists && (includeInactive || record.active) && !knownIds.has(record.fundId)).map(async record => {
    const uri = record.metadataUri;
    try {
      const url = new URL(uri);
      if (!['https:', 'ipfs:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported metadata URI');
      // Other apps share the router and may point to prose rather than fund JSON.
      if (url.protocol === 'https:' && /\.md$/i.test(url.pathname)) return null;
      if (!reads.has(uri)) reads.set(uri, readMetadata(uri));
      const metadata = await reads.get(uri);
      if (!metadata) throw new Error('Registry metadata is unavailable');
      return discoveredFund(metadata, { fundId: record.fundId, routerAddress, ethers });
    } catch (error) {
      onWarning(`Some shared-registry metadata could not be verified; newly added funds may be missing. ${error.message}`);
      return null;
    }
  }));
  return funds.filter(Boolean);
}
