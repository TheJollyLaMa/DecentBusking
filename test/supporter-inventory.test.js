const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('../discord-bot/node_modules/ethers');

const owner = '0x807061DF657A7697c04045dA7d16D941861cAABc';
const nftAbi = ['function maxSupply(uint256) view returns(uint256)', 'function uri(uint256) view returns(string)'];

test('Supporter inventory keeps held, capped Supporter DNFTs and skips uncapped or other tokens', async () => {
  const { loadSupporterInventory } = await import('../js/supporter-inventory.mjs');
  const iface = new Interface(nftAbi);
  const caps = { 1: 0n, 2: 100n, 3: 100n }, uris = { 1: 'ipfs://show', 2: 'ipfs://supporter', 3: 'ipfs://poster' };
  const ethers = {
    Contract: class {
      constructor(address) {
        if (/^0xca11/i.test(address)) {
          this.aggregate3 = async calls => calls.map(({ callData }) => {
            const call = iface.parseTransaction({ data: callData });
            const id = Number(call.args[0]);
            return { success: true, returnData: iface.encodeFunctionResult(call.name, [call.name === 'uri' ? uris[id] : caps[id]]) };
          });
        } else {
          this.interface = iface;
          this.nextTokenId = async () => 4n;
          this.balanceOfBatch = async (accounts, ids) => ids.map(id => (id === 0 ? 0n : id === 2 ? 11n : 1n));
        }
      }
    },
  };
  const fetchJson = async url => ({ name: url.endsWith('/supporter') ? 'DecentBusking v1.0.0 Supporter DNFT' : 'Gig poster' });
  const tokens = await loadSupporterInventory({ owner, ethers, provider: {}, fetchJson, refresh: true });
  assert.deepEqual(tokens.map(t => [t.tokenId, t.balance, t.name]), [['2', '11', 'DecentBusking v1.0.0 Supporter DNFT']]);
});
