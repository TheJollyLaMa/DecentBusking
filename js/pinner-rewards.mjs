export function buildCommunityPinManifest({ checkpointCid = '', tracks = [], albumRoots = [], generatedAt = new Date().toISOString() }) {
  const entries = new Map();
  const add = (cid, kind, title = '') => {
    if (typeof cid !== 'string' || !cid) return;
    const [root, ...pathParts] = cid.replace(/^ipfs:\/\//, '').split('/');
    if (!/^b[a-z2-7]{20,}$/i.test(root) && !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(root)) throw new Error('Invalid CID in community pin manifest');
    const canonical = root;
    const prior = entries.get(canonical) || { cid: canonical, kinds: [], titles: [] };
    if (!prior.kinds.includes(kind)) prior.kinds.push(kind);
    if (title && !prior.titles.includes(title)) prior.titles.push(title);
    if (pathParts.length) prior.paths = [...new Set([...(prior.paths || []), pathParts.join('/')])];
    entries.set(canonical, prior);
  };
  if (checkpointCid) add(checkpointCid, 'playlist-checkpoint');
  for (const track of tracks) add(track.ipfsCid, 'audio', track.title || '');
  for (const album of albumRoots) add(album.cid, 'album', album.title || '');
  return { schemaVersion: 1, chainId: 8453, generatedAt, entryCount: entries.size,
    entries: [...entries.values()].sort((first, second) => first.cid.localeCompare(second.cid)),
    rewardStatus: 'not-active', rewardPolicy: 'Rewards use verified availability-check counts; adding a pin alone is not currently reward-eligible.' };
}

export async function pinCommunityManifest({ manifest, provider, pinataJwt = '', ipfsApiUrl = 'http://127.0.0.1:5001',
  fetchImpl = fetch, onProgress = () => {} }) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > 1000) {
    throw new Error('Invalid community pin manifest');
  }
  if (!['local', 'pinata'].includes(provider)) throw new Error('Choose IPFS Desktop or your own Pinata account');
  if (provider === 'pinata' && !pinataJwt.trim()) throw new Error('Enter your Pinata API key for this session');
  const successes = [];
  const failures = [];
  for (let index = 0; index < manifest.entries.length; index++) {
    const cid = manifest.entries[index].cid;
    if (!/^b[a-z2-7]{20,}$/i.test(cid) && !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
      failures.push({ cid: String(cid), error: 'Invalid CID' });
      onProgress({ completed: index + 1, total: manifest.entries.length, cid });
      continue;
    }
    try {
      if (provider === 'local') {
        const base = new URL(ipfsApiUrl);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Local IPFS must be loopback');
        const query = new URLSearchParams({ arg: cid, recursive: 'true' });
        const response = await fetchImpl(`${ipfsApiUrl.replace(/\/$/, '')}/api/v0/pin/add?${query}`, {
          method: 'POST', signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`IPFS Desktop returned ${response.status}`);
        const verify = await fetchImpl(`${ipfsApiUrl.replace(/\/$/, '')}/api/v0/pin/ls?${new URLSearchParams({ arg: cid, type: 'recursive' })}`, {
          method: 'POST', signal: AbortSignal.timeout(15000),
        });
        if (!verify.ok) throw new Error(`IPFS Desktop pin verification returned ${verify.status}`);
        const pins = (await verify.json()).Keys || {};
        if (!Object.keys(pins).some(value => value.toLowerCase() === cid.toLowerCase() && pins[value].Type === 'recursive')) {
          throw new Error('IPFS Desktop did not confirm a recursive pin');
        }
      } else {
        const response = await fetchImpl('https://api.pinata.cloud/pinning/pinByHash', {
          method: 'POST', headers: { authorization: `Bearer ${pinataJwt}`, 'content-type': 'application/json' },
          body: JSON.stringify({ hashToPin: cid, pinataMetadata: { name: `DecentBusking community pin ${cid}` } }),
          redirect: 'error', signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`Pinata returned ${response.status}`);
      }
      successes.push(cid);
    } catch (error) { failures.push({ cid, error: error.message }); }
    onProgress({ completed: index + 1, total: manifest.entries.length, cid });
  }
  return { provider, successes, failures, rewardStatus: manifest.rewardStatus };
}

export function allocatePinnerRewards({ fundBalanceUnits, pinners, minimumChecks = 20, minimumAvailabilityBps = 9000,
  staleAfterMs = 24 * 60 * 60 * 1000, now = Date.now() }) {
  if (typeof fundBalanceUnits !== 'bigint' || fundBalanceUnits < 0n || !Array.isArray(pinners) ||
    !Number.isSafeInteger(minimumChecks) || minimumChecks < 1 || !Number.isInteger(minimumAvailabilityBps) ||
    minimumAvailabilityBps < 1 || minimumAvailabilityBps > 10000) throw new Error('Invalid pinner reward inputs');
  const eligible = pinners.map(pinner => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(pinner.wallet || '') || !Number.isSafeInteger(pinner.successfulChecks) ||
      !Number.isSafeInteger(pinner.failedChecks) || pinner.successfulChecks < 0 || pinner.failedChecks < 0 ||
      !Number.isFinite(Date.parse(pinner.lastVerifiedAt || ''))) throw new Error('Invalid verified pinner record');
    const total = pinner.successfulChecks + pinner.failedChecks;
    const fresh = now - Date.parse(pinner.lastVerifiedAt) <= staleAfterMs;
    const bps = total ? Math.floor(pinner.successfulChecks * 10000 / total) : 0;
    return { wallet: pinner.wallet.toLowerCase(), score: BigInt(pinner.successfulChecks), totalChecks: total,
      availabilityBps: bps, eligible: fresh && total >= minimumChecks && bps >= minimumAvailabilityBps };
  }).filter(pinner => pinner.eligible && pinner.score > 0n).sort((first, second) => first.wallet.localeCompare(second.wallet));
  const totalScore = eligible.reduce((sum, pinner) => sum + pinner.score, 0n);
  if (totalScore === 0n || fundBalanceUnits === 0n) return { fundBalanceUnits, distributedUnits: 0n, remainingUnits: fundBalanceUnits, eligible: [] };
  let distributed = 0n;
  const rewards = eligible.map((pinner, index) => {
    const amount = index === eligible.length - 1 ? fundBalanceUnits - distributed : fundBalanceUnits * pinner.score / totalScore;
    distributed += amount;
    return { ...pinner, amountUnits: amount };
  });
  return { fundBalanceUnits, distributedUnits: distributed, remainingUnits: fundBalanceUnits - distributed, eligible: rewards };
}
