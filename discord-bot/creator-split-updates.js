export function createCreatorSplitUpdateQueue({
  restore = async () => [], save = async () => {}, now = () => Date.now(),
} = {}) {
  let requests = [];
  let task = Promise.resolve();
  const copy = value => structuredClone(value);
  const run = operation => {
    const result = task.then(operation);
    task = result.catch(() => {});
    return result;
  };
  const ordered = () => [...requests].sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  const isExpired = request => Number.isFinite(Date.parse(request.expiresAt)) && Date.parse(request.expiresAt) <= now();
  const publicCopy = request => {
    const result = copy(request);
    if (result.status === 'pending' && isExpired(result)) result.status = 'expired';
    return result;
  };
  const persist = async next => {
    await save(copy(next));
    requests = next;
  };
  const normalize = request => ({
    ...request,
    requestId: String(request.requestId || crypto.randomUUID()),
    status: request.status || 'pending',
    requestedAt: request.requestedAt || new Date().toISOString(),
    approvals: Array.isArray(request.approvals) ? request.approvals : [],
  });

  return {
    async initialize() {
      return run(async () => {
        const restored = await restore();
        if (restored !== null && !Array.isArray(restored)) throw new Error('Invalid creator split update checkpoint');
        requests = (restored || []).map(normalize);
        return ordered();
      });
    },
    getRequests() {
      return ordered().map(publicCopy);
    },
    getRequest(requestId) {
      const request = requests.find(entry => entry.requestId === requestId);
      return request ? publicCopy(request) : null;
    },
    getPendingRequests() {
      return ordered().filter(entry => entry.status === 'pending' && !isExpired(entry)).map(copy);
    },
    getReadyRequests() {
      return ordered().filter(entry => entry.status === 'pending' &&
        !isExpired(entry) &&
        entry.approvals.length === entry.owners.length &&
        entry.owners.every(owner => entry.approvals.some(approval =>
          approval.address.toLowerCase() === owner.toLowerCase()))).map(copy);
    },
    async queueRequest(request) {
      return run(async () => {
        const normalized = normalize(request);
        const next = requests.map(copy);
        for (const existing of next) {
          if (existing.status === 'pending' && existing.kind === normalized.kind && existing.resourceId === normalized.resourceId) {
            existing.status = 'superseded';
            existing.supersededAt = normalized.requestedAt;
            existing.supersededBy = normalized.requestId;
          }
        }
        next.unshift(normalized);
        await persist(next);
        return copy(normalized);
      });
    },
    async addApproval(requestId, approval) {
      return run(async () => {
        const next = requests.map(copy);
        const request = next.find(entry => entry.requestId === requestId);
        if (!request || request.status !== 'pending') throw new Error('Split proposal is no longer pending');
        if (isExpired(request)) throw new Error('Split proposal has expired');
        const approved = String(approval.address || '').toLowerCase();
        if (!request.owners.some(owner => owner.toLowerCase() === approved)) throw new Error('Approval wallet is not a current owner');
        if (request.approvals.some(entry => entry.address.toLowerCase() === approved)) {
          throw new Error('This owner has already approved the proposal');
        }
        request.approvals.push({ address: approval.address, signature: approval.signature, approvedAt: approval.approvedAt });
        await persist(next);
        return copy(request);
      });
    },
    async completeRequest(requestId, update = {}) {
      return run(async () => {
        const next = requests.map(copy);
        const request = next.find(entry => entry.requestId === requestId);
        if (!request) throw new Error('Split proposal not found');
        if (request.status !== 'pending') throw new Error('Split proposal is no longer pending');
        if (isExpired(request)) throw new Error('Split proposal has expired');
        request.status = 'completed';
        request.completedAt = new Date().toISOString();
        request.txHash = update.txHash;
        await persist(next);
        return copy(request);
      });
    },
    async rejectRequest(requestId, reason = 'rejected') {
      return run(async () => {
        const next = requests.map(copy);
        const request = next.find(entry => entry.requestId === requestId);
        if (!request) throw new Error('Split proposal not found');
        if (request.status !== 'pending') throw new Error('Split proposal is no longer pending');
        request.status = 'rejected';
        request.rejectedAt = new Date().toISOString();
        request.rejectionReason = reason;
        await persist(next);
        return copy(request);
      });
    },
  };
}
