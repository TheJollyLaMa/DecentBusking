import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { id, isAddress, verifyMessage } from 'ethers';
import { CONTENT_REASONS, contentAliases, contentAuthorization, contentKey, contentTarget } from '../js/content-review.mjs';

const scopes = ['none', 'music-only', 'all-radio'];
const states = ['new', 'in-review', 'actioned', 'dismissed'];
const text = (value, label, max = 1000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is required (max ${max} characters)`);
  return value.trim();
};

export function contentReviewCodec(keyHex) {
  if (!/^[0-9a-f]{64}$/i.test(keyHex || '')) throw new Error('CONTENT_REVIEW_STORAGE_KEY must be 32 random bytes in hex, privately backed up');
  const key = Buffer.from(keyHex, 'hex');
  return {
    serialize(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from('dbusk-content-review-v1'));
      const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return { schema: 'encrypted-content-review-v1', iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
    },
    deserialize(value) {
      if (value?.schema !== 'encrypted-content-review-v1') throw new Error('Invalid encrypted content review checkpoint');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
      decipher.setAAD(Buffer.from('dbusk-content-review-v1'));
      decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString());
    },
  };
}

function validateState(state) {
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Array.isArray(state.items) || !Array.isArray(state.reports) || !Array.isArray(state.history) ||
      state.items.length > 10000 || state.reports.length > 20000 || state.history.length > 30000) {
    throw new Error('Invalid content review checkpoint; restore a verified backup');
  }
  const keys = new Set();
  for (const item of state.items) {
    if (contentKey(item.target) !== item.key || keys.has(item.key) || !Array.isArray(item.aliases) ||
        !item.aliases.includes(item.key) || item.aliases.some(alias => typeof alias !== 'string') ||
        !scopes.includes(item.scope) || !['original', 'song', 'advert'].includes(item.classification)) {
      throw new Error('Invalid content review policy');
    }
    keys.add(item.key);
  }
  const ids = new Set();
  for (const report of state.reports) {
    if (typeof report.id !== 'string' || ids.has(report.id) || !keys.has(report.key) ||
        !CONTENT_REASONS.includes(report.reason) || !states.includes(report.status) ||
        !isAddress(report.reporter) || !Number.isFinite(Date.parse(report.at)) ||
        typeof report.note !== 'string' || report.note.length > 1000 ||
        report.reason === 'other' && !report.note.trim()) throw new Error('Invalid content review report');
    ids.add(report.id);
  }
  for (const entry of state.history) {
    if (!keys.has(entry.key) || !isAddress(entry.reviewer) || !Number.isFinite(Date.parse(entry.at)) ||
        !['policy', 'report'].includes(entry.action)) throw new Error('Invalid content review history');
    text(entry.reason, 'Review history reason');
  }
}

export function createContentReview({ store, getItems, ownerWallet, onChange = async () => {}, now = Date.now,
  verifySignature = verifyMessage }) {
  if (!isAddress(ownerWallet)) throw new Error('Content review requires the configured admin wallet');
  let state = { schemaVersion: 1, revision: 0, items: [], reports: [], history: [] };
  let ready = false, fault = '', initialization, serial = Promise.resolve();
  const run = fn => {
    const result = serial.then(fn);
    serial = result.catch(() => {});
    return result;
  };
  const assertReady = () => {
    if (!ready || fault) throw new Error(fault || 'Content review is restoring or encrypted storage is unavailable');
  };
  const initialize = () => initialization ||= (async () => {
    if (!store) throw new Error('Content review requires encrypted checkpoint storage');
    const restored = await store.restore();
    if (restored) { validateState(restored); state = restored; }
    ready = true;
  })();
  function apply(item) {
    assertReady();
    const aliases = contentAliases(item);
    const matches = state.items.filter(policy => policy.aliases.some(alias => aliases.includes(alias)));
    const scope = matches.some(p => p.scope === 'all-radio') ? 'all-radio'
      : matches.some(p => p.scope === 'music-only') ? 'music-only' : 'none';
    const classification = matches.findLast(p => p.classification !== 'original')?.classification;
    return { ...item, ...(classification ? { isDevertAd: classification === 'advert' } : {}),
      contentReview: { scope, classification: classification || 'original' } };
  }
  async function catalog() {
    assertReady();
    const seen = new Set();
    return (await getItems()).filter(item => {
      const key = contentKey(contentTarget(item));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  async function resolve(target) {
    const key = contentKey(target);
    const item = (await catalog()).find(item => contentAliases(item).includes(key));
    if (!item) throw new Error('Recording is not in the platform catalog; refresh before reporting');
    const canonicalTarget = contentTarget(item);
    const canonicalKey = contentKey(canonicalTarget);
    return { key: canonicalKey, target: canonicalTarget, aliases: [...new Set([key, canonicalKey, ...contentAliases(item)])],
      title: item.title || item.name || item.filename || key, item };
  }
  async function adminState() {
    return { revision: state.revision, items: (await catalog()).map(item => ({
      target: contentTarget(item), key: contentKey(contentTarget(item)), title: item.title || item.name || item.filename,
      ...apply(item), reports: state.reports.filter(r => {
        const policy = state.items.find(p => p.key === r.key);
        return policy?.aliases.some(alias => contentAliases(item).includes(alias));
      }),
    })), history: state.history };
  }
  async function execute(body, origin) {
    return run(async () => {
      assertReady();
      const { address, command, issuedAt, signature } = body;
      if (!isAddress(address) || body.origin !== origin || !Number.isFinite(Date.parse(issuedAt)) ||
          Math.abs(now() - Date.parse(issuedAt)) > 300000 ||
          verifySignature(contentAuthorization(body), signature).toLowerCase() !== address.toLowerCase()) {
        throw new Error('Invalid or expired content review authorization');
      }
      const admin = address.toLowerCase() === ownerWallet.toLowerCase();
      if (command?.action === 'view') {
        if (!admin) throw new Error('Only the admin can view reports');
        return adminState();
      }
      if (!['report', 'policy', 'review-report'].includes(command?.action)) throw new Error('Unknown content review action');
      if (command.action !== 'report' && !admin) throw new Error('Only the admin can moderate recordings');
      if (admin && command.action !== 'report' && command.revision !== state.revision) throw new Error('Review changed; refresh before retrying');
      const next = structuredClone(state);
      let changedPolicy = false;
      if (command.action === 'review-report') {
        const report = next.reports.find(r => r.id === command.reportId);
        if (!report || !states.includes(command.status)) throw new Error('Invalid report review');
        const reason = text(command.reason, 'Admin reason');
        next.history.push({ key: report.key, action: 'report', reviewer: address.toLowerCase(),
          reason, at: new Date(now()).toISOString(), before: report.status, after: command.status });
        report.status = command.status;
      } else {
        const resolved = await resolve(command.target);
        let policy = next.items.find(p => p.key === resolved.key);
        if (!policy) {
          policy = { key: resolved.key, target: resolved.target, aliases: resolved.aliases,
            classification: 'original', scope: 'none' };
          next.items.push(policy);
        }
        if (command.action === 'report') {
          if (next.reports.some(report => report.authorizationHash === id(signature))) throw new Error('Report authorization already used');
          if (!CONTENT_REASONS.includes(command.reason)) throw new Error('Choose a report reason');
          const note = command.reason === 'other' ? text(command.note, 'Explanation') : '';
          const recent = next.reports.filter(r => r.reporter === address.toLowerCase() && now() - Date.parse(r.at) < 3600000);
          if (recent.length >= 10) throw new Error('Report limit reached; retry in an hour');
          if (next.reports.some(r => r.key === policy.key && r.reporter === address.toLowerCase() &&
              r.reason === command.reason && ['new', 'in-review'].includes(r.status))) {
            throw new Error('You already submitted this report; it is awaiting review');
          }
          next.reports.push({ id: randomUUID(), key: policy.key, reason: command.reason, note,
            reporter: address.toLowerCase(), at: new Date(now()).toISOString(), status: 'new', authorizationHash: id(signature) });
        } else {
          if (!scopes.includes(command.scope) || !['original', 'song', 'advert'].includes(command.classification) ||
              typeof command.stopNow !== 'boolean') throw new Error('Invalid classification or radio scope');
          const reason = text(command.reason, 'Admin reason');
          const before = { classification: policy.classification, scope: policy.scope };
          // Policies sharing a recording must not leave a conflicting exclusion behind.
          for (const existing of next.items.filter(p => p.aliases.some(alias => resolved.aliases.includes(alias)))) {
            existing.scope = command.scope;
            existing.classification = command.classification;
          }
          next.history.push({ key: policy.key, action: 'policy', reviewer: address.toLowerCase(),
            reason, at: new Date(now()).toISOString(), before,
            after: { classification: command.classification, scope: command.scope }, stopNow: command.stopNow });
          changedPolicy = true;
        }
      }
      next.revision++;
      validateState(next);
      try {
        const uri = await store.save(next);
        if (!String(uri).startsWith('ipfs://')) throw new Error('Checkpoint receipt is missing');
      } catch (error) {
        fault = `Content review checkpoint is uncertain: ${error.message}. Further writes and playback selections are blocked; restore/restart before retrying.`;
        console.error(fault);
        throw new Error(fault);
      }
      state = next;
      if (changedPolicy) {
        try { await onChange({ stopNow: command.stopNow }); }
        catch (error) { throw new Error(`Policy saved, but playback refresh failed: ${error.message}. Refresh review and retry playback refresh.`); }
      }
      return command.action === 'report' ? { submitted: true } : adminState();
    });
  }
  return { initialize, apply, execute, adminState };
}
