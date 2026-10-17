const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'ipfs-state.js')).href;

test('paid journal storage requires local mirroring before publication and rejects CID mismatches', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  assert.throws(() => createPinataStateStore({ pinataJwt: 'test', requireLocalMirror: true }), /local mirror is required/);
  for (const result of ['offline', 'mismatch', 'match']) {
    const events = [];
    const store = createPinataStateStore({ pinataJwt: 'test', requireLocalMirror: true,
      serialize: value => value,
      beforeUpload: async () => {
        events.push('mirror');
        if (result === 'offline') throw new Error('Mirror offline');
        return result === 'match' ? 'confirmed-cid' : 'different-cid';
      },
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'POST') {
          events.push('publish');
          return new Response(JSON.stringify({ data: { cid: 'confirmed-cid' } }));
        }
        return new Response(JSON.stringify({ data: { files: [] } }));
      } });
    if (result === 'match') {
      assert.equal(await store.save({ schemaVersion: 1, records: [] }), 'ipfs://confirmed-cid');
      assert.deepEqual(events, ['mirror', 'publish']);
    } else {
      await assert.rejects(store.save({ schemaVersion: 1, records: [] }), result === 'offline' ? /Mirror offline/ : /CIDs do not match/);
      assert.deepEqual(events, result === 'offline' ? ['mirror'] : ['mirror', 'publish']);
      assert.equal(store.getLatestSnapshotUri(), '');
    }
  }
});

test('production advert cadence store is isolated from playlist snapshots on restore and prune', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { createPinataStateStore } = await import(moduleUrl);
  const source = fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
  const definition = source.match(/config\.jukeLoopMainRadioAdStore = config\.pinataJwt \? createPinataStateStore\(([\s\S]*?)\) : null;/);
  assert.ok(definition);
  const options = vm.runInNewContext(`(${definition[1]})`, { config: {} });
  assert.equal(options.name, 'decentbusking-main-radio-ad-state.json');
  assert.equal(options.tags.kind, 'main-radio-ad-state');
  const requested = [];
  const files = [
    { id: 'playlist', cid: 'playlist-cid', name: 'decentbusking-jukeloop-state.json',
      keyvalues: { app: 'decentbusking', kind: 'jukeloop-state', schema: '1' }, created_at: '2026-10-16T02:00:00Z' },
    { id: 'ad', cid: 'ad-cid', name: options.name, keyvalues: options.tags, created_at: '2026-10-16T01:59:00Z' },
  ];
  const state = { schemaVersion: 1, musicSinceAd: 12, musicPlayCount: 12,
    preparedDevertAd: null, pendingDevertAds: [], failedDevertCampaigns: [], lastSkip: null };
  const store = createPinataStateStore({ ...options, pinataJwt: 'test-jwt', fetchImpl: async (url, init = {}) => {
    requested.push({ url, method: init.method || 'GET' });
    if (url.includes('/gateways')) return new Response(JSON.stringify({ data: { rows: [] } }));
    if (init.method === 'POST') return new Response(JSON.stringify({ data: { cid: 'saved-ad-cid' } }));
    if (url.includes('/files')) return new Response(JSON.stringify({ data: { files } }));
    assert.match(url, /\/ad-cid$/);
    return new Response(JSON.stringify(state));
  } });
  assert.deepEqual(await store.restore(), state);
  await store.save(state);
  assert.ok(requested.filter(r => r.url.includes('/files') && r.method === 'GET')
    .every(r => new URL(r.url).searchParams.get('name') === options.name));
  assert.equal(requested.some(r => r.method === 'DELETE' && r.url.endsWith('/playlist')), false);
});

