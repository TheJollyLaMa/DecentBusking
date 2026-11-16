const test = require('node:test');
const assert = require('node:assert/strict');
const { id } = require('../discord-bot/node_modules/ethers');

const artist = '0x' + '22'.repeat(20);
const txHash = '0x' + '44'.repeat(32);
const NOW = Date.parse('2026-11-14T03:00:00Z');
const END = Date.parse('2026-11-14T02:20:00Z');
const model = () => import('../js/live-afterparty.mjs');

const booking = (over = {}) => ({
  id: 'friday-live-performance:2026-11-13:fixture', mode: 'phase1', payoutPolicy: 'pilot-guaranteed-v1', status: 'funded', wallet: artist,
  displayName: 'Fixture performer', title: 'Friday fixture', amountUnits: '20000000', termsHash: id('terms'),
  startUtc: '2026-11-14T02:00:00.000Z', endUtc: '2026-11-14T02:20:00.000Z', claimDeadline: '2026-11-18T02:20:00.000Z', reviewWindow: 86400,
  transactions: {}, ...over,
});
const finished = { known: true, pending: false, actualEndedAt: END - 60000, endReason: 'producer-finished' };
const byId = rows => Object.fromEntries(rows.map(item => [item.id, item]));
const rowsFor = async (b, options = {}) => byId((await model()).afterpartyRows(b, { now: NOW, ...options }));

test('completion is verified only from the stage record or a live re-entry state, never from the clock', async () => {
  const { completionFacts, stageEndedSuccessfully } = await model();
  assert.deepEqual(completionFacts(booking({ broadcastCompletion: finished })), { state: 'verified', endReason: 'producer-finished', endedAt: END - 60000 });
  assert.equal(stageEndedSuccessfully(completionFacts(booking({ broadcastCompletion: finished }))), true);
  assert.equal(stageEndedSuccessfully(completionFacts(booking({ broadcastCompletion: { ...finished, endReason: 'operator-cut' } }))), false);
  assert.equal(stageEndedSuccessfully(completionFacts(booking({ broadcastCompletion: { ...finished, endReason: null } }))), false);
  assert.equal(completionFacts(booking(), { status: 'ended', endReason: 'producer-finished' }).state, 'verified');
  assert.equal(completionFacts(booking(), { status: 'ended', endReason: null }).endReason, null);
  assert.deepEqual(completionFacts(booking({ broadcastCompletion: { known: true, pending: true } })), { state: 'pending' });
  assert.deepEqual(completionFacts(booking(), { status: 'active' }), { state: 'pending' });
  assert.deepEqual(completionFacts(booking({ broadcastCompletion: { known: true, pending: false, actualEndedAt: null } })), { state: 'unknown', reason: 'no-stage-record' });
  assert.deepEqual(completionFacts(booking({ broadcastCompletion: { known: false, pending: true } })), { state: 'unknown', reason: 'unavailable' });
  assert.deepEqual(completionFacts(booking({ broadcastCompletion: null })), { state: 'unknown', reason: 'not-reported' }, 'a null record means the server did not report completion');
  assert.deepEqual(completionFacts(booking()), { state: 'unknown', reason: 'not-reported' });
  assert.equal(stageEndedSuccessfully(completionFacts(booking(), null)), false);
  assert.equal(stageEndedSuccessfully(null), false);
  assert.equal(completionFacts(null).state, 'unknown');
});

