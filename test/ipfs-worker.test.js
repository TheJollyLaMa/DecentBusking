const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { Interface, Wallet, id } = require('../discord-bot/node_modules/ethers');
const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'ipfs-worker.js')).href;

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('DJuke top earners endpoint returns indexed payouts or an explicit unavailable response', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const data = { chainId: 8453, asset: 'USDC', period: 'all-time', earners: [{ address: Wallet.createRandom().address, totalUnits: '225000' }] };
  for (const [getDjukeTopEarners, expected] of [
    [async () => data, 200],
    [undefined, 503],
    [async () => { throw new Error('DJuke earnings are still indexing; retry shortly'); }, 503],
  ]) {
    const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: Wallet.createRandom().address, getDjukeTopEarners });
    await withServer(handler, async base => {
      const response = await fetch(`${base}/api/djuke/earners`);
      assert.equal(response.status, expected);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      const result = await response.json();
      if (expected === 200) assert.deepEqual(result, data);
      else assert.match(result.error, /index/);
    });
  }
});

test('checkpoint mirror routes reject unauthenticated requests and do not expose jobs publicly', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const { createCheckpointMirror } = await import('../discord-bot/checkpoint-mirror.js');
  const secret = 'test-only-checkpoint-route-secret-32bytes';
  const mirror = createCheckpointMirror({ secret });
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: Wallet.createRandom().address,
    checkpointMirror: mirror });
  await withServer(handler, async base => {
    const rejected = await fetch(`${base}/api/checkpoint-mirror/claim`, { method: 'POST' });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).job, undefined);
    const accepted = await fetch(`${base}/api/checkpoint-mirror/claim`, { method: 'POST',
      headers: { authorization: `Bearer ${secret}` } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await accepted.json(), { job: null });
    assert.equal(mirror.status().available, true);
    const unknown = await fetch(`${base}/api/checkpoint-mirror/ack`, { method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'expired', cid: 'bad', recursivePinned: true }) });
    assert.equal(unknown.status, 400);
  });
});

test('public community pin manifest does not expose credentials and stays unavailable until ready', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom().address;
  const manifest = { schemaVersion: 1, entryCount: 1, entries: [{ cid: 'bafy' }] };
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: owner, getPinnerManifest: () => manifest });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/pinners/manifest`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), manifest);
    const unavailable = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: owner });
    await withServer(unavailable, async nested => {
      assert.equal((await fetch(`${nested}/api/pinners/manifest`)).status, 404);
    });
  });
});

test('DeVert campaign snapshot is public read-only data and stays unavailable until configured', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom().address;
  const snapshot = { chainId: 8453, campaigns: [{ campaignId: '7', title: 'Ad' }] };
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: owner, getDevertState: async () => snapshot });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/devert`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), snapshot);
    const unavailable = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: owner });
    await withServer(unavailable, async nested => {
      assert.equal((await fetch(`${nested}/api/devert`)).status, 404);
    });
  });
});

test('ad library is publicly readable from the connected wallet address', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  let requestedAddress;
  const library = { ads: [{ trackId: 'ad-one', state: 'ready' }], metadataUnavailable: 1 };
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: owner.address,
    getDevertAds: async ({ address }) => { requestedAddress = address; return library; } });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/devert/ads?wallet=${owner.address}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), library);
    assert.equal(requestedAddress, owner.address);
    assert.equal((await fetch(`${base}/api/devert/ads`)).status, 400);
  });
});

