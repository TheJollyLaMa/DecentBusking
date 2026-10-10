const STATE_FILE_NAME = 'decentbusking-jukeloop-state.json';
const STATE_KEYVALUES = {
  app: 'decentbusking',
  kind: 'jukeloop-state',
  schema: '1',
};
const SNAPSHOTS_TO_KEEP = 3;
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
  fetchImpl = globalThis.fetch,
  name = STATE_FILE_NAME,
  tags = STATE_KEYVALUES,
  retainSnapshots = SNAPSHOTS_TO_KEEP,
  beforeUpload,
  serialize = playlist => ({ schemaVersion: 1, savedAt: new Date().toISOString(), playlist }),
  deserialize = snapshot => {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.playlist)) throw new Error('IPFS state snapshot has an unsupported format');
    return snapshot.playlist;
  },
} = {}) {
  if (!pinataJwt) throw new Error('PINATA_JWT is required for playlist checkpoints');
  const headers = { authorization: `Bearer ${pinataJwt}` };

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

  async function restore() {
    const [latest] = await listSnapshots();
    if (!latest?.cid) return null;

    let lastStatus = 0;
    for (const base of [...new Set([gateway, FALLBACK_GATEWAY])]) {
      const response = await fetchImpl(`${base.replace(/\/(ipfs\/?)?$/, '')}/ipfs/${latest.cid}`, {
        signal: AbortSignal.timeout(RESTORE_REQUEST_TIMEOUT_MS),
      }).catch(() => null);
      if (!response?.ok) {
        lastStatus = response?.status || 0;
        continue;
      }
      const snapshot = await response.json();
      return deserialize(snapshot, `ipfs://${latest.cid}`);
    }
    throw new Error(`IPFS state restore failed (${lastStatus})`);
  }

  async function save(playlist) {
    const snapshot = serialize(playlist);
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
    const mirroredCid = beforeUpload ? await beforeUpload(bytes) : null;
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
    if (mirroredCid && cid !== mirroredCid) throw new Error(`Pinata checkpoint ${cid} differs from locally mirrored ${mirroredCid}; do not adopt this state`);

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

  return { restore, save };
}
