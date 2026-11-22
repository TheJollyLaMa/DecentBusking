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

test('buffered tips bind the audible act, not the next studio act or the previous recording', async () => {
  const program = { at: 1000, playId: 'live:show', bookingId: 'show', live: true, performer: live.performer };
  const state = { serverTime: 25000, liveAudio: { ...live, bookingId: 'next-show',
    performer: { ...live.performer, wallet: `0x${'34'.repeat(20)}` } },
  publicBroadcast: { selected: true, programHistory: [program,
    { at: 20000, playId: 'next-show', bookingId: 'next-show', live: true, performer: live.performer }] } };
  const audibleBroadcast = { at: 12000, observedAt: 25000, program };
  assert.deepEqual(await read(state, { audibleBroadcast, expectedBookingId: 'show' }),
    { bookingId: 'show', ...live.performer });
  await assert.rejects(read(state, { audibleBroadcast, expectedBookingId: 'next-show' }), /changed/);
  await assert.rejects(read(state, { audibleBroadcast: null }), /timing is unavailable/);
  await assert.rejects(read({ ...state, serverTime: 150000 }, { audibleBroadcast }), /timing is unavailable/);
  await assert.rejects(read(state, { audibleBroadcast: { ...audibleBroadcast,
    program: { ...program, playId: 'invented' } } }), /changed/);
});

test('ordinary buffered radio skips live-performer timing and returns to NFT tip lookup', async () => {
  const state = { serverTime: 25000, liveAudio: null, activeShow: { type: 'normal_rotation' },
    publicBroadcast: { selected: true, programHistory: [{
      at: 1000, playId: 'recording:1', trackId: 'recording-1', live: false, isDevert: false,
    }] } };
  assert.equal(await read(state, { audibleBroadcast: null }), null);
  assert.equal(await read(state, { audibleBroadcast: { at: 12000, program: state.publicBroadcast.programHistory[0] } }), null);
});