test('completion row: celebrates only a verified producer finish; every other ending is stated plainly with the fee unchanged', async () => {
  const rows = async (completion, reentry) => (await rowsFor(booking(completion === undefined ? {} : { broadcastCompletion: completion }), { reentry })).completion;
  const done = await rows(finished);
  assert.deepEqual([done.state, done.text, done.celebrate], ['verified', 'Set finished ✓', true]);
  assert.match(done.detail, /Performer finished; producer confirmed the song-boundary ending\. Nov 13, 2026, 9:19 PM ET\./);
  for (const [reason, headline, detail] of [['operator-cut', 'Set ended early', /Interrupted by an owner cut/], ['authorization-expired', 'Set ended when airtime expired', /Authorized airtime expired/],
    ['audio-loss', 'Set ended after audio loss', /Interrupted after audio loss/], ['declined', 'No set aired · slot declined', /declined this slot/], ['not-ready', 'No set aired · not ready', /not ready/]]) {
    const item = await rows({ ...finished, endReason: reason });
    assert.deepEqual([item.state, item.text, item.celebrate], ['verified', headline, false], reason);
    assert.match(item.detail, detail, reason);
    assert.match(item.detail, /guaranteed fee is unchanged/, reason);
  }
  const unlabeled = await rows({ ...finished, endReason: null });
  assert.equal(unlabeled.text, 'Stage ended · reason not reported');
  assert.equal(unlabeled.celebrate, false);
  const pending = await rows({ known: true, pending: true, actualEndedAt: null });
  assert.deepEqual([pending.state, pending.text, pending.celebrate], ['pending', 'Set not finished yet', false]);
  assert.match(pending.detail, /scheduled end passing is not proof/);
  assert.match(pending.next, /Check again after the stage closes/);
  for (const [name, completion, text] of [['no record', { known: true, pending: false, actualEndedAt: null }, /No stage record exists/], ['unavailable', { known: false, pending: true }, /could not be read/],
    ['null', null, /did not report stage completion/], ['absent', undefined, /did not report stage completion/]]) {
    const item = await rows(completion);
    assert.deepEqual([item.state, item.text, item.celebrate], ['unknown', 'Finish not verified', false], name);
    assert.match(item.detail, text, name);
    assert.match(item.detail, /Payment is unaffected/, name);
    assert.ok(item.next, `${name}: next action`);
  }
  const reentry = await rows(undefined, { status: 'ended', endReason: 'producer-finished' });
  assert.deepEqual([reentry.state, reentry.celebrate], ['verified', true]);
});

test('approval and payment rows follow the escrow status and clock, and each state has a next action for the right audience', async () => {
  const expectations = [
    ['funded before the end', { status: 'funded' }, END - 1000, { approval: ['pending', /Waiting for the show to end/], payment: ['pending', /Not paid yet/] }],
    ['funded in review window', { status: 'funded' }, NOW, { approval: ['pending', /Waiting for approval/], payment: ['pending', /Not paid yet/] }],
    ['funded after review window', { status: 'funded' }, END + 86400000, { approval: ['attention', /Review window ended/], payment: ['pending', /Claimable now/] }],
    ['funded after deadline', { status: 'funded' }, Date.parse('2026-11-19T00:00:00Z'), { approval: ['attention', /Claim deadline passed/], payment: ['attention', /Claim deadline passed/] }],
    ['approved', { status: 'approved', approvedUnits: '20000000' }, NOW, { approval: ['verified', /Approved on Base · \$20\.00 USDC/], payment: ['pending', /Approved · not claimed yet/] }],
    ['paid', { status: 'paid', approvedUnits: '20000000', paidUnits: '20000000', transactions: { PerformancePaid: { hash: txHash } } }, NOW, { approval: ['verified', /Approved on Base/], payment: ['verified', /Payment confirmed · \$20\.00 USDC/] }],
    ['refunded', { status: 'refunded' }, NOW, { approval: ['attention', /Refunded · no payout approved/], payment: ['attention', /Not paid · escrow refunded/] }],
    ['draft', { status: 'draft' }, NOW, { approval: ['info', /Not funded/], payment: ['info', /No payment yet/] }],
    ['unusable terms', { status: 'funded', endUtc: 'nope' }, NOW, { approval: ['unknown', /Approval status unclear/], payment: ['pending', /Not paid yet/] }],
  ];
  for (const [name, change, now, expected] of expectations) {
    for (const audience of ['performer', 'admin']) {
      const rows = await rowsFor(booking(change), { audience, now });
      for (const [key, [state, text]] of Object.entries(expected)) {
        assert.equal(rows[key].state, state, `${name}/${audience}/${key}`);
        assert.match(rows[key].text, text, `${name}/${audience}/${key}`);
      }
      if (['pending', 'attention', 'unknown', 'info'].includes(rows.approval.state)) assert.ok(rows.approval.next, `${name}/${audience}: approval has a next action`);
      if (['pending', 'attention', 'info'].includes(rows.payment.state)) assert.ok(rows.payment.next, `${name}/${audience}: payment has a next action`);
    }
  }
  const performer = await rowsFor(booking(), { audience: 'performer' }), admin = await rowsFor(booking(), { audience: 'admin' });
  assert.match(performer.approval.next, /Nothing for you to sign/);
  assert.match(admin.approval.next, /guided release above/);
  const early = await rowsFor(booking({ broadcastCompletion: finished }), { now: END - 30000, audience: 'performer' });
  assert.equal(early.approval.text, 'Waiting for the original booked end');
  assert.match(early.approval.detail, /stage ended.*original contract opens approval/);
  const paid = await rowsFor(booking({ status: 'paid', transactions: { PerformancePaid: { hash: txHash } } }), { audience: 'performer' });
  assert.deepEqual(paid.payment.links, [{ label: 'View transaction on BaseScan', href: `https://basescan.org/tx/${txHash}` }]);
  assert.equal(paid.payment.celebrate, true);
  const noHash = await rowsFor(booking({ status: 'paid' }), { audience: 'performer' });
  assert.equal(noHash.payment.state, 'verified', 'the backend status is the verified fact');
  assert.equal(noHash.payment.celebrate, false, 'but a celebration needs the transaction hash as its evidence');
  const automatic = await rowsFor(booking({ status: 'approved', reportUri: 'automatic-review-window' }), { audience: 'performer' });
  assert.match(automatic.approval.detail, /Approved automatically when the review window passed/);
  const report = await rowsFor(booking({ status: 'approved', reportUri: 'ipfs://bafkreireport' }), { audience: 'admin' });
  assert.deepEqual(report.approval.links, [{ label: 'Read public fee report', href: 'https://gateway.pinata.cloud/ipfs/bafkreireport' }]);
});

