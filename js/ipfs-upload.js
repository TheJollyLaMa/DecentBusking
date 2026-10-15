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

export function buildUploadBatchAuthorizationMessage({ address, origin, issuedAt, files }) {
  return [
    'DecentBusking IPFS metadata batch upload authorization',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
    `Files: ${JSON.stringify(files)}`,
  ].join('\n');
}

function extractCid(result) {
  return result.data?.cid || result.cid || result.IpfsHash || result.Hash;
}

function readResponseError(response, fallbackMessage) {
  return response.text().then(async text => {
    const result = text ? JSON.parse(text) : {};
    const detail = typeof result.error === 'string' ? result.error
      : result.error?.message || result.error?.reason || result.message || result.Message;
    const error = new Error(detail || fallbackMessage);
    error.status = response.status;
    error.retryable = response.status >= 500 || response.status === 429 || response.status === 408;
    return error;
  }).catch(() => {
    const error = new Error(fallbackMessage);
    error.status = response.status;
    error.retryable = response.status >= 500 || response.status === 429 || response.status === 408;
    return error;
  });
}

function uploadWithProgress(endpoint, file, fetchImpl, includeNetwork, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, file.name);
    if (includeNetwork) form.append('network', 'public');
    xhr.open('POST', endpoint, true);
    xhr.responseType = 'text';
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && typeof onProgress === 'function') {
        onProgress({ loaded: event.loaded, total: event.total, progress: event.total ? event.loaded / event.total : 0 });
      }
    };
    xhr.onload = async () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(await readResponseError({ status: xhr.status, text: async () => xhr.responseText }, `IPFS upload failed (${xhr.status}) for ${file.name}`));
        return;
      }
      try {
        const cid = extractCid(JSON.parse(xhr.responseText || '{}'));
        if (!cid) throw new Error('IPFS upload response did not include a CID');
        resolve(`ipfs://${cid}`);
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error(`Network error uploading ${file.name}`));
    xhr.onabort = () => reject(new Error(`Upload aborted for ${file.name}`));
    xhr.timeout = 0;
    xhr.send(form);
  });
}

async function uploadForm(endpoint, file, fetchImpl, includeNetwork = false, { onProgress } = {}) {
  if (typeof XMLHttpRequest !== 'undefined' && typeof onProgress === 'function') {
    return uploadWithProgress(endpoint, file, fetchImpl, includeNetwork, onProgress);
  }
  const form = new FormData();
  form.append('file', file, file.name);
  if (includeNetwork) form.append('network', 'public');
  const response = await fetchImpl(endpoint, { method: 'POST', body: form });
  if (!response.ok) {
    throw await readResponseError(response, `IPFS upload failed (${response.status}) for ${file.name}`);
  }
  const cid = extractCid(await response.json());
  if (!cid) throw new Error('IPFS upload response did not include a CID');
  return `ipfs://${cid}`;
}

function isRetryableError(error) {
  return Boolean(error?.retryable || /Failed to fetch|NetworkError|network|load failed|fetch failed|aborted|AbortError/i.test(error?.message || ''));
}

function stepError(prefix, step, detail, suggestion) {
  const message = `${prefix} (${step}) — ${detail || suggestion}`;
  const error = new Error(message);
  error.step = step;
  return error;
}

async function withRetries(step, action, {
  retries = 2,
  prefix,
  retrySuggestion,
  logPrefix = '[ipfs-upload]',
}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      const retryable = attempt < retries && isRetryableError(error);
      console.warn(logPrefix, step, { attempt: attempt + 1, retryable, error });
      if (!retryable) break;
      await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw stepError(prefix, step, lastError?.message, retrySuggestion);
}