test('AdLoop state endpoint exposes live now-playing state without requiring a main-radio campaign reader', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom().address;
  const state = { ready: true, nowPlaying: { radioPlayId: 'devert-loop:7:1', campaignId: '7', audible: true } };
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: owner, getDevertLoopState: () => state });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/devert/loop`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), state);
  });
});

test('public calendar subscription serves real events and alarms, fails closed during calendar restore', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const { defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  let ready = true;
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: Wallet.createRandom().address,
    now: () => Date.parse('2026-10-30T12:00:00Z'),
    getRadioSchedule: () => ({ ready, schedule: defaultRadioSchedule(), events: [] }) });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/radio/calendar.ics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/calendar/);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('cache-control'), /max-age=300/);
    const calendar = await response.text();
    assert.match(calendar, /BEGIN:VCALENDAR/);
    assert.match(calendar, /Friday Top 10 Hype Hour/);
    assert.match(calendar, /TRIGGER:-PT15M/);
    ready = false;
    const unavailable = await fetch(`${base}/api/radio/calendar.ics`);
    assert.equal(unavailable.status, 503);
    assert.match((await unavailable.json()).error, /temporarily unavailable/);
  });
  await withServer(createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: Wallet.createRandom().address }), async base => {
    assert.equal((await fetch(`${base}/api/radio/calendar.ics`)).status, 404);
  });
});

test('public radio schedule is readable and schedule edits require an origin-bound owner signature', async () => {
  const { buildRadioScheduleAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const { buildRadioScheduleAuthorizationMessage: buildBrowserAuthorizationMessage } = await import('../js/radio-schedule-ui.mjs');
  const owner = Wallet.createRandom();
  const origin = 'https://busking.example';
  const now = Date.parse('2026-10-10T12:00:00Z');
  const issuedAt = new Date(now).toISOString();
  const events = [{ id: 'web-event', type: 'live_performance', title: 'Live Set',
    startUtc: new Date(now + 60_000).toISOString(), endUtc: new Date(now + 60 * 60_000).toISOString(), priority: 200 }];
  const weeklySchedule = {
    'friday-top10-hype': { weekday: 5, startHourLocal: 19, endHourLocal: 20 },
    'friday-live-performance': { weekday: 5, startHourLocal: 20, endHourLocal: 22 },
  };
  let saved;
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: owner.address, now: () => now,
    getRadioSchedule: () => ({ schedule: [], events, ready: true }),
    saveRadioSchedule: async next => { saved = next; return { schedule: [], ...next, ready: true }; } });
  await withServer(handler, async base => {
    const publicResponse = await fetch(`${base}/api/radio/schedule`);
    assert.equal(publicResponse.status, 200);
    assert.deepEqual((await publicResponse.json()).events, events);

    const authorization = { address: owner.address, origin, issuedAt, events, weeklySchedule };
    assert.equal(buildBrowserAuthorizationMessage(authorization), buildRadioScheduleAuthorizationMessage(authorization));
    const signature = await owner.signMessage(buildRadioScheduleAuthorizationMessage(authorization));
    const request = () => fetch(`${base}/api/radio/schedule`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }) });
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual(saved, { events, weeklySchedule });
    assert.equal((await request()).status, 400);

    const unavailable = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: owner.address });
    await withServer(unavailable, async nested => {
      assert.equal((await fetch(`${nested}/api/radio/schedule`)).status, 404);
    });
  });
});

test('payment ledger is public but reconciliation requires an allowed origin and a valid hash', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const hashes = [];
  const handler = createWorkerRequestHandler({ allowedOrigins: ['https://busking.example'], ownerWallet: Wallet.createRandom().address,
    getPaymentLedger: () => ({ chainId: 8453, entries: [] }),
    reconcilePayment: async hash => { hashes.push(hash); return { pending: false, entries: [] }; } });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/payroll/ledger`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const txHash = `0x${'1'.repeat(64)}`;
    for (const [origin, hash, expected] of [['https://other.example', txHash, 400], ['https://busking.example', 'bad', 400], ['https://busking.example', txHash, 200]]) {
      const result = await fetch(`${base}/api/payroll/reconcile`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ txHash: hash }) });
      assert.equal(result.status, expected);
    }
    assert.deepEqual(hashes, [txHash]);
  });
});

test('earnings index is public and filters entries by wallet address', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const requested = [];
  const address = `0x${'1'.repeat(40)}`;
  const entry = { kind: 'payroll', fundId: '0xabc', fundLabel: 'Repo dev payroll', asset: 'USDC', units: '100000', txHash: `0x${'2'.repeat(64)}`,
    logIndex: 1, blockNumber: 123, timestamp: 456, recipient: address };
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: Wallet.createRandom().address,
    getEarnings: async ({ address: wallet }) => { requested.push(wallet); return { ready: true, through: 123, entries: [entry] }; } });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/earnings/${address}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { ready: true, through: 123, entries: [entry] });
    assert.deepEqual(requested, [address]);
  });
});

test('weekly payflow endpoint filters artists and New York history calendar is explicit', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const wallet = Wallet.createRandom().address;
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: wallet,
    getWeeklyPayflow: options => ({ ready: true, timeZone: 'America/New_York', wallet: options.wallet }),
    getRadioHistory: options => [{ calendar: options.calendar }] });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/payroll/weekly?wallet=${wallet}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).wallet, wallet);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal((await fetch(`${base}/api/payroll/weekly?wallet=bad`)).status, 400);
    const history = await (await fetch(`${base}/api/radio/history?calendar=new-york`)).json();
    assert.equal(history.weeks[0].calendar, 'new-york');
  });
});

