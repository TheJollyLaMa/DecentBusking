const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modules = import('../js/performer-gift.mjs');
const booking = gift => ({ id: gift.bookingId, wallet: gift.wallet,
  endUtc: '2026-11-14T02:20:00Z' });

test('encore belongs only to the exact approved booking and wallet after its end', async () => {
  const { performerGiftFor, FIRST_LIVE_GIFT: gift } = await modules;
  const now = Date.parse('2026-11-14T03:00:00Z'), b = booking(gift);
  assert.equal(performerGiftFor(b, gift.wallet.toLowerCase(), now), gift);
  for (const [changed, wallet, time] of [
    [{ ...b, id: 'another-show' }, gift.wallet, now],
    [{ ...b, wallet: '0x' + '11'.repeat(20) }, gift.wallet, now],
    [b, '0x' + '11'.repeat(20), now],
    [b, gift.wallet, Date.parse(b.endUtc) - 1],
    [{ ...b, endUtc: 'invalid' }, gift.wallet, now],
  ]) assert.equal(performerGiftFor(changed, wallet, time), null);
});

test('holdings use the exact collection, token, recipient and confirmed Base block, without a signer', async () => {
  const { readSupporterHolding, FIRST_LIVE_GIFT: gift } = await modules;
  const calls = [];
  let balance = 1n, chainId = 8453n;
  const provider = { getNetwork: async () => ({ chainId }), getBlockNumber: async () => 101 };
  const ethers = { Contract: class {
    constructor(address, abi, actualProvider) {
      assert.equal(address, gift.contract);
      assert.deepEqual(abi, ['function balanceOf(address account,uint256 id) view returns(uint256)']);
      assert.equal(actualProvider, provider);
    }
    async balanceOf(...args) { calls.push(args); return balance; }
  } };
  assert.deepEqual(await readSupporterHolding({ gift, ethers, provider }), { held: true, block: 100 });
  assert.deepEqual(calls, [[gift.wallet, 75, { blockTag: 100 }]]);
  balance = 0n;
  assert.deepEqual(await readSupporterHolding({ gift, ethers, provider }), { held: false, block: 100 });
  balance = null;
  await assert.rejects(readSupporterHolding({ gift, ethers, provider }), /invalid token balance/);
  chainId = 1n;
  await assert.rejects(readSupporterHolding({ gift, ethers, provider }), /requires Base/);
  assert.equal(calls.length, 3);
  await assert.rejects(readSupporterHolding({ gift, ethers, provider: null }), /unavailable/);
});

test('RPC errors stay unavailable rather than becoming not-held or received', async () => {
  const { readSupporterHolding, FIRST_LIVE_GIFT: gift } = await modules;
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getBlockNumber: async () => 101 };
  const ethers = { Contract: class {
    async balanceOf() { throw Error('Fixture RPC offline'); }
  } };
  await assert.rejects(readSupporterHolding({ gift, ethers, provider }), /RPC offline/);
});

function dom(t) {
  const savedDocument = global.document, savedWindow = global.window;
  t.after(() => { global.document = savedDocument; global.window = savedWindow; });
  const make = tag => ({
    tag, children: [], attributes: {}, textContent: '', open: false,
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  global.document = { createElement: make };
  global.window = {};
  return make;
}
const descendants = node => [node, ...(node.children || []).flatMap(descendants)];

test('gift showcase is viewable while pending, never signs, and retries an explicit failed holding read', async t => {
  const { renderPerformerGift, FIRST_LIVE_GIFT: gift } = await modules;
  dom(t);
  t.mock.method(Date, 'now', () => Date.parse('2026-11-14T03:00:00Z'));
  let fail = true, held = false;
  const section = renderPerformerGift({
    booking: booking(gift), wallet: gift.wallet, ethers: {},
    readHolding: async actual => {
      assert.equal(actual, gift);
      if (fail) throw Error('Fixture unavailable');
      return { held, block: 100 };
    },
  });
  const nodes = descendants(section), output = nodes.find(n => n.tag === 'output');
  const refresh = nodes.find(n => n.className === 'live-encore-refresh');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(section.attributes['data-gift-state'], 'unavailable');
  assert.match(output.textContent, /Fixture unavailable.*not confirmation of delivery/);
  assert.equal(refresh.disabled, false);
  assert.equal(nodes.find(n => n.tag === 'details').open, false);
  assert.match(nodes.find(n => n.tag === 'summary').textContent, /Open your encore/);
  fail = false;
  await refresh.onclick();
  assert.equal(section.attributes['data-gift-state'], 'not-held');
  assert.match(output.textContent, /not in your booked wallet/);
  held = true;
  await refresh.onclick();
  assert.equal(section.attributes['data-gift-state'], 'held');
  assert.match(output.textContent, /In your wallet.*block 100/);
  const art = nodes.find(n => n.tag === 'img');
  const flip = nodes.find(n => n.textContent === 'Turn the card');
  flip.onclick();
  assert.match(art.src, new RegExp(gift.backCid));
  art.onerror(); art.onerror();
  assert.ok(nodes.some(n => /artwork is unavailable/.test(n.textContent)));
  assert.ok(nodes.some(n => /not your performance fee or a mint/.test(n.textContent)));
});

test('encore reuses Profile integration and has reduced-motion and keyboard-visible styles', () => {
  const profile = fs.readFileSync(path.join(__dirname, '../js/live-performance-profile.mjs'), 'utf8');
  assert.match(profile, /renderPerformerGift\(\{ booking: b, wallet, ethers/);
  assert.match(profile, /onReveal: \(\) => celebrateLiveInvitation\(\)/);
  const css = fs.readFileSync(path.join(__dirname, '../css/live-performance.css'), 'utf8');
  assert.match(css, /prefers-reduced-motion:reduce[^}]+live-encore-presentation\{animation:none/);
  assert.match(css, /live-encore :is\(button,summary,a\):focus-visible/);
});
