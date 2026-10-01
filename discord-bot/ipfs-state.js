const STATE_FILE_NAME = 'decentbusking-jukeloop-state.json';
const STATE_KEYVALUES = {
  app: 'decentbusking',
  kind: 'jukeloop-state',
  schema: '1',
};
const SNAPSHOTS_TO_KEEP = 3;

function buildListUrl(filesApiUrl, limit = 100) {
  const url = new URL(filesApiUrl);
  url.searchParams.set('keyvalues[app]', STATE_KEYVALUES.app);
  url.searchParams.set('keyvalues[kind]', STATE_KEYVALUES.kind);
  url.searchParams.set('keyvalues[schema]', STATE_KEYVALUES.schema);
  url.searchParams.set('order', 'DESC');
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

function extractFiles(result) {
  return result.data?.files || result.files || [];
}

async function responseError(response, fallback) {
  const result = await response.json().catch(() => ({}));
  const detail = result.error?.message || result.error;
  return detail ? `${fallback} (${response.status}): ${detail}` : `${fallback} (${response.status})`;
}

export function createPinataStateStore({
  pinataJwt,
  uploadUrl = 'https://uploads.pinata.cloud/v3/files',
  filesApiUrl = 'https://api.pinata.cloud/v3/files/public',
  gateway = 'https://dweb.link',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!pinataJwt) throw new Error('PINATA_JWT is required for playlist checkpoints');
  const headers = { authorization: `Bearer ${pinataJwt}` };

  async function listSnapshots(limit = 100) {
    const response = await fetchImpl(buildListUrl(filesApiUrl, limit), { headers });
    if (!response.ok) throw new Error(await responseError(response, 'Pinata state listing failed'));
    return extractFiles(await response.json());
  }

  async function restore() {
    const [latest] = await listSnapshots(1);
    if (!latest?.cid) return null;

    const response = await fetchImpl(`${gateway.replace(/\/$/, '')}/ipfs/${latest.cid}`);
    if (!response.ok) throw new Error(`IPFS state restore failed (${response.status})`);
    const snapshot = await response.json();
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.playlist)) {
      throw new Error('IPFS state snapshot has an unsupported format');
    }
    return snapshot.playlist;
  }

  async function save(playlist) {
    const snapshot = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      playlist,
    };
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(snapshot)], { type: 'application/json' }), STATE_FILE_NAME);
    form.append('network', 'public');
    form.append('name', STATE_FILE_NAME);
    form.append('keyvalues', JSON.stringify(STATE_KEYVALUES));

    const response = await fetchImpl(uploadUrl, { method: 'POST', headers, body: form });
    if (!response.ok) throw new Error(await responseError(response, 'Pinata state upload failed'));
    const result = await response.json();
    const cid = result.data?.cid || result.cid || result.IpfsHash;
    if (!cid) throw new Error('Pinata state upload did not return a CID');

    const snapshots = await listSnapshots();
    await Promise.all(snapshots.slice(SNAPSHOTS_TO_KEEP).map(async ({ id }) => {
      if (!id) return;
      const deleteResponse = await fetchImpl(`${filesApiUrl}/${id}`, { method: 'DELETE', headers });
      if (!deleteResponse.ok) console.warn(`[ipfs-state] Failed to prune snapshot ${id}: ${deleteResponse.status}`);
    }));
    return `ipfs://${cid}`;
  }

  return { restore, save };
}
