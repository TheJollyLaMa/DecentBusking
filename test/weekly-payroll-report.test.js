const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture({ forfeiture = false } = {}) {
  const { id } = require('../discord-bot/node_modules/ethers');
  const { finalizeRadioAllocation } = await import('../js/radio-payroll.mjs');
  const { createWeeklyPayrollReporter, buildWeeklyPayrollReport } = await import('../discord-bot/weekly-payroll-report.js');
  const wallet = number => `0x${number.toString(16).padStart(40, '0')}`;
  const config = { routerAddress: wallet(100), assets: { USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' } },
    radioFunds: { playback: 'dbusk-playback', topTen: 'dbusk-top10' } };
  const report = { week: 'NY-2026-10-12', current: false, tracks: Array.from({ length: 13 }, (_, index) =>
    ({ trackId: `song-${index}`, title: `Song ${index}`, artist: `Artist ${index}`, wallet: wallet(index + 1),
      plays: 100 - index, votes: 20 - index })) };
  report.tracks.push({ ...report.tracks[0], trackId: 'encore', title: 'Encore', plays: 2, votes: 0 });
  if (forfeiture) report.tracks[1].wallet = null;
  const allocations = ['playback', 'top10'].map(category => {
    const allocation = finalizeRadioAllocation({ report, category, budgetUnits: 1000000000n,
      minimumUnits: 10000n, fundSlug: category === 'playback' ? 'dbusk-playback' : 'dbusk-top10',
      routerAddress: config.routerAddress, assetAddress: config.assets.USDC.address, topTenScheduleVersion: 3,
      now: Date.parse('2026-10-19T05:00:00Z') });
    return { allocation, metadataUri: `ipfs://${category}`, metadataHash: id(JSON.stringify(allocation)) };
  });
  const weekly = { ready: true, allocations, lastError: '', backupPending: false };
  const ledger = { ready: true, chainId: 8453, routerAddress: config.routerAddress, lastError: '', backupPending: false,
    entries: allocations.flatMap(record => record.allocation.entries.map(entry => ({
      chainId: 8453, routerAddress: config.routerAddress, fundId: id(record.allocation.fundSlug),
      asset: config.assets.USDC.address, recipient: entry.wallet, amountUnits: entry.amountUnits,
      workReference: id(entry.workReferenceText), repositoryIdHash: id('TheJollyLaMa/DecentBusking'),
      contributorIdHash: id(`radio-artist:${entry.wallet.toLowerCase()}`), metadataUri: record.metadataUri,
      metadataHash: record.metadataHash, verification: 'verified',
    }))) };
  const posts = [];
  const history = new Map([['100', { id: '100', author: { id: 'human' }, embeds: [] }]]);
  const channel = {
    id: '123', client: { user: { id: 'bot' } },
    messages: { fetch: async ({ limit, before }) => {
      const messages = [...history.values()].filter(message => !before || BigInt(message.id) < BigInt(before))
        .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, limit);
      const result = new Map(messages.map(message => [message.id, message]));
      result.first = () => messages[0];
      return result;
    } },
    send: async payload => {
      posts.push(payload);
      const message = { id: String(101 + posts.length), author: { id: 'bot' }, ...payload };
      history.set(message.id, message);
      return message;
    },
  };
  let saved = null;
  let saves = 0;
  const options = { config, channelId: channel.id, siteUrl: 'https://example.org/DecentBusking/',
    getWeeklyPayflow: () => weekly, getPaymentLedger: () => ledger, getReports: () => [report],
    getChannel: async () => channel, now: () => Date.parse('2026-10-19T08:00:00Z'),
    restore: async () => structuredClone(saved),
    save: async value => { saves++; saved = structuredClone(value); return 'ipfs://reports'; } };
  return { id, options, weekly, ledger, report, allocations, channel, posts, history, saves: () => saves,
    saved: () => saved, create: override => createWeeklyPayrollReporter({ ...options, ...override }), buildWeeklyPayrollReport };
}

test('combined report waits for every verified payment in both published allocations', async () => {
  const value = await fixture();
  const reporter = value.create();
  const proof = value.ledger.entries.pop();
  await reporter.tick();
  assert.equal(value.posts.length, 0);
  value.ledger.entries.push({ ...proof, verification: 'restored-awaiting-comparison' });
  await reporter.tick();
  assert.equal(value.posts.length, 0);
  value.ledger.entries[value.ledger.entries.length - 1] = proof;
  const prizes = value.weekly.allocations.pop();
  await reporter.tick();
  assert.equal(value.posts.length, 0);
  value.weekly.allocations.push(prizes);
  await Promise.all([reporter.tick(), reporter.tick()]);
  assert.equal(value.posts.length, 1);
  assert.equal(reporter.getState().reports[0].status, 'sent');
  assert.deepEqual(value.posts[0].allowedMentions, { parse: [] });
  await reporter.tick();
  await value.create().tick();
  assert.equal(value.posts.length, 1);
  assert.equal(value.saves(), 2);
});

