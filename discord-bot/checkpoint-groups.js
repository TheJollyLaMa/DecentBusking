export async function ensureCheckpointGroups({ pinataJwt, fetchImpl = fetch,
  apiUrl = 'https://api.pinata.cloud/v3/groups/public' }) {
  const headers = { authorization: `Bearer ${pinataJwt}`, 'content-type': 'application/json' };
  async function ensure(name) {
    let token;
    const seen = new Set();
    do {
      const url = new URL(apiUrl);
      url.searchParams.set('name', name);
      url.searchParams.set('limit', '100');
      if (token) url.searchParams.set('pageToken', token);
      const response = await fetchImpl(url.toString(), { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Pinata checkpoint group listing failed (${response.status})`);
      const result = await response.json();
      const existing = result.data?.groups?.find(group => group.name === name);
      if (existing?.id) return existing.id;
      token = result.data?.next_page_token;
      if (token && seen.has(token)) throw new Error('Pinata group listing repeated a page token');
      if (token) seen.add(token);
    } while (token);
    const response = await fetchImpl(apiUrl, { method: 'POST', headers, body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Pinata checkpoint group creation failed (${response.status})`);
    const result = await response.json();
    if (!result.data?.id) throw new Error('Pinata checkpoint group creation returned no ID');
    return result.data.id;
  }
  return { groupId: await ensure('DecentBusking - Live checkpoints'),
    archiveGroupId: await ensure('DecentBusking - Weekly archives'), retentionDays: 7 };
}