test('fund week archive groups payroll payouts by week and surfaces queued entries', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const { finalizeRadioAllocation } = await import('../js/radio-payroll.mjs');
  const fundSlug = 'dbusk-top10';
  const routerAddress = `0x${'1'.repeat(40)}`;
  const assetAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const report = { week: 'NY-2026-10-05', current: false, tracks: [{ wallet: `0x${'2'.repeat(40)}`, artist: 'Artist One', plays: 12, votes: 12 },
    { wallet: `0x${'3'.repeat(40)}`, artist: 'Artist Two', plays: 9, votes: 9 }] };
  const allocation = finalizeRadioAllocation({ report, category: 'top10', budgetUnits: 1000000n, minimumUnits: 0n, fundSlug, routerAddress, assetAddress,
    now: Date.parse('2026-10-13T12:00:00Z') });
  const firstReference = allocation.entries[0].workReferenceText;
  const payout = { slug: fundSlug, workReference: id(firstReference),
    recipient: allocation.entries[0].wallet, amountUnits: allocation.entries[0].amountUnits, txHash: '0x' + '7'.repeat(64), blockNumber: 10, timestamp: 10_000, metadataUri: 'ipfs://meta' };
  const handler = createWorkerRequestHandler({
    allowedOrigins: [],
    ownerWallet: Wallet.createRandom().address,
    getFunds: async () => ({ funds: { [fundSlug]: { slug: fundSlug, payouts: [payout] } } }),
    getWeeklyPayflow: async ({ wallet }) => { assert.equal(wallet, undefined); return { currentPeriod: { week: 'NY-2026-10-12' }, allocations: [{ allocation, metadataUri: 'ipfs://meta' }] }; },
  });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/funds/${fundSlug}/weeks`, { headers: { Origin: 'http://127.0.0.1:3000' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const body = await response.json();
    assert.equal(body.weeks.length, 1);
    assert.equal(body.weeks[0].status, 'partial');
    assert.equal(body.weeks[0].paidUnits, allocation.entries[0].amountUnits);
    assert.equal(body.weeks[0].entries[0].paid, true);
    assert.equal(body.weeks[0].entries[1].paid, false);
    assert.equal(body.weeks[0].metadataUri, 'ipfs://meta');
  });
});

test('weekly fund archive errors remain readable from local and hosted browsers', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  for (const origin of ['http://127.0.0.1:3000', 'https://thejollylama.github.io']) {
    const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: Wallet.createRandom().address,
      getFunds: async () => { throw new Error('Index unavailable'); }, getWeeklyPayflow: async ({ wallet }) => ({ wallet }) });
    await withServer(handler, async base => {
      const response = await fetch(`${base}/api/funds/dbusk-top10/weeks`, { headers: { Origin: origin } });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.match((await response.json()).error, /archive unavailable/);
    });
  }
});

test('weekly archive reports actual paid amounts, recipient discrepancies, duplicate logs, and unmatched payments', async () => {
  const { buildFundWeeklyArchive } = await import('../js/fund-archive.mjs');
  const fundSlug = 'dbusk-top10';
  const wallet = `0x${'1'.repeat(40)}`;
  const workReferenceText = `decentbusking:radio:v4:8453:NY-2026-10-05:top10:${wallet}:song-a`;
  const record = { metadataUri: 'ipfs://receipt', allocation: { fundSlug, category: 'top10', week: 'NY-2026-10-05', entries: [{ wallet, workReferenceText, amountUnits: '1000000', trackId: 'song-a', title: 'Song A' }] } };
  const payout = { slug: fundSlug, workReference: id(workReferenceText), recipient: wallet, amountUnits: '100000', metadataUri: 'ipfs://receipt', txHash: `0x${'2'.repeat(64)}`, logIndex: 0 };
  const build = payouts => buildFundWeeklyArchive({ fundSlug, fund: { payouts }, weeklyPayflow: { allocations: [record] } });
  const mismatch = build([payout, payout]);
  assert.equal(mismatch.weeks[0].paidUnits, '100000');
  assert.equal(mismatch.weeks[0].totalUnits, '1000000');
  assert.equal(mismatch.weeks[0].status, 'mismatch');
  assert.equal(mismatch.weeks[0].entries[0].paid, false);
  assert.equal(mismatch.weeks[0].entries[0].title, 'Song A');
  const wrongRecipient = build([{ ...payout, amountUnits: '1000000', recipient: `0x${'3'.repeat(40)}` }]);
  assert.equal(wrongRecipient.weeks[0].status, 'mismatch');
  assert.equal(wrongRecipient.weeks[0].remainingUnits, '1000000');
  assert.equal(build([{ ...payout, amountUnits: '1000000' }]).weeks[0].status, 'paid');
  const orphan = buildFundWeeklyArchive({ fundSlug, fund: { payouts: [payout] }, weeklyPayflow: { allocations: [] } });
  assert.equal(orphan.weeks.length, 0);
  assert.equal(orphan.unmatchedPayouts.length, 1);
  assert.equal(orphan.unmatchedPaidUnits, '100000');
  assert.equal(build([{ ...payout, slug: 'dbusk-playback' }]).weeks[0].paidUnits, '0');
});

test('artwork CID validation normalizes file CIDs without imposing an attachment-size limit', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const cid = 'bafybeieupiamdn7e4qmi4hou6zfu4cwluoubn6ppgsqs4rfjydyee7wtnm';
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: Wallet.createRandom().address });
  await withServer(handler, async base => {
    for (const value of [cid, `ipfs://${cid}`]) {
      const response = await fetch(`${base}/api/ipfs/artwork-cid?${new URLSearchParams({ cid: value })}`);
      assert.equal(response.status, 200); assert.equal((await response.json()).cid, cid);
    }
    for (const value of ['bad', `${cid}/image.gif`, `https://example.org/${cid}`]) {
      assert.equal((await fetch(`${base}/api/ipfs/artwork-cid?${new URLSearchParams({ cid: value })}`)).status, 400);
    }
  });
});

test('VertLoop votes require an allowed origin and a valid live-play payload', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const origin = 'https://busking.example';
  const votes = [];
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: Wallet.createRandom().address,
    onDevertLoopVote: async payload => { votes.push(payload); return { ...payload, duplicate: false }; } });
  await withServer(handler, async base => {
    const payload = { playId: 'devert-loop:17:10000', voterId: 'listener-browser-0001', vote: 1 };
    const post = (body, requestOrigin = origin) => fetch(`${base}/api/devert/loop/vote`, { method: 'POST',
      headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(payload, 'https://untrusted.example')).status, 400);
    assert.equal((await post({ ...payload, vote: 2 })).status, 400);
    assert.equal((await post(payload)).status, 200);
    assert.deepEqual(votes, [payload]);
  });
});

