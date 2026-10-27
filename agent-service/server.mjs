import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getAddress } from 'ethers';
import { SiweMessage } from 'siwe';
import { directory, readHandoff, isApproved, questionInstructions } from './handoff.mjs';
import { askModel } from './model.mjs';
import { createRetriever } from './knowledge.mjs';
import { MODES, selectRoute, deeperRoute, fitContext, finalAnswer } from './routing.mjs';
import { createMetrics } from './metrics.mjs';

const SESSION_MS = 15 * 60 * 1000;
const NONCE_MS = 5 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const problem = (status, message) => Object.assign(new Error(message), { status });
const token = () => randomBytes(32).toString('hex');

export function loadSettings(env = process.env) {
  const site = new URL(env.DBUSKER_SITE_URL || 'http://localhost:8080');
  if (site.username || site.password || site.search || site.hash) throw new Error('Site URL must not contain credentials, query or fragment');
  if (site.protocol !== 'https:' && !(site.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(site.hostname))) throw new Error('Site URL requires HTTPS outside localhost');
  const maxCalls = Number(env.DBUSKER_MAX_CALLS || 100);
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10000) throw new Error('Invalid DBUSKER_MAX_CALLS');
  if (env.DBUSKER_MODEL) throw new Error('DBUSKER_MODEL has been replaced by reviewed handoff/routing.json; remove the environment override.');
  return {
    enabled: env.DBUSKER_ENABLED === 'true', siteUrl: site.href, origin: site.origin,
    domain: site.host, apiKey: env.OPENAI_API_KEY || '',
    accessFile: path.resolve(env.DBUSKER_ACCESS_FILE || path.join(directory, 'access.json')),
    approvalFile: path.resolve(env.DBUSKER_APPROVAL_FILE || path.join(directory, 'approval.json')),
    stateFile: path.resolve(env.DBUSKER_STATE_FILE || path.join(directory, 'state.sqlite')), maxCalls,
  };
}

