const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { Wallet, id } = require('../discord-bot/node_modules/ethers');
const kubo = require('../discord-bot/node_modules/kubo');
const bot = path.join(__dirname, '../discord-bot');
const load = file => import(pathToFileURL(path.join(__dirname, '..', file)).href);
const origin = 'https://busking.example';
const cid = 'bafybeidxx4rufx7xrn5lmt3npyaej6doupxajyh53ibb4fp43whdvgfm2u';
const execute = promisify(execFile);

async function peerFor(value) {
  const { CID } = await load('discord-bot/node_modules/multiformats/dist/src/cid.js');
  const { sha256 } = await load('discord-bot/node_modules/multiformats/dist/src/hashes/sha2.js');
  return CID.createV1(0x72, await sha256.digest(new TextEncoder().encode(value))).toString();
}

async function harness() {
  const { createPinnerNetwork } = await load('discord-bot/pinner-network.js');
  const { buildPinnerCommandMessage } = await load('js/pinner-rewards.mjs');
  const owner = Wallet.createRandom(), member = Wallet.createRandom();
  let clock = Date.parse('2026-11-23T12:00:00Z'), latest = null, balance = 10000000n;
  let failSave = false, proofOk = true, memberOk = true, sharedMember = false;
  const paid = new Set(), uploads = [], closingCalls = [];
  const router = { target: '0x' + '3'.repeat(40), runner: { getNetwork: async () => ({ chainId: 8453 }) },
    funds: async () => ({ exists: true, active: true }), approvedAssets: async () => true,
    fundBalances: async () => balance, completedWorkReferences: async reference => paid.has(reference) };
  const options = { router, ownerWallet: owner.address, now: () => clock,
    choose: (first, second) => second === undefined ? 0 : first,
    restore: async () => structuredClone(latest),
    save: async snapshot => {
      if (failSave) throw new Error('Checkpoint unavailable');
      latest = structuredClone(snapshot); return `ipfs://${cid}`;
    },
    upload: async bytes => { uploads.push(JSON.parse(bytes)); return `ipfs://${cid}`; },
    getManifest: async () => ({ entries: [{ cid }] }),
    verifyMember: async wallet => {
      if (!memberOk) throw new Error('Discord membership unavailable');
      return id(`discord-member:${sharedMember ? member.address.toLowerCase() : wallet.toLowerCase()}`);
    },
    probe: { initialize: async () => {}, check: async () => ({ ok: proofOk, blockCid: proofOk ? cid : '',
      latencyMs: 5, reason: proofOk ? '' : 'Node cannot serve its ownership marker' }) },
    getClosingBalance: async input => { closingCalls.push(input); return 10000000n; } };
  const network = createPinnerNetwork(options);
  await network.initialize();
  const command = async (action, signer = member, peerId, wallet = member.address, extra = {}) => {
    const body = { action, address: signer.address, wallet, peerId: peerId || await peerFor('one'),
      revision: network.getState().revision, nonce: randomBytes(16).toString('hex'),
      issuedAt: new Date(clock).toISOString(), ...extra };
    body.signature = await signer.signMessage(buildPinnerCommandMessage({ ...body, origin }));
    return network.command(body, origin);
  };
  return { network, owner, member, command, uploads, closingCalls, router, paid,
    setClock: value => { clock = value; }, setBalance: value => { balance = value; },
    setFailSave: value => { failSave = value; }, setProof: value => { proofOk = value; },
    setMember: value => { memberOk = value; }, setSharedMember: value => { sharedMember = value; },
    snapshot: () => structuredClone(latest), options };
}

