export function createBilling({ apiKey, projectId, monthlyBudget, now = Date.now, fetchImpl = fetch }) {
  let cached = null, pending = null;
  return async function billing() {
    if (!apiKey || !/^proj_[a-z0-9]+$/i.test(projectId || '') ||
        !Number.isFinite(monthlyBudget) || monthlyBudget <= 0) {
      throw Object.assign(new Error('DBusker billing is not configured.'), { status: 503 });
    }
    const time = now(), date = new Date(time);
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    if (cached && cached.start === start && time >= cached.time && time - cached.time < 60_000) return cached.value;
    if (pending?.start === start) return pending.promise;
    const promise = (async () => {
      const params = new URLSearchParams({ start_time: String(Math.floor(start / 1000)), limit: '31' });
      params.append('project_ids[]', projectId);
      params.append('group_by[]', 'project_id');
      let total = 0, pageCount = 0;
      const cursors = new Set();
      while (true) {
        if (++pageCount > 10) throw new Error('Too many billing pages.');
        const response = await fetchImpl(`https://api.openai.com/v1/organization/costs?${params}`, {
          headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`Billing provider returned HTTP ${response.status}.`);
        const data = await response.json();
        if (!Array.isArray(data.data) || typeof data.has_more !== 'boolean') throw new Error('Invalid billing response.');
        for (const bucket of data.data) {
          if (!Array.isArray(bucket.results)) throw new Error('Invalid billing bucket.');
          for (const result of bucket.results) {
            if (result.project_id !== projectId || result.amount?.currency !== 'usd' ||
                !Number.isFinite(result.amount.value)) throw new Error('Invalid project billing amount.');
            total += result.amount.value;
          }
        }
        if (!data.has_more) break;
        if (typeof data.next_page !== 'string' || !data.next_page || cursors.has(data.next_page)) throw new Error('Invalid billing cursor.');
        cursors.add(data.next_page);
        params.set('page', data.next_page);
      }
      const value = { spent: total, monthlyBudget, currency: 'usd', month: new Date(start).toISOString().slice(0, 7),
        updatedAt: new Date(now()).toISOString() };
      if (Date.UTC(new Date(now()).getUTCFullYear(), new Date(now()).getUTCMonth(), 1) === start) {
        cached = { start, time: now(), value };
      }
      return value;
    })();
    pending = { start, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = null; }
  };
}
