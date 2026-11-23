// One free signature tags a listener's radio votes with their wallet for 7 days.
// The signed message itself is the pass, so the worker needs no secret and passes survive restarts.
export const VOTE_PASS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TITLE = 'DecentBusking listener sign-in';
const NOTE = 'Tags my radio votes with this wallet for 7 days. Free: no transaction, no payment.';
const FIELDS = ['Wallet', 'Listener', 'Origin', 'Issued', 'Expires'];

export function votePassMessage({ wallet, listener, origin, issuedAt, expiresAt }) {
  return [TITLE, NOTE, `Wallet: ${String(wallet).toLowerCase()}`, `Listener: ${listener}`, `Origin: ${origin}`,
    `Issued: ${issuedAt}`, `Expires: ${expiresAt}`].join('\n');
}

export function parseVotePass(message) {
  const lines = String(message || '').split('\n');
  if (lines.length !== 7 || lines[0] !== TITLE || lines[1] !== NOTE) return null;
  const values = {};
  for (const [index, field] of FIELDS.entries()) {
    const line = lines[index + 2];
    if (!line.startsWith(`${field}: `)) return null;
    values[field] = line.slice(field.length + 2);
  }
  const pass = { wallet: values.Wallet, listener: values.Listener, origin: values.Origin,
    issuedAt: values.Issued, expiresAt: values.Expires };
  return votePassMessage(pass) === message ? pass : null;
}

const storageKey = wallet => `dbusk-vote-pass:${String(wallet).toLowerCase()}`;
const declinedKey = wallet => `dbusk-vote-pass-declined:${String(wallet).toLowerCase()}`;

export function storedVotePass({ wallet, listener, origin, storage, now = Date.now() }) {
  try {
    const pass = JSON.parse(storage?.getItem(storageKey(wallet)) || 'null');
    const fields = parseVotePass(pass?.message);
    if (fields && fields.wallet === String(wallet).toLowerCase() && fields.listener === listener &&
        fields.origin === origin && Date.parse(fields.expiresAt) - now > 60_000 && /^0x[0-9a-fA-F]+$/.test(pass.signature)) {
      return { message: pass.message, signature: pass.signature };
    }
  } catch {}
  return null;
}

export function forgetVotePass(wallet, storage) {
  try { storage?.removeItem(storageKey(wallet)); } catch {}
}

/**
 * Returns a valid pass for the connected wallet, asking for one signature when none is stored.
 * Returns null without a wallet, or when the listener declines (asked again next browser session).
 */
export async function ensureVotePass({ wallet, signer, listener, origin, storage, session, now = Date.now(), onSign = () => {} }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || '') || !signer) return null;
  const stored = storedVotePass({ wallet, listener, origin, storage, now });
  if (stored) return stored;
  try { if (session?.getItem(declinedKey(wallet))) return null; } catch {}
  const message = votePassMessage({ wallet, listener, origin, issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + VOTE_PASS_TTL_MS).toISOString() });
  try {
    onSign();
    const signature = await signer.signMessage(message);
    try { storage?.setItem(storageKey(wallet), JSON.stringify({ message, signature })); } catch {}
    return { message, signature };
  } catch {
    try { session?.setItem(declinedKey(wallet), '1'); } catch {}
    return null;
  }
}
