import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLiveMusicEvidence } from '../live-music.mjs';

const catalog = {
  total: 2,
  lastCheckedAt: '2026-11-27T10:00:00.000Z',
  refreshError: '',
  nfts: [
    { name: 'Newest', artist: 'Artist A', mintedAt: '2026-11-27T09:00:00.000Z',
      releaseAlbums: [{ album: 'New Album' }], metadataUri: 'ipfs://must-not-be-shared' },
    { name: 'Earlier', artist: 'Artist B', mintedAt: '2026-11-26T09:00:00.000Z' },
  ],
};

test('live music evidence uses only bounded, public catalog and radio fields', async () => {
  const calls = [];
  const evidence = await fetchLiveMusicEvidence({
    now: new Date('2026-11-27T10:01:00.000Z'),
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url).includes('/api/nfts?')) return Response.json(catalog);
      return Response.json({
        serverTime: '2026-11-27T10:00:30.000Z',
        activeShow: { label: 'Regular Rotation' },
        nowPlaying: { title: 'Truckin', uploader: 'Artist C', startedAt: Date.parse('2026-11-27T09:59:00Z'),
          ipfsCid: 'must-not-be-shared' },
      });
    },
  });
  assert.deepEqual(calls, [
    'https://decentbusking.onrender.com/api/nfts?offset=0&limit=25',
    'https://decentbusking.onrender.com/api/radio',
  ]);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].kind, 'live-music');
  assert.equal(evidence[0].url, calls[0]);
  assert.equal(evidence[1].url, calls[1]);
  const catalogEvidence = JSON.parse(evidence[0].text);
  const radioEvidence = JSON.parse(evidence[1].text);
  assert.equal(catalogEvidence.catalog.newestTracks[0].title, 'Newest');
  assert.equal(catalogEvidence.catalog.newestTracks[0].albums[0], 'New Album');
  assert.equal(radioEvidence.liveRadio.nowPlaying.title, 'Truckin');
  assert.equal(catalogEvidence.observedAt, '2026-11-27T10:01:00.000Z');
  assert.doesNotMatch(evidence.map(source => source.text).join('\n'), /must-not-be-shared|metadataUri|ipfsCid/);
});

test('rejects invalid or non-newest-first catalog results rather than citing them as latest', async () => {
  await assert.rejects(fetchLiveMusicEvidence({
    fetchImpl: async url => String(url).includes('/api/nfts?')
      ? Response.json({ ...catalog, nfts: [...catalog.nfts].reverse() })
      : Response.json({ nowPlaying: null }),
  }), /newest-first/);
  await assert.rejects(fetchLiveMusicEvidence({
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
  }), /HTTP 503/);
});
