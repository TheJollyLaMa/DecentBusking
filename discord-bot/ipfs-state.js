const STATE_FILE_NAME = 'decentbusking-jukeloop-state.json';
const STATE_KEYVALUES = {
  app: 'decentbusking',
  kind: 'jukeloop-state',
  schema: '1',
};
const SNAPSHOTS_TO_KEEP = 3;
const MAX_RESTORE_CANDIDATES = 3;
const RESTORE_REQUEST_TIMEOUT_MS = 15_000;
// Bounded so a large backlog is pruned across several saves without tripping Pinata rate limits.
const MAX_PRUNE_PER_SAVE = 10;
const FALLBACK_GATEWAY = 'https://gateway.pinata.cloud';

// Pinata v3 only filters by network in the path; `?network=public` silently returns no files.
function buildListUrl(filesApiUrl, limit = 100, name = STATE_FILE_NAME) {
  const url = new URL(`${filesApiUrl.replace(/\/(public|private)?\/?$/, '')}/public`);
  url.searchParams.set('name', name);
  url.searchParams.set('order', 'DESC');
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

function extractFiles(result) {
  return result.data?.files || result.files || [];
}

function isStateSnapshot(file, name = STATE_FILE_NAME, tags = STATE_KEYVALUES) {
  const keyvalues = file.keyvalues || {};
  return (
    keyvalues.app === tags.app &&
    keyvalues.kind === tags.kind &&
    keyvalues.schema === tags.schema
  ) || file.name === name;
}

async function responseError(response, fallback) {
  const result = await response.json().catch(() => ({}));
  const detail = result.error?.message || result.error;
  return detail ? `${fallback} (${response.status}): ${detail}` : `${fallback} (${response.status})`;
}

export function createPinataStateStore({
  pinataJwt,
  uploadUrl = 'https://uploads.pinata.cloud/v3/files',
  filesApiUrl = 'https://api.pinata.cloud/v3/files',
  gateway = 'https://dweb.link',
  gatewayAccessToken = process.env.PINATA_GATEWAY_TOKEN || '',
  fetchImpl = globalThis.fetch,
  name = STATE_FILE_NAME,
  tags = STATE_KEYVALUES,
  retainSnapshots = SNAPSHOTS_TO_KEEP,
  beforeUpload,
  log = console,
  serialize = playlist => ({ schemaVersion: 1, savedAt: new Date().toISOString(), playlist }),
  deserialize = snapshot => {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.playlist)) throw new Error('IPFS state snapshot has an unsupported format');
    return snapshot.playlist;
  },
} = {}) {
  if (!pinataJwt) throw new Error('PINATA_JWT is required for playlist checkpoints');
  const headers = { authorization: `Bearer ${pinataJwt}` };
  let latestSnapshotUri = '';
  let latestSnapshotSavedAt = '';
  let restoreGatewaysPromise = null;

  async function listSnapshots(limit = 100) {
    const response = await fetchImpl(buildListUrl(filesApiUrl, limit, name), {
      headers,
      signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(await responseError(response, 'Pinata state listing failed'));
    return extractFiles(await response.json())
      .filter(file => isStateSnapshot(file, name, tags))
      .sort((first, second) => Date.parse(second.created_at || 0) - Date.parse(first.created_at || 0));
  }

  async function restoreGateways() {
    if (!restoreGatewaysPromise) restoreGatewaysPromise = (async () => {
      const candidates = [];
      try {
        const response = await fetchImpl('https://api.pinata.cloud/v3/gateways?pageSize=100&page=1', {
          headers, signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
        });
        if (response.ok) {
          const data = await response.json();
          for (const gateway of data.data?.rows || []) {
            for (const value of [gateway.domain, ...(gateway.custom_domains || []).map(item => item.domain)]) {
              const raw = String(value || '').replace(/^https?:\/\//i, '').split('/')[0];
              if (!raw || !/^[a-z0-9.-]+$/i.test(raw)) continue;
              const base = `https://${raw.includes('.') ? raw : `${raw}.mypinata.cloud`}`;
              candidates.push({ base, accessToken: '' });
              for (const key of gateway.settings?.restriction_policies?.accessTokens || []) {
                if (typeof key.value === 'string' && key.value) candidates.push({ base, accessToken: key.value });
              }
            }
          }
        }
      } catch {}
      const explicitToken = typeof gatewayAccessToken === 'string' ? gatewayAccessToken.trim() : '';
      const bases = [gateway, FALLBACK_GATEWAY].map(base => ({ base, accessToken: '' }));
      const allCandidates = [...candidates, ...bases];
      if (explicitToken) allCandidates.push(...allCandidates.map(({ base }) => ({ base, accessToken: explicitToken })));
      const unique = new Map();
      for (const candidate of allCandidates) unique.set(`${candidate.base}\u0000${candidate.accessToken}`, candidate);
      return [...unique.values()];
    })();
    return restoreGatewaysPromise;
  }

  async function restore() {
    const snapshots = await listSnapshots();
    if (!snapshots.length) return null;

    const failures = [];
    const candidates = snapshots.slice(0, MAX_RESTORE_CANDIDATES);
    const gateways = await restoreGateways();
    for (const [index, candidate] of candidates.entries()) {
      if (!candidate.cid) continue;
      for (const { base, accessToken } of gateways) {
        const url = new URL(`${base.replace(/\/(ipfs\/?)?$/, '')}/ipfs/${candidate.cid}`);
        if (accessToken) url.searchParams.set('pinataGatewayToken', accessToken);
        const response = await fetchImpl(url.toString(), {
          signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
        }).catch(() => null);
        if (!response?.ok) {
          failures.push(`${candidate.cid} (${base}): HTTP ${response?.status || 'network error'}`);
          continue;
        }
        try {
          const snapshot = await response.json();
          const restored = deserialize(snapshot, `ipfs://${candidate.cid}`);
          latestSnapshotUri = `ipfs://${candidate.cid}`;
          latestSnapshotSavedAt = snapshot.savedAt || candidate.created_at || '';
          if (index > 0) log.warn(`[ipfs-state] Restored older checkpoint ${candidate.cid}; newer snapshot gateways were unavailable.`);
          return restored;
        } catch (error) {
          failures.push(`${candidate.cid} (${base}): ${error.message}`);
        }
      }
    }
    throw new Error(`IPFS state restore failed; tried ${candidates.length} checkpoint(s): ${failures.join('; ')}`);
  }

  async function restoreCid(cid, { attempts = 1, baseDelayMs = 15_000,
    wait = delay => new Promise(resolve => setTimeout(resolve, delay)) } = {}) {
    if (!/^[a-zA-Z0-9]{20,120}$/.test(cid || '')) throw new Error('Invalid IPFS state snapshot CID');
    if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
      throw new Error('Invalid IPFS restore retry policy');
    }
    let failures = [];
    const gateways = await restoreGateways();
    for (let attempt = 0; attempt < attempts; attempt++) {
      failures = [];
      let transientFailure = false;
      for (const { base, accessToken } of gateways) {
        const url = new URL(`${base.replace(/\/(ipfs\/?)?$/, '')}/ipfs/${cid}`);
        if (accessToken) url.searchParams.set('pinataGatewayToken', accessToken);
        const response = await fetchImpl(url.toString(), {
          signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
        }).catch(() => null);
        if (!response?.ok) {
          const status = response?.status || 0;
          failures.push(`${base}: HTTP ${status || 'network error'}`);
          transientFailure ||= !status || status === 429 || status >= 500;
          continue;
        }
        try {
          const snapshot = await response.json();
          const restored = deserialize(snapshot, `ipfs://${cid}`);
          latestSnapshotUri = `ipfs://${cid}`;
          latestSnapshotSavedAt = snapshot.savedAt || '';
          return restored;
        } catch (error) {
          failures.push(`${base}: ${error.message}`);
        }
      }
      if (!transientFailure || attempt === attempts - 1) break;
      const delay = baseDelayMs * 2 ** attempt;
      log.warn(`[ipfs-state] Checkpoint ${cid} unavailable; retrying in ${Math.ceil(delay / 1000)}s.`);
      await wait(delay);
    }
    throw new Error(`IPFS state restore failed for ${cid}: ${failures.join('; ')}`);
  }

  async function save(playlist) {
    const snapshot = serialize(playlist);
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/json' }), name);
    form.append('network', 'public');
    form.append('name', name);
    form.append('keyvalues', JSON.stringify(tags));

    const response = await fetchImpl(uploadUrl, { method: 'POST', headers, body: form });
    if (!response.ok) throw new Error(await responseError(response, 'Pinata state upload failed'));
    const result = await response.json();
    const cid = result.data?.cid || result.cid || result.IpfsHash;
    if (!cid) throw new Error('Pinata state upload did not return a CID');
    latestSnapshotUri = `ipfs://${cid}`;
    if (beforeUpload) Promise.resolve().then(() => beforeUpload(bytes, cid))
      .then(mirroredCid => {
        if (mirroredCid && mirroredCid !== cid) console.warn(`[ipfs-state] Local mirror CID ${mirroredCid} differs from shared Pinata CID ${cid}`);
      })
      .catch(error => console.warn(`[ipfs-state] Shared checkpoint ${cid} is saved; local/community mirror deferred: ${error.message}`));

    const snapshots = await listSnapshots();
    const normalizedFilesUrl = filesApiUrl.replace(/\/(public|private)?\/?$/, '');
    const stale = retainSnapshots === Infinity ? [] : snapshots.slice(retainSnapshots).slice(-MAX_PRUNE_PER_SAVE);
    await Promise.all(stale.map(async ({ id }) => {
      if (!id) return;
      const deleteResponse = await fetchImpl(`${normalizedFilesUrl}/public/${id}`, { method: 'DELETE', headers });
      if (!deleteResponse.ok) console.warn(`[ipfs-state] Failed to prune snapshot ${id}: ${deleteResponse.status}`);
    }));
    return `ipfs://${cid}`;
  }

  return { restore, restoreCid, save, getLatestSnapshotUri: () => latestSnapshotUri,
    getLatestSnapshotSavedAt: () => latestSnapshotSavedAt };
}