test('enrollment needs member identity, owner approval and actual node ownership before any checks count', async () => {
  const h = await harness();
  h.setMember(false);
  await assert.rejects(h.command('enroll'), /Discord membership/);
  assert.equal(h.network.getState().participants.length, 0);
  h.setMember(true);
  const enrolled = await h.command('enroll');
  assert.equal(enrolled.participants[0].status, 'pending');
  assert.equal(enrolled.participants[0].successfulChecks, 0);
  assert.ok(enrolled.ownership.contentBase64);
  assert.ok(!JSON.stringify(h.snapshot()).includes('contentBase64'));
  await assert.rejects(h.command('approve'), /only the owner/);
  h.setProof(false);
  await assert.rejects(h.command('approve', h.owner), /Node ownership could not be verified/);
  assert.equal(h.network.getState().participants[0].status, 'pending');
  h.setProof(true);
  await h.command('approve', h.owner);
  assert.equal(h.network.getState().participants[0].successfulChecks, 0);
  assert.equal(h.network.getState().participants[0].status, 'active');
  const other = Wallet.createRandom();
  await assert.rejects(h.command('enroll', other, await peerFor('one'), other.address), /already registered to another wallet/);
  h.setSharedMember(true);
  await assert.rejects(h.command('enroll', other, await peerFor('two'), other.address), /Discord member already has/);
  h.setSharedMember(false);
  const marker = h.snapshot().pinners[0].ownershipCid;
  const reset = await h.command('enroll');
  assert.equal(reset.participants[0].status, 'pending');
  assert.notEqual(reset.ownership.cid, marker);
  assert.equal(reset.participants[0].qualified, false);
  await h.command('approve', h.owner);
  assert.equal(h.network.getState().participants[0].status, 'active');
  await h.command('suspend', h.owner);
  h.setSharedMember(true);
  await h.command('enroll', other, await peerFor('one'), other.address);
  assert.equal(h.network.getState().participants.find(pinner => pinner.wallet === other.address.toLowerCase()).status, 'pending');
});

test('qualifying peer checks freeze once per NY week, archive evidence and reserve every unpaid award', async () => {
  const h = await harness();
  await h.command('enroll'); await h.command('approve', h.owner);
  const close = Date.parse(h.network.getState().nextCloseAt);
  for (let hours = 21; hours > 0; hours--) {
    h.setClock(close - hours * 3600000); await h.network.tick();
  }
  assert.equal(h.network.getState().participants[0].qualified, true);
  h.setClock(close); await h.network.tick(); await h.network.tick();
  let state = h.network.getState();
  assert.equal(state.receipts.length, 1);
  assert.equal(state.receipts[0].allocation.allocatedUnits, '10000000');
  assert.equal(state.fund.reservedUnits, '10000000');
  assert.equal(state.fund.availableUnits, '0');
  assert.equal(h.uploads.find(value => value.schema === 'pinner-checks/v1').checks.length, 21);
  assert.equal(h.closingCalls[0].report.endAt, new Date(close).toISOString());
  assert.ok(h.snapshot().checks.every(check => Date.parse(check.at) >= close));
  const nextClose = Date.parse(state.nextCloseAt);
  for (let hours = 21; hours > 0; hours--) {
    h.setClock(nextClose - hours * 3600000); await h.network.tick();
  }
  h.setClock(nextClose); await h.network.tick();
  state = h.network.getState();
  assert.equal(state.receipts.length, 2);
  assert.equal(state.receipts[1].allocation.allocatedUnits, '0');
  assert.equal(h.closingCalls[1].allocations.length, 1);
  const reference = state.receipts[0].allocation.entries[0].workReferenceText;
  h.paid.add(id(reference)); h.setBalance(0n); await h.network.tick();
  assert.equal(h.network.getState().fund.reservedUnits, '0');
  assert.deepEqual(h.network.getState().receipts[0].paidWorkReferences, [reference]);
});

test('a failed evidence checkpoint cannot manufacture availability or lose the saved registry', async () => {
  const h = await harness();
  await h.command('enroll'); await h.command('approve', h.owner);
  const before = h.snapshot();
  h.setFailSave(true);
  await assert.rejects(h.network.tick(), /Checkpoint unavailable/);
  assert.equal(h.network.getState().rewardStatus, 'unavailable');
  assert.equal(h.network.getState().participants[0].successfulChecks, 0);
  assert.deepEqual(h.snapshot(), before);
  h.setFailSave(false);
  await h.network.tick();
  assert.equal(h.network.getState().participants[0].successfulChecks, 1);
  assert.equal(h.network.getState().rewardStatus, 'active');
  const { createPinnerNetwork } = await load('discord-bot/pinner-network.js');
  const corrupt = { ...h.snapshot(), receipts: [{ allocation: { schema: 'wrong' } }] };
  await assert.rejects(createPinnerNetwork({ ...h.options, restore: async () => corrupt }).initialize(), /Invalid pinner/);
});