test('worker issues a Pinata URL only for a fresh owner signature', async () => {
  const { buildUploadAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const issuedAt = '2026-10-01T12:00:00.000Z';
  const authorization = {
    address: owner.address,
    origin: 'https://busking.example',
    name: 'performance.mp4',
    size: 12 * 1024 * 1024,
    type: 'video/mp4',
    issuedAt,
  };
  const signature = await owner.signMessage(buildUploadAuthorizationMessage(authorization));
  const handler = createWorkerRequestHandler({
    allowedOrigins: [authorization.origin],
    ownerWallet: owner.address,
    pinataJwt: 'server-secret',
    now: () => Date.parse(issuedAt),
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer server-secret');
      const request = JSON.parse(options.body);
      assert.deepEqual(request.allow_mime_types, ['video/mp4']);
      assert.equal(request.max_file_size, authorization.size + 64 * 1024);
      assert.equal('mime_types' in request, false);
      return new Response(JSON.stringify({ data: 'https://uploads.pinata.example/signed' }), { status: 200 });
    },
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ipfs/upload-url`, {
      method: 'POST',
      headers: { origin: authorization.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).url, 'https://uploads.pinata.example/signed');

    const replay = await fetch(`${baseUrl}/api/ipfs/upload-url`, {
      method: 'POST',
      headers: { origin: authorization.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /already been used/);
  });
});

test('worker returns a readable 403 for disallowed upload origins and exposes a public pending count', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const origin = 'https://busking.example';
  const handler = createWorkerRequestHandler({
    allowedOrigins: [origin],
    ownerWallet: Wallet.createRandom().address,
    getMintQueue: () => [{ trackId: 'one' }, { trackId: 'two' }],
    pinataJwt: 'server-secret',
    fetchImpl: async () => new Response(JSON.stringify({ data: 'https://uploads.example/signed' })),
  });
  await withServer(handler, async baseUrl => {
    const count = await fetch(`${baseUrl}/api/mint-queue/pending-count`).then(response => response.json());
    assert.deepEqual(count, { count: 2 });
    const response = await fetch(`${baseUrl}/api/ipfs/upload-url`, {
      method: 'POST',
      headers: { origin: 'https://unlisted.example', 'content-type': 'application/json' },
      body: JSON.stringify({
        address: Wallet.createRandom().address,
        origin: 'https://unlisted.example',
        name: 'song.mp3',
        size: 1,
        type: 'audio/mpeg',
        issuedAt: new Date().toISOString(),
        signature: '0xsigned',
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://unlisted.example');
    assert.match((await response.json()).error, /authorized for uploads/);
  });
});

test('worker grants one owner signature a one-use set of metadata upload URLs', async () => {
  const { buildUploadBatchAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const origin = 'https://busking.example';
  const issuedAt = '2026-10-01T12:00:00.000Z';
  const files = [
    { name: 'first.json', size: 12, type: 'application/json' },
    { name: 'second.json', size: 18, type: 'application/json' },
  ];
  const authorization = { address: owner.address, origin, issuedAt, files };
  const signature = await owner.signMessage(buildUploadBatchAuthorizationMessage(authorization));
  const pinataFiles = [];
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: owner.address,
    pinataJwt: 'server-secret', now: () => Date.parse(issuedAt),
    fetchImpl: async (_url, options) => {
      pinataFiles.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ data: `https://uploads.pinata.example/${pinataFiles.length}` }));
    } });

  await withServer(handler, async baseUrl => {
    const request = body => fetch(`${baseUrl}/api/ipfs/upload-batch-urls`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await request({ ...authorization, signature });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).urls, [
      'https://uploads.pinata.example/1', 'https://uploads.pinata.example/2',
    ]);
    assert.equal(pinataFiles.length, 2);
    assert.deepEqual(pinataFiles.map(file => file.filename), ['first.json', 'second.json']);
    assert.equal(pinataFiles.every(file => file.allow_mime_types[0] === 'application/json'), true);
    assert.equal((await request({ ...authorization, signature })).status, 400);
    const changed = { ...authorization, files: [{ ...files[0], size: 13 }, files[1]], signature };
    assert.equal((await request(changed)).status, 400);
  });
});

