const test = require('node:test');
const assert = require('node:assert/strict');

test('explicit DeVert ads route from VertLoop or as a JukeBox fallback when intake is disabled', async () => {
  const { shouldHandleDevertLoopSubmission } = await import('../discord-bot/submission-routing.js');
  assert.equal(shouldHandleDevertLoopSubmission({ channelId: 'vertloop', content: 'hello' }, {
    jukeboxChannelId: 'jukebox',
    vertLoopChannelId: 'vertloop',
    adIntakeEnabled: false,
  }), false);
  assert.equal(shouldHandleDevertLoopSubmission({ channelId: 'jukebox', content: '!devert-ad Title | ipfs://cid | video/mp4' }, {
    jukeboxChannelId: 'jukebox',
    vertLoopChannelId: 'vertloop',
    adIntakeEnabled: false,
  }), true);
  assert.equal(shouldHandleDevertLoopSubmission({ channelId: 'jukebox', content: '!devert-ad Title | ipfs://cid | video/mp4' }, {
    jukeboxChannelId: 'jukebox',
    vertLoopChannelId: 'vertloop',
    adIntakeEnabled: true,
  }), true);
});