test('campaign qualification preserves real daily probes across weekly payroll, restoration and an unavailable checkpoint', async () => {
  const h = await harness();
  const { newYorkDayPeriod } = await load('js/payroll-week.mjs');
  const { createPinnerNetwork } = await load('discord-bot/pinner-network.js');
  await h.command('enroll'); await h.command('approve', h.owner);
  const request = { wallet: h.member.address.toLowerCase(), campaignId: 'pinning-test',
    startsAt: '2026-11-23T12:00:00Z', joinedAt: '2026-11-23T12:00:00Z',
    endsAt: '2026-12-04T05:00:00Z', qualifyingDays: 2 };
  const { createPromotions } = await load('discord-bot/promotions.js');
  const { PINNER_CAMPAIGN_VERSION, pinnerEthAmounts, promotionAuthorization } = await load('js/promotions.mjs');
  let campaignCheckpoint;
  const promotional = createPromotions({ ownerWallet: h.owner.address, routerAddress: h.router.target, provider: {},
    restore: async () => campaignCheckpoint, save: async value => { campaignCheckpoint = structuredClone(value); return `ipfs://${cid}`; },
    readFunding: async () => 100000000000000000n, readPinnerProgress: h.network.campaignProgress, now: h.options.now });
  const execute = async (command, signer = h.owner) => {
    const body = { command: { revision: campaignCheckpoint?.revision || 0, ...command }, address: signer.address,
      origin, issuedAt: new Date(h.options.now()).toISOString() };
    body.signature = await signer.signMessage(promotionAuthorization(body));
    return promotional.execute(body, origin);
  };
  const draft = (await execute({ action: 'save', campaign: { template: 'pinner',
    qualificationVersion: PINNER_CAMPAIGN_VERSION, asset: 'eth', title: 'Node bonus', criteria: 'Pin community music',
    terms: 'Generated fixed terms', maxAwards: 5, qualifyingDays: 2,
    supporterRewards: [], ...pinnerEthAmounts('1250000000000000', 5),
    startsAt: request.startsAt, endsAt: request.endsAt, claimDeadline: '2026-12-11T05:00:00Z' } })).campaigns[0];
  await execute({ action: 'status', campaignId: draft.id, status: 'published' });
  await execute({ action: 'join', campaignId: draft.id, acceptTerms: true, termsVersion: 1 }, h.member);
  const checkDay = async (date, count, failures = 0) => {
    const day = newYorkDayPeriod(date);
    for (let hour = 0; hour < count; hour++) {
      h.setClock(Date.parse(day.startAt) + hour * 3600000);
      h.setProof(!(hour >= 1 && hour <= failures));
      await h.network.tick();
    }
    h.setProof(true);
    h.setClock(Date.parse(day.endAt));
    await h.network.tick();
  };
  await checkDay('2026-11-24', 20, 2);
  assert.equal(h.network.campaignProgress(request).completedDays, 1, '18/20 is exactly 90%');
  await checkDay('2026-11-25', 20, 3);
  assert.equal(h.network.campaignProgress(request).completedDays, 1, '17/20 is below the required availability');
  await checkDay('2026-11-29', 20);
  const progress = h.network.campaignProgress(request);
  assert.equal(progress.completedDays, 2);
  assert.equal(progress.completedAt, '2026-11-30T05:00:00.000Z');
  assert.equal(h.network.getState().receipts.length, 1, 'ordinary weekly payroll still closes');
  const publicCampaign = await promotional.publicState();
  const profile = publicCampaign.participantProfiles.find(row => row.wallet === request.wallet);
  assert.equal(profile.completedDays, 2);
  assert.equal(profile.eligible, true);
  assert.equal(profile.nodeStatus, 'active');
  const { publicCalendarData } = await load('js/dbusk-calendar-core.mjs');
  assert.equal(publicCalendarData({}, publicCampaign).campaigns[0].portal.id, draft.id);
  const claim = (await execute({ action: 'claim', campaignId: draft.id }, h.member)).claims[0];
  await execute({ action: 'review', claimId: claim.id, decision: 'approved', reason: 'Independent probes verified' });
  assert.equal((await promotional.publicState()).participantProfiles[0].approvedUnits, draft.rewardUnits);
  assert.equal(h.network.getState().receipts[0].allocation.fundSlug, 'dbusk-pinners');
  assert.equal(campaignCheckpoint.claims[0].fund, 'dbusk-pinner-campaigns');
  assert.ok(h.snapshot().checks.every(check => Date.parse(check.at) >= Date.parse(progress.completedAt)));
  const restored = createPinnerNetwork(h.options);
  await restored.initialize();
  assert.deepEqual(restored.campaignProgress(request), progress, 'progress is not erased by weekly pruning or a restart');
  assert.equal(restored.campaignProgress({ ...request, joinedAt: '2026-11-24T06:00:00Z' }).completedDays, 1,
    'a day that started before joining is not counted');
  h.setFailSave(true);
  h.setClock(Date.parse('2026-11-30T07:00:00Z'));
  await assert.rejects(restored.tick(), /Checkpoint unavailable/);
  assert.throws(() => restored.campaignProgress(request), /evidence is unavailable/);
  assert.equal(newYorkDayPeriod('2026-03-08').endAt, '2026-03-09T04:00:00.000Z');
  assert.equal(Date.parse(newYorkDayPeriod('2026-11-01').endAt) - Date.parse(newYorkDayPeriod('2026-11-01').startAt), 25 * 3600000);
});

