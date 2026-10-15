export function createArtworkUpdateQueue({ restore = async () => [], save = async () => {} } = {}) {
  let requests = [];

  const normalize = (request) => ({
    ...request,
    requestId: request.requestId || crypto.randomUUID(),
    tokenId: String(request.tokenId),
    contractAddress: String(request.contractAddress || '').toLowerCase(),
    status: request.status || 'pending',
    requestedAt: request.requestedAt || new Date().toISOString(),
  });

  const sortRequests = () => [...requests].sort((a, b) => Date.parse(a.requestedAt || 0) - Date.parse(b.requestedAt || 0));

  const persist = async () => save(structuredClone(requests));

  return {
    async initialize() {
      const restored = await restore();
      requests = Array.isArray(restored) ? restored.map(normalize) : [];
      return sortRequests();
    },
    getRequests() {
      return sortRequests();
    },
    getPendingRequests() {
      return sortRequests().filter(request => request.status === 'pending');
    },
    getPendingCount() {
      return requests.filter(request => request.status === 'pending').length;
    },
    getRequest({ requestId, tokenId, contractAddress }) {
      return sortRequests().find(request =>
        (requestId && request.requestId === requestId) ||
        (tokenId !== undefined && String(request.tokenId) === String(tokenId) &&
          (!contractAddress || request.contractAddress === String(contractAddress).toLowerCase())));
    },
    async queueRequest(request) {
      const normalized = normalize(request);
      const existingIndex = requests.findIndex(entry =>
        entry.status === 'pending' && String(entry.tokenId) === normalized.tokenId &&
        entry.contractAddress === normalized.contractAddress);
      if (existingIndex >= 0) {
        const existing = requests[existingIndex];
        existing.status = 'superseded';
        existing.supersededAt = normalized.requestedAt;
        existing.supersededBy = normalized.requestId;
      }
      requests.unshift(normalized);
      await persist();
      return normalized;
    },
    async completeRequest(requestId, update = {}) {
      const request = requests.find(entry => entry.requestId === requestId);
      if (!request) return null;
      request.status = 'completed';
      request.completedAt = new Date().toISOString();
      if (update.txHash) request.txHash = update.txHash;
      if (update.metadataUri) request.metadataUri = update.metadataUri;
      await persist();
      return request;
    },
    async rejectRequest(requestId, reason = 'rejected') {
      const request = requests.find(entry => entry.requestId === requestId);
      if (!request) return null;
      request.status = 'rejected';
      request.rejectedAt = new Date().toISOString();
      request.rejectionReason = reason;
      await persist();
      return request;
    },
  };
}
