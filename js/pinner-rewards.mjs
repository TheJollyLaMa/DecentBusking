import { currentPayrollPeriod, payrollPeriodFromKey } from './payroll-week.mjs';
import { BASE_USDC_ADDRESS } from './settlement-funds.mjs';

export function buildCommunityPinManifest({ checkpointCid = '', tracks = [], albumRoots = [], generatedAt = new Date().toISOString(),
  rewardStatus = 'not-active' }) {
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
    rewardStatus, rewardPolicy: 'Admin-approved pinners earn shares from independently verified availability checks, not from clicking Pin. Weekly awards require owner-signed Base USDC payroll.' };
}

export const COMMUNITY_CAR_GATEWAY = 'https://gateway.pinata.cloud';

export async function pinCommunityManifest({ manifest, provider, pinataJwt = '', ipfsApiUrl = 'http://127.0.0.1:5001',
  carGatewayUrl = COMMUNITY_CAR_GATEWAY, carTimeoutMs = 30 * 60000, fetchImpl = fetch, onProgress = () => {} }) {
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
        const base = localIpfsBase(ipfsApiUrl);
        const query = new URLSearchParams({ arg: cid, recursive: 'true' });
        try {
          const response = await fetchImpl(`${base}/api/v0/pin/add?${query}`, {
            method: 'POST', signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) throw new Error(`IPFS Desktop returned ${response.status}`);
        } catch (pinError) {
          if (!carGatewayUrl) throw pinError;
          // New uploads are often not advertised to the DHT yet; a CAR import still hash-verifies every block.
          try { await importVerifiedCar({ cid, base, carGatewayUrl, carTimeoutMs, fetchImpl }); }
          catch (carError) { throw new Error(`${pinError.message}; verified gateway copy failed: ${carError.message}`); }
        }
        const verify = await fetchImpl(`${base}/api/v0/pin/ls?${new URLSearchParams({ arg: cid, type: 'recursive' })}`, {
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

async function importVerifiedCar({ cid, base, carGatewayUrl, carTimeoutMs, fetchImpl }) {
  const gateway = new URL(carGatewayUrl);
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password) throw new Error('CAR gateway must use HTTPS');
  const signal = AbortSignal.timeout(carTimeoutMs);
  const car = await fetchImpl(`${gateway.origin}/ipfs/${cid}?format=car&dag-scope=all`, {
    headers: { accept: 'application/vnd.ipld.car' }, redirect: 'error', signal,
  });
  if (!car.ok || !car.body) throw new Error(`gateway returned ${car.status}`);
  if (!(car.headers.get('content-type') || '').startsWith('application/vnd.ipld.car')) throw new Error('gateway did not return a CAR');
  const response = await fetchImpl(`${base}/api/v0/dag/import?pin-roots=true`, {
    method: 'POST', signal, ...await carImportBody(car, cid),
  });
  if (!response.ok) throw new Error(`IPFS Desktop import returned ${response.status}`);
  const roots = (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).Root).filter(Boolean);
  if (roots.length !== 1 || roots[0].Cid?.['/']?.toLowerCase() !== cid.toLowerCase()) throw new Error('gateway CAR root does not match');
  if (roots[0].PinErrorMsg) throw new Error(roots[0].PinErrorMsg);
}

async function carImportBody(car, cid) {
  if (!globalThis.process?.versions?.node) {
    // Browsers cannot stream request bodies to loopback HTTP/1.1; large Blobs are disk-backed.
    const form = new FormData();
    form.append('file', await car.blob(), `${cid}.car`);
    return { body: form };
  }
  // Node streams the CAR so a large album is never held in memory.
  const boundary = `dbusk-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const reader = car.body.getReader();
  let stage = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (stage === 0) {
        stage = 1;
        controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${cid}.car"\r\n` +
          'Content-Type: application/vnd.ipld.car\r\n\r\n'));
        return;
      }
      const { done, value } = await reader.read();
      if (!done) { controller.enqueue(value); return; }
      controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
      controller.close();
    },
    cancel: reason => reader.cancel(reason),
  });
  return { body, duplex: 'half', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function localIpfsBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password) throw new Error('Local IPFS must be loopback');
  return url.toString().replace(/\/$/, '');
}

