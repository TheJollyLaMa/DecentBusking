const test = require('node:test');
const assert = require('node:assert/strict');

test('recording permission binds conscious rights scope to the exact performer, booking, site and time', async () => {
  const { liveRecordingConsentMessage } = await import('../js/live-recording-consent.mjs');
  const input = { bookingId: 'friday:fixture', wallet: `0x${'a'.repeat(40)}`,
    origin: 'https://radio.example', issuedAt: 1794585000000, enabled: true };
  const message = liveRecordingConsentMessage(input);
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
