// IPFS upload adapters shared by the Discord ingestion flow.

const DEFAULT_PINATA_API_URL = 'https://uploads.pinata.cloud/v3/files';
const DEFAULT_IPFS_API_URL = 'http://127.0.0.1:5001';

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
