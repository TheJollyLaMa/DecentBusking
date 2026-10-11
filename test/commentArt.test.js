const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ENS_ETH_LOGO_URL,
  ARTWORKS,
  artworkIndex,
  renderArtFiComment,
  renderArtworkTable,
  selectArtwork,
} = require('../scripts/commentArt');
const { buildMergedPayrollComment } = require('../scripts/processMergedBounty');
const { buildTestingComment } = require('../scripts/processTestingBounty');
const { buildSettlementComment } = require('../scripts/settlePayroll');

test('contains 25 unique visible 10x10 branded emoji scenes', () => {
  assert.equal(ARTWORKS.length, 25);
  assert.equal(new Set(ARTWORKS.map(artwork => artwork.name)).size, 25);
  assert.equal(new Set(ARTWORKS.map(artwork => JSON.stringify(artwork.rows))).size, 25);
  for (const artwork of ARTWORKS) {
    assert.equal(artwork.rows.length, 10, artwork.name);
    for (const row of artwork.rows) assert.equal(row.length, 10, artwork.name);
    assert.ok(artwork.rows.flat().includes('🟢'));
    assert.ok(artwork.rows.flat().includes('💠'));
  }
});

test('selects scenes deterministically while covering all 25', () => {
  assert.equal(selectArtwork(30, 'merged-payroll'), selectArtwork(30, 'merged-payroll'));
  const selected = new Set();
  for (let issue = 1; issue <= 100; issue += 1) selected.add(artworkIndex(issue, `event-${issue % 4}`));
  assert.equal(selected.size, 25);
});

test('renders 100 cells with neutral artwork and ENS/Ethereum imagery, with no dropdown', () => {
  const rendered = renderArtFiComment('Queued 25 ART.', 30, 'merged-payroll');
  assert.match(rendered, new RegExp(ENS_ETH_LOGO_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(rendered, /artizen/i);
  assert.match(rendered, /alt="ENS and Ethereum logo"/);
  assert.doesNotMatch(rendered, /<details>|<summary>|<select/i);
  const table = renderArtworkTable(selectArtwork(30, 'merged-payroll'));
  assert.equal((table.match(/<tr>/g) || []).length, 10);
  assert.equal((table.match(/<td /g) || []).length, 100);
});

test('production comment builders preserve ART workflow messages', () => {
  const comments = [
    buildMergedPayrollComment({
      entries: [{ amount: '20', contributorGithub: 'builder', role: 'implementer' }],
      isManual: false,
      prNumber: 32,
      issueNumber: 30,
    }),
    buildTestingComment('Testing noted.', 30, 'test-complete'),
    buildSettlementComment({ settledCount: 2, actor: 'TheJollyLaMa', txHash: '0x123', issueNumber: 30, currency: 'ART' }),
  ];
  assert.match(comments[0], /Payroll queued from merged PR #32/);
  assert.match(comments[0], /20 ART/);
  assert.match(comments[2], /Settled 2 ART payroll entries/);
  for (const comment of comments) {
    assert.doesNotMatch(comment, /artizen/i);
    assert.match(comment, /ENS and Ethereum logo/);
  }
});