test('approved baseline replaces incorrect counters exactly once and retains later activity on restart', async () => {
  const { recoverVerifiedPlaylistBaseline } = await import(moduleUrl);
  const cid = 'bafyapprovedbaseline';
  const week = 'NY-2026-10-12';
  const baseline = [{ trackId: 'first', payrollPlays: { [week]: 29 }, payrollVotes: { [week]: 17 } },
    { trackId: 'second', payrollPlays: { [week]: 23 }, payrollVotes: { [week]: 8 } }];
  let restores = 0;
  let saves = 0;
  const options = { cid, week, savedAt: '2026-10-15T22:33:36.952Z', expectedTracks: 2, expectedPlays: 52, expectedVotes: 25,
    expectedSongs: [{ trackId: 'first', plays: 29, votes: 17 }],
    store: { restoreCid: async () => { restores++; return structuredClone(baseline); }, getLatestSnapshotSavedAt: () => '2026-10-15T22:33:36.952Z',
      save: async () => { saves++; return 'ipfs://recovered'; } } };
  const result = await recoverVerifiedPlaylistBaseline([{ trackId: 'first', payrollPlays: { [week]: 1 } }], options);
  assert.equal(result.recovered, true);
  assert.equal(result.playlist[0].payrollPlays[week], 29);
  assert.equal(result.playlist[0].payrollVotes[week], 17);
  result.playlist[0].payrollPlays[week]++;
  result.playlist.push({ trackId: 'new-song' });
  const restarted = await recoverVerifiedPlaylistBaseline(result.playlist, options);
  assert.equal(restarted.recovered, false);
  assert.equal(restarted.playlist[0].payrollPlays[week], 30);
  assert.equal(restarted.playlist.length, 3);
  assert.equal(restores, 1);
  assert.equal(saves, 1);
});

test('baseline recovery refuses unexpected totals and does not adopt state when checkpointing fails', async () => {
  const { recoverVerifiedPlaylistBaseline } = await import(moduleUrl);
  let saves = 0;
  const options = { cid: 'bafyapprovedbaseline', week: 'NY-2026-10-12', savedAt: '2026-10-15T22:33:36.952Z', expectedTracks: 1, expectedPlays: 29, expectedVotes: 17,
    store: { restoreCid: async () => [{ trackId: 'first', payrollPlays: { 'NY-2026-10-12': 1 } }], getLatestSnapshotSavedAt: () => '2026-10-15T22:33:36.952Z',
      save: async () => { saves++; throw new Error('Checkpoint unavailable'); } } };
  await assert.rejects(recoverVerifiedPlaylistBaseline([], options), /totals do not match/);
  assert.equal(saves, 0);
  options.store.restoreCid = async () => [{ trackId: 'first', payrollPlays: { 'NY-2026-10-12': 29 }, payrollVotes: { 'NY-2026-10-12': 17 } }];
  await assert.rejects(recoverVerifiedPlaylistBaseline([], options), /Checkpoint unavailable/);
});

test('restores the newest tagged JukeLoop snapshot from Pinata', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const requests = [];
  const store = createPinataStateStore({
    pinataJwt: 'test-jwt',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.startsWith('https://api.pinata.cloud/')) {
        return new Response(JSON.stringify({ data: { files: [{
          cid: 'bafystate',
          name: 'decentbusking-jukeloop-state.json',
          created_at: '2026-10-01T12:00:00.000Z',
        }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'track-1' }] }), { status: 200 });
    },
  });

  assert.deepEqual(await store.restore(), [{ trackId: 'track-1' }]);
  const listUrl = new URL(requests[0].url);
  assert.equal(listUrl.pathname, '/v3/files/public');
  assert.equal(listUrl.searchParams.get('name'), 'decentbusking-jukeloop-state.json');
  assert.equal(listUrl.searchParams.get('network'), null);
  assert.equal(listUrl.searchParams.get('order'), 'DESC');
  assert.equal(listUrl.searchParams.get('limit'), '100');
  assert.equal(requests[1].url, 'https://api.pinata.cloud/v3/gateways?pageSize=100&page=1');
  assert.equal(requests[2].url, 'https://dweb.link/ipfs/bafystate');
  assert.ok(requests.every(({ options }) => options.signal instanceof AbortSignal));
});