const IMAGE_SIGNATURES = [
  { type: 'image/jpeg', ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', ext: 'png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: 'image/gif', ext: 'gif', test: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { type: 'image/webp', ext: 'webp', test: b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

// Pinata checks the real file contents against the signed MIME type, so an image whose
// extension doesn't match its bytes (e.g. a JPEG saved as .png) must be relabelled first.
export async function normalizeImageFileType(file) {
  if (!file || typeof file.slice !== 'function' || !String(file.type || '').startsWith('image/')) return file;
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const detected = IMAGE_SIGNATURES.find(signature => signature.test(bytes));
  if (!detected || detected.type === file.type || typeof File === 'undefined') return file;
  const base = String(file.name || 'artwork').replace(/\.[^.]*$/, '');
  return new File([file], `${base}.${detected.ext}`, { type: detected.type, lastModified: file.lastModified });
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
  retries = 2,
}) {
  const upload = async function upload(file, options = {}) {
    const { onProgress } = options || {};
    if (provider === 'local') {
      const endpoint = `${ipfsApiUrl.replace(/\/$/, '')}/api/v0/add?cid-version=1&pin=true`;
      return withRetries('step 1/2', () => uploadForm(endpoint, file, fetchImpl, false, { onProgress }), {
        retries,
        prefix: 'Upload to IPFS failed',
        retrySuggestion: 'retry, or try a smaller file',
      });
    }
    if (provider !== 'pinata') throw new Error(`Unsupported IPFS upload provider: ${provider}`);
    if (!serviceUrl) throw new Error('The Render IPFS worker URL is not configured');
    if (!signer || !address) throw new Error('Connect your wallet before uploading');
    file = await normalizeImageFileType(file);

    const endpoint = purpose === 'submission' ? 'submission-upload-url' : 'upload-url';
    let lastUploadError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let url;
      try {
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
        const signingResponse = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/ipfs/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...authorization, signature }),
        });
        if (!signingResponse.ok) {
          throw await readResponseError(signingResponse, `Pinata signing failed (${signingResponse.status})`);
        }
        const signingResult = await signingResponse.json();
        url = signingResult.url;
        if (!url) throw new Error('Pinata signing response did not include a URL');
      } catch (error) {
        const retryable = attempt < retries && isRetryableError(error);
        console.warn('[ipfs-upload]', 'step 1/2', { attempt: attempt + 1, retryable, error });
        if (!retryable) throw stepError('Couldn’t reach the upload service', 'step 1/2', error.message, 'please retry');
        await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
        continue;
      }
      try {
        return await uploadForm(url, file, fetchImpl, true, { onProgress });
      } catch (error) {
        lastUploadError = error;
        const retryable = attempt < retries && isRetryableError(error);
        console.warn('[ipfs-upload]', 'step 2/2', { attempt: attempt + 1, retryable, error });
        if (!retryable) break;
        await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
      }
    }
    throw stepError('Upload to IPFS failed', 'step 2/2', lastUploadError?.message, 'retry, or try a smaller file');
  };

  upload.batch = async files => {
    if (!Array.isArray(files) || files.length < 1 || files.length > 20) {
      throw new Error('Metadata upload batches must contain 1 to 20 files');
    }
    if (provider === 'local') return Promise.all(files.map(file => uploadForm(
      `${ipfsApiUrl.replace(/\/$/, '')}/api/v0/add?cid-version=1&pin=true`, file, fetchImpl)));
    if (provider !== 'pinata') throw new Error(`Unsupported IPFS upload provider: ${provider}`);
    if (!serviceUrl) throw new Error('The Render IPFS worker URL is not configured');
    if (!signer || !address) throw new Error('Connect your wallet before uploading');
    const issuedAt = new Date().toISOString();
    const descriptors = files.map(file => ({ name: file.name, size: file.size,
      type: file.type || 'application/octet-stream' }));
    const authorization = { address, origin, issuedAt, files: descriptors };
    const signature = await signer.signMessage(buildUploadBatchAuthorizationMessage(authorization));
    const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/ipfs/upload-batch-urls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...authorization, signature }),
    });
    if (!response.ok) {
      throw await readResponseError(response, `Pinata batch signing failed (${response.status})`);
    }
    const result = await response.json();
    if (!Array.isArray(result.urls) || result.urls.length !== files.length || result.urls.some(url => typeof url !== 'string' || !url)) {
      throw new Error('Pinata batch signing response did not include one URL per metadata file');
    }
    return Promise.all(files.map((file, index) => withRetries(`batch ${index + 1}/${files.length}`, () =>
      uploadForm(result.urls[index], file, fetchImpl, true, {}), {
        retries,
        prefix: 'Upload to IPFS failed',
        retrySuggestion: 'retry, or try a smaller file',
      })));
  };

  return upload;
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
