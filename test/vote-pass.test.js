const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('../discord-bot/node_modules/ethers');

const origin = 'https://busking.example', listener = 'browser-listener-0001';
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

test('one signature creates a 7-day pass the worker verifies for that wallet, browser and site only', async () => {
  const { ensureVotePass, storedVotePass } = await import('../js/vote-pass.mjs');
  const { createVotePassVerifier } = await import('../discord-bot/vote-pass.js');
  const wallet = Wallet.createRandom();
  let clock = Date.parse('2026-11-23T20:00:00Z'), signatures = 0;
  const signer = { signMessage: async message => { signatures++; return wallet.signMessage(message); } };
  const storage = memory(), session = memory();
  const pass = await ensureVotePass({ wallet: wallet.address, signer, listener, origin, storage, session, now: clock });
  assert.deepEqual(await ensureVotePass({ wallet: wallet.address, signer, listener, origin, storage, session, now: clock + 1000 }), pass);
  assert.equal(signatures, 1);
  const verify = createVotePassVerifier({ now: () => clock });
  assert.equal(verify({ pass, voterId: listener, origin }), wallet.address.toLowerCase());
  assert.equal(verify({ pass: null, voterId: listener, origin }), '');
  assert.throws(() => verify({ pass, voterId: 'browser-someone-else-01', origin }), /another browser/);
  assert.throws(() => verify({ pass, voterId: listener, origin: 'https://evil.example' }), /another site/);
  const forged = { message: pass.message.replace(wallet.address.toLowerCase(), Wallet.createRandom().address.toLowerCase()), signature: pass.signature };
  assert.throws(() => verify({ pass: forged, voterId: listener, origin }), /does not match/);
  clock += 7 * 24 * 3600 * 1000;
  assert.throws(() => verify({ pass, voterId: listener, origin }), /expired/);
  assert.equal(storedVotePass({ wallet: wallet.address, listener, origin, storage, now: clock }), null);
});

test('declining the signature keeps votes anonymous without asking again this session', async () => {
  const { ensureVotePass } = await import('../js/vote-pass.mjs');
  const wallet = Wallet.createRandom();
  let asks = 0;
  const signer = { signMessage: async () => { asks++; throw new Error('User rejected'); } };
  const options = { wallet: wallet.address, signer, listener, origin, storage: memory(), session: memory() };
  assert.equal(await ensureVotePass(options), null);
  assert.equal(await ensureVotePass(options), null);
  assert.equal(asks, 1);
  assert.equal(await ensureVotePass({ ...options, signer: null }), null);
});