test('restore falls back to the Pinata gateway when the configured gateway is rate-limited', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const fetched = [];
  const store = createPinataStateStore({
    pinataJwt: 'test-jwt',
    filesApiUrl: 'https://api.pinata.cloud/v3/files/public',
    fetchImpl: async (url) => {
      fetched.push(url);
      if (url.startsWith('https://api.pinata.cloud/')) {
        return new Response(JSON.stringify({ data: { files: [{ cid: 'bafystate', name: 'decentbusking-jukeloop-state.json', created_at: '2026-10-01T12:00:00Z' }] } }));
      }
      if (url.startsWith('https://dweb.link')) return new Response('', { status: 429 });
      return new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'kept' }] }));
    },
  });

  assert.deepEqual(await store.restore(), [{ trackId: 'kept' }]);
  assert.equal(new URL(fetched[0]).pathname, '/v3/files/public');
  assert.deepEqual(fetched.slice(1), [
    'https://api.pinata.cloud/v3/gateways?pageSize=100&page=1',
    'https://dweb.link/ipfs/bafystate',
    'https://gateway.pinata.cloud/ipfs/bafystate',
  ]);
});

test('restore falls back to a retained older checkpoint when the newest CID is unavailable', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const fetched = [];
  const warnings = [];
  const store = createPinataStateStore({ pinataJwt: 'test-jwt', log: { warn: message => warnings.push(message) },
    fetchImpl: async url => {
      fetched.push(url);
      if (url.startsWith('https://api.pinata.cloud/')) return new Response(JSON.stringify({ data: { files: [
        { cid: 'latest', name: 'decentbusking-jukeloop-state.json', created_at: '2026-10-02T12:00:00Z' },
        { cid: 'previous', name: 'decentbusking-jukeloop-state.json', created_at: '2026-10-01T12:00:00Z' },
      ] } }));
      if (url.endsWith('/ipfs/latest')) return new Response('', { status: 429 });
      return new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'recovered' }] }));
    } });
  assert.deepEqual(await store.restore(), [{ trackId: 'recovered' }]);
  assert.equal(store.getLatestSnapshotUri(), 'ipfs://previous');
  assert.ok(fetched.includes('https://dweb.link/ipfs/previous'));
  assert.match(warnings[0], /Restored older checkpoint previous/);
});

test('restoreCid fetches an explicit checkpoint without requiring it to remain in Pinata file listings', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  const store = createPinataStateStore({ pinataJwt: 'test-jwt', fetchImpl: async url => {
    if (url.endsWith(`/ipfs/${cid}`)) {
      return new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'recovered' }] }));
    }
    return new Response('', { status: 404 });
  } });
  assert.deepEqual(await store.restoreCid(cid), [{ trackId: 'recovered' }]);
  assert.equal(store.getLatestSnapshotUri(), `ipfs://${cid}`);
});

test('latest-only countdown restore never rewinds progress to an older available checkpoint', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const source = require('node:fs').readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
  const definition = source.match(/config\.topTenHypeStore = config\.pinataJwt \? createPinataStateStore\(([\s\S]*?)\) : null;/);
  assert.ok(definition);
  const options = require('node:vm').runInNewContext(`(${definition[1]})`, { config: {}, checkpointMirror: null });
  assert.equal(options.restoreLatestOnly, true);
  assert.equal(options.name, 'decentbusking-friday-top10-hype.json');
  assert.equal(options.tags.kind, 'friday-top10-hype');
  const fetched = [];
  const store = createPinataStateStore({ ...options, pinataJwt: 'test-jwt',
    fetchImpl: async url => {
      fetched.push(url);
      if (url.startsWith('https://api.pinata.cloud/')) return new Response(JSON.stringify({ data: { files: [
        { cid: 'latest', name: 'decentbusking-friday-top10-hype.json', created_at: '2026-10-17T00:20:00Z' },
        { cid: 'previous', name: 'decentbusking-friday-top10-hype.json', created_at: '2026-10-17T00:10:00Z' },
      ] } }));
      if (url.endsWith('/ipfs/latest')) return new Response('', { status: 429 });
      return new Response(JSON.stringify({ cursor: 1 }));
    } });
  await assert.rejects(store.restore(), /tried 1 checkpoint/);
  assert.equal(fetched.some(url => url.endsWith('/ipfs/previous')), false);
  assert.equal(store.getLatestSnapshotUri(), '');
});