export async function readLocalPinnerPeer({ ipfsApiUrl = 'http://127.0.0.1:5001', fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${localIpfsBase(ipfsApiUrl)}/api/v0/id`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`IPFS Desktop identity unavailable (${response.status})`);
  const { ID } = await response.json();
  if (typeof ID !== 'string' || ID.length < 40 || ID.length > 128) throw new Error('Invalid IPFS Desktop peer identity');
  return ID;
}

export async function pinPinnerOwnership({ ownership, ipfsApiUrl = 'http://127.0.0.1:5001', fetchImpl = fetch }) {
  if (!ownership || !/^[A-Za-z0-9]{20,128}$/.test(ownership.cid || '') ||
    typeof ownership.contentBase64 !== 'string' || ownership.contentBase64.length > 1024) throw new Error('Invalid pinner ownership marker');
  const bytes = Uint8Array.from(atob(ownership.contentBase64), character => character.charCodeAt(0));
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'dbusk-pinner-ownership');
  const query = new URLSearchParams({ pin: 'true', 'cid-version': '1', 'raw-leaves': 'true', chunker: 'size-262144' });
  const response = await fetchImpl(`${localIpfsBase(ipfsApiUrl)}/api/v0/add?${query}`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Ownership marker pin failed (${response.status})`);
  const value = JSON.parse((await response.text()).trim().split('\n').at(-1));
  if (value.Hash !== ownership.cid) throw new Error('IPFS Desktop returned a different ownership marker CID');
}