test('payment rows are independent of recording and supporter-gift state: a gift or recording failure never downgrades cash', async () => {
  const states = [undefined, { known: false }, { known: true, state: 'none' }, { known: true, state: 'processing' }, { known: true, state: 'mint-requested' },
    { known: true, state: 'minted', tokenId: '7' }, { known: true, state: 'airing', trackId: 't1' }, { known: true, state: 'aired', trackId: 't1' }];
  const gifts = [undefined, { state: 'failed', error: 'mint reverted' }, { state: 'pending' }, { state: 'sent' }];
  for (const status of ['funded', 'approved', 'paid']) {
    const baseline = await rowsFor(booking({ status, transactions: status === 'paid' ? { PerformancePaid: { hash: txHash } } : {} }), { audience: 'performer' });
    for (const recordingRelease of states) {
      for (const gift of gifts) {
        const rows = await rowsFor(booking({ status, recordingRelease, gift, nftGift: gift, transactions: status === 'paid' ? { PerformancePaid: { hash: txHash } } : {} }), { audience: 'performer' });
        assert.deepEqual(rows.payment, baseline.payment, `${status}: payment unchanged`);
        assert.deepEqual(rows.approval, baseline.approval, `${status}: approval unchanged`);
        assert.deepEqual(rows.completion, baseline.completion, `${status}: completion unchanged`);
      }
    }
  }
  const rows = await rowsFor(booking(), { audience: 'performer' });
  assert.deepEqual([rows.gift.state, rows.gift.text], ['info', 'Separate from your fee']);
  assert.match(rows.gift.detail, /never delays, reduces or blocks the cash payment/);
});