test('restoreCid retries a transient gateway 429 and restores the archived checkpoint', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  let gatewayRequests = 0;
  const delays = [];
  const store = createPinataStateStore({ pinataJwt: 'test-jwt', fetchImpl: async url => {
    if (!url.endsWith(`/ipfs/${cid}`)) return new Response('', { status: 404 });
    gatewayRequests++;
    return gatewayRequests <= 2 ? new Response('', { status: 429 })
      : new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'recovered' }], savedAt: '2026-10-12T15:37:06.715Z' }));
  } });
  assert.deepEqual(await store.restoreCid(cid, { attempts: 2, baseDelayMs: 50, wait: async delay => delays.push(delay) }),
    [{ trackId: 'recovered' }]);
  assert.equal(gatewayRequests, 3);
  assert.deepEqual(delays, [50]);
  assert.equal(store.getLatestSnapshotSavedAt(), '2026-10-12T15:37:06.715Z');
});

test('restoreCid discovers the account Pinata gateway before public gateways', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  const requested = [];
  const store = createPinataStateStore({ pinataJwt: 'test-jwt', fetchImpl: async url => {
    requested.push(url);
    if (url.startsWith('https://api.pinata.cloud/v3/gateways')) {
      return new Response(JSON.stringify({ data: { rows: [{ domain: 'studio', custom_domains: [] }] } }));
    }
    if (url === `https://studio.mypinata.cloud/ipfs/${cid}`) {
      return new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'recovered' }] }));
    }
    return new Response('', { status: 429 });
  } });
  assert.deepEqual(await store.restoreCid(cid), [{ trackId: 'recovered' }]);
  assert.deepEqual(requested.slice(0, 2), [
    'https://api.pinata.cloud/v3/gateways?pageSize=100&page=1',
    `https://studio.mypinata.cloud/ipfs/${cid}`,
  ]);
});

test('restoreCid uses a gateway access token from the authenticated Pinata gateway list', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  let gatewayRequest;
  const store = createPinataStateStore({ pinataJwt: 'test-jwt', fetchImpl: async url => {
    if (url.startsWith('https://api.pinata.cloud/v3/gateways')) return new Response(JSON.stringify({ data: { rows: [{
      domain: 'studio', settings: { restriction_policies: { accessTokens: [{ value: 'gateway-secret' }] } },
    }] } }));
    if (url.includes('studio.mypinata.cloud')) {
      gatewayRequest = new URL(url);
      if (gatewayRequest.searchParams.get('pinataGatewayToken') === 'gateway-secret') {
        return new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'recovered' }] }));
      }
    }
    return new Response('', { status: 429 });
  } });
  assert.deepEqual(await store.restoreCid(cid), [{ trackId: 'recovered' }]);
  assert.equal(gatewayRequest.searchParams.get('pinataGatewayToken'), 'gateway-secret');
});

test('restoreCid applies the explicit server gateway token to a discovered dedicated gateway', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const cid = 'bafybeiamfpzoadbpbjbu4usncdlxpgbg3p5besebug7tofsipmp2g2mply';
  let dedicatedRequest;
  const store = createPinataStateStore({ pinataJwt: 'test-jwt', gatewayAccessToken: 'render-gateway-key',
    fetchImpl: async url => {
      if (url.startsWith('https://api.pinata.cloud/v3/gateways')) {
        return new Response(JSON.stringify({ data: { rows: [{ domain: 'peach-fast-pike-16' }] } }));
      }
      if (url.includes('peach-fast-pike-16.mypinata.cloud')) {
        dedicatedRequest = new URL(url);
        return dedicatedRequest.searchParams.get('pinataGatewayToken') === 'render-gateway-key'
          ? new Response(JSON.stringify({ schemaVersion: 1, playlist: [{ trackId: 'recovered' }] }))
          : new Response('', { status: 401 });
      }
      return new Response('', { status: 429 });
    },
  });
  assert.deepEqual(await store.restoreCid(cid), [{ trackId: 'recovered' }]);
  assert.equal(dedicatedRequest.searchParams.get('pinataGatewayToken'), 'render-gateway-key');
});