test('report lists chart songs by rank and only ten aggregated Playback payees by total paid', async () => {
  const value = await fixture();
  await value.create().tick();
  const embed = value.posts[0].embeds[0];
  assert.equal(embed.fields[0].value.split('\n').length, 10);
  assert.match(embed.fields[0].value, /^1\. Song 0 - Artist 0: \*\*\$500\.00\*\*/);
  assert.match(embed.fields[0].value, /10\. Song 9/);
  const playback = embed.fields[1].value;
  assert.equal(playback.split('\n').length, 11);
  assert.match(playback, /^1\. Artist 0 /);
  assert.equal((playback.match(/Artist 0 /g) || []).length, 1);
  assert.doesNotMatch(playback, /Song |Encore|Artist 10/);
  assert.match(playback, /Plus 3 other artists:/);
  assert.match(embed.description, /\$2000\.00 USDC paid/);
  assert.match(embed.description, /\[Payment proofs & fund walkthrough\]\(https:\/\/example\.org\/DecentBusking\/\?tutorial=payroll&week=NY-2026-10-12\)/);
  const first = value.allocations[0].allocation.entries.find(entry => entry.wallet === value.report.tracks[0].wallet);
  const { formatUsdcUnits } = await import('../js/usdc-format.mjs');
  assert.ok(playback.includes(`$${formatUsdcUnits(first.amountUnits)}`));
});

test('forfeited chart positions stay visible as unpaid and are never counted in paid totals', async () => {
  const value = await fixture({ forfeiture: true });
  await value.create().tick();
  assert.equal(value.posts.length, 1);
  const embed = value.posts[0].embeds[0];
  assert.match(embed.fields[0].value, /2\. Song 1 - Artist 1: \*\*\$0\.00 \(not payable\)\*\*/);
  assert.match(embed.fields[0].value, /3\. Song 2 - Artist 2: \*\*\$125\.00\*\*/);
  assert.doesNotMatch(embed.fields[1].value, /Artist 1 \(/);
  assert.doesNotMatch(embed.description, /\$2000\.00 USDC paid/);
});

test('report ranks by amount, sums case-insensitive artist wallets, and breaks ties deterministically', async () => {
  const value = await fixture();
  const playback = structuredClone(value.allocations[0]);
  playback.allocation.entries = [
    { wallet: '0xabc', artist: 'Same artist', amountUnits: '1000000' },
    { wallet: '0xABC', artist: 'Same artist', amountUnits: '2000000' },
    { wallet: '0xdef', artist: 'Second', amountUnits: '2000000' },
    { wallet: '0x123', artist: 'Tied', amountUnits: '2000000' },
  ];
  const result = value.buildWeeklyPayrollReport({ playback, top10: value.allocations[1],
    report: value.report, siteUrl: value.options.siteUrl });
  const lines = result.embeds[0].fields[1].value.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /Same artist.*\$3\.00/);
  assert.match(lines[1], /Tied/);
  assert.match(lines[2], /Second/);
});

test('healthy allocation and ledger checkpoints are mandatory', async () => {
  for (const [state, key, bad] of [['weekly', 'ready', false], ['weekly', 'backupPending', true],
    ['weekly', 'lastError', 'archive RPC unavailable'], ['ledger', 'ready', false],
    ['ledger', 'backupPending', true], ['ledger', 'lastError', 'RPC unavailable']]) {
    const value = await fixture();
    value[state][key] = bad;
    await value.create().tick();
    assert.equal(value.posts.length, 0);
  }
});

test('verified events must exactly match recipient, fund, token, amount, namespace and allocation metadata', async () => {
  for (const [key, bad] of [['recipient', '0xwrong'], ['fundId', '0xwrong'], ['asset', '0xwrong'],
    ['amountUnits', '1'], ['repositoryIdHash', '0xwrong'], ['contributorIdHash', '0xwrong'],
    ['metadataUri', 'ipfs://other'], ['metadataHash', '0xwrong'], ['routerAddress', '0xwrong'], ['chainId', 1]]) {
    const value = await fixture();
    value.ledger.entries[0][key] = bad;
    const reporter = value.create();
    await assert.rejects(reporter.tick(), /proof does not match/);
    assert.equal(value.posts.length, 0);
    assert.match(reporter.getState().lastError, /proof does not match/);
  }
});