test('worker rejects a valid signature from a non-owner wallet', async () => {
  const { buildUploadAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const stranger = Wallet.createRandom();
  const issuedAt = '2026-10-01T12:00:00.000Z';
  const authorization = {
    address: stranger.address,
    origin: 'https://busking.example',
    name: 'cover.png',
    size: 5,
    type: 'image/png',
    issuedAt,
  };
  const signature = await stranger.signMessage(buildUploadAuthorizationMessage(authorization));
  const handler = createWorkerRequestHandler({
    allowedOrigins: [authorization.origin],
    ownerWallet: owner.address,
    pinataJwt: 'server-secret',
    now: () => Date.parse(issuedAt),
    fetchImpl: async () => { throw new Error('Pinata must not be called'); },
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ipfs/upload-url`, {
      method: 'POST',
      headers: { origin: authorization.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not from the mint owner/);
  });
});

test('reviewed album import requires a fresh owner signature and returns queued counts without minting', async () => {
  const { buildReviewedAlbumImportAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const origin = 'https://busking.example';
  const issuedAt = new Date().toISOString();
  let calls = 0;
  const result = { added: 190, queued: 190, skipped: 0, checkpointUri: 'ipfs://playlist-checkpoint', minted: 0 };
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: owner.address,
    onReviewedAlbumImport: async () => { calls++; return result; } });
  const authorization = { address: owner.address, origin, issuedAt };
  const signature = await owner.signMessage(buildReviewedAlbumImportAuthorizationMessage(authorization));
  await withServer(handler, async base => {
    const request = () => fetch(`${base}/api/admin/reviewed-album-import`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...authorization, signature }) });
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.equal(calls, 1);
    assert.equal((await request()).status, 400);
    assert.equal(calls, 1);
  });
});

test('artist MP4 uploads use separate authorization and cannot access owner upload permissions', async () => {
  const { buildUploadAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const artist = Wallet.createRandom();
  const issuedAt = '2026-10-05T12:00:00Z';
  const origin = 'https://busking.example';
  const payload = { address: artist.address, origin, issuedAt, name: 'DecentAdvert_01.mp4',
    type: 'video/mp4', size: 111_027_138, purpose: 'submission' };
  const signature = await artist.signMessage(buildUploadAuthorizationMessage(payload));
  const oversized = { ...payload, size: 251 * 1024 * 1024 };
  const oversizedSignature = await artist.signMessage(buildUploadAuthorizationMessage(oversized));
  let pinataCalls = 0;
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: Wallet.createRandom().address,
    now: () => Date.parse(issuedAt), pinataJwt: 'secret',
    fetchImpl: async (_url, options) => {
      pinataCalls++;
      assert.equal(JSON.parse(options.body).max_file_size, payload.size + 64 * 1024);
      assert.deepEqual(JSON.parse(options.body).allow_mime_types, ['video/mp4']);
      return new Response(JSON.stringify({ data: 'https://uploads.example/signed' }));
    } });
  await withServer(handler, async baseUrl => {
    const post = (endpoint, body) => fetch(`${baseUrl}/api/ipfs/${endpoint}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await post('upload-url', { ...payload, signature })).status, 400);
    assert.equal((await post('submission-upload-url', { ...payload, signature })).status, 200);
    assert.equal((await post('submission-upload-url', { ...payload, signature })).status, 400);
    assert.equal((await post('submission-upload-url', { ...oversized, signature: oversizedSignature })).status, 400);
    assert.equal(pinataCalls, 1);
  });
});

test('CID format detection reads a bounded prefix, normalizes CIDs and cancels the stream', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const cid = 'bafybeifynaihnl2t37s3nfez3k5vbwwziaqyvayadqwt4bou3yv6jstxye';
  let canceled = false;
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: Wallet.createRandom().address,
    fetchImpl: async (url, options) => {
      assert.equal(url, `https://gateway.pinata.cloud/ipfs/${cid}`);
      assert.equal(options.headers.Range, 'bytes=0-65535');
      return new Response(new ReadableStream({ start(controller) {
        const bytes = new Uint8Array(100000);
        bytes.set(Buffer.from('RIFF1234WAVE'));
        controller.enqueue(bytes);
      }, cancel() { canceled = true; } }), { headers: { 'content-type': 'application/octet-stream' } });
    } });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/ipfs/media-type?cid=${cid}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cid, mediaType: 'audio/wav', filename: 'track.wav' });
    assert.equal(canceled, true);
    assert.equal((await fetch(`${base}/api/ipfs/media-type?cid=bad`)).status, 400);
  });
});

test('signed CID submissions validate the artist, media, expiry, origin, and replay protection', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const mediaModule = pathToFileURL(path.join(__dirname, '../discord-bot/media.js')).href;
  const { buildSubmissionAuthorizationMessage } = await import(mediaModule);
  const browserModule = pathToFileURL(path.join(__dirname, '../js/mint-submission.js')).href;
  const browser = await import(browserModule);
  const artist = Wallet.createRandom();
  const other = Wallet.createRandom();
  const origin = 'https://busking.example';
  const issuedAt = '2026-10-05T12:00:00Z';
  const payload = { address: artist.address, origin, issuedAt, title: 'Performance', artist: 'Artist',
    ipfsCid: 'bafybeifynaihnl2t37s3nfez3k5vbwwziaqyvayadqwt4bou3yv6jstxye',
    mediaType: 'video/mp4', filename: 'performance.mp4', recipient: artist.address,
    artworkCid: '', tipWallet: artist.address, parentTokenId: 7, isDevertAd: true,
    creatorSplits: [{ wallet: artist.address, shareBps: 6000 }, { wallet: other.address, shareBps: 4000 }] };
  assert.equal(browser.buildSubmissionAuthorizationMessage(payload), buildSubmissionAuthorizationMessage(payload));
  const submissions = [];
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: other.address,
    now: () => Date.parse(issuedAt), onMediaSubmission: async submission => {
      submissions.push(submission);
      return { trackId: 'queued-video', mintStatus: 'requested' };
    } });
  await withServer(handler, async baseUrl => {
    const post = async (body, requestOrigin = origin, signer = artist) => fetch(`${baseUrl}/api/media/submit`, {
      method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, signature: await signer.signMessage(buildSubmissionAuthorizationMessage(body)) }),
    });
    const accepted = await post(payload);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { trackId: 'queued-video', status: 'requested' });
    assert.equal(submissions[0].mediaType, 'video/mp4');
    assert.equal(submissions[0].parentTokenId, 7);
    assert.equal(submissions[0].isDevertAd, true);
    assert.deepEqual(submissions[0].creatorSplits, payload.creatorSplits);
    assert.equal((await post(payload)).status, 400);
    for (const invalid of [
      { ...payload, recipient: Wallet.createRandom().address },
      { ...payload, ipfsCid: `${payload.ipfsCid}/movie.mp4` },
      { ...payload, ipfsCid: 'not-a-cid' },
      { ...payload, filename: 'movie.mp3' },
      { ...payload, issuedAt: '2026-10-01T00:00:00Z' },
      { ...payload, parentTokenId: -1 },
      { ...payload, creatorSplits: [{ wallet: artist.address, shareBps: 9000 }] },
      { ...payload, creatorSplits: [{ wallet: other.address, shareBps: 10000 }] },
    ]) assert.equal((await post(invalid)).status, 400);
    assert.equal((await post({ ...payload, title: 'Forged' }, origin, other)).status, 400);
    assert.equal((await post(payload, 'https://other.example')).status, 400);
    assert.equal(submissions.length, 1);
  });
});