test('peer lookup filters private addresses and never treats routing outages as successful proofs', async () => {
  const { resolvePinnerAddresses, normalizePinnerPeerId, verifyPinnerBlock } = await load('discord-bot/pinner-probe.js');
  const peer = normalizePinnerPeerId(await peerFor('one'));
  const addresses = await resolvePinnerAddresses(peer, { fetchImpl: async () => new Response(JSON.stringify({
    Peers: [{ ID: peer, Addrs: ['/ip4/127.0.0.1/tcp/4001', '/ip4/10.0.0.1/tcp/4001',
      '/ip6/::1/tcp/4001', '/dns4/internal.example/tcp/4001', '/ip4/8.8.8.8/tcp/4001'] }],
  })) });
  assert.deepEqual(addresses, [`/ip4/8.8.8.8/tcp/4001/p2p/${peer}`]);
  await assert.rejects(resolvePinnerAddresses(peer, { fetchImpl: async () => new Response('', { status: 503 }) }), /routing service unavailable/);
  assert.throws(() => verifyPinnerBlock(cid, Buffer.from('wrong')), /does not match/);
});

test('isolated Kubo probes require the marker and selected content from that peer, without cache fallback', { timeout: 90000 }, async t => {
  const { probeKuboPeer } = await load('discord-bot/pinner-probe.js');
  const { checkpointContentCid } = await load('discord-bot/checkpoint-mirror.js');
  const executable = kubo.path({ autoDownload: false });
  const directory = await mkdtemp(path.join(tmpdir(), 'dbusk-pinner-test-source-'));
  const env = { PATH: process.env.PATH, HOME: directory, IPFS_PATH: directory };
  const command = args => execute(executable, args, { env, timeout: 15000, maxBuffer: 2097152 });
  let daemon, closed;
  t.after(async () => {
    if (daemon?.exitCode === null) { daemon.kill('SIGTERM'); await closed; }
    await rm(directory, { recursive: true, force: true });
  });
  await command(['init', '--profile=test']);
  const configPath = path.join(directory, 'config');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.Bootstrap = []; config.Discovery.MDNS.Enabled = false; config.Routing.Type = 'none';
  if (config.AutoConf) config.AutoConf.Enabled = false;
  config.Addresses.Swarm = ['/ip4/127.0.0.1/tcp/0']; config.Addresses.Gateway = '';
  config.Addresses.API = `/unix${path.join(directory, 'api.sock')}`;
  await writeFile(configPath, JSON.stringify(config));
  daemon = spawn(executable, ['daemon', '--routing=none'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise(resolve => daemon.once('close', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test IPFS node startup timed out')), 15000);
    daemon.once('error', reject); daemon.once('exit', code => reject(new Error(`Test IPFS node exited (${code})`)));
    daemon.stdout.on('data', bytes => { if (bytes.toString().includes('Daemon is ready')) { clearTimeout(timer); resolve(); } });
    daemon.stderr.resume();
  });
  const marker = path.join(directory, 'marker'), media = path.join(directory, 'media');
  await writeFile(marker, randomBytes(64)); await writeFile(media, randomBytes(1048576));
  const ownershipCid = (await command(['add', '-q', '--cid-version=1', '--raw-leaves=true', marker])).stdout.trim();
  const rootCid = (await command(['add', '-q', '--cid-version=1', '--raw-leaves=true', media])).stdout.trim();
  const identity = JSON.parse((await command(['id'])).stdout);
  const peerAddress = identity.Addresses.find(address => address.startsWith('/ip4/127.0.0.1/tcp/'));
  assert.ok(peerAddress);
  const args = { peerAddress, rootCid, ownershipCid, executable, choose: (first, second) => second === undefined ? 0 : first };
  const success = await probeKuboPeer(args);
  assert.equal(success.ok, true);
  assert.notEqual(success.blockCid, rootCid);
  const missing = await checkpointContentCid(randomBytes(64));
  assert.equal((await probeKuboPeer({ ...args, ownershipCid: missing, timeoutMs: 8000 })).ok, false);
  daemon.kill('SIGTERM'); await closed;
  assert.equal((await probeKuboPeer({ ...args, timeoutMs: 8000 })).ok, false);
});

test('pinner payroll validates frozen amounts and skips completed references on every retry', async () => {
  const { buildPinnerReceipt } = await load('js/pinner-rewards.mjs');
  const { settlePinnerReceipt } = await load('js/pinner-rewards-ui.mjs');
  const owner = Wallet.createRandom(), recipient = Wallet.createRandom().address.toLowerCase();
  const routerAddress = '0x' + '3'.repeat(40);
  const allocation = buildPinnerReceipt({ week: 'NY-2026-11-23', budgetUnits: 123456n, routerAddress,
    checksUri: `ipfs://${cid}`, checksHash: id('checks'), generatedAt: '2026-11-30T05:00:00.000Z',
    pinners: [{ wallet: recipient, successfulChecks: 20, failedChecks: 0, lastVerifiedAt: '2026-11-30T04:00:00.000Z' }] });
  const record = { allocation, metadataUri: `ipfs://${cid}`, metadataHash: id(JSON.stringify(allocation)) };
  const paid = new Set(), payouts = [];
  const payout = Object.assign(async (...args) => {
    payouts.push(args); paid.add(args[4]); return { hash: id('transaction'), wait: async () => ({ status: 1 }) };
  }, { staticCall: async () => {} });
  const router = { target: routerAddress, paused: async () => false, PAYROLL_ROLE: async () => id('role'),
    hasRole: async () => true, approvedAssets: async () => true, funds: async () => ({ exists: true, active: true }),
    contributors: async () => ({ approved: true }), fundBalances: async () => 123456n,
    completedWorkReferences: async reference => paid.has(reference), payout };
  const signer = { getAddress: async () => owner.address, provider: { getNetwork: async () => ({ chainId: 8453 }) } };
  const options = { record, router, signer, owner: owner.address, hashReference: id,
    now: Date.parse('2026-11-30T05:00:00Z'), onTransaction: async () => {} };
  assert.equal((await settlePinnerReceipt(options)).confirmed.length, 1);
  assert.equal((await settlePinnerReceipt(options)).skipped, 1);
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0][3], 123456n);
  const tampered = structuredClone(record); tampered.allocation.entries[0].amountUnits = '123457';
  await assert.rejects(settlePinnerReceipt({ ...options, record: tampered }), /Invalid pinner receipt/);
  await assert.rejects(settlePinnerReceipt({ ...options, now: Date.parse('2026-11-30T04:59:59Z') }), /Only a closed/);
});