export function allocatePinnerRewards({ fundBalanceUnits, pinners, minimumChecks = 20, minimumAvailabilityBps = 9000,
  staleAfterMs = 24 * 60 * 60 * 1000, now = Date.now() }) {
  if (typeof fundBalanceUnits !== 'bigint' || fundBalanceUnits < 0n || !Array.isArray(pinners) ||
    !Number.isSafeInteger(minimumChecks) || minimumChecks < 1 || !Number.isInteger(minimumAvailabilityBps) ||
    minimumAvailabilityBps < 1 || minimumAvailabilityBps > 10000 || !Number.isFinite(now) ||
    !Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new Error('Invalid pinner reward inputs');
  const wallets = new Set();
  const eligible = pinners.map(pinner => {
    if (!pinner || !/^0x[0-9a-fA-F]{40}$/.test(pinner.wallet || '') || !Number.isSafeInteger(pinner.successfulChecks) ||
      !Number.isSafeInteger(pinner.failedChecks) || pinner.successfulChecks < 0 || pinner.failedChecks < 0 ||
      !Number.isFinite(Date.parse(pinner.lastVerifiedAt || ''))) throw new Error('Invalid verified pinner record');
    const total = pinner.successfulChecks + pinner.failedChecks;
    const wallet = pinner.wallet.toLowerCase();
    if (wallets.has(wallet) || !Number.isSafeInteger(total)) throw new Error('Duplicate wallet or invalid check total');
    wallets.add(wallet);
    const age = now - Date.parse(pinner.lastVerifiedAt);
    const fresh = age >= 0 && age <= staleAfterMs;
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

export const PINNER_FUND = 'dbusk-pinners';
export const PINNER_POLICY = Object.freeze({ fundShareBps: 10000, minimumChecks: 20,
  minimumAvailabilityBps: 9000, staleAfterMs: 86400000 });

export function buildPinnerCommandMessage({ action, address, wallet, peerId, revision, nonce, issuedAt, origin }) {
  return `DecentBusking pinner command v1\n${JSON.stringify({ action, address: String(address).toLowerCase(),
    wallet: String(wallet).toLowerCase(), peerId, revision, nonce, issuedAt, origin })}`;
}

export function pinnerWeekStats(checks, wallet, period = currentPayrollPeriod()) {
  const events = checks.filter(check => check.wallet === wallet.toLowerCase() &&
    Date.parse(check.at) >= Date.parse(period.startAt) && Date.parse(check.at) < Date.parse(period.endAt));
  const successful = events.filter(check => check.ok);
  const latest = successful.map(check => check.at).sort().at(-1) || new Date(0).toISOString();
  return { wallet: wallet.toLowerCase(), successfulChecks: successful.length,
    failedChecks: events.length - successful.length, lastVerifiedAt: latest };
}

export function buildPinnerReceipt({ week, budgetUnits, pinners, routerAddress, checksUri, checksHash,
  generatedAt = new Date().toISOString() }) {
  const period = payrollPeriodFromKey(week);
  if (!/^0x[0-9a-fA-F]{40}$/.test(routerAddress || '') || !/^ipfs:\/\/[^/\s]+$/.test(checksUri || '') ||
    !/^0x[0-9a-fA-F]{64}$/.test(checksHash || '') || !Number.isFinite(Date.parse(generatedAt)) ||
    Date.parse(generatedAt) < Date.parse(period.endAt)) throw new Error('Invalid closed-week pinner receipt');
  const result = allocatePinnerRewards({ fundBalanceUnits: budgetUnits, pinners, ...PINNER_POLICY,
    now: Date.parse(period.endAt) });
  return { schema: 'pinner-rewards/v1', chainId: 8453, fundSlug: PINNER_FUND, routerAddress: routerAddress.toLowerCase(),
    assetAddress: BASE_USDC_ADDRESS.toLowerCase(), ...period, generatedAt, policy: { ...PINNER_POLICY },
    checksUri, checksHash, pinners: [...pinners].sort((a, b) => a.wallet.localeCompare(b.wallet)),
    budgetUnits: budgetUnits.toString(), allocatedUnits: result.distributedUnits.toString(),
    remainderUnits: result.remainingUnits.toString(), entries: result.eligible.filter(entry => entry.amountUnits > 0n)
      .map(entry => ({ wallet: entry.wallet, amountUnits: entry.amountUnits.toString(),
        workReferenceText: `${PINNER_FUND}:${week}:${entry.wallet}` })) };
}

export function validatePinnerReceipt(receipt, routerAddress) {
  if (receipt?.schema !== 'pinner-rewards/v1' || receipt.chainId !== 8453 || receipt.fundSlug !== PINNER_FUND ||
    receipt.routerAddress !== routerAddress?.toLowerCase() || receipt.assetAddress !== BASE_USDC_ADDRESS.toLowerCase() ||
    typeof receipt.budgetUnits !== 'string' || !/^\d+$/.test(receipt.budgetUnits) ||
    JSON.stringify(receipt.policy) !== JSON.stringify(PINNER_POLICY)) {
    throw new Error('Invalid pinner allocation policy or deployment');
  }
  const expected = buildPinnerReceipt({ ...receipt, budgetUnits: BigInt(receipt.budgetUnits) });
  for (const key of ['startAt', 'endAt', 'timeZone', 'allocatedUnits', 'remainderUnits', 'entries', 'pinners']) {
    if (JSON.stringify(receipt[key]) !== JSON.stringify(expected[key])) throw new Error(`Invalid pinner receipt ${key}`);
  }
  return receipt;
}

export function validatePinnerCheckpoint(snapshot) {
  if (snapshot?.schema !== 'pinner-network/v1' || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
    !Number.isFinite(Date.parse(snapshot.startedAt || '')) || !Number.isFinite(Date.parse(snapshot.nextWeekStartAt || '')) ||
    !/^0x[0-9a-fA-F]{40}$/.test(snapshot.routerAddress || '') ||
    !Array.isArray(snapshot.pinners) || !Array.isArray(snapshot.checks) ||
    !Array.isArray(snapshot.receipts) || !Array.isArray(snapshot.nonces)) throw new Error('Invalid pinner checkpoint');
  const wallets = new Set(), peers = new Set(), members = new Set(), weeks = new Set();
  const firstPeriod = currentPayrollPeriod(Date.parse(snapshot.startedAt));
  if (currentPayrollPeriod(Date.parse(snapshot.nextWeekStartAt)).startAt !== snapshot.nextWeekStartAt ||
    Date.parse(snapshot.nextWeekStartAt) < Date.parse(firstPeriod.startAt)) throw new Error('Invalid pinner checkpoint week cursor');
  for (const pinner of snapshot.pinners) {
    if (!pinner || !/^0x[0-9a-f]{40}$/.test(pinner.wallet || '') || wallets.has(pinner.wallet) ||
      typeof pinner.peerId !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{40,80}$/.test(pinner.peerId) ||
      !/^0x[0-9a-f]{64}$/.test(pinner.memberHash || '') || !/^[A-Za-z0-9]{20,128}$/.test(pinner.ownershipCid || '') ||
      !Number.isFinite(Date.parse(pinner.nextCheckAt || '')) || !Array.isArray(pinner.statusEvents) || !pinner.statusEvents.length ||
      pinner.statusEvents.some(event => !event || !['pending', 'active', 'suspended'].includes(event.status) ||
        !Number.isFinite(Date.parse(event.at || '')))) throw new Error('Invalid registered pinner');
    if (pinner.statusEvents.some((event, index) => index > 0 &&
      Date.parse(event.at) < Date.parse(pinner.statusEvents[index - 1].at))) throw new Error('Pinner status history is out of order');
    if (pinner.statusEvents.at(-1).status !== 'suspended') {
      if (members.has(pinner.memberHash)) throw new Error('Duplicate registered Discord pinner identity');
      if (peers.has(pinner.peerId)) throw new Error('This IPFS peer is already registered to another wallet');
      members.add(pinner.memberHash); peers.add(pinner.peerId);
    }
    wallets.add(pinner.wallet);
  }
  for (const check of snapshot.checks) {
    if (!check || !wallets.has(check.wallet) || !Number.isFinite(Date.parse(check.at || '')) || typeof check.ok !== 'boolean' ||
      !/^[A-Za-z0-9]{20,128}$/.test(check.rootCid || '') || (check.blockCid && !/^[A-Za-z0-9]{20,128}$/.test(check.blockCid)) ||
      !Number.isSafeInteger(check.latencyMs) || check.latencyMs < 0) throw new Error('Invalid pinner availability evidence');
  }
  let cursor = firstPeriod.startAt;
  for (const record of snapshot.receipts) {
    validatePinnerReceipt(record?.allocation, snapshot.routerAddress);
    if (weeks.has(record.allocation.week) || !/^ipfs:\/\/[^/\s]+$/.test(record.metadataUri || '') ||
      !/^0x[0-9a-fA-F]{64}$/.test(record.metadataHash || '')) throw new Error('Invalid or duplicate pinner receipt');
    weeks.add(record.allocation.week);
    if (record.allocation.startAt !== cursor) throw new Error('Pinner receipt history has a gap or overlap');
    cursor = record.allocation.endAt;
  }
  if (cursor !== snapshot.nextWeekStartAt) throw new Error('Pinner receipt history does not match the week cursor');
  for (const nonce of snapshot.nonces) {
    if (!nonce || !/^0x[0-9a-fA-F]{64}$/.test(nonce.hash || '') || !Number.isFinite(nonce.expiresAt)) throw new Error('Invalid pinner authorization history');
  }
  return snapshot;
}

export function validatePinnerChecks(value) {
  if (value?.schema !== 'pinner-checks/v1' || !Array.isArray(value.checks)) throw new Error('Invalid pinner challenge journal');
  const period = payrollPeriodFromKey(value.week);
  if (value.startAt !== period.startAt || value.endAt !== period.endAt || value.timeZone !== period.timeZone ||
    value.checks.some(check => !check || !/^0x[0-9a-f]{40}$/.test(check.wallet || '') ||
      typeof check.ok !== 'boolean' || !Number.isFinite(Date.parse(check.at || '')) ||
      Date.parse(check.at) < Date.parse(period.startAt) || Date.parse(check.at) >= Date.parse(period.endAt) ||
      !/^[A-Za-z0-9]{20,128}$/.test(check.rootCid || '') ||
      !Number.isSafeInteger(check.latencyMs) || check.latencyMs < 0)) throw new Error('Invalid pinner challenge evidence');
  return value;
}
