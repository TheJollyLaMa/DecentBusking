const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

test('recording permission binds conscious rights scope to the exact performer, booking, site and time', async () => {
  const { liveRecordingConsentMessage } = await import('../js/live-recording-consent.mjs');
  const input = { bookingId: 'friday:fixture', wallet: `0x${'a'.repeat(40)}`,
    origin: 'https://radio.example', issuedAt: 1794585000000, enabled: true };
  const message = liveRecordingConsentMessage(input);
  assert.equal(createHash('sha256').update(message).digest('hex'),
    '98aaf711d114b71498ead92718d4e0ee8ad153a179d2cf65ebef158d8c54423c',
    'Legacy scheduled-only signatures must remain byte-for-byte compatible');
  assert.match(message, /Record this and play on the radio: YES/);
  assert.match(message, /public IPFS.*DNFT.*my wallet/);
  assert.match(message, /can grant these rights/);
  assert.match(message, /guaranteed fee.*unchanged/);
  for (const change of [{ bookingId: 'other' }, { wallet: `0x${'b'.repeat(40)}` },
    { origin: 'https://other.example' }, { issuedAt: input.issuedAt + 1 }, { enabled: false }]) {
    assert.notEqual(liveRecordingConsentMessage({ ...input, ...change }), message);
  }
  assert.match(liveRecordingConsentMessage({ ...input, enabled: false }), /Stop new capture and publication/);
  for (const change of [{ bookingId: 'bad\nbooking' }, { wallet: 'wrong' }, { origin: 'https://radio.example/path' },
    { issuedAt: 0 }, { enabled: 'true' }]) {
    assert.throws(() => liveRecordingConsentMessage({ ...input, ...change }), /Invalid/);
  }
});

test('allocated-set recording needs an explicit new permission, bound to the delayed set and ten-minute encore limit', async () => {
  const { liveRecordingConsentMessage, LIVE_RECORDING_ALLOCATED_CONSENT_VERSION } =
    await import('../js/live-recording-consent.mjs');
  const input = { bookingId: 'friday:fixture', wallet: `0x${'a'.repeat(40)}`,
    origin: 'https://radio.example', issuedAt: 1794585000000, enabled: true };
  const legacy = liveRecordingConsentMessage(input);
  const allocated = liveRecordingConsentMessage({ ...input, version: LIVE_RECORDING_ALLOCATED_CONSENT_VERSION });
  assert.notEqual(allocated, legacy);
  assert.match(legacy, /only my scheduled live set/);
  assert.doesNotMatch(legacy, /delayed start|encore/);
  assert.match(allocated, /Version: dbusk-live-recording-v2/);
  assert.match(allocated, /only my on-air performance for this booking.*delayed start.*short or full set.*ten minutes of producer-approved encore/);
  assert.match(allocated, /Private practice and soundchecks are not recorded/);
  assert.match(allocated, /guaranteed fee and original booking terms are unchanged/);
  const revoke = liveRecordingConsentMessage({ ...input, enabled: false, version: LIVE_RECORDING_ALLOCATED_CONSENT_VERSION });
  assert.match(revoke, /Stop new capture and publication.*cannot be recalled/);
  assert.doesNotMatch(revoke, /I permit recording/);
  for (const version of [null, '', 'dbusk-live-recording-v3']) {
    assert.throws(() => liveRecordingConsentMessage({ ...input, version }), /Invalid recording permission/);
  }
});
