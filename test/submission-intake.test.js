const test = require('node:test');
const assert = require('node:assert/strict');

test('submission prompts default to song or advert and reject other users', async () => {
  const { createSubmissionIntake, buildSubmissionButtons } = await import('../discord-bot/submission-intake.js');
  const defaults = buildSubmissionButtons('key', 'advert')[0].components;
  assert.equal(defaults[0].label, 'Song');
  assert.equal(defaults[0].style, 2);
  assert.equal(defaults[1].style, 1);

  const timers = [];
  const replies = [];
  const selections = [];
  const intake = createSubmissionIntake({
    siteUrl: 'https://example.com',
    setTimer: callback => { timers.push(callback); return { unref() {} }; },
    clearTimer: () => {},
    isAdmin: interaction => interaction.user.id === 'admin',
    onChoose: async payload => { selections.push(payload.choice); return { handled: true }; },
  });
  const message = {
    id: 'msg',
    channelId: 'jukebox',
    author: { id: 'uploader' },
    attachments: new Map([['a', { id: 'att', name: 'clip.mp4', size: 10, contentType: 'video/mp4' }]]),
    reply: async payload => { replies.push(payload); return payload; },
  };
  await intake.prompt(message, message.attachments.values().next().value, 'song');
  assert.match(replies[0].content, /clip\.mp4/);
  assert.equal(replies[0].components[0].components[0].label, 'Song');

  const other = { isButton: () => true, customId: 'submission:choice:msg__att:song', user: { id: 'someone' },
    reply: async payload => { replies.push(payload); } };
  assert.equal(await intake.handleInteraction(other), true);
  assert.match(replies.at(-1).content, /Only the uploader can choose/);
  assert.equal(selections.length, 0);
  timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(selections[0], 'song');
});

test('oversized uploads get a short DVert link instead of a prompt', async () => {
  const { createSubmissionIntake } = await import('../discord-bot/submission-intake.js');
  const replies = [];
  const intake = createSubmissionIntake({ siteUrl: 'https://example.com', onChoose: async () => ({ handled: true }) });
  const message = {
    id: 'msg',
    channelId: 'jukebox',
    author: { id: 'uploader' },
    attachments: new Map([['a', { id: 'att', name: 'clip.mp4', size: 10 * 1024 * 1024 + 1, contentType: 'video/mp4' }]]),
    reply: async payload => { replies.push(payload); return payload; },
  };
  await intake.prompt(message, message.attachments.values().next().value, 'advert');
  assert.match(replies[0].content, /too big for Discord/);
  assert.equal(replies[0].components[0].components[0].label, 'Open DVert panel');
});
