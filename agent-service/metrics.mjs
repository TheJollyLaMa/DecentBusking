import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHandoff, directory } from './handoff.mjs';

export function createMetrics(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS route_totals (
    digest TEXT NOT NULL, mode TEXT NOT NULL, task TEXT NOT NULL, tier TEXT NOT NULL,
    model TEXT NOT NULL, attempt INTEGER NOT NULL, outcome TEXT NOT NULL,
    calls INTEGER NOT NULL, latency_ms INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL, usage_missing INTEGER NOT NULL,
    PRIMARY KEY (digest, mode, task, tier, model, attempt, outcome)
  )`);
  const record = db.prepare(`INSERT INTO route_totals VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT (digest, mode, task, tier, model, attempt, outcome) DO UPDATE SET
    calls=calls+1, latency_ms=latency_ms+excluded.latency_ms,
    input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
    usage_missing=usage_missing+excluded.usage_missing`);
  return {
    record({ digest, route, attempt, outcome, latencyMs, usage }) {
      record.run(digest, route.mode, route.task, route.tier, route.model, attempt, outcome,
        Math.max(0, Math.round(latencyMs)), usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage ? 0 : 1);
    },
  };
}

export function routingReport(db, pack) {
  const totals = db.prepare('SELECT * FROM route_totals WHERE digest = ? ORDER BY mode, task, tier, attempt, outcome').all(pack.digest);
  const groups = new Map();
  for (const row of totals.filter(row => row.attempt === 1)) {
    const key = `${row.mode}:${row.task}:${row.tier}`;
    const group = groups.get(key) || { mode: row.mode, task: row.task, tier: row.tier, calls: 0, review: 0, evidenceLimits: 0 };
    group.calls += row.calls;
    if (row.outcome === 'needs_deeper_review') group.review += row.calls;
    if (row.outcome === 'insufficient_evidence') group.evidenceLimits += row.calls;
    groups.set(key, group);
  }
  const recommendations = [...groups.values()].map(group => {
    const routeTotals = totals.filter(row => row.mode === group.mode && row.task === group.task);
    const sum = (field, predicate = () => true) => routeTotals.filter(predicate).reduce((total, row) => total + row[field], 0);
    const providerCalls = sum('calls'), failures = sum('calls', row => row.outcome === 'error');
    const reviewRate = group.review / group.calls, failureRate = failures / providerCalls;
    const evidenceLimitRate = group.evidenceLimits / group.calls;
    const { minSamples, reviewRate: reviewThreshold, failureRate: failureThreshold } = pack.routing.recommendations;
    let action = 'Keep collecting steward-evaluated examples; these counters do not establish answer quality or optimality.';
    if (group.calls < minSamples) action = `Insufficient samples: collect at least ${minSamples} first passes before considering a routing change.`;
    else if (failureRate >= failureThreshold) action = 'Investigate provider/configuration errors before changing models; no automatic retry or promotion.';
    else if (evidenceLimitRate >= reviewThreshold) action = 'Review source coverage and stale/live-state questions before buying more compute; model promotion cannot supply missing evidence.';
    else if (reviewRate >= reviewThreshold) action = group.mode === 'balanced' && group.tier !== 'deep'
      ? 'Test a higher starting tier against the same steward evaluation questions; approve a policy change only if quality, tokens and latency justify it.'
      : 'Review difficult cases with the steward; more compute is not proof of better evidence.';
    return {
      ...group, providerCalls, failures, reviewRate, failureRate, evidenceLimitRate,
      deeperPasses: sum('calls', row => row.attempt === 2),
      deeperReady: sum('calls', row => row.attempt === 2 && row.outcome === 'ready'),
      cancelled: sum('calls', row => row.outcome === 'cancelled'),
      meanProviderLatencyMs: sum('latency_ms') / providerCalls,
      inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), usageMissing: sum('usage_missing'), action,
    };
  });
  return {
    digest: pack.digest, policy: pack.routing, totals, recommendations,
    learning: 'Recommendations only. No prompts, answers, wallet IDs, individual timestamps, or automatic policy changes. Self-checks are not independent correctness judgments. Token totals with missing usage are lower bounds, not dollar costs.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = new DatabaseSync(path.resolve(process.env.DBUSKER_STATE_FILE || path.join(directory, 'state.sqlite')), { readOnly: true });
  try { console.log(JSON.stringify(routingReport(db, readHandoff()), null, 2)); }
  finally { db.close(); }
}