test('payment snapshot namespace is separate and immutable payment backups are retained', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const requests = [];
  const snapshot = { schemaVersion: 1, chainId: 8453, entries: [{ txHash: 'proof' }] };
  const store = createPinataStateStore({ pinataJwt: 'test', name: 'decentbusking-payment-ledger.json',
    tags: { app: 'decentbusking', kind: 'payment-ledger', schema: '1' }, retainSnapshots: Infinity,
    serialize: value => value, deserialize: (value, uri) => ({ ...value, snapshotUri: uri }),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === 'POST') {
        assert.deepEqual(JSON.parse(await options.body.get('file').text()), snapshot);
        return new Response(JSON.stringify({ data: { cid: 'ledger' } }));
      }
      if (url.includes('/ipfs/')) return new Response(JSON.stringify(snapshot));
      assert.equal(new URL(url).searchParams.get('name'), 'decentbusking-payment-ledger.json');
      return new Response(JSON.stringify({ data: { files: Array.from({ length: 5 }, (_, index) => ({ id: String(index), cid: 'ledger', name: 'decentbusking-payment-ledger.json' })) } }));
    } });
  assert.equal(await store.save(snapshot), 'ipfs://ledger');
  assert.deepEqual(await store.restore(), { ...snapshot, snapshotUri: 'ipfs://ledger' });
  assert.equal(requests.some(value => value.options.method === 'DELETE'), false);
});

test('uploads tagged state and prunes snapshots older than the newest five', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  const requests = [];
  const store = createPinataStateStore({
    pinataJwt: 'test-jwt',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === 'https://uploads.pinata.cloud/v3/files') {
        return new Response(JSON.stringify({ data: { cid: 'bafynew' } }), { status: 200 });
      }
      if (options.method === 'DELETE') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({
        data: { files: ['new', 'two', 'three', 'four', 'five', 'old'].map((id, index) => ({
          id,
          cid: `bafy${id}`,
          name: 'decentbusking-jukeloop-state.json',
          created_at: `2026-10-01T12:00:0${5 - index}.000Z`,
        })) },
      }), { status: 200 });
    },
  });

  assert.equal(await store.save([{ trackId: 'track-1' }]), 'ipfs://bafynew');
  const upload = requests.find((request) => request.url.includes('uploads.pinata.cloud'));
  assert.equal(upload.options.body.get('name'), 'decentbusking-jukeloop-state.json');
  assert.deepEqual(JSON.parse(upload.options.body.get('keyvalues')), {
    app: 'decentbusking', kind: 'jukeloop-state', schema: '1',
  });
  const snapshot = JSON.parse(await upload.options.body.get('file').text());
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.playlist, [{ trackId: 'track-1' }]);
  assert.deepEqual(
    requests.filter((request) => request.options.method === 'DELETE').map((request) => request.url),
    ['https://api.pinata.cloud/v3/files/public/old'],
  );
});

test('shared Pinata checkpoint publishes immediately when the community mirror is offline', async () => {
  const { createPinataStateStore } = await import(moduleUrl);
  let mirrored;
  let publishResolved = false;
  let completeMirror;
  const store = createPinataStateStore({ pinataJwt: 'test', beforeUpload: bytes => {
    mirrored = Buffer.from(bytes);
    return new Promise(resolve => { completeMirror = resolve; });
  }, fetchImpl: async (url, options = {}) => {
    if (options.method === 'POST') {
      publishResolved = true;
      mirrored = Buffer.from(await options.body.get('file').arrayBuffer());
      return new Response(JSON.stringify({ data: { cid: 'shared-cid' } }));
    }
    return new Response(JSON.stringify({ data: { files: [] } }));
  } });
  assert.equal(await store.save([{ trackId: 'song' }]), 'ipfs://shared-cid');
  assert.equal(publishResolved, true);
  const snapshot = JSON.parse(mirrored.toString());
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.playlist, [{ trackId: 'song' }]);
  assert.equal(typeof completeMirror, 'function');
  completeMirror('different-local-profile');
  const offline = createPinataStateStore({ pinataJwt: 'test', beforeUpload: async () => { throw new Error('Mirror offline'); },
    fetchImpl: async (url, options = {}) => options.method === 'POST'
      ? new Response(JSON.stringify({ data: { cid: 'shared-anyway' } }))
      : new Response(JSON.stringify({ data: { files: [] } })) });
  assert.equal(await offline.save([]), 'ipfs://shared-anyway');
});