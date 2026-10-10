// IPFS upload adapters shared by the Discord ingestion flow.
import { CID } from 'multiformats/cid';

const DEFAULT_PINATA_API_URL = 'https://uploads.pinata.cloud/v3/files';
const DEFAULT_IPFS_API_URL = 'http://127.0.0.1:5001';

export async function ensureLocalRecursivePin({ cid, ipfsApiUrl = DEFAULT_IPFS_API_URL, fetchImpl = fetch }) {
  const normalized = CID.parse(cid).toV1().toString();
  const endpoint = new URL(ipfsApiUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('Local pinning requires a loopback Kubo API');
  }
  const base = ipfsApiUrl.replace(/\/$/, '');
  const query = new URLSearchParams({ arg: normalized, type: 'recursive' });
  const verified = async () => {
    const response = await fetchImpl(`${base}/api/v0/pin/ls?${query}`, { method: 'POST', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return false;
    const result = await response.json();
    return Object.entries(result.Keys || {}).some(([key, pin]) => {
      try { return CID.parse(key).toV1().toString() === normalized && pin.Type === 'recursive'; } catch { return false; }
    });
  };
  if (await verified()) return { cid: normalized, alreadyPinned: true };
  const added = await fetchImpl(`${base}/api/v0/pin/add?${new URLSearchParams({ arg: normalized, recursive: 'true' })}`,
    { method: 'POST', signal: AbortSignal.timeout(120000) });
  if (!added.ok) throw new Error(`Local pin failed (${added.status})`);
  if (!await verified()) throw new Error('Local recursive pin could not be verified');
  return { cid: normalized, alreadyPinned: false };
}

export function createDualPinUploader({ pinataJwt, pinataApiUrl, ipfsApiUrl, fetchImpl = fetch, onPinataPinned = () => {} } = {}) {
  const upload = createIpfsUploader({ provider: 'pinata', pinataJwt, pinataApiUrl, fetchImpl });
  return async (buffer, filename, mimeType, { existingPinataCid } = {}) => {
    const uri = existingPinataCid ? `ipfs://${CID.parse(existingPinataCid).toV1().toString()}` : await upload(buffer, filename, mimeType);
    const cid = uri.slice(7);
    onPinataPinned({ cid, filename, reused: !!existingPinataCid });
    try { await ensureLocalRecursivePin({ cid, ipfsApiUrl, fetchImpl }); }
    catch (error) {
      const failure = new Error(`Pinata copy exists at ${uri}; local pin pending. Reuse this CID on retry, do not upload again. ${error.message}`);
      failure.pinataCid = cid;
      throw failure;
    }
    return uri;
  };
}

function extractCid(result) {
  return result.data?.cid || result.cid || result.IpfsHash || result.Hash;
}

/** Create an uploader backed by Pinata or a local Kubo node. */
export function createIpfsUploader({
  provider = 'pinata',
  pinataJwt,
  pinataApiUrl = DEFAULT_PINATA_API_URL,
  ipfsApiUrl = DEFAULT_IPFS_API_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (provider === 'pinata' && !pinataJwt) {
    throw new Error('PINATA_JWT is required when IPFS_UPLOAD_PROVIDER=pinata');
  }
  if (!['pinata', 'local'].includes(provider)) {
    throw new Error(`Unsupported IPFS_UPLOAD_PROVIDER: ${provider}`);
  }

  return async function upload(buffer, filename, mimeType) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), filename);

    let endpoint;
    const options = { method: 'POST', body: form };
    if (provider === 'pinata') {
      endpoint = pinataApiUrl;
      form.append('network', 'public');
      options.headers = { authorization: `Bearer ${pinataJwt}` };
    } else {
      endpoint = `${ipfsApiUrl.replace(/\/$/, '')}/api/v0/add?cid-version=1&pin=true`;
    }

    const response = await fetchImpl(endpoint, options);
    if (!response.ok) {
      throw new Error(`${provider === 'pinata' ? 'Pinata' : 'Local IPFS'} upload failed (${response.status})`);
    }
    const cid = extractCid(await response.json());
    if (!cid) throw new Error('IPFS upload response did not include a CID');
    return `ipfs://${cid}`;
  };
}

/** Upload one file using the configured provider. */
export function uploadToIPFS(buffer, filename, mimeType, options) {
  return createIpfsUploader(options)(buffer, filename, mimeType);
}
