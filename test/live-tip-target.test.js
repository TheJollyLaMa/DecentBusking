const test = require('node:test');
const assert = require('node:assert/strict');

const wallet = `0x${'12'.repeat(20)}`;
const live = {
  configured: true, phase: 'live', armed: true, bookingId: 'show', serverTime: 2000,
  policy: { mode: 'live' },
  bookingVerification: { fresh: true, verifiedAt: 1000 },
  performer: { wallet, artist: 'Live artist', title: 'Live set' },
};

async function read(state, options = {}) {
  const { readLiveTipTarget } = await import('../js/live-tip-target.mjs');
  return readLiveTipTarget({ serviceUrl: 'https://worker.test/', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://worker.test/api/radio');
    assert.equal(init.cache, 'no-store');
    return { ok: true, json: async () => ({ nowPlaying: null, ...state }) };
  }, ...options });
}

test('live tipping uses fresh canonical performer evidence, not optional program or previous recorded metadata', async () => {
  const target = await read({ liveAudio: live, nowPlaying: { wallet: 'wrong', title: 'Old recording' } });
  assert.deepEqual(target, { bookingId: 'show', wallet, artist: 'Live artist', title: 'Live set' });
  assert.equal(Object.isFrozen(target), true);
  assert.equal(await read({ liveAudio: null }), null);
});

test('stale verification, unavailable live transport and changing shows never fall back to the prior song', async () => {
  for (const change of [
    { armed: false }, { configured: false }, { bookingId: '' }, { performer: null },
    { bookingVerification: undefined }, { bookingVerification: { fresh: false, verifiedAt: 1000 } },
    { bookingVerification: { fresh: true, verifiedAt: 3000 } },
    { serverTime: 31001, bookingVerification: { fresh: true, verifiedAt: 1000 } },
    { performer: { ...live.performer, wallet: `0x${'0'.repeat(40)}` } },
  ]) await assert.rejects(read({ liveAudio: { ...live, ...change } }), /verif|wallet/i);
  await assert.rejects(read({ liveAudio: live }, { expectedBookingId: 'previous-show' }), /changed/);
  await assert.rejects(read({ liveAudio: null }, { expectedBookingId: 'show' }), /ended or changed/);
  await assert.rejects(read({ liveAudio: null, activeShow: { type: 'live_performance' } }), /not verified/);
});

test('confirmed non-live modes preserve recorded tipping; network errors remain errors', async () => {
  for (const mode of ['adverts', 'radio', 'fault']) {
    assert.equal(await read({ liveAudio: { ...live, phase: 'ended', policy: { mode } } }), null);
  }
  await assert.rejects(read({}, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});
