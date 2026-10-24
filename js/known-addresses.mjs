const BASESCAN_ADDRESS = 'https://basescan.org/address/';

const ADDRESS_BOOK = [
  { address: '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5', label: 'ArtFi settlement router', kind: 'contract' },
  { address: '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9', label: '📜 DJuke v0.3', kind: 'contract' },
  { address: '0xBBCb7F7369978cbdc32C6719B1d24B07f3d55619', label: '📜 DJuke v0.4', kind: 'contract' },
  { address: '0xf51D2F7892cF9D49e14DF4afDf227a59ee170A51', label: '📜 DJuke v0.5', kind: 'contract' },
  { address: '0x135Cbc573F87637158eb3186C87c584fb0B34CD9', label: '📜 DeVert v0.1', kind: 'contract' },
  { address: '0xe54609f022A8D760417E7cc0Eea6360b6E1D11Bb', label: '📜 DVert paid queue v0.2', kind: 'contract' },
  { address: '0x64D5aDc50E5513975EfF7e9ba366B7eE58586fa3', label: 'DecentNFT v0.3', kind: 'contract' },
  { address: '0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B', label: 'DecentNFT v0.2', kind: 'contract' },
  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', label: 'USDC', kind: 'token' },
];

const ADDRESS_MAP = new Map(ADDRESS_BOOK.map(entry => [entry.address.toLowerCase(), entry]));

export function normalizeKnownAddress(address) {
  return String(address || '').toLowerCase();
}

export function knownAddressEntry(address) {
  return ADDRESS_MAP.get(normalizeKnownAddress(address)) || null;
}

export function basescanAddressUrl(address) {
  return `${BASESCAN_ADDRESS}${address}`;
}

export function labelKnownAddress(address) {
  const entry = knownAddressEntry(address);
  if (!entry) return null;
  return {
    address: entry.address,
    label: entry.label,
    kind: entry.kind,
    href: entry.kind === 'contract' ? `${basescanAddressUrl(entry.address)}#code` : basescanAddressUrl(entry.address),
  };
}