test('recording and radio rows come only from the recording pipeline and radio facts, in order', async () => {
  const rec = recordingRelease => rowsFor(booking({ recordingRelease }), { audience: 'performer' });
  const cases = [
    ['absent', undefined, ['unknown', 'Recording state unavailable'], ['unknown', 'Radio release unknown']],
    ['not known', { known: false, state: 'minted' }, ['unknown', 'Recording state unavailable'], ['unknown', 'Radio release unknown']],
    ['unrecognised state', { known: true, state: 'sparkly' }, ['unknown', 'Recording state unavailable'], ['unknown', 'Radio release unknown']],
    ['none', { known: true, state: 'none' }, ['info', 'No recording submitted yet'], ['info', 'Nothing to air yet']],
    ['processing', { known: true, state: 'processing' }, ['pending', 'Recording is being prepared'], ['pending', 'Waiting for the mint']],
    ['mint requested', { known: true, state: 'mint-requested', partial: true }, ['pending', 'Submitted · waiting for the mint'], ['pending', 'Waiting for the mint']],
    ['minted', { known: true, state: 'minted', tokenId: '7', replayAfter: Date.parse('2026-11-15T02:00:00Z') }, ['verified', 'Minted as token #7'], ['pending', 'Not played on the radio yet']],
    ['airing', { known: true, state: 'airing', tokenId: '7', trackId: 'track-1' }, ['verified', 'Minted as token #7'], ['verified', 'On the radio now ✓']],
    ['aired', { known: true, state: 'aired', tokenId: '7', trackId: 'track-1' }, ['verified', 'Minted as token #7'], ['verified', 'Played on the radio ✓']],
  ];
  for (const [name, release, expectedRecording, expectedRadio] of cases) {
    const rows = await rec(release);
    assert.deepEqual([rows.recording.state, rows.recording.text], expectedRecording, `${name}: recording`);
    assert.deepEqual([rows.radio.state, rows.radio.text], expectedRadio, `${name}: radio`);
    for (const key of ['recording', 'radio']) if (['pending', 'unknown', 'info'].includes(rows[key].state)) assert.ok(rows[key].next !== undefined, `${name}: ${key} has a next field`);
  }
  assert.match((await rec({ known: true, state: 'minted', replayAfter: Date.parse('2026-11-15T02:00:00Z') })).radio.detail, /Minting alone does not mean it aired\. It plays in a normal rotation slot after Nov 14, 2026, 9:00 PM ET/);
  assert.match((await rec({ known: true, state: 'mint-requested', partial: true })).recording.detail, /Nothing is automatic\. This is a partial recording/);
  const adminMint = await rowsFor(booking({ recordingRelease: { known: true, state: 'mint-requested' } }), { audience: 'admin' });
  assert.match(adminMint.recording.next, /Admin › mint queue \(owner-signed\)/);
  assert.match((await rec({ known: true, state: 'mint-requested' })).recording.next, /Nothing for you to sign/);
  const minted = await rec({ known: true, state: 'minted', tokenId: '7', contractAddress: '0x' + '77'.repeat(20) });
  assert.deepEqual(minted.recording.links, [{ label: 'View the token on BaseScan', href: `https://basescan.org/nft/0x${'77'.repeat(20)}/7` }]);
  assert.equal((await rec({ known: true, state: 'minted', tokenId: '7' })).recording.links.length, 0);
  assert.equal((await rec({ known: true, state: 'aired', trackId: 'track-1' })).radio.celebrate, true);
  assert.equal((await rec({ known: true, state: 'aired' })).radio.celebrate, false, 'no track id, no verifiable release');
  assert.equal((await rec({ known: true, state: 'minted' })).radio.celebrate, false);
});

test('the public sees only a verified producer finish and a verified radio release; payment, approval and gift stay private', async () => {
  const { afterpartyRows } = await model();
  const publicRows = (change, options = {}) => afterpartyRows(booking(change), { audience: 'public', now: NOW, ...options });
  assert.deepEqual(publicRows({}).map(item => item.id), [], 'a booking with no verified facts shows nothing');
  assert.deepEqual(publicRows({ broadcastCompletion: finished }).map(item => item.id), ['completion']);
  assert.deepEqual(publicRows({ broadcastCompletion: { ...finished, endReason: 'operator-cut' } }).map(item => item.id), [], 'an unsuccessful ending is not advertised');
  assert.deepEqual(publicRows({ broadcastCompletion: { known: true, pending: true } }).map(item => item.id), []);
  assert.deepEqual(publicRows({ recordingRelease: { known: true, state: 'minted', tokenId: '7' } }).map(item => item.id), [], 'minted is not aired');
  assert.deepEqual(publicRows({ recordingRelease: { known: true, state: 'airing', trackId: 't' } }).map(item => item.id), ['radio']);
  assert.deepEqual(publicRows({ broadcastCompletion: finished, recordingRelease: { known: true, state: 'aired', trackId: 't' } }).map(item => item.id), ['completion', 'radio']);
  const everything = publicRows({ status: 'paid', approvedUnits: '20000000', paidUnits: '20000000', transactions: { PerformancePaid: { hash: txHash } },
    broadcastCompletion: finished, recordingRelease: { known: true, state: 'aired', trackId: 't' } });
  assert.deepEqual(everything.map(item => item.id), ['completion', 'radio']);
  assert.doesNotMatch(JSON.stringify(everything), /PerformancePaid|20\.00|0x4444|Fixture performer’s fee/);
  assert.deepEqual(publicRows({ broadcastCompletion: null }, { reentry: { status: 'ended', endReason: 'producer-finished' } }).map(item => item.id), ['completion']);
  assert.deepEqual((await model()).afterpartyRows(null), []);
});