test('worker reconciles only a verified Base mint transaction', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const completions = [];
  const txHash = `0x${'ab'.repeat(32)}`;
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://busking.example'],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    pinataJwt: 'server-secret',
    verifyMintTransaction: async ({ tokenId, txHash: receivedHash }) => {
      assert.equal(tokenId, '42');
      assert.equal(receivedHash, txHash);
      return { recipient: '0x2222222222222222222222222222222222222222', contractAddress: '0x3333333333333333333333333333333333333333' };
    },
    onMintComplete: async (completion) => completions.push(completion),
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mint-complete`, {
      method: 'POST',
      headers: { origin: 'https://busking.example', 'content-type': 'application/json' },
      body: JSON.stringify({ trackId: 'track-1', tokenId: '42', txHash }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(completions, [{
      trackId: 'track-1',
      tokenId: '42',
      txHash,
      recipient: '0x2222222222222222222222222222222222222222',
      contractAddress: '0x3333333333333333333333333333333333333333',
    }]);
  });
});

test('verifies the owner transaction and EditionMinted event on Base', async () => {
  const { createMintTransactionVerifier } = await import(moduleUrl);
  const owner = '0x1111111111111111111111111111111111111111';
  const recipient = '0x2222222222222222222222222222222222222222';
  const contract = '0x3333333333333333333333333333333333333333';
  const txHash = `0x${'ab'.repeat(32)}`;
  const iface = new Interface([
    'event EditionMinted(uint256 indexed tokenId, address indexed to, uint256 amount, address indexed minter)',
  ]);
  const encoded = iface.encodeEventLog(iface.getEvent('EditionMinted'), [42, recipient, 1, owner]);
  const verify = createMintTransactionVerifier({
    contractAddress: contract,
    ownerWallet: owner,
    provider: {
      getTransaction: async () => ({ from: owner, to: contract }),
      getTransactionReceipt: async () => ({
        status: 1,
        logs: [{ address: contract, topics: encoded.topics, data: encoded.data }],
      }),
    },
  });

  assert.deepEqual(await verify({ tokenId: '42', txHash }), { recipient, amount: '1', contractAddress: contract });
});

test('mint reconciliation accepts owner EditionMinted events from either configured NFT collection', async () => {
  const { createMintTransactionVerifier } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const recipient = Wallet.createRandom().address;
  const legacy = Wallet.createRandom().address;
  const batch = Wallet.createRandom().address;
  const iface = new Interface(['event EditionMinted(uint256 indexed tokenId,address indexed to,uint256 amount,address indexed minter)']);
  const provider = {
    getTransaction: async () => ({ hash: `0x${'1'.repeat(64)}` }),
    getTransactionReceipt: async () => ({ status: 1, logs: [{
      address: batch,
      topics: iface.encodeEventLog(iface.getEvent('EditionMinted'), [12, recipient, 1, owner.address]).topics,
      data: iface.encodeEventLog(iface.getEvent('EditionMinted'), [12, recipient, 1, owner.address]).data,
    }] }),
  };
  const verify = createMintTransactionVerifier({ rpcUrl: 'unused', contractAddresses: [legacy, batch], ownerWallet: owner.address, provider });
  assert.deepEqual(await verify({ tokenId: '12', txHash: `0x${'1'.repeat(64)}` }), { recipient, amount: '1', contractAddress: batch });
});

test('accepts owner mints routed through a smart-account delegation contract', async () => {
  const { createMintTransactionVerifier } = await import(moduleUrl);
  const owner = '0x1111111111111111111111111111111111111111';
  const recipient = '0x2222222222222222222222222222222222222222';
  const contract = '0x3333333333333333333333333333333333333333';
  const delegationManager = '0x4444444444444444444444444444444444444444';
  const iface = new Interface([
    'event EditionMinted(uint256 indexed tokenId, address indexed to, uint256 amount, address indexed minter)',
  ]);
  const verifierFor = (minter, logAddress = contract) => {
    const encoded = iface.encodeEventLog(iface.getEvent('EditionMinted'), [8, recipient, 1, minter]);
    return createMintTransactionVerifier({
      contractAddress: contract,
      ownerWallet: owner,
      provider: {
        getTransaction: async () => ({ from: owner, to: delegationManager }),
        getTransactionReceipt: async () => ({
          status: 1,
          logs: [{ address: logAddress, topics: encoded.topics, data: encoded.data }],
        }),
      },
    });
  };
  const txHash = `0x${'cd'.repeat(32)}`;

  assert.deepEqual(await verifierFor(owner)({ tokenId: '8', txHash }), { recipient, amount: '1', contractAddress: contract });
  await assert.rejects(verifierFor(recipient)({ tokenId: '8', txHash }), /not minted by the configured owner/);
  await assert.rejects(verifierFor(owner, delegationManager)({ tokenId: '8', txHash }), /does not contain exactly one claimed EditionMinted/);
});

test('returns the pending queue only to the mint owner', async () => {
  const { buildAdminAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const issuedAt = '2026-10-01T12:00:00.000Z';
  const authorization = {
    address: owner.address,
    origin: 'https://busking.example',
    issuedAt,
  };
  const signature = await owner.signMessage(buildAdminAuthorizationMessage(authorization));
  const handler = createWorkerRequestHandler({
    allowedOrigins: [authorization.origin],
    ownerWallet: owner.address,
    pinataJwt: 'server-secret',
    now: () => Date.parse(issuedAt),
    getMintQueue: async () => [{ trackId: 'track-1', title: 'Track One' }],
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mint-queue`, {
      method: 'POST',
      headers: { origin: authorization.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).requests, [{ trackId: 'track-1', title: 'Track One' }]);
  });
});

  test('owner queue pagination returns twenty requests and rejects oversized or unauthorized pages', async () => {
    const { buildAdminAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
    const owner = Wallet.createRandom();
    const origin = 'https://busking.example';
    const issuedAt = new Date().toISOString();
    const authorization = { address: owner.address, origin, issuedAt };
    const signature = await owner.signMessage(buildAdminAuthorizationMessage(authorization));
    const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: owner.address,
      getMintQueue: async () => Array.from({ length: 43 }, (_, i) => ({ trackId: String(i) })) });
    await withServer(handler, async base => {
      const request = (offset, limit, sig = signature) => fetch(`${base}/api/mint-queue`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ ...authorization, signature: sig, offset, limit }),
      });
      const first = await (await request(0, 20)).json();
      assert.equal(first.requests.length, 20);
      assert.equal(first.total, 43);
      assert.equal(first.nextOffset, 20);
      const last = await (await request(40, 20)).json();
      assert.equal(last.requests.length, 3);
      assert.equal(last.nextOffset, null);
      assert.equal((await request(0, 21)).status, 400);
      assert.equal((await request(-1, 20)).status, 400);
      assert.equal((await request(0, 20, await Wallet.createRandom().signMessage(buildAdminAuthorizationMessage(authorization)))).status, 400);
    });
  });

  test('public NFT archive endpoint applies search, artist and timeline bounds to bounded pages', async () => {
    const { createWorkerRequestHandler } = await import(moduleUrl);
    const { nftCatalogPage } = await import('../js/nft-loader.js');
    const address = `0x${'1'.repeat(40)}`;
    const nfts = Array.from({ length: 55 }, (_, tokenId) => ({ tokenId, chainId: 8453, contractAddress: address,
      name: tokenId === 0 ? 'Forgotten Song' : `Track ${tokenId}`, audioUrl: 'ipfs://audio', artistName: 'Alice', artist: address,
      mintedAt: new Date(Date.UTC(2026, 9, tokenId + 1)).toISOString() }));
    const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: address,
      getNftCatalog: options => nftCatalogPage(nfts, options) });
    await withServer(handler, async base => {
      const response = await fetch(`${base}/api/nfts`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      const first = await response.json();
      assert.equal(first.nfts.length, 25);
      assert.equal(first.nfts[0].tokenId, 54);
      assert.equal(first.nextOffset, 25);
      const search = await (await fetch(`${base}/api/nfts?query=forgotten%20alice`)).json();
      assert.equal(search.nfts.length, 1);
      assert.equal(search.nfts[0].tokenId, 0);
      assert.equal((await fetch(`${base}/api/nfts?limit=26`)).status, 400);
    });
  });

