const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const embedUrl = pathToFileURL(path.join(__dirname, '../discord-bot/embed.js')).href;
const interactionsUrl = pathToFileURL(path.join(__dirname, '../discord-bot/mint-interactions.js')).href;

test('Discord CID submission queues profile artwork rather than an empty artwork default', () => {
  const source = fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
  const submission = source.slice(source.indexOf("if (sub === 'submit')"), source.indexOf("if (sub === 'request-mint')"));
  assert.match(submission, /existing\?\.artworkCid \|\| await pinDiscordAvatar\(interaction.user, config\)/);
  assert.match(submission, /requestTrackMint\(getTrackId\(track\), interaction.user.id, recipient, artworkCid\)/);
  assert.match(submission, /if \(!artworkCid\) throw/);
});

test('pending Discord requests missing artwork recover their profile image without replacing custom artwork', async () => {
  const { ensureDefaultMintArtwork } = await import(interactionsUrl);
  const wallet = `0x${'1'.repeat(40)}`;
  const requests = [{ trackId: 'missing', uploaderId: '735090955560157185', mintRecipient: wallet },
    { trackId: 'custom', uploaderId: '735090955560157185', artworkCid: 'custom-image' }, { trackId: 'site', uploaderId: 'wallet:artist' }];
  let pins = 0; let saved = 0;
  const result = await ensureDefaultMintArtwork({ requests, getUser: async id => ({ id }),
    getDefaultArtwork: async () => { pins++; return 'profile-image'; },
    requestTrackMint: (trackId, uploaderId, recipient, artworkCid) => ({ trackId, uploaderId, mintRecipient: recipient, artworkCid }),
    waitForPersistence: async () => { saved++; } });
  assert.equal(result[0].artworkCid, 'profile-image');
  assert.equal(result[1].artworkCid, 'custom-image');
  assert.equal(pins, 1); assert.equal(saved, 1);
});

test('upload prompt carries the track identity in a bounded NFT request button', async () => {
  const { buildMintEmbed, buildMintRequestComponents, mintRequestKey } = await import(embedUrl);
  const trackId = `legacy:${'long-file-name'.repeat(20)}.mp4`;
  const button = buildMintRequestComponents(trackId)[0].toJSON().components[0];
  assert.equal(button.label, 'Request NFT');
  assert.equal(button.custom_id, `mint-request:${mintRequestKey(trackId)}`);
  assert.ok(button.custom_id.length <= 100);
  assert.notEqual(mintRequestKey(trackId), mintRequestKey(`${trackId}-other`));
  const embed = buildMintEmbed({ title: 'Video', ipfsCid: 'bafy-video', trackId, uploaderTag: 'Artist' }).toJSON();
  assert.match(embed.description, /Request NFT/);
  assert.match(embed.description, /no NFT is minted yet/);
  assert.match(embed.description, /optional image.*Discord profile image/);
  assert.match(embed.description, /artwork IPFS CID for larger images/);
});

test('NFT request modal carries track identity, prefills a single known wallet, and prompts for optional artwork', async () => {
  const { createMintRequestInteractionHandler, previousArtistWallet } = await import(interactionsUrl);
  const { mintRequestKey } = await import(embedUrl);
  const wallet = `0x${'1'.repeat(40)}`;
  const track = { trackId: 'video', title: 'Video', uploaderId: 'artist', ipfsCid: 'bafy-video', pinStatus: 'pinned', mintStatus: 'unminted' };
  const tracks = [track, { trackId: 'old', uploaderId: 'artist', mintRecipient: wallet }];
  let shown;
  const handler = createMintRequestInteractionHandler({ getPlaylist: () => tracks });
  await handler({ isButton: () => true, customId: `mint-request:${mintRequestKey(track.trackId)}`, user: { id: 'artist' },
    showModal: async modal => { shown = modal.toJSON(); } });
  assert.equal(shown.custom_id, `mint-wallet:${mintRequestKey(track.trackId)}`);
  assert.ok(shown.custom_id.length <= 100);
  assert.equal(shown.components[0].component.value, wallet);
  assert.match(shown.components[1].description, /Discord profile image/);
  assert.equal(shown.components[1].component.required, false);
  assert.match(shown.components[1].description, /over 10 MB/);
  assert.equal(shown.components[2].component.custom_id, 'artwork-cid');
  assert.equal(shown.components[2].component.required, false);
  assert.equal(previousArtistWallet([...tracks, { uploaderId: 'artist', mintRecipient: `0x${'2'.repeat(40)}` }], 'artist'), '');
});

