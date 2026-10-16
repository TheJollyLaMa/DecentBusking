export function createDevertRemovals({ restore, save, now = () => Date.now() }) {
  let removals;
  let task = Promise.resolve();
  const ready = () => { if (!removals) throw new Error('Campaign removal state is unavailable'); };
  return {
    async initialize() {
      const state = await restore();
      if (state && (state.schemaVersion !== 1 || !Array.isArray(state.removals) ||
        state.removals.some(item => !/^\d+$/.test(item.campaignId) || !/^0x[0-9a-f]{40}$/i.test(item.removedBy) ||
          !Number.isFinite(Date.parse(item.removedAt))))) throw new Error('Invalid campaign removal checkpoint');
      removals = state?.removals || [];
    },
    isRemoved(campaignId) { ready(); return removals.some(item => item.campaignId === String(campaignId)); },
    list() { ready(); return structuredClone(removals); },
    remove({ campaignId, address }) {
      const operation = task.then(async () => {
        ready();
        const existing = removals.find(item => item.campaignId === String(campaignId));
        if (existing) return structuredClone(existing);
        const entry = { campaignId: String(campaignId), removedBy: address, removedAt: new Date(now()).toISOString() };
        const next = [...removals, entry];
        const uri = await save({ schemaVersion: 1, removals: next });
        if (!uri?.startsWith('ipfs://')) throw new Error('Campaign removal could not be durably saved');
        removals = next;
        return structuredClone(entry);
      });
      task = operation.catch(() => {});
      return operation;
    },
  };
}
