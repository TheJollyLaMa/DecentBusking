const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const PREFIX = 'decentbusking:personal-play:v1:';

function validate(session) {
  if (!session || !ADDRESS.test(session.payer) || !ADDRESS.test(session.contract) || !HASH.test(session.txHash) ||
      !['pending', 'confirmed', 'completed', 'failed'].includes(session.status) ||
      !Array.isArray(session.items) || !session.items.length || session.items.length > 50 ||
      session.items.some(item => !HASH.test(item.songId) || typeof item.audioUrl !== 'string' || !item.audioUrl) ||
      !Number.isInteger(session.index) || session.index < 0 || session.index >= session.items.length ||
      !Number.isFinite(session.position) || session.position < 0) {
    throw new Error('Saved Personal Play session is invalid. Do not purchase again; keep your transaction receipt.');
  }
  return session;
}

export function createPersonalPlayRecovery(storage = globalThis.localStorage) {
  const key = payer => {
    if (!ADDRESS.test(payer)) throw new Error('Connect the wallet that purchased Personal Play.');
    return `${PREFIX}${payer.toLowerCase()}`;
  };
  function list(payer) {
    const raw = storage.getItem(key(payer));
    if (!raw) return [];
    let sessions;
    try { sessions = JSON.parse(raw); }
    catch { throw new Error('Personal Play recovery data could not be read. Do not purchase again; keep your transaction receipt.'); }
    if (!Array.isArray(sessions)) throw new Error('Invalid Personal Play recovery data.');
    return sessions.map(validate).map(session => {
      if (session.payer.toLowerCase() !== payer.toLowerCase()) throw new Error('Personal Play recovery wallet mismatch.');
      return session;
    });
  }
  function write(payer, sessions) {
    try { storage.setItem(key(payer), JSON.stringify(sessions)); }
    catch { throw new Error('Personal Play recovery could not be saved. Enable browser storage before purchasing; if already paid, do not purchase again.'); }
  }
  function check(payer, songIds) {
    const sessions = list(payer);
    if (sessions.some(session => ['pending', 'confirmed'].includes(session.status) &&
        session.items.length === songIds.length &&
        session.items.every((item, index) => item.songId.toLowerCase() === songIds[index].toLowerCase()))) {
      throw new Error('This playlist already has an unfinished Personal Play purchase. Resume it in Profile → Playlists instead of paying again.');
    }
    write(payer, sessions);
  }
  function save({ payer, contract, txHash, items, name = 'Personal playlist' }) {
    const sessions = list(payer);
    if (sessions.some(session => session.txHash.toLowerCase() === txHash.toLowerCase())) return;
    const session = validate({ payer, contract, txHash, name, status: 'pending', index: 0, position: 0,
      items: items.map(item => ({ songId: item.songId, title: item.title || 'Untitled song',
        artist: item.artist || '', audioUrl: item.audioUrl, mediaType: item.mediaType || '' })) });
    write(payer, [...sessions.filter(entry => !['completed', 'failed'].includes(entry.status)), session]);
  }
  function update(payer, txHash, changes) {
    const sessions = list(payer);
    const session = sessions.find(entry => entry.txHash.toLowerCase() === txHash.toLowerCase());
    if (!session) throw new Error('Personal Play recovery session is missing. Do not purchase again.');
    Object.assign(session, changes);
    validate(session);
    write(payer, sessions);
    return session;
  }
  return { list, check, save, update };
}

export async function verifyPersonalPlaySession(session, provider) {
  if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Switch to Base to verify your Personal Play purchase.');
  const receipt = await provider.getTransactionReceipt(session.txHash);
  if (!receipt) throw new Error('Your purchase is still awaiting confirmation. Retry Resume later; do not pay again.');
  if (receipt.from?.toLowerCase() !== session.payer.toLowerCase() ||
      receipt.to?.toLowerCase() !== session.contract.toLowerCase()) throw new Error('Personal Play transaction does not match the saved purchase.');
  if (receipt.status !== 1) {
    const error = new Error('Your Personal Play transaction reverted; playback was not purchased.');
    error.code = 'PERSONAL_PLAY_REVERTED';
    throw error;
  }
  return receipt;
}
