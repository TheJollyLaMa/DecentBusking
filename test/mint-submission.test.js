const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const cid = 'bafybeifynaihnl2t37s3nfez3k5vbwwziaqyvayadqwt4bou3yv6jstxye';
const address = '0x1111111111111111111111111111111111111111';

async function formPage({ useCid = false, file } = {}) {
  const helpers = await import('../js/submission-media.mjs');
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', files: [], dataset: {}, classList: { toggle() {}, add() {}, remove() {} } });
    return nodes.get(id);
  };
  node('mint-source-cid').checked = useCid;
  node('mint-title').value = 'Performance';
  node('mint-artist').value = 'Artist';
  node('mint-media-type').value = 'video/mp4';
  node('mint-cid-input').value = cid;
  node('mint-file').files = file ? [file] : [];
  const uploaded = [];
  const submissions = [];
  const context = vm.createContext({ File, URLSearchParams, Uint8Array, AbortSignal, ...helpers,
    fetch: async () => new Response(JSON.stringify({ mediaType: 'video/mp4' })),
    window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example' },
      _wallet: { address, signer: {} }, location: { origin: 'https://site.example' } },
    document: { getElementById: node, addEventListener() {}, querySelectorAll: () => [] },
    createBrowserIpfsUploader: options => {
      assert.equal(options.purpose, 'submission');
      return async media => { uploaded.push(media); return `ipfs://${cid}`; };
    },
    submitMediaForApproval: async options => { submissions.push(options); return { status: 'requested' }; },
  });
  const source = fs.readFileSync(path.join(__dirname, '../js/mint.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(`${source}\nglobalThis.submit = handleSubmission; globalThis.sourceMode = setSource;`, context);
  return { node, uploaded, submissions, context, submit: () => context.submit({ preventDefault() {} }), setSource: context.sourceMode };
}

test('briefcase submits an MP4 file for owner approval with artist, artwork, tip, and remix fields', async () => {
  const page = await formPage({ file: new File([new Uint8Array([0, 0, 0, 24]), 'ftypisom', 'video bytes'], 'Performance.MP4', { type: 'application/octet-stream' }) });
  page.node('mint-parent').value = '12';
  page.node('mint-image').files = [new File(['image'], 'cover.png', { type: 'image/png' })];
  await page.submit();
  assert.equal(page.uploaded[0].type, 'video/mp4');
  assert.equal(page.uploaded[1].type, 'image/png');
  const media = page.submissions[0].media;
  assert.equal(media.ipfsCid, cid);
  assert.equal(media.artworkCid, cid);
  assert.equal(media.recipient, address);
  assert.equal(media.tipWallet, address);
  assert.equal(media.parentTokenId, 12);
  assert.equal(media.mediaType, 'video/mp4');
  assert.match(page.node('mint-status').textContent, /Queued for owner approval/);
  assert.equal(page.node('mint-submit-btn').disabled, false);
});

test('briefcase CID mode does not require or upload a Discord-sized attachment', async () => {
  const page = await formPage({ useCid: true });
  page.setSource();
  assert.equal(page.node('mint-file').disabled, true);
  assert.equal(page.node('mint-file').required, false);
  assert.equal(page.node('mint-cid-input').required, true);
  await page.submit();
  assert.equal(page.uploaded.length, 0);
  assert.equal(page.submissions[0].media.filename, 'track.mp4');
  assert.equal(page.submissions[0].media.mediaType, 'video/mp4');
});

test('briefcase carries an artwork CID, DVert classification and edited creator percentages into the signed submission', async () => {
  const page = await formPage({ useCid: true });
  page.node('mint-art-source-cid').checked = true;
  page.node('mint-artwork-cid').value = `ipfs://${cid}`;
  page.node('mint-devert').checked = true;
  const collaborator = `0x${'2'.repeat(40)}`;
  vm.runInContext(`splits = [{ wallet: '${address}', shareBps: 6000 }, { wallet: '${collaborator}', shareBps: 4000 }];`, page.context);
  await page.submit();
  assert.equal(page.uploaded.length, 0);
  assert.equal(page.submissions[0].media.artworkCid, cid);
  assert.equal(page.submissions[0].media.isDevertAd, true);
  assert.deepEqual(JSON.parse(JSON.stringify(page.submissions[0].media.creatorSplits)), [
    { wallet: address, shareBps: 6000 }, { wallet: collaborator, shareBps: 4000 },
  ]);
  assert.match(page.node('mint-status').textContent, /book airtime separately/);
});

test('briefcase does not upload invalid media or shares and surfaces CID detection failures', async () => {
  const fake = await formPage({ file: new File(['not a movie'], 'fake.mp4') });
  await fake.submit();
  assert.match(fake.node('mint-status').textContent, /Could not detect/);
  assert.equal(fake.uploaded.length, 0);
  const shares = await formPage({ useCid: true });
  vm.runInContext(`splits = [{wallet: '${address}', shareBps: 9000}];`, shares.context);
  await shares.submit();
  assert.match(shares.node('mint-status').textContent, /exactly 100%/);
  assert.equal(shares.submissions.length, 0);
  const unavailable = await formPage({ useCid: true });
  unavailable.context.fetch = async () => new Response(JSON.stringify({ error: 'IPFS gateway unavailable' }), { status: 502 });
  await unavailable.submit();
  assert.match(unavailable.node('mint-status').textContent, /IPFS gateway unavailable/);
  assert.equal(unavailable.submissions.length, 0);
  assert.equal(unavailable.node('mint-submit-btn').disabled, false);
});

test('upload information opens a policy dialog without submitting or claiming AI/removal protection', () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); },
      showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  let ready;
  const context = vm.createContext({ URLSearchParams, window: { location: { search: '' } },
    document: { getElementById: node, querySelectorAll: () => [], addEventListener: (_name, listener) => { ready = listener; } } });
  const source = fs.readFileSync(path.join(__dirname, '../js/submission-policy.js'), 'utf8');
  vm.runInContext(source, context);
  ready();
  const dialog = node('submission-policy-dialog');
  node('submission-policy-open').listeners.get('click')();
  assert.equal(dialog.open, true);
  node('submission-policy-close').listeners.get('click')();
  assert.equal(dialog.open, false);
  node('submission-policy-open').listeners.get('click')();
  dialog.listeners.get('click')({ target: dialog });
  assert.equal(dialog.open, false);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /does not, by itself, transfer copyright/);
  assert.match(html, /grants no permission for AI training/);
  assert.match(html, /cannot guarantee removal of other copies/);
  assert.match(html, /not a signed licence or consent record/);
  assert.match(html, /does not yet have a separate radio-consent or opt-out control/);
});

