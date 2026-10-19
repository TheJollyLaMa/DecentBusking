export function buildSubmissionAuthorizationMessage(payload) {
  const { address, origin, issuedAt, title, artist, ipfsCid, mediaType, filename,
    recipient, artworkCid = '', tipWallet = '', parentTokenId = 0, isDevertAd = false, creatorSplits } = payload;
  return [
    'DecentBusking media submission for owner approval',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
    JSON.stringify({ title, artist, ipfsCid, mediaType, filename, recipient, artworkCid, tipWallet, parentTokenId, isDevertAd,
      ...(creatorSplits !== undefined ? { creatorSplits } : {}) }),
  ].join('\n');
}

function isRetryableError(error) {
  return Boolean(error?.retryable || /Failed to fetch|NetworkError|load failed|network|timeout|AbortError/i.test(error?.message || ''));
}

async function withRetries(action, { retries = 2, prefix = 'Couldn’t reach the submission service', step = 'step 4/4' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      const retryable = attempt < retries && isRetryableError(error);
      console.warn('[mint-submission]', step, { attempt: attempt + 1, retryable, error });
      if (!retryable) break;
      await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw new Error(`${prefix} (${step}) — ${lastError?.message || 'please retry'}`);
}

export async function submitMediaForApproval({ serviceUrl, signer, address, origin, media, fetchImpl = fetch }) {
  if (!serviceUrl) throw new Error('Media submission service is not configured');
  if (!signer || !address) throw new Error('Connect your artist wallet first');
  return withRetries(async () => {
    const payload = { ...media, address, origin, issuedAt: new Date().toISOString() };
    const signature = await signer.signMessage(buildSubmissionAuthorizationMessage(payload));
    const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/media/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `Submission failed (${response.status})`);
      error.retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      throw error;
    }
    return result;
  });
}