test('does not announce mismatched recovered history or corrupt allocation metadata', async () => {
  const value = await fixture();
  value.report.tracks[0].plays++;
  await assert.rejects(value.create().tick(), /no longer matches/);
  assert.equal(value.posts.length, 0);
  value.report.tracks[0].plays--;
  value.allocations[0].metadataHash = value.id('wrong');
  await assert.rejects(value.create().tick(), /Invalid payroll allocation proof/);
});

test('failed intent backup prevents send; successful send with failed backup recovers across restart', async () => {
  const value = await fixture();
  await assert.rejects(value.create({ save: async () => { throw new Error('IPFS offline'); } }).tick(), /IPFS offline/);
  assert.equal(value.posts.length, 0);
  let calls = 0;
  const reporter = value.create({ save: async snapshot => {
    if (++calls === 2) throw new Error('IPFS offline');
    return value.options.save(snapshot);
  } });
  await assert.rejects(reporter.tick(), /IPFS offline/);
  assert.equal(value.posts.length, 1);
  assert.equal(value.saved().reports[0].messageId, undefined);
  await value.create().tick();
  assert.equal(value.posts.length, 1);
  assert.equal(value.saved().reports[0].messageId, '102');
});

test('Discord failures retry without paying again and lost send responses are recovered from history', async () => {
  const value = await fixture();
  const send = value.channel.send;
  value.channel.send = async () => { throw new Error('Missing Send Messages permission'); };
  const reporter = value.create();
  await assert.rejects(reporter.tick(), /Missing Send Messages permission/);
  value.channel.send = async payload => { await send(payload); throw new Error('Response lost'); };
  await assert.rejects(reporter.tick(), /Response lost/);
  await value.create().tick();
  assert.equal(value.posts.length, 1);
  assert.equal(value.saved().reports[0].messageId, '102');
});

test('recovery searches beyond the newest 100 messages and ignores non-bot copies of the marker', async () => {
  const value = await fixture();
  const send = value.channel.send;
  value.channel.send = async payload => { await send(payload); throw new Error('Response lost'); };
  await assert.rejects(value.create().tick(), /Response lost/);
  for (let index = 103; index < 310; index++) value.history.set(String(index), {
    id: String(index), author: { id: 'human' }, embeds: [{ footer: { text: 'decentbusking-payroll-paid:NY-2026-10-12' } }],
  });
  await value.create().tick();
  assert.equal(value.posts.length, 1);
  assert.equal(value.saved().reports[0].messageId, '102');
});

test('failure to read recovery history never causes a blind resend', async () => {
  const value = await fixture();
  const send = value.channel.send;
  value.channel.send = async payload => { await send(payload); throw new Error('Response lost'); };
  await assert.rejects(value.create().tick(), /Response lost/);
  value.channel.messages.fetch = async () => { throw new Error('Missing Read Message History permission'); };
  await assert.rejects(value.create().tick(), /Missing Read Message History/);
  assert.equal(value.posts.length, 1);
});

test('checkpoint scope and channel identity prevent accidental posts to a different destination', async () => {
  const value = await fixture();
  await value.create().tick();
  const checkpoint = structuredClone(value.saved());
  checkpoint.channelId = '456';
  await assert.rejects(value.create({ restore: async () => checkpoint }).tick(), /Invalid payroll announcement checkpoint/);
  const other = await fixture();
  other.channel.id = '456';
  await assert.rejects(other.create().tick(), /channel is unavailable/);
  assert.equal(other.posts.length, 0);
});

test('long artist and song names cannot expand or inject mentions into bounded Discord fields', async () => {
  const value = await fixture();
  for (const track of value.report.tracks) {
    track.title = '@everyone **[click](url)**\n'.repeat(20);
    track.artist = '@here <@123> Artist\n'.repeat(20);
  }
  const playback = structuredClone(value.allocations[0]);
  for (const entry of playback.allocation.entries) entry.artist = '@everyone **artist**\n'.repeat(20);
  const payload = value.buildWeeklyPayrollReport({ playback, top10: value.allocations[1],
    report: value.report, siteUrl: value.options.siteUrl });
  assert.ok(payload.embeds[0].fields.every(field => field.value.length <= 1024));
  assert.doesNotMatch(payload.embeds[0].fields.map(field => field.value).join(''), /@everyone|@here|<@/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});
