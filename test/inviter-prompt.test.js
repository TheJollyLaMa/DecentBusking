const test = require('node:test');
const assert = require('node:assert/strict');

const jolly = '0x807061df657a7697c04045da7d16d941861caabc';
const agency = '0xcaeed8422fb5682c298b7f0971906d446ffd4e7a';
const vacuum = '0x405bb3cdf23833bb27bad6629b7cd4f01688235f';
const fresh = '0x' + '12'.repeat(20);

test('founding roster supplies inviters until the public journal records one', async () => {
  const { rosterPeople, inviterFor } = await import('../js/inviter-prompt.mjs');
  const roster = rosterPeople(require('../contributor-accounts.json'));
  assert.deepEqual(inviterFor(jolly.toUpperCase().replace('0X', '0x'), { roster }),
    { wallet: agency, name: 'decentagency.eth', source: 'founding' });
  assert.equal(inviterFor(vacuum, { roster }).wallet, jolly);
  assert.equal(inviterFor(fresh, { roster }), null);
  assert.equal(inviterFor(vacuum, { roster, inviters: [{ wallet: vacuum, referrer: fresh, at: 'x' }] }).wallet, fresh);
});

test('inviter choices put open-campaign referrers first and never offer the viewer', async () => {
  const { inviterChoices } = await import('../js/inviter-prompt.mjs');
  const roster = [{ wallet: jolly, name: 'TheJollyLaMa' }, { wallet: vacuum, name: 'withinthevacuum' }];
  const campaigns = [{ template: 'musician-referral', status: 'published', startsAt: '2026-01-01T00:00:00Z',
    endsAt: '2027-01-01T00:00:00Z', curatedReferrers: [fresh, vacuum] }];
  const choices = inviterChoices(vacuum, { roster, campaigns, now: Date.parse('2026-06-01T00:00:00Z') });
  assert.deepEqual(choices.map(c => c.wallet), [fresh, jolly]);
});

test('DBusker nudges a first-time Discord uploader once, and stays quiet when the inviter is known', async () => {
  const { createInviterNudge } = await import('../discord-bot/inviter-nudge.js');
  let inviters = [];
  const nudge = createInviterNudge({ siteUrl: 'https://busk.example/app', getState: async () => ({ inviters }),
    getLinked: id => id === '1' ? { address: fresh } : id === '2' ? { address: jolly } : null,
    foundingInvitees: () => new Set([jolly]) });
  const reply = await nudge({ author: { id: '1' } });
  assert.equal(reply.components[0].components[0].url, 'https://busk.example/app/?inviter=1');
  assert.equal(await nudge({ author: { id: '1' } }), null);
  assert.equal(await nudge({ author: { id: '2' } }), null);
  inviters = [{ wallet: fresh }];
  const again = createInviterNudge({ siteUrl: 'https://busk.example', getState: async () => ({ inviters }),
    getLinked: () => ({ address: fresh }), foundingInvitees: () => new Set() });
  assert.equal(await again({ author: { id: '1' } }), null);
  assert.ok(await createInviterNudge({ siteUrl: 'https://busk.example', getState: async () => null,
    getLinked: () => null, foundingInvitees: () => new Set() })({ author: { id: '3' } }));
});