test('briefcase rejects oversized media and directory CIDs before requesting uploads', async () => {
  const oversized = await formPage({ file: { name: 'large.mp4', size: 51 * 1024 * 1024 } });
  await oversized.submit();
  assert.match(oversized.node('mint-status').textContent, /50 MB/);
  assert.equal(oversized.uploaded.length, 0);
  assert.equal(oversized.submissions.length, 0);
  const directory = await formPage({ useCid: true });
  directory.node('mint-cid-input').value = `${cid}/movie.mp4`;
  await directory.submit();
  assert.match(directory.node('mint-status').textContent, /file CID/);
  assert.equal(directory.submissions.length, 0);
});

test('submission retries transient network failures with fresh signatures', async () => {
  const { submitMediaForApproval } = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'mint-submission.js')).href);
  const signed = [];
  let attempts = 0;
  const result = await submitMediaForApproval({
    serviceUrl: 'https://worker.example',
    signer: { signMessage: async message => { signed.push(message); return `0xsigned-${signed.length}`; } },
    address,
    origin: 'https://site.example',
    media: { title: 'Song', artist: 'Artist', recipient: address, tipWallet: address, parentTokenId: 0, filename: 'song.mp3', mediaType: 'audio/mpeg', ipfsCid: cid, artworkCid: '' },
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ status: 'requested', trackId: 'track-1' }), { status: 200 });
    },
  });
  assert.deepEqual(result, { status: 'requested', trackId: 'track-1' });
  assert.equal(attempts, 2);
  assert.equal(signed.length, 2);
});