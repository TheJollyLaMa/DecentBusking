// Shared browser protocol for the website and portable DBusk radio.
export function radioEndpoint(workerUrl) {
  return `${String(workerUrl || '').replace(/\/+$/, '')}/api/radio`;
}

export function radioMediaUrl(radioUrl, cid, { validate = true } = {}) {
  if (validate && !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(String(cid || ''))) return null;
  return `${radioUrl}/media?cid=${encodeURIComponent(cid)}`;
}

export async function readRadioState({ radioUrl, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(radioUrl, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const state = await response.json();
  if (!state || typeof state !== 'object' || !Object.hasOwn(state, 'nowPlaying')) {
    throw new Error('Invalid radio state');
  }
  return state;
}

export async function readRadioMediaBlob({ url, fetchImpl = fetch, signal, mime = '',
  maxBytes = 80 * 1024 * 1024, onProgress = () => {} }) {
  const response = await fetchImpl(url, { signal, mode: 'cors' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel?.();
    throw new Error('file is over the preload limit');
  }
  const chunks = [];
  let bytes = 0;
  const reader = response.body?.getReader?.();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error('file is over the preload limit');
        onProgress(bytes);
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    } finally { reader.releaseLock?.(); }
  } else {
    const buffer = await response.arrayBuffer();
    bytes = buffer.byteLength;
    if (bytes > maxBytes) throw new Error('file is over the preload limit');
    onProgress(bytes);
    chunks.push(buffer);
  }
  if (!bytes) throw new Error('empty radio recording');
  const type = mime || response.headers?.get?.('content-type') || '';
  return new Blob(chunks, type ? { type } : {});
}

export async function sendRadioVote({ radioUrl, playId, voterId, vote, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(`${radioUrl}/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playId, voterId, vote }),
    signal: signal || AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Voting failed (${response.status})`);
  return result;
}

export function radioListenerId(storage, cryptoImpl = globalThis.crypto) {
  let id;
  try { id = storage?.getItem('decentbusking:listener:v1'); } catch {}
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(id || '')) {
    id = cryptoImpl.randomUUID();
    try { storage?.setItem('decentbusking:listener:v1', id); } catch {}
  }
  return id;
}

export function readRadioVotes(storage, radioUrl) {
  try {
    const entries = JSON.parse(storage?.getItem(`decentbusking:votes:v1:${radioUrl}`) || '[]');
    return new Map(Array.isArray(entries) ? entries.slice(-100).filter(entry =>
      Array.isArray(entry) && typeof entry[0] === 'string' && (entry[1] === 1 || entry[1] === -1)) : []);
  } catch { return new Map(); }
}

export function saveRadioVotes(storage, radioUrl, votes) {
  while (votes.size > 100) votes.delete(votes.keys().next().value);
  try { storage?.setItem(`decentbusking:votes:v1:${radioUrl}`, JSON.stringify([...votes])); } catch {}
}

export async function readRadioNet({ radioUrl, track, fetchImpl = fetch, signal }) {
  if (track?.isDevert) {
    const tally = track.adVotes;
    return Number.isSafeInteger(tally?.up) && tally.up >= 0 &&
      Number.isSafeInteger(tally?.down) && tally.down >= 0 && tally.net === tally.up - tally.down ? tally.net : null;
  }
  if (!track?.trackId) return null;
  const response = await fetchImpl(`${radioUrl}/history?weeks=1&calendar=new-york`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const history = await response.json();
  const tracks = history.weeks?.find(entry => entry.current)?.tracks;
  if (!Array.isArray(tracks)) throw new Error('Weekly vote totals unavailable');
  const net = tracks.find(entry => entry.trackId === track.trackId)?.votes ?? 0;
  if (!Number.isSafeInteger(net)) throw new Error('Invalid net vote total');
  return net;
}

export function radioShowLabel(state) {
  return state?.activeShow?.title || state?.activeShow?.label || state?.activeShow?.name ||
    (state?.activeShow?.id === 'top10' ? 'Top 10' : state?.activeShow?.id === 'new' ? 'Songs Awaiting Your Vote' :
      state?.activeShow?.id ? String(state.activeShow.id) : 'Regular rotation');
}