test('private wallet submissions use uploaded artwork or the profile image and only queue owner approval', async () => {
  const { createMintRequestInteractionHandler } = await import(interactionsUrl);
  const { mintRequestKey } = await import(embedUrl);
  const wallet = `0x${'1'.repeat(40)}`;
  for (const customArtwork of [false, true]) {
    const track = { trackId: 'video', title: 'Video', uploaderId: 'artist', ipfsCid: 'bafy-video', pinStatus: 'pinned', mintStatus: 'unminted' };
    const artwork = { name: 'cover.jpg', contentType: 'image/jpeg', size: 10 * 1024 * 1024 };
    let queued;
    let persisted = false;
    let deferred;
    let reply;
    const handler = createMintRequestInteractionHandler({ getPlaylist: () => [track],
      getDefaultArtwork: async () => { assert.equal(customArtwork, false); return 'bafy-avatar'; },
      uploadArtwork: async file => { assert.equal(file, artwork); return 'bafy-cover'; },
      requestTrackMint: (...args) => { queued = args; return { ...track, artworkCid: args[3], mintStatus: 'requested' }; },
      waitForPersistence: async () => { persisted = true; } });
    await handler({ isModalSubmit: () => true, customId: `mint-wallet:${mintRequestKey(track.trackId)}`, user: { id: 'artist' },
      fields: { getTextInputValue: id => id === 'artist-wallet' ? wallet : '', getUploadedFiles: () => customArtwork ? { first: () => artwork } : null },
      deferReply: async options => { deferred = options; }, editReply: async options => { assert.equal(persisted, true); reply = options; } });
    assert.deepEqual(queued, ['video', 'artist', wallet, customArtwork ? 'bafy-cover' : 'bafy-avatar']);
    assert.equal(deferred.flags, 64);
    assert.match(reply.content, /No NFT has been minted yet/);
    assert.match(reply.content, customArtwork ? /uploaded image/ : /Discord profile image/);
  }
});

test('mint prompts reject other uploaders, invalid wallets, oversized artwork, and minted tracks', async () => {
  const { createMintRequestInteractionHandler } = await import(interactionsUrl);
  const { mintRequestKey } = await import(embedUrl);
  const track = { trackId: 'video', uploaderId: 'artist', ipfsCid: 'bafy-video', pinStatus: 'pinned', mintStatus: 'unminted' };
  let rejected = 0;
  const handler = createMintRequestInteractionHandler({ getPlaylist: () => [track], requestTrackMint: () => { throw new Error('Must not queue'); } });
  const reply = async options => { assert.equal(options.flags, 64); rejected++; };
  await handler({ isButton: () => true, customId: `mint-request:${mintRequestKey(track.trackId)}`, user: { id: 'other' }, reply });
  await handler({ isModalSubmit: () => true, customId: `mint-wallet:${mintRequestKey(track.trackId)}`, user: { id: 'other' }, reply });
  const fields = { getTextInputValue: id => id === 'artist-wallet' ? 'not-a-wallet' : '', getUploadedFiles: () => null };
  await handler({ isModalSubmit: () => true, customId: `mint-wallet:${mintRequestKey(track.trackId)}`, user: { id: 'artist' }, fields, reply });
  fields.getTextInputValue = id => id === 'artist-wallet' ? `0x${'1'.repeat(40)}` : '';
  fields.getUploadedFiles = () => ({ first: () => ({ name: 'cover.png', contentType: 'image/png', size: 10 * 1024 * 1024 + 1 }) });
  await handler({ isModalSubmit: () => true, customId: `mint-wallet:${mintRequestKey(track.trackId)}`, user: { id: 'artist' }, fields, reply });
  track.mintStatus = 'minted';
  await handler({ isButton: () => true, customId: `mint-request:${mintRequestKey(track.trackId)}`, user: { id: 'artist' }, reply });
  assert.equal(rejected, 5);
  assert.equal(await handler({ isButton: () => true, customId: 'unrelated', user: { id: 'artist' } }), false);
});