test('reviewed album import requires fresh owner authorization and rejects replay', async () => {
  const { buildReviewedAlbumImportAuthorizationMessage, createWorkerRequestHandler } = await import(moduleUrl);
  const owner = Wallet.createRandom();
  const origin = 'https://busking.example';
  const issuedAt = new Date().toISOString();
  let imports = 0;
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: owner.address,
    onReviewedAlbumImport: async () => { imports++; return { added: 190, queued: 190, skipped: 0, minted: 0 }; } });
  const authorization = { address: owner.address, origin, issuedAt };
  const signature = await owner.signMessage(buildReviewedAlbumImportAuthorizationMessage(authorization));
  await withServer(handler, async baseUrl => {
    const send = () => fetch(`${baseUrl}/api/admin/reviewed-album-import`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...authorization, signature }) });
    const response = await send();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { added: 190, queued: 190, skipped: 0, minted: 0 });
    assert.equal(imports, 1);
    assert.equal((await send()).status, 400);
    assert.equal(imports, 1);
  });
});

test('public health check is readable from local and hosted dapp origins', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://busking.example'],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    pinataJwt: 'server-secret',
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { origin: 'http://localhost:4173' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { ok: true, ipfsProvider: 'pinata' });
  });
});
test('radio state is public and readable from any dapp origin', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://busking.example'],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    getRadioState: async () => ({ serverTime: 1, nowPlaying: null, recent: [] }),
  });

  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/radio`, { headers: { origin: 'http://localhost:4173' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { serverTime: 1, nowPlaying: null, recent: [] });
  });
});

test('radio media streams ranges without exposing the private gateway URL', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const cid = 'bafybeih6bvh4bgb2g5gsqxbsv6fuzbhve7m2zby654jyhrqmii5ftki3l4';
  const requests = [];
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://busking.example'],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    getRadioMediaUrl: async value => value === cid ? 'https://private.example/ipfs/song?token=private' : null,
    fetchImpl: async (url, options) => {
      requests.push({ url, range: options.headers.range });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          'content-type': 'audio/mpeg',
          'content-range': 'bytes 4-6/100',
          'content-length': '3',
          'accept-ranges': 'bytes',
        },
      });
    },
  });
  await withServer(handler, async base => {
    const response = await fetch(`${base}/api/radio/media?cid=${cid}`, { headers: { range: 'bytes=4-6' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('content-range'), 'bytes 4-6/100');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('location'), null);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
    assert.equal(requests[0].range, 'bytes=4-6');
    assert.equal(requests.length, 1);

    const unknown = await fetch(`${base}/api/radio/media?cid=bafyunknownrecording123456789`);
    assert.equal(unknown.status, 404);
    assert.equal(requests.length, 1, 'unknown recordings never reach the gateway');
    const invalid = await fetch(`${base}/api/radio/media?cid=https://other.example`);
    assert.equal(invalid.status, 400);
    assert.equal(requests.length, 1);
  });
});

