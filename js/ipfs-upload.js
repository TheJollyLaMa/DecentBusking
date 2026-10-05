export function buildUploadAuthorizationMessage({ address, origin, name, size, type, issuedAt, purpose }) {
  return [
    purpose === 'submission' ? 'DecentBusking artist media upload authorization' : 'DecentBusking IPFS upload authorization',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `File: ${name}`,
    `Size: ${size}`,
    `Type: ${type}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

function extractCid(result) {
  return result.data?.cid || result.cid || result.IpfsHash || result.Hash;
}

async function uploadForm(endpoint, file, fetchImpl, includeNetwork = false) {
  const form = new FormData();
  form.append('file', file, file.name);
  if (includeNetwork) form.append('network', 'public');
  const response = await fetchImpl(endpoint, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`IPFS upload failed (${response.status})`);
  const cid = extractCid(await response.json());
  if (!cid) throw new Error('IPFS upload response did not include a CID');
  return `ipfs://${cid}`;
}

export function createBrowserIpfsUploader({
  provider = 'pinata',
  serviceUrl,
  ipfsApiUrl = 'http://127.0.0.1:5001',
  signer,
  address,
  origin,
  purpose,
  fetchImpl = globalThis.fetch,
}) {
  return async function upload(file) {
    if (provider === 'local') {
      const endpoint = `${ipfsApiUrl.replace(/\/$/, '')}/api/v0/add?cid-version=1&pin=true`;
      return uploadForm(endpoint, file, fetchImpl);
    }
    if (provider !== 'pinata') throw new Error(`Unsupported IPFS upload provider: ${provider}`);
    if (!serviceUrl) throw new Error('The Render IPFS worker URL is not configured');
    if (!signer || !address) throw new Error('Connect your wallet before uploading');

    const issuedAt = new Date().toISOString();
    const authorization = {
      address,
      origin,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      issuedAt,
      ...(purpose === 'submission' ? { purpose } : {}),
    };
    const signature = await signer.signMessage(buildUploadAuthorizationMessage(authorization));
    const endpoint = purpose === 'submission' ? 'submission-upload-url' : 'upload-url';
    const signingResponse = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/ipfs/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    if (!signingResponse.ok) {
      const result = await signingResponse.json().catch(() => ({}));
      throw new Error(result.error || `Pinata signing failed (${signingResponse.status})`);
    }
    const { url } = await signingResponse.json();
    if (!url) throw new Error('Pinata signing response did not include a URL');
    return uploadForm(url, file, fetchImpl, true);
  };
}

export function uploadFileToIPFS(file) {
  const config = window.DecentConfig || {};
  const params = new URLSearchParams(window.location.search);
  return createBrowserIpfsUploader({
    provider: config.ipfsUploadProvider || 'pinata',
    serviceUrl: params.get('worker') || config.ipfsUploadServiceUrl,
    ipfsApiUrl: config.ipfsApiUrl,
    signer: window._wallet?.signer,
    address: window._wallet?.address,
    origin: window.location.origin,
  })(file);
}
