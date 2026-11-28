const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, access } = require('node:fs/promises');
const { join } = require('node:path');
const { createRequire } = require('node:module');

const root = join(__dirname, '..');
let chromium;
try {
  chromium = createRequire(join(root, 'discord-bot/package.json'))('playwright-core').chromium;
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');

test('calendar campaign popouts preserve preset terms and use the public unsigned snapshot', async t => {
  if (!chromium || !await access(chrome).then(() => true, () => false)) {
    return t.skip('Playwright and a Chromium executable are needed for this browser test');
  }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') {
      const index = await readFile(join(root, 'index.html'), 'utf8');
      const importMap = index.match(/<script type="importmap">[\s\S]*?<\/script>/)?.[0];
      if (!importMap) { res.writeHead(500); return res.end('Production import map not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html>${importMap}<link rel="stylesheet" href="/css/radio-programming.css"><main id="calendar"></main>`);
    }
    if (!/^\/(?:js|css)\/[\w.-]+$/.test(path)) { res.writeHead(404); return res.end(); }
    try {
      const content = await readFile(join(root, path));
      res.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : 'text/javascript' });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const start = Date.now() + 2 * 86400000;
    const source = { id: 'existing-referral', template: 'referral', title: 'Saved rush',
      criteria: 'Bring qualified referrals', terms: 'Reviewed terms', rewardUnits: '12000000',
      budgetUnits: '72000000', maxAwards: 6, fund: 'dbusk-promotionals',
      requiredReferrals: 4, activityWindow: 'offer-window', curatedReferrers: ['0x1234567890123456789012345678901234567890'],
      startsAt: new Date(start).toISOString(), endsAt: new Date(start + 38 * 86400000).toISOString(),
      claimDeadline: new Date(start + 45 * 86400000).toISOString(), status: 'draft', remainingAwards: 6,
      remainingUnits: '72000000', committedUnits: '0', approvedUnits: '0', paymentPendingUnits: '0',
      paidUnits: '0', applications: 0, awaitingReview: 0 };
    window.commands = [];
    window.mockState = { revision: 1, campaigns: [source], members: [], claims: [],
      funds: [{ slug: 'dbusk-promotionals', balanceUnits: '1000000000' }],
      features: { pinnerCampaign: 'pinner-days-v1' } };
    window.DecentConfig = { ipfsUploadServiceUrl: 'http://worker.test' };
    window._wallet = { address: '0x807061DF657A7697c04045dA7d16D941861cAABc',
      signer: { signMessage: async () => 'signature', provider: { getNetwork: async () => ({ chainId: 8453 }) } } };
    window.confirm = () => true;
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (String(url).includes('api.coinbase.com')) return Response.json({ data: { amount: '3000' } });
      if (!String(url).includes('worker.test/api/promotions')) return originalFetch(url, options);
      if (options?.method === 'POST') {
        const { command } = JSON.parse(options.body);
        window.commands.push(command);
        if (command.action === 'save') {
          const item = { ...command.campaign, id: command.campaignId || `saved-${window.commands.length}`,
            status: 'draft', remainingAwards: command.campaign.maxAwards, remainingUnits: command.campaign.budgetUnits,
            committedUnits: '0', approvedUnits: '0', paymentPendingUnits: '0', paidUnits: '0', applications: 0, awaitingReview: 0 };
          window.mockState.campaigns = window.mockState.campaigns.filter(c => c.id !== item.id).concat(item);
        } else if (command.action === 'status') {
          window.mockState.campaigns.find(c => c.id === command.campaignId).status = command.status;
        }
        window.mockState.revision++;
      }
      const response = structuredClone(window.mockState);
      if (!options?.method) delete response.funds;
      return Response.json(response);
    };
    const { mountRadioProgrammingCalendar } = await import('/js/radio-programming-calendar.mjs');
    const event = { id: source.id, title: source.title, status: source.status, startUtc: source.startsAt,
      endUtc: source.endsAt, remainingAwards: 6, campaign: source };
    mountRadioProgrammingCalendar(document.querySelector('#calendar'), {
      getSchedule: () => ({ ready: true, events: [], weeklySchedule: {}, promotionEvents: [event] }), save: async () => {},
    });
  });
  await page.getByRole('button', { name: 'Next week' }).click();
  const drop = async label => {
    await page.locator('summary[aria-label^="Campaign preset:"]').click();
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.evaluate(() => {
      const dataTransfer = new DataTransfer();
      document.querySelector('summary[aria-label^="Campaign preset:"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      document.querySelector('.radio-calendar-slot[data-minute="600"]').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
    });
    await page.waitForSelector('dialog[open]');
  };
  const close = async () => {
    await page.locator('dialog[open] [aria-label="Close"]').first().click();
    await page.waitForSelector('dialog[open]', { state: 'detached' });
  };
  for (const [label, template, field] of [
    ['Bring your album', 'album', 'minOriginalTracks'], ['Referral rush', 'referral', 'requiredReferrals'],
    ['Sponsor scout', 'sponsor', 'minPurchase'], ['Bring a band buddy', 'buddy', null],
    ['First sponsor match', 'sponsor-match', 'matchTargetFund'], ['Village listening session', 'session', null],
    ['Pin Reward Campaign', 'pinner', 'qualifyingDays'],
  ]) {
    await drop(label);
    const dialog = page.locator('dialog[open]');
    assert.ok(await dialog.evaluate(el => el.classList.contains('promotion-blob')));
    await dialog.getByText('Ready · changes require a signature.').waitFor();
    assert.match(await dialog.locator('[data-promo-funding]').textContent(), /Balance unavailable/);
    assert.equal(await dialog.locator('[name=template]').inputValue(), template);
    assert.ok((await dialog.locator('[name=startsAt]').inputValue()).endsWith('T10:00'));
    if (field) assert.equal(await dialog.locator(`[name=${field}]`).isEnabled(), true);
    if (template === 'pinner') {
      await dialog.locator('summary').filter({ hasText: 'Reward target' }).click();
      await dialog.locator('[name=reward]').fill('7');
      assert.match(await dialog.locator('summary').filter({ hasText: 'Total target cap' }).textContent(), /35/);
    }
    await dialog.locator('form button:not([type])').first().click();
    await page.waitForFunction(value => window.commands.some(c => c.action === 'save' && c.campaign.template === value), template);
    if (template === 'sponsor-match') {
      await dialog.getByText('Draft only · fund-to-fund delivery is not available.').waitFor();
      assert.equal(await dialog.locator('[data-promo-state=published]').count(), 0);
    } else await dialog.locator('[data-promo-state=published]').waitFor();
    const saved = await page.evaluate(value => window.commands.find(c => c.action === 'save' && c.campaign.template === value), template);
    if (template === 'referral') assert.equal(saved.campaign.requiredReferrals, 2);
    if (template === 'pinner') {
      assert.equal(saved.campaign.qualificationVersion, 'pinner-days-v1');
      assert.equal(saved.campaign.qualifyingDays, 30);
      assert.equal(saved.campaign.asset, 'eth');
      assert.equal(saved.campaign.rewardUsdCents, 700);
      await dialog.locator('[data-promo-state=published]').click();
      await page.waitForFunction(() => window.commands.some(c => c.action === 'status' && c.status === 'published'));
      const updates = await page.evaluate(() => window.commands.filter(c => c.action === 'save' && c.campaign.template === 'pinner'));
      assert.equal(updates.length, 2);
      assert.ok(updates[1].campaign.draftQuote.ethUsdMicros);
    }
    await close();
  }
  await drop('↻ Saved rush');
  assert.equal(await page.locator('dialog[open] [name=requiredReferrals]').inputValue(), '4');
  assert.equal(await page.locator('dialog[open] [name=activityWindow]').inputValue(), 'offer-window');
  await close();
  await page.getByRole('button', { name: /Saved rush.*DRAFT/ }).click();
  await page.waitForSelector('dialog[open] [data-promo-edit]');
  await page.locator('dialog[open] [data-promo-edit]').click();
  await page.locator('dialog[open] form button:not([type])').first().click();
  await page.waitForFunction(() => window.commands.some(c => c.action === 'save' && c.campaignId === 'existing-referral'));
  const edited = await page.evaluate(() => window.commands.find(c => c.action === 'save' && c.campaignId === 'existing-referral'));
  assert.deepEqual(edited.campaign.curatedReferrers, ['0x1234567890123456789012345678901234567890']);
  await close();
  await drop('Referral Campaign');
  assert.ok(await page.locator('dialog[open]').evaluate(el => el.classList.contains('referral-blob')));
  await close();
  await drop('Custom');
  assert.ok(await page.locator('dialog[open]').evaluate(el => el.classList.contains('promotion-calendar-editor-dialog')));
  assert.equal(await page.locator('dialog[open] [name=template]').inputValue(), 'custom');
  assert.equal(await page.locator('dialog[open] [name=template]').isVisible(), false);
  assert.equal(await page.locator('dialog[open] [data-promo-campaigns]').isVisible(), false);
  for (const [name, value] of Object.entries({ title: 'Custom event', criteria: 'Participate',
    terms: 'Reviewed terms', reward: '10', budget: '50' })) {
    await page.locator(`dialog[open] [name=${name}]`).fill(value);
  }
  await page.locator('dialog[open] form button:not([type])').first().click();
  await page.waitForFunction(() => window.commands.some(c => c.action === 'save' && c.campaign.template === 'custom'));
  await page.locator('dialog[open]').getByText('Draft saved. Select its calendar bar to review and publish it.').waitFor();
  await close();
  await page.evaluate(async () => {
    const source = window.mockState.campaigns.find(c => c.id === 'existing-referral');
    window.mockState.campaigns.push({ ...source, id: 'existing-musician', title: 'Referral Campaign',
      template: 'musician-referral', fund: 'dbusk-referrals', asset: 'eth',
      rewardUnits: '1000000000000000', budgetUnits: '6000000000000000', baseBudgetUnits: '6000000000000000',
      legAmounts: { referrer: '400000000000000', musician: '200000000000000',
        'dbusk-top10': '200000000000000', 'dbusk-playback': '200000000000000' },
      requiredVotes: 10, gifts: [], settlementVersion: 'eth-usdc-match-v1',
      supporterRewards: [{ chainId: 8453, contract: '0xe63ec9f8228720baac2fd528c0a6d06b3dc5439b', tokenId: '75', quantity: 1 }],
      fundMatchQuote: { ethUsdMicros: '3000000000', quotedAt: new Date().toISOString() },
      curatedReferrerNames: { '0x1234567890123456789012345678901234567890': 'Tester' } });
    const { openPromotionCalendarEditor } = await import('/js/promotions-ui.mjs?v=20261126-pinner-dashboard');
    openPromotionCalendarEditor({ campaignId: 'existing-musician', template: 'musician-referral', compact: true });
  });
  await page.waitForSelector('dialog[open] [data-promo-edit]');
  await page.locator('dialog[open] [data-promo-edit]').click();
  assert.equal(await page.locator('dialog[open] [name=reward]').inputValue(), '0.001');
  await page.locator('dialog[open] form button:not([type])').first().click();
  await page.waitForFunction(() => window.commands.some(c => c.action === 'save' && c.campaignId === 'existing-musician'));
  const musician = await page.evaluate(() => window.commands.find(c => c.action === 'save' && c.campaignId === 'existing-musician').campaign);
  assert.equal(musician.rewardUnits, '1000000000000000');
  assert.equal(musician.budgetUnits, '6000000000000000');
  assert.equal(musician.settlementVersion, 'eth-usdc-match-v1');
  assert.equal(musician.requiredVotes, 10);
  assert.equal(musician.supporterRewards[0].tokenId, '75');
  assert.equal(musician.curatedReferrerNames['0x1234567890123456789012345678901234567890'], 'Tester');
  await close();
  await page.setViewportSize({ width: 390, height: 844 });
  await drop('Pin Reward Campaign');
  const bounds = await page.locator('dialog[open]').boundingBox();
  assert.ok(bounds.width <= 390 && bounds.height <= 844);
  await close();
  assert.deepEqual(errors, []);
});
