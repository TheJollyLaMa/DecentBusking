import { getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';

export function repositoryWorkReferenceText(entry) {
  const currency = String(entry.currency || 'ETH').trim().toUpperCase();
  const base = `${entry.issueRef}:${entry.contributorGithub}:${entry.role || 'contributor'}`;
  return currency === 'ART' ? base : `${base}:${currency}`;
}

export async function getRepositoryPayrollStatus({ queue, config, ethers = globalThis.window?.ethers,
  provider = getBaseReadProvider({ ethers, config }),
}) {
  if (!Array.isArray(queue.pending)) throw new Error('Invalid payroll pending queue');
  if (config.chainId !== 8453 || !config.assets || !ethers?.Contract || !provider) {
    throw new Error('Base payroll verification is unavailable');
  }
  const candidates = queue.pending.filter(entry => {
    const currency = String(entry.currency || 'ETH').trim().toUpperCase();
    return currency !== 'ETH' && config.assets[currency] && !entry.retainedInFund;
  });
  if (!candidates.length) return { verified: true, pending: [], completed: [], blockNumber: null };
  if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Payroll verification requires Base');
  const blockNumber = Math.max(0, await provider.getBlockNumber() - 1);
  if (await provider.getCode(config.routerAddress, blockNumber) === '0x') throw new Error('Payroll router is unavailable');
  const router = new ethers.Contract(config.routerAddress,
    ['function completedWorkReferences(bytes32) view returns (bool)'], provider);
  const paid = await Promise.all(candidates.map(entry =>
    router.completedWorkReferences(ethers.id(repositoryWorkReferenceText(entry)), { blockTag: blockNumber })));
  if (paid.some(value => typeof value !== 'boolean')) throw new Error('Invalid payroll completion response');
  return {
    verified: true, blockNumber,
    pending: candidates.filter((entry, index) => !paid[index]),
    completed: candidates.filter((entry, index) => paid[index]),
  };
}
