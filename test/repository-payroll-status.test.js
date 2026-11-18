const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const ethers = createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');

const config = { chainId: 8453, routerAddress: 'router', assets: { ART: {}, USDC: {} } };
const entry = { issueRef: 'owner/repo#1', contributorGithub: 'reporter', role: 'bug-catcher', currency: 'USDC', amount: '1' };
const provider = { getNetwork: async () => ({ chainId: 8453 }), getBlockNumber: async () => 101, getCode: async () => '0x60' };

test('verified backlog excludes completed, retained and historical records with unchanged payment references', async () => {
  const { getRepositoryPayrollStatus, repositoryWorkReferenceText } = await import('../js/repository-payroll-status.mjs');
  const paid = { ...entry }, unpaid = { ...entry, issueRef: 'owner/repo#2', currency: 'ART' };
  const queue = { pending: [paid, unpaid, { ...entry, currency: 'ETH' }, { ...entry, retainedInFund: true }] };
  const calls = [];
  const api = { ...ethers, Contract: class {
    async completedWorkReferences(reference, options) {
      calls.push({ reference, options });
      return reference === ethers.id('owner/repo#1:reporter:bug-catcher:USDC');
    }
  } };
  const result = await getRepositoryPayrollStatus({ queue, config, provider, ethers: api });
  assert.deepEqual(result.pending, [unpaid]);
  assert.deepEqual(result.completed, [paid]);
  assert.equal(result.blockNumber, 100);
  assert.equal(queue.pending.length, 4);
  assert.deepEqual(calls, [
    { reference: ethers.id('owner/repo#1:reporter:bug-catcher:USDC'), options: { blockTag: 100 } },
    { reference: ethers.id('owner/repo#2:reporter:bug-catcher'), options: { blockTag: 100 } },
  ]);
  assert.equal(repositoryWorkReferenceText({ ...entry, currency: 'ART', role: undefined }), 'owner/repo#1:reporter:contributor');
});

test('all-paid rows mean zero unpaid, but missing proof or RPC failure cannot become a zero count', async () => {
  const { getRepositoryPayrollStatus } = await import('../js/repository-payroll-status.mjs');
  const queue = { pending: [entry] };
  const api = { ...ethers, Contract: class { async completedWorkReferences() { return true; } } };
  const result = await getRepositoryPayrollStatus({ queue, config, provider, ethers: api });
  assert.equal(result.pending.length, 0);
  assert.equal(result.completed.length, 1);
  for (const bad of [
    { ...provider, getNetwork: async () => ({ chainId: 10 }) },
    { ...provider, getCode: async () => '0x' },
    { ...provider, getBlockNumber: async () => { throw new Error('RPC offline'); } },
  ]) await assert.rejects(getRepositoryPayrollStatus({ queue, config, provider: bad, ethers: api }), /Base|unavailable|offline/);
  await assert.rejects(getRepositoryPayrollStatus({ queue, config, provider, ethers: {
    ...api, Contract: class { async completedWorkReferences() { throw new Error('RPC offline'); } },
  } }), /offline/);
});
