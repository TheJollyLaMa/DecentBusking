const api = (serviceUrl, path) => `${String(serviceUrl || '').replace(/\/$/, '')}${path}`;

async function readJson(response, label) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `${label} failed (${response.status})`);
  return result;
}

export async function createCreatorSplitProposal({ serviceUrl, signer, address, proposal, fetchImpl = fetch }) {
  if (!serviceUrl || !signer || !address) throw new Error('Connect a current collaborator wallet to propose a split');
  const availabilityResponse = await fetchImpl(api(serviceUrl, '/api/creator/split-status'), {
    cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  const availability = await readJson(availabilityResponse, 'Split approval service availability');
  if (availability.available !== true || availability.chainId !== proposal.domain.chainId ||
      String(availability.contractAddress || '').toLowerCase() !== proposal.domain.verifyingContract.toLowerCase()) {
    throw new Error('Split approval service does not match this DJuke deployment; no signature was requested');
  }
  const signature = await signer.signTypedData(proposal.domain, proposal.types, proposal.value);
  const response = await fetchImpl(api(serviceUrl, '/api/creator/split-proposals'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: proposal.kind,
      resourceId: proposal.resourceId,
      albumId: proposal.albumId,
      nftContractAddress: proposal.nftContractAddress,
      nftTokenId: proposal.nftTokenId,
      revision: proposal.revision,
      title: proposal.title,
      recipients: proposal.recipients,
      sharesBps: proposal.sharesBps,
      positions: proposal.positions,
      address,
      signature,
    }),
    signal: AbortSignal.timeout(30000),
  });
  return readJson(response, 'Split proposal');
}

export async function fetchCreatorSplitProposal({ serviceUrl, requestId, fetchImpl = fetch }) {
  if (!serviceUrl || !requestId) throw new Error('Split proposal link is incomplete');
  const response = await fetchImpl(api(serviceUrl, `/api/creator/split-proposal?requestId=${encodeURIComponent(requestId)}`), {
    cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  return readJson(response, 'Split proposal');
}

export async function approveCreatorSplitProposal({ serviceUrl, signer, address, requestId, fetchImpl = fetch }) {
  if (!serviceUrl || !signer || !address || !requestId) throw new Error('Connect a wallet to review this split proposal');
  const { request } = await fetchCreatorSplitProposal({ serviceUrl, requestId, fetchImpl });
  if (!request?.typedData?.domain || !request?.typedData?.types || !request?.typedData?.value) {
    throw new Error('Split proposal has no valid approval data');
  }
  const signature = await signer.signTypedData(request.typedData.domain, request.typedData.types, request.typedData.value);
  const response = await fetchImpl(api(serviceUrl, `/api/creator/split-proposals/${encodeURIComponent(requestId)}/approve`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, signature }),
    signal: AbortSignal.timeout(30000),
  });
  return readJson(response, 'Split approval');
}

export async function completeCreatorSplitProposal({
  serviceUrl, signer, address, requestId, txHash, origin, fetchImpl = fetch, now = () => Date.now(),
}) {
  if (!serviceUrl || !signer || !address || !requestId || !txHash) throw new Error('Split completion details are incomplete');
  const issuedAt = new Date(now()).toISOString();
  const message = [
    'DecentBusking creator split update completion',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Proposal: ${requestId}`,
    `Transaction: ${txHash.toLowerCase()}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
  const signature = await signer.signMessage(message);
  const response = await fetchImpl(api(serviceUrl, `/api/creator/split-proposals/${encodeURIComponent(requestId)}/complete`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, txHash, issuedAt, signature }),
    signal: AbortSignal.timeout(30000),
  });
  return readJson(response, 'Split update reconciliation');
}

export async function rejectCreatorSplitProposal({ serviceUrl, signer, address, requestId, fetchImpl = fetch, now = () => Date.now() }) {
  if (!serviceUrl || !signer || !address || !requestId) throw new Error('Split rejection details are incomplete');
  const issuedAt = new Date(now()).toISOString();
  const signature = await signer.signMessage(buildAdminAuthorizationMessage({
    address, origin: globalThis.location?.origin || '', issuedAt,
  }));
  const response = await fetchImpl(api(serviceUrl, `/api/creator/split-proposals/${encodeURIComponent(requestId)}/reject`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, issuedAt, signature }),
    signal: AbortSignal.timeout(30000),
  });
  return readJson(response, 'Split proposal rejection');
}
import { buildAdminAuthorizationMessage } from './admin-mint-queue.js';
import { buildAlbumTrackRemovalAuthorizationMessage } from './creator-splits.mjs?v=20261025-song-splits';

export async function reconcileRemovedAlbumTrack({
  serviceUrl, signer, address, albumId, songId, txHash, origin, fetchImpl = fetch, now = () => Date.now(),
}) {
  if (!serviceUrl || !signer || !address || !albumId || !songId || !txHash) {
    throw new Error('Album track reconciliation details are incomplete');
  }
  const issuedAt = new Date(now()).toISOString();
  const authorization = { address, origin, albumId, songId, txHash, issuedAt };
  const signature = await signer.signMessage(buildAlbumTrackRemovalAuthorizationMessage(authorization));
  const response = await fetchImpl(api(serviceUrl, '/api/creator/album-track-removal'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...authorization, signature }),
    signal: AbortSignal.timeout(30000),
  });
  return readJson(response, 'Album track metadata reconciliation');
}