test('radio media preserves unsatisfiable range responses and reports upstream failures', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  let upstreamStatus = 416;
  const handler = createWorkerRequestHandler({
    allowedOrigins: [],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    getRadioMediaUrl: async () => 'https://private.example/audio',
    fetchImpl: async () => new Response(null, {
      status: upstreamStatus,
      headers: { 'content-range': 'bytes */100' },
    }),
  });
  await withServer(handler, async base => {
    const url = `${base}/api/radio/media?cid=bafyrecording1234567890`;
    const range = await fetch(url, { headers: { range: 'bytes=1000-' } });
    assert.equal(range.status, 416);
    assert.equal(range.headers.get('content-range'), 'bytes */100');
    await range.arrayBuffer();
    upstreamStatus = 429;
    const failed = await fetch(url);
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: 'Radio media gateway is unavailable' });
  });
});

test('radio votes need no wallet but require an allowed origin', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  const ballots = [];
  const handler = createWorkerRequestHandler({
    allowedOrigins: ['https://busking.example'],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    onRadioVote: (ballot) => { ballots.push(ballot); return { ...ballot, duplicate: false }; },
  });
  await withServer(handler, async (baseUrl) => {
    const body = JSON.stringify({ playId: 'track:1000', voterId: 'browser-123456789', vote: 1 });
    const accepted = await fetch(`${baseUrl}/api/radio/vote`, {
      method: 'POST', headers: { origin: 'https://busking.example', 'content-type': 'application/json' }, body,
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('access-control-allow-origin'), 'https://busking.example');
    assert.equal((await accepted.json()).vote, 1);
    const rejected = await fetch(`${baseUrl}/api/radio/vote`, {
      method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body,
    });
    assert.equal(rejected.status, 400);
    assert.equal(ballots.length, 1);
  });
});

test('weekly radio history is public and clamps the requested range', async () => {
  const { createWorkerRequestHandler } = await import(moduleUrl);
  let receivedWeeks;
  let receivedWallet;
  let receivedAllTime;
  const handler = createWorkerRequestHandler({
    allowedOrigins: [],
    ownerWallet: '0x1111111111111111111111111111111111111111',
    getRadioHistory: async ({ weeks, wallet, includeAllTime }) => { receivedWeeks = weeks; receivedWallet = wallet; receivedAllTime = includeAllTime; return [{ week: '2026-W41', totalPlays: 4 }]; },
  });
  await withServer(handler, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/radio/history?weeks=500&wallet=0x1111111111111111111111111111111111111111`, { headers: { origin: 'http://localhost:8765' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), { weeks: [{ week: '2026-W41', totalPlays: 4 }] });
    assert.equal(receivedWeeks, 52);
    assert.equal(receivedWallet, '0x1111111111111111111111111111111111111111');
    assert.equal(receivedAllTime, false);
    const allTime = await fetch(`${baseUrl}/api/radio/history?includeAllTime=1&wallet=0x1111111111111111111111111111111111111111`);
    assert.equal(allTime.status, 200);
    assert.equal(receivedAllTime, true);
    assert.equal(receivedWallet, '0x1111111111111111111111111111111111111111');
    const invalid = await fetch(`${baseUrl}/api/radio/history?wallet=not-a-wallet`);
    assert.equal(invalid.status, 400);
  });
});

test('signed artwork uploads accept any supported image type so mislabelled images still upload', async () => {
  const { requestPinataSignedUrl } = await import(moduleUrl);
  let body;
  await requestPinataSignedUrl({ pinataSignUrl: 'https://pinata.example/sign', name: 'a.png', size: 10, type: 'image/png',
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ data: 'https://signed' }) }; } });
  assert.deepEqual(body.allow_mime_types, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  await requestPinataSignedUrl({ pinataSignUrl: 'https://pinata.example/sign', name: 'a.mp3', size: 10, type: 'audio/mpeg',
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ data: 'https://signed' }) }; } });
  assert.deepEqual(body.allow_mime_types, ['audio/mpeg']);
});
