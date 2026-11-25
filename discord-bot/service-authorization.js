import { timingSafeEqual } from 'node:crypto';

// Server-only bearer secrets for platform roles. The checkpoint mirror secret is accepted
// only while the role's dedicated secret is unset; once it is set, only that secret works.
export function createServiceAuthorization({ name, secret, legacySecret, log = console }) {
  const value = secret ? secret : legacySecret;
  const fail = () => { throw new Error(`${name} authorization failed`); };
  if (!value) return fail;
  if (Buffer.byteLength(value) < 32) {
    log.warn(`[auth] ${name} must be at least 32 bytes; requests are refused`);
    return fail;
  }
  if (!secret) log.warn(`[auth] ${name} is not set; accepting CHECKPOINT_MIRROR_SECRET until it is configured`);
  const expected = Buffer.from(`Bearer ${value}`);
  return authorization => {
    const actual = Buffer.from(String(authorization || ''));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail();
  };
}
