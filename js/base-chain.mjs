export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_HEX = `0x${BASE_CHAIN_ID.toString(16)}`;

const BASE_CHAIN_PARAMS = {
  chainId: BASE_CHAIN_HEX,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
};

export async function ensureBaseNetwork(provider) {
  if (Number((await provider.getNetwork()).chainId) === BASE_CHAIN_ID) return;
  if (typeof window === 'undefined' || !window.ethereum?.request) throw new Error('Switch your wallet to Base');
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_HEX }] });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [BASE_CHAIN_PARAMS] });
  }
  if (Number((await provider.getNetwork()).chainId) !== BASE_CHAIN_ID) {
    throw new Error('Switch your wallet to Base');
  }
}

export async function waitForAllowance(token, owner, spender, minimumAmount, { retries = 10, delayMs = 50 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (await token.allowance(owner, spender) >= minimumAmount) return;
    if (attempt + 1 < retries) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('Waiting for approval to confirm timed out');
}

export function isMissingRevertData(error) {
  return error?.code === 'CALL_EXCEPTION' && /missing revert data/i.test(String(error?.message || ''));
}

export async function retryMissingRevertData(action, refresh) {
  try {
    return await action();
  } catch (error) {
    if (!isMissingRevertData(error)) throw error;
    if (refresh) await refresh();
    return action();
  }
}
