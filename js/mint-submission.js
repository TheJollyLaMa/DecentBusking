export function buildSubmissionAuthorizationMessage(payload) {
  const { address, origin, issuedAt, title, artist, ipfsCid, mediaType, filename,
    recipient, artworkCid = '', tipWallet = '', parentTokenId = 0 } = payload;
  return [
    'DecentBusking media submission for owner approval',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
    JSON.stringify({ title, artist, ipfsCid, mediaType, filename, recipient, artworkCid, tipWallet, parentTokenId }),
  ].join('\n');
}

export async function submitMediaForApproval({ serviceUrl, signer, address, origin, media, fetchImpl = fetch }) {
  if (!serviceUrl) throw new Error('Media submission service is not configured');
  if (!signer || !address) throw new Error('Connect your artist wallet first');
  const payload = { ...media, address, origin, issuedAt: new Date().toISOString() };
  const signature = await signer.signMessage(buildSubmissionAuthorizationMessage(payload));
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/media/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, signature }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Submission failed (${response.status})`);
  return result;
}