import test from 'node:test';
import assert from 'node:assert/strict';
import { createBilling } from '../billing.mjs';

test('billing reads only the configured project, paginates, caches and rolls over in UTC', async () => {
  let time = Date.parse('2026-11-30T23:59:50Z');
  const requests = [];
  const billing = createBilling({ apiKey: 'test-key', projectId: 'proj_test', monthlyBudget: 50, now: () => time,
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(url), init });
      const next = new URL(url).searchParams.has('page');
      return Response.json({ data: [{ results: [{ project_id: 'proj_test', amount: { currency: 'usd', value: next ? 0.4 : 1.2 } }] }],
        has_more: !next, next_page: next ? null : 'next' });
    } });
  const [first, concurrent] = await Promise.all([billing(), billing()]);
  assert.equal(first.spent, 1.6);
  assert.equal(concurrent.month, '2026-11');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.searchParams.get('project_ids[]'), 'proj_test');
  assert.equal(requests[0].url.searchParams.get('start_time'), String(Date.parse('2026-11-01T00:00:00Z') / 1000));
  assert.equal((await billing()).monthlyBudget, 50);
  assert.equal(requests.length, 2);
  time += 20_000;
  assert.equal((await billing()).month, '2026-12');
  assert.equal(requests.length, 4);
});

test('billing rejects unavailable, invalid and cross-project results instead of showing zero', async () => {
  const settings = { apiKey: 'test-key', projectId: 'proj_test', monthlyBudget: 50 };
  await assert.rejects(createBilling({ ...settings, apiKey: '' })(), /not configured/);
  await assert.rejects(createBilling({ ...settings, fetchImpl: async () => new Response('', { status: 403 }) })(), /HTTP 403/);
  await assert.rejects(createBilling({ ...settings, fetchImpl: async () => Response.json({
    data: [{ results: [{ project_id: 'proj_other', amount: { currency: 'usd', value: 1 } }] }], has_more: false,
  }) })(), /Invalid project billing amount/);
});
