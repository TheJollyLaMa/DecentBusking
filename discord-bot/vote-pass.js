import { verifyMessage } from 'ethers';
import { VOTE_PASS_TTL_MS, parseVotePass } from '../js/vote-pass.mjs';

/** Verifies listener vote passes, caching recovered signatures so each vote stays cheap. */
export function createVotePassVerifier({ now = Date.now, verify = verifyMessage } = {}) {
  const verified = new Map();
  return function walletForVote({ pass, voterId, origin }) {
    if (!pass) return '';
    const fields = parseVotePass(pass.message);
    if (!fields || typeof pass.signature !== 'string') throw new Error('Wallet pass is malformed');
    const issued = Date.parse(fields.issuedAt), expires = Date.parse(fields.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now() + 300_000 ||
        expires <= now() || expires - issued > VOTE_PASS_TTL_MS) throw new Error('Wallet pass expired');
    if (fields.origin !== origin) throw new Error('Wallet pass was signed for another site');
    if (fields.listener !== voterId) throw new Error('Wallet pass belongs to another browser');
    if (!/^0x[0-9a-f]{40}$/.test(fields.wallet)) throw new Error('Wallet pass is malformed');
    const key = `${pass.signature}:${pass.message}`;
    if (!verified.has(key)) {
      if (String(verify(pass.message, pass.signature)).toLowerCase() !== fields.wallet) throw new Error('Wallet pass signature does not match');
      if (verified.size >= 5000) verified.delete(verified.keys().next().value);
      verified.set(key, fields.wallet);
    }
    return verified.get(key);
  };
}