test('performer and admin checklists always list the six independent facts in the same order', async () => {
  const { afterpartyRows } = await model();
  for (const audience of ['performer', 'admin']) {
    for (const change of [{}, { status: 'approved' }, { status: 'paid' }, { status: 'refunded' }, { status: 'draft' }, { broadcastCompletion: finished }]) {
      assert.deepEqual(afterpartyRows(booking(change), { audience, now: NOW }).map(item => item.id), ['completion', 'approval', 'payment', 'recording', 'radio', 'gift']);
    }
  }
  for (const item of afterpartyRows(booking(), { audience: 'performer', now: NOW })) {
    assert.ok(['verified', 'pending', 'unknown', 'info', 'attention'].includes(item.state), item.id);
    assert.ok(item.text && item.label, item.id);
    assert.ok(Array.isArray(item.links));
  }
  assert.doesNotThrow(() => afterpartyRows({}, { now: NOW }));
  assert.doesNotThrow(() => afterpartyRows({ status: 'funded' }, { now: NOW }));
});

test('milestones exist only for verified facts and carry their evidence in a stable id', async () => {
  const { afterpartyRows, afterpartyMilestones } = await model();
  const milestones = change => { const b = booking(change); return afterpartyMilestones(b, afterpartyRows(b, { audience: 'performer', now: NOW })); };
  assert.deepEqual(milestones({}), []);
  assert.deepEqual(milestones({ broadcastCompletion: { ...finished, endReason: 'declined' } }), []);
  assert.deepEqual(milestones({ status: 'approved' }), [], 'approval alone is not a celebration');
  assert.deepEqual(milestones({ status: 'paid' }), [], 'a paid status without its transaction hash has no evidence');
  const all = milestones({ status: 'paid', paidUnits: '20000000', transactions: { PerformancePaid: { hash: txHash } }, broadcastCompletion: finished,
    recordingRelease: { known: true, state: 'aired', trackId: 'track-1', tokenId: '7' } });
  assert.deepEqual(all.map(item => item.kind), ['completion', 'payment', 'radio-release']);
  assert.deepEqual(all.map(item => item.id), [`curtain:${booking().id}`, `payment:${booking().id}:${txHash}`, `release:${booking().id}:track-1`]);
  assert.equal(all[1].subtitle, '$20.00 USDC');
  assert.deepEqual(all[1].evidence, { txHash, chainId: 8453 });
  assert.match(all[2].subtitle, /Friday fixture is out/);
  assert.equal(new Set(all.map(item => item.id)).size, 3);
  const b = booking();
  const reentered = afterpartyMilestones(b, afterpartyRows(b, {
    now: NOW, reentry: { status: 'ended', endReason: 'producer-finished' },
  }));
  assert.equal(reentered[0].id, all[0].id, 'a later known end time does not create another curtain call');
});

function celebrationHarness() {
  const store = new Map(), calls = [];
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  return { store, calls, storage };
}

test('a milestone celebrates once, replays on request, and survives broken storage', async () => {
  const { celebrateAfterparty, milestoneSeen, resetAfterpartyMilestones, setAfterpartyCelebrator, AFTERPARTY_SEEN_KEY } = await model();
  resetAfterpartyMilestones();
  const { store, calls, storage } = celebrationHarness();
  const restore = setAfterpartyCelebrator(detail => calls.push(detail));
  const milestone = { id: `payment:b1:${txHash}`, kind: 'payment', title: 'Payment confirmed', subtitle: '$20.00 USDC', bookingId: 'b1', evidence: { txHash } };
  assert.equal(milestoneSeen(milestone.id, storage), false);
  assert.deepEqual(celebrateAfterparty(milestone, { storage }), { celebrated: true, fresh: true });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].id, calls[0].replay, calls[0].reducedMotion], [milestone.id, false, false]);
  assert.equal(milestoneSeen(milestone.id, storage), true);
  assert.deepEqual(JSON.parse(store.get(AFTERPARTY_SEEN_KEY)), [milestone.id]);
  assert.deepEqual(celebrateAfterparty(milestone, { storage }), { celebrated: false, reason: 'already-seen' });
  assert.equal(calls.length, 1, 'a second render does not celebrate again');
  resetAfterpartyMilestones();
  assert.equal(milestoneSeen(milestone.id, storage), true, 'storage remembers across page loads');
  assert.deepEqual(celebrateAfterparty(milestone, { storage }), { celebrated: false, reason: 'already-seen' });
  assert.deepEqual(celebrateAfterparty(milestone, { storage, replay: true }), { celebrated: true, fresh: false });
  assert.deepEqual([calls.length, calls[1].replay], [2, true]);
  assert.deepEqual(JSON.parse(store.get(AFTERPARTY_SEEN_KEY)), [milestone.id], 'a replay does not duplicate the stored id');
  for (const bad of [null, {}, { id: 5 }, { id: '' }]) assert.deepEqual(celebrateAfterparty(bad, { storage }), { celebrated: false, reason: 'no-id' });
  resetAfterpartyMilestones();
  const broken = { getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('quota'); } };
  const other = { ...milestone, id: 'curtain:b1:1' };
  assert.deepEqual(celebrateAfterparty(other, { storage: broken }), { celebrated: true, fresh: true });
  assert.deepEqual(celebrateAfterparty(other, { storage: broken }), { celebrated: false, reason: 'already-seen' }, 'memory still prevents repeats this session');
  assert.deepEqual(celebrateAfterparty({ ...other, id: 'curtain:b1:2' }, { storage: undefined }), { celebrated: true, fresh: true });
  resetAfterpartyMilestones();
  store.set(AFTERPARTY_SEEN_KEY, '{not json');
  assert.equal(milestoneSeen('x', storage), false, 'corrupt storage reads as nothing seen');
  store.set(AFTERPARTY_SEEN_KEY, JSON.stringify(['a', 5, null, 'b']));
  assert.equal(milestoneSeen('b', storage), true);
  const many = celebrationHarness();
  resetAfterpartyMilestones();
  for (let index = 0; index < 130; index++) celebrateAfterparty({ id: `m${index}` }, { storage: many.storage });
  assert.equal(JSON.parse(many.store.get(AFTERPARTY_SEEN_KEY)).length, 120, 'the stored list is bounded');
  restore();
  resetAfterpartyMilestones();
});

