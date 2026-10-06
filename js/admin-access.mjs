const DEFAULT_ADMIN_WALLET = '0x807061DF657A7697c04045dA7d16D941861cAABc';

export function isAdminWallet(address = globalThis.window?._wallet?.address) {
  const expected = globalThis.window?.DecentConfig?.adminWalletAddress || DEFAULT_ADMIN_WALLET;
  return typeof address === 'string' && address.toLowerCase() === expected.toLowerCase();
}