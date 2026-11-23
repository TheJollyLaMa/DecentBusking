// Mirrors DecentSongSplitWalletFactory_v0_1.walletFor (DecentMarket) so payees resolve without an RPC read.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const SONG_SPLIT_WALLET_ABI = [
  'function split() view returns (address[] recipients, uint16[] sharesBps)',
  'function distribute(address token) returns (uint256)',
];
export const SONG_SPLIT_WALLET_FACTORY_ABI = [
  'function implementation() view returns (address)',
  'function isWallet(address) view returns (bool)',
  'function walletFor(address[] recipients,uint16[] sharesBps) view returns (address)',
  'function createWallet(address[] recipients,uint16[] sharesBps) returns (address)',
];

// Multi-owner payout rows from a catalog record, in on-chain (DJuke configureSong) order; null for single owners.
export function songSplitOwners(nft) {
  const rows = Array.isArray(nft?.creatorSplits) ? nft.creatorSplits : [];
  if (rows.length < 2 || rows.length > 16) return null;
  const seen = new Set();
  let total = 0;
  for (const row of rows) {
    const wallet = String(row?.wallet || '');
    if (!ADDRESS.test(wallet) || /^0x0{40}$/i.test(wallet) || seen.has(wallet.toLowerCase()) ||
        !Number.isInteger(row.shareBps) || row.shareBps < 1) return null;
    seen.add(wallet.toLowerCase());
    total += row.shareBps;
  }
  return total === 10000 ? rows.map(({ wallet, shareBps }) => ({ wallet, shareBps })) : null;
}

export function songSplitWalletAddress({ factory, implementation, owners }, ethers) {
  if (!ADDRESS.test(factory || '') || !ADDRESS.test(implementation || '') || !owners?.length) return '';
  const recipients = owners.map(owner => ethers.getAddress(owner.wallet));
  const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder()
    .encode(['address[]', 'uint16[]'], [recipients, owners.map(owner => owner.shareBps)]));
  const initCode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  return ethers.getCreate2Address(factory, salt, ethers.keccak256(initCode));
}

export function songSplitPayeeResolver({ factory, implementation }, ethers) {
  if (!ADDRESS.test(factory || '') || !ADDRESS.test(implementation || '') || !ethers) return null;
  return owners => songSplitWalletAddress({ factory, implementation, owners }, ethers);
}