test('a denied localStorage getter does not block a celebration or the rest of the page', async t => {
  const { celebrateAfterparty, resetAfterpartyMilestones } = await model();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('access denied'); } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
    resetAfterpartyMilestones();
  });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  resetAfterpartyMilestones();
  assert.deepEqual(celebrateAfterparty({ id: 'curtain:storage-denied' }), { celebrated: true, fresh: true });
  assert.deepEqual(celebrateAfterparty({ id: 'curtain:storage-denied' }), { celebrated: false, reason: 'already-seen' });
  assert.match(warnings[0][0], /milestone storage unavailable/);
});

test('a failing celebrator never breaks the page, and the default announces a DOM event with reduced-motion state', async t => {
  const { celebrateAfterparty, resetAfterpartyMilestones, setAfterpartyCelebrator } = await model();
  resetAfterpartyMilestones();
  const { storage } = celebrationHarness();
  const originalWarn = console.warn, warnings = [];
  console.warn = message => warnings.push(message);
  t.after(() => { console.warn = originalWarn; });
  const restore = setAfterpartyCelebrator(() => { throw new Error('visual crashed'); });
  assert.deepEqual(celebrateAfterparty({ id: 'x1' }, { storage }), { celebrated: true, fresh: true });
  assert.match(String(warnings[0]), /celebration unavailable/);
  restore();
  const events = [], previous = { document: globalThis.document, CustomEvent: globalThis.CustomEvent, matchMedia: globalThis.matchMedia };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
  globalThis.document = { dispatchEvent: event => events.push(event) };
  globalThis.matchMedia = query => ({ matches: /reduce/.test(query) });
  celebrateAfterparty({ id: 'x2', title: 'Curtain call' }, { storage });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'afterparty-celebration');
  assert.deepEqual([events[0].detail.id, events[0].detail.reducedMotion, events[0].detail.replay], ['x2', true, false]);
  setAfterpartyCelebrator(null);
  celebrateAfterparty({ id: 'x2' }, { storage, replay: true });
  assert.equal(events.length, 2, 'passing a non-function restores the default announcer');
  assert.equal(events[1].detail.replay, true);
  resetAfterpartyMilestones();
});

test('display helpers never throw on odd input', async () => {
  const { shortHex, shortError, formatEt } = await model();
  assert.equal(shortHex('0x' + 'ab'.repeat(32)), '0xabab…abab');
  assert.equal(shortHex('0x' + 'ab'.repeat(20)), '0xabab…abab');
  assert.equal(shortHex('not a hash'), 'not a hash');
  assert.equal(shortHex(null), '');
  assert.equal(shortError({ shortMessage: 'short', message: 'long' }), 'short');
  assert.equal(shortError(null), 'Unknown error');
  assert.equal(shortError('x'.repeat(500)).length, 240);
  assert.equal(formatEt(Date.parse('2026-11-14T02:20:00Z')), 'Nov 13, 2026, 9:20 PM ET');
  assert.equal(formatEt(NaN), 'an unknown time');
  assert.equal(formatEt(undefined), 'an unknown time');
});