test('artwork CID submissions reuse IPFS images without a file upload or profile-image pin', async () => {
  const { createMintRequestInteractionHandler } = await import(interactionsUrl);
  const { mintRequestKey } = await import(embedUrl);
  const cid = 'bafybeieupiamdn7e4qmi4hou6zfu4cwluoubn6ppgsqs4rfjydyee7wtnm';
  const wallet = `0x${'1'.repeat(40)}`;
  for (const value of [cid, `ipfs://${cid}`]) {
    const track = { trackId: 'video', title: 'Video', uploaderId: 'artist', ipfsCid: 'bafy-video', pinStatus: 'pinned', mintStatus: 'unminted' };
    let queued;
    let reply;
    const handler = createMintRequestInteractionHandler({ getPlaylist: () => [track],
      getDefaultArtwork: async () => { throw new Error('Must not pin profile image'); },
      uploadArtwork: async () => { throw new Error('Must not upload'); },
      requestTrackMint: (...args) => { queued = args; return { ...track, artworkCid: args[3] }; },
      waitForPersistence: async () => {} });
    await handler({ isModalSubmit: () => true, customId: `mint-wallet:${mintRequestKey(track.trackId)}`, user: { id: 'artist' },
      fields: { getTextInputValue: id => id === 'artist-wallet' ? wallet : value, getUploadedFiles: () => null },
      deferReply: async () => {}, editReply: async options => { reply = options; } });
    assert.deepEqual(queued, ['video', 'artist', wallet, cid]);
    assert.match(reply.content, /your IPFS image/);
  }
});

test('invalid artwork CIDs and conflicting artwork sources are rejected without queue changes', async () => {
  const { createMintRequestInteractionHandler } = await import(interactionsUrl);
  const { mintRequestKey } = await import(embedUrl);
  const cid = 'bafybeieupiamdn7e4qmi4hou6zfu4cwluoubn6ppgsqs4rfjydyee7wtnm';
  const track = { trackId: 'video', title: 'Video', uploaderId: 'artist', ipfsCid: 'bafy-video', pinStatus: 'pinned', mintStatus: 'unminted' };
  const handler = createMintRequestInteractionHandler({ getPlaylist: () => [track],
    requestTrackMint: () => { throw new Error('Must not queue'); } });
  for (const [value, attachment] of [['not-a-cid', null], [`${cid}/image.jpg`, null],
    [`https://gateway.example/ipfs/${cid}`, null], [cid, { name: 'cover.jpg', size: 10, contentType: 'image/jpeg' }]]) {
    let rejected;
    await handler({ isModalSubmit: () => true, customId: `mint-wallet:${mintRequestKey(track.trackId)}`, user: { id: 'artist' },
      fields: { getTextInputValue: id => id === 'artist-wallet' ? `0x${'1'.repeat(40)}` : value,
        getUploadedFiles: () => attachment ? { first: () => attachment } : null },
      reply: async options => { rejected = options; } });
    assert.equal(rejected.flags, 64);
    assert.match(rejected.content, attachment ? /Choose one artwork source/ : /valid artwork file CID/);
  }
});