export function createAgentServer(settings, { modelCall = askModel, now = Date.now, logger = console } = {}) {
  const pack = readHandoff();
  const retrieve = createRetriever(pack.sources, pack.topics);
  const db = new DatabaseSync(settings.stateFile);
  chmodSync(settings.stateFile, 0o600);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), calls INTEGER NOT NULL); INSERT OR IGNORE INTO budget VALUES (1,0)');
  const metrics = createMetrics(db);
  const reserve = db.prepare('UPDATE budget SET calls=calls+1 WHERE id=1 AND calls < ? RETURNING calls');
  const challenges = new Map(), sessions = new Map(), rates = new Map(), active = new Map();
  let closed = false;
  function access() {
    const value = JSON.parse(readFileSync(settings.accessFile, 'utf8'));
    if (typeof value.enabled !== 'boolean' || !Array.isArray(value.wallets) ||
        value.wallets.some(wallet => typeof wallet !== 'string')) throw new Error('Invalid access file');
    return { enabled: value.enabled, wallets: new Set(value.wallets.map(wallet => getAddress(wallet).toLowerCase())) };
  }
  function ready() {
    if (!settings.enabled) throw problem(503, 'DBusker is disabled pending steward review.');
    if (!settings.apiKey) throw problem(503, 'DBusker model credentials are not configured.');
    if (!isApproved(pack, settings.approvalFile) || readHandoff().digest !== pack.digest) {
      throw problem(503, 'DBusker handoff needs review and service restart.');
    }
    if (!access().enabled) throw problem(503, 'DBusker has been paused by the steward.');
  }
  function limit(key, ceiling) {
    const time = now();
    let entry = rates.get(key);
    if (!entry || entry.expires <= time) {
      if (rates.size >= 10000) throw problem(503, 'Sign-in capacity reached. Try later.');
      entry = { count: 0, expires: time + 60_000 };
      rates.set(key, entry);
    }
    if (++entry.count > ceiling) throw problem(429, 'Please wait a minute before trying again.');
  }
  function authorized(request) {
    const credential = request.headers.authorization;
    if (!/^Bearer [a-f0-9]{64}$/.test(credential || '')) throw problem(401, 'Please sign in to DBusker.');
    const key = hash(credential.slice(7));
    const session = sessions.get(key);
    if (!session || session.expires <= now()) throw problem(401, 'Your chat sign-in has expired.');
    if (!access().wallets.has(session.wallet)) {
      sessions.delete(key);
      throw problem(403, 'This wallet no longer has DBusker access.');
    }
    return { key, session };
  }
  async function body(request) {
    if (request.headers['content-type'] !== 'application/json') throw problem(415, 'Expected application/json.');
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16000) throw problem(413, 'Request is too large.');
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw problem(400, 'Invalid JSON request.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw problem(400, 'Expected a JSON object.');
    return result;
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      }
    };
    try {
      if (request.url === '/health' && request.method === 'GET') return send(200, { status: 'running', enabled: settings.enabled });
      if (request.headers.origin !== settings.origin) throw problem(403, 'Site origin is not allowed.');
      response.setHeader('Access-Control-Allow-Origin', settings.origin);
      response.setHeader('Vary', 'Origin');
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        response.writeHead(204); response.end(); return;
      }
      if (request.method === 'DELETE' && request.url === '/session') {
        const { key } = authorized(request);
        active.get(key)?.abort(problem(401, 'Signed out.'));
        sessions.delete(key);
        return send(200, { cleared: true });
      }
      ready();
      if (request.url === '/challenge' && request.method === 'POST') {
        limit(`ip:${request.socket.remoteAddress}`, 15);
        const { address, chainId } = await body(request);
        let wallet;
        try { wallet = getAddress(address); } catch { throw problem(400, 'Invalid wallet address.'); }
        if (chainId !== 8453) throw problem(400, 'Connect your wallet to Base before signing in.');
        if (!access().wallets.has(wallet.toLowerCase())) throw problem(403, 'This wallet is not invited to DBusker yet.');
        if (challenges.size >= 1000 || sessions.size >= 1000) throw problem(503, 'Sign-in capacity reached.');
        const nonce = token();
        const message = new SiweMessage({
          domain: settings.domain, address: wallet,
          statement: 'Sign in to DBusker chat. No transaction, payment or token approval.',
          uri: settings.siteUrl, version: '1', chainId: 8453, nonce,
          issuedAt: new Date(now()).toISOString(), expirationTime: new Date(now() + NONCE_MS).toISOString(),
        }).prepareMessage();
        challenges.set(nonce, { wallet: wallet.toLowerCase(), message, expires: now() + NONCE_MS });
        return send(200, { message });
      }
      if (request.url === '/session' && request.method === 'POST') {
        limit(`ip:${request.socket.remoteAddress}`, 15);
        const payload = await body(request);
        let parsed;
        try { parsed = new SiweMessage(payload.message); } catch { throw problem(400, 'Invalid sign-in message.'); }
        const challenge = challenges.get(parsed.nonce);
        challenges.delete(parsed.nonce);
        if (!challenge || challenge.expires <= now() || challenge.message !== payload.message) throw problem(401, 'Sign-in challenge expired or already used.');
        try {
          await parsed.verify({ signature: payload.signature, domain: settings.domain, nonce: parsed.nonce,
            time: new Date(now()).toISOString() });
        } catch { throw problem(401, 'Wallet signature could not be verified.'); }
        ready();
        if (!access().wallets.has(challenge.wallet)) throw problem(403, 'This wallet is not invited to DBusker.');
        const credential = token(), expires = now() + SESSION_MS;
        sessions.set(hash(credential), { wallet: challenge.wallet, expires, messages: [], calls: 0 });
        return send(200, { token: credential, expiresAt: expires, wallet: challenge.wallet,
          handoff: { digest: pack.digest, commit: pack.commit, indexedAt: pack.indexedAt } });
      }
      if (request.url === '/chat' && request.method === 'POST') {
        const { key, session } = authorized(request);
        limit(`wallet:${session.wallet}`, 6);
        if (active.has(key)) throw problem(409, 'Wait for your current answer.');
        if (active.size >= 3) throw problem(429, 'DBusker is busy. Please try shortly.');
        if (session.calls >= 20) throw problem(429, 'This session has reached its pilot limit.');
        const { message, consent, mode = 'balanced' } = await body(request);
        if (consent !== true) throw problem(400, 'Consent to send messages to the model provider is required.');
        if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw problem(400, 'Enter a question of 1-2000 characters.');
        if (!MODES.includes(mode)) throw problem(400, 'Choose Efficient, Balanced or Deep dive.');
        if (active.has(key)) throw problem(409, 'Wait for your current answer.');
        if (active.size >= 3) throw problem(429, 'DBusker is busy. Please try shortly.');
        const sources = retrieve(message, session.messages);
        const instructions = questionInstructions(pack, message, session.messages);
        const messages = [...session.messages, { role: 'user', content: message.trim() }].slice(-7);
        let route = selectRoute(pack.routing, mode, message, session.task);
        if (!sources.length) {
          const answer = 'I could not find approved public evidence for this question. Try naming the feature or code symbol, or use the public newcomer guide and community links. I cannot verify live balances, payouts or deployment state.';
          session.messages = [...messages, { role: 'assistant', content: answer }].slice(-6);
          session.task = route.task;
          return send(200, { answer, abstained: true, sources: [], handoffDigest: pack.digest,
            routing: { mode, task: route.task, models: [], tiers: [], attempts: 0, review: 'insufficient_evidence', escalation: 'missing_evidence' } });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(problem(504, 'DBusker took too long. Please try again.')), 45000);
        const disconnect = () => { if (!response.writableEnded) controller.abort(problem(499, 'Visitor disconnected.')); };
        response.on('close', disconnect);
        active.set(key, controller);
        try {
          let candidate, context, draft;
          const used = [];
          for (let attempt = 1; attempt <= 2; attempt++) {
            controller.signal.throwIfAborted();
            ready();
            authorized(request);
            context = fitContext({ instructions, sources, messages, draft });
            if (session.calls >= 20) throw problem(429, 'This session has reached its pilot provider-call limit.');
            if (!reserve.get(settings.maxCalls)) throw problem(429, 'The pilot usage budget is exhausted. Please contact the steward.');
            session.calls++;
            used.push(route);
            const started = performance.now();
            let outcome = 'error', usage = null;
            try {
              candidate = await modelCall({ ...context, apiKey: settings.apiKey, model: route.model, signal: controller.signal });
              controller.signal.throwIfAborted();
              outcome = candidate.review;
              usage = candidate.usage;
            } catch (error) {
              if (controller.signal.aborted) outcome = 'cancelled';
              throw controller.signal.aborted ? controller.signal.reason : error;
            } finally {
              metrics.record({ digest: pack.digest, route, attempt, outcome, usage, latencyMs: performance.now() - started });
            }
            const next = deeperRoute(pack.routing, route, candidate.review, attempt);
            if (!next) break;
            draft = { answer: candidate.answer, review: candidate.review, sourceIds: candidate.sources.map(source => source.id) };
            route = next;
          }
          controller.signal.throwIfAborted();
          ready();
          authorized(request);
          const answer = finalAnswer(candidate);
          session.messages = [...context.messages, { role: 'assistant', content: answer.answer }].slice(-6);
          session.task = route.task;
          return send(200, { answer: answer.answer, sources: answer.sources, abstained: answer.abstained,
            handoffDigest: pack.digest, routing: {
              mode, task: route.task, models: used.map(item => item.model), tiers: used.map(item => item.tier),
              attempts: used.length, review: answer.review,
              escalation: used.length > 1 ? 'used' : answer.review === 'needs_deeper_review'
                ? (mode === 'balanced' ? 'tier_limit' : 'mode_limit') : 'not_needed',
            } });
        } finally {
          clearTimeout(timeout);
          response.off('close', disconnect);
          active.delete(key);
        }
      }
      throw problem(404, 'Unknown DBusker endpoint.');
    } catch (error) {
      const status = error.status || 503;
      // Do not log prompts, signatures, tokens, addresses, or provider response bodies.
      logger.error(`[dbusker] request failed (${status}): ${error.status ? error.message : 'service dependency failure'}`);
      send(status, { error: error.status ? error.message : 'DBusker is unavailable. Please try later or contact the steward.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const sweep = setInterval(() => {
    for (const [key, challenge] of challenges) if (challenge.expires <= now()) challenges.delete(key);
    for (const [key, entry] of rates) if (entry.expires <= now()) rates.delete(key);
    for (const [key, session] of sessions) if (session.expires <= now()) sessions.delete(key);
    for (const [key, controller] of active) {
      try {
        ready();
        const session = sessions.get(key);
        if (!session || !access().wallets.has(session.wallet)) throw problem(403, 'DBusker access has ended.');
      } catch {
        controller.abort(problem(403, 'DBusker access ended or the service was paused.'));
      }
    }
  }, 1000).unref();
  server.on('close', () => {
    clearInterval(sweep);
    for (const controller of active.values()) controller.abort(problem(503, 'DBusker is shutting down.'));
    if (!closed) { db.close(); closed = true; }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = loadSettings();
  const server = createAgentServer(settings);
  server.listen(Number(process.env.DBUSKER_PORT || 8788), process.env.DBUSKER_HOST || '127.0.0.1', () => {
    console.log(`[dbusker] listening; live chat ${settings.enabled ? 'enabled subject to approval/access checks' : 'disabled'}`);
  });
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => server.close());
}
