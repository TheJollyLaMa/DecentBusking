const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { ethers } = createRequire(`${__dirname}/../discord-bot/package.json`)('ethers');

test('song editing resolves missing NFT registration fields by exact recording and configured DJuke deployment', async () => {
  const { resolveNftSongId } = await import('../js/creator-splits.mjs');
  const songId = ethers.id('registered-song');
  const config = { djukeContractAddress: `0x${'1'.repeat(40)}`, ipfsUploadServiceUrl: 'https://worker.test', chainId: 8453 };
  const snapshot = { chainId: 8453, contractAddress: config.djukeContractAddress,
    tracks: [{ ipfsCid: 'exactRecording', songId }] };
  const nft = { audioUrl: 'https://gateway.test/ipfs/exactRecording?download=1' };
  let calls = 0;
  const options = { config, fetchImpl: async url => {
    calls++;
    assert.equal(url, 'https://worker.test/api/djuke');
    return { ok: true, json: async () => snapshot };
  } };
  assert.equal(await resolveNftSongId(nft, options), songId);
  assert.equal(await resolveNftSongId({ djukeSongId: songId }, options), songId);
  assert.equal(calls, 1);
  await assert.rejects(resolveNftSongId({ audioUrl: 'ipfs://otherRecording' }, options), /not registered/);
  snapshot.catalogReadErrors = 1;
  await assert.rejects(resolveNftSongId({ audioUrl: 'ipfs://otherRecording' }, options), /could not verify/);
  snapshot.catalogReadErrors = 0;
  snapshot.tracks.push({ ipfsCid: 'exactRecording', songId: ethers.id('duplicate') });
  await assert.rejects(resolveNftSongId(nft, options), /multiple DJuke registrations/);
  snapshot.contractAddress = `0x${'2'.repeat(40)}`;
  await assert.rejects(resolveNftSongId(nft, options), /does not match/);
  options.fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(resolveNftSongId(nft, options), /unavailable \(503\)/);
});
test('split rows validate distinct recipients and exact 100% shares', async () => {
  const { validateCreatorSplitRows, parseCreatorSplitLines, resolveCreatorSplitLines } =
    await import('../js/creator-splits.mjs');
  const first = `0x${'1'.repeat(40)}`;
  const second = `0x${'2'.repeat(40)}`;
  assert.deepEqual(validateCreatorSplitRows([
    { wallet: first, shareBps: 7000, position: 'Performer' },
    { wallet: second, shareBps: 3000, position: 'Producer' },
  ]), [
    { wallet: first, shareBps: 7000, position: 'Performer' },
    { wallet: second, shareBps: 3000, position: 'Producer' },
  ]);
  assert.deepEqual(parseCreatorSplitLines(`${first}, 70, Performer\nproducer.eth, 30.25, Producer`), [
    { input: first, shareBps: 7000, position: 'Performer' },
    { input: 'producer.eth', shareBps: 3025, position: 'Producer' },
  ]);
  assert.deepEqual(await resolveCreatorSplitLines(`${first}, 70, Performer\nproducer.eth, 30, Producer`,
    async name => name === 'producer.eth' ? second : null), [
    { wallet: first, shareBps: 7000, position: 'Performer' },
    { wallet: second, shareBps: 3000, position: 'Producer' },
  ]);
  assert.throws(() => validateCreatorSplitRows([
    { wallet: first, shareBps: 7000 }, { wallet: first, shareBps: 3000 },
  ]), /distinct/);
  assert.throws(() => validateCreatorSplitRows([{ wallet: first, shareBps: 9999 }]), /exactly 100%/);
});

test('proposal creation verifies worker availability before requesting a signature', async () => {
  const { createCreatorSplitProposal } = await import('../js/creator-split-proposal.mjs');
  const address = `0x${'1'.repeat(40)}`;
  let signatures = 0;
  const signer = { signTypedData: async () => { signatures++; return '0xsignature'; } };
  const proposal = { domain: { chainId: 8453, verifyingContract: address }, types: {}, value: {} };
  const options = { serviceUrl: 'https://worker.test', address, signer, proposal };
  await assert.rejects(createCreatorSplitProposal({ ...options,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) }),
  }), /Not found/);
  assert.equal(signatures, 0);
  await assert.rejects(createCreatorSplitProposal({ ...options,
    fetchImpl: async () => ({ ok: true, json: async () => ({
      available: true, chainId: 8453, contractAddress: `0x${'2'.repeat(40)}`,
    }) }),
  }), /no signature was requested/);
  assert.equal(signatures, 0);
  const urls = [];
  const response = await createCreatorSplitProposal({ ...options, fetchImpl: async (url, init) => {
    urls.push(url);
    if (url.endsWith('/split-status')) return { ok: true, json: async () => ({
      available: true, chainId: 8453, contractAddress: address,
    }) };
    assert.equal(JSON.parse(init.body).signature, '0xsignature');
    return { ok: true, json: async () => ({ request: { requestId: 'saved' } }) };
  } });
  assert.equal(signatures, 1);
  assert.deepEqual(urls, ['https://worker.test/api/creator/split-status', 'https://worker.test/api/creator/split-proposals']);
  assert.equal(response.request.requestId, 'saved');
});
test('song album migration payload matches the contract EIP-712 domain', async () => {
  const { buildSongAlbumMigrationTypedData } = await import('../js/creator-splits.mjs');
  const address = `0x${'1'.repeat(40)}`;
  const albumId = ethers.id('album');
  const songId = ethers.id('song');
  const recipients = [`0x${'2'.repeat(40)}`, `0x${'3'.repeat(40)}`];
  const shares = [7000, 3000];
  const positions = ['Performer', 'Producer'];
  const result = buildSongAlbumMigrationTypedData({
    ethers,
    contractAddress: address,
    albumId,
    songId,
    albumRevision: 4n,
    audioURI: 'ipfs://audio',
    currentRecipients: recipients,
    currentSharesBps: [6000, 4000],
    albumRecipients: recipients,
    albumSharesBps: shares,
    albumPositions: positions,
    useAlbumDefault: false,
  });
  assert.equal(result.domain.version, '0.2');
  assert.equal(result.domain.verifyingContract, address);
  assert.equal(result.value.albumRevision, 4n);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const expected = {
    albumId,
    songId,
    albumRevision: 4n,
    audioURIHash: ethers.keccak256(ethers.toUtf8Bytes('ipfs://audio')),
    currentRecipientsHash: ethers.keccak256(coder.encode(['address[]'], [recipients])),
    currentSharesHash: ethers.keccak256(coder.encode(['uint16[]'], [[6000, 4000]])),
    albumRecipientsHash: ethers.keccak256(coder.encode(['address[]'], [recipients])),
    albumSharesHash: ethers.keccak256(coder.encode(['uint16[]'], [shares])),
    albumPositionsHash: ethers.keccak256(coder.encode(['string[]'], [positions])),
    useAlbumDefault: false,
  };
  assert.deepEqual(result.value, expected);
  assert.equal(ethers.TypedDataEncoder.hash(result.domain, result.types, result.value),
    ethers.TypedDataEncoder.hash(result.domain, result.types, expected));
});
