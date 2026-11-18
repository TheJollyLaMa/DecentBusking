const test = require('node:test');
const assert = require('node:assert/strict');

test('local report drafts remove encoded secrets and private identifiers before URL construction', async () => {
  const { reviewIssueDraft, sanitizeIssueText } = await import('../js/issue-draft.mjs');
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456789';
  const body = [
    'Chrome: the drawer stays blank after clicking Report.',
    `details ${encodeURIComponent(encodeURIComponent(secret))}`,
    'wallet: 0x1111111111111111111111111111111111111111',
    'email: person@example.com, IP 192.168.10.1 and <@123456789012345678>',
    'https://example.com/private-path',
    'private key:\nnever publish these words\nor these words',
  ].join('\n');
  const draft = reviewIssueDraft({ title: 'Drawer stays blank', body });
  const url = new URL(draft.url);
  assert.equal(url.origin + url.pathname, 'https://github.com/TheJollyLaMa/DecentBusking/issues/new');
  assert.equal(url.searchParams.get('body'), draft.body);
  assert.equal(url.searchParams.get('labels'), 'bug,bug-catcher-pending');
  for (const privateText of [secret, '111111111111', 'person@', '192.168', '123456789012345678', 'private-path', 'never publish', 'or these words']) {
    assert.ok(!decodeURIComponent(draft.url).includes(privateText), privateText);
  }
  assert.match(draft.body, /Chrome: the drawer stays blank/);
  assert.equal(sanitizeIssueText(draft.body, 5000), draft.body);
  assert.equal(new URL(draft.searchUrl).searchParams.get('q'), 'is:issue Drawer stays blank');
  assert.ok(!new URL(draft.searchUrl).searchParams.get('q').includes('is:open'));
  assert.ok(draft.redacted);
});

test('interview creates required sections and rejects malformed, oversized or missing content explicitly', async () => {
  const { buildIssueDraft, reviewIssueDraft, sanitizeIssueText } = await import('../js/issue-draft.mjs');
  const input = {
    title: 'Playback control is blank', actual: 'Control is blank', expected: 'A play control',
    steps: 'Open the radio', impact: 'Listeners cannot start audio', environment: 'Firefox desktop',
  };
  const draft = buildIssueDraft(input);
  for (const heading of ['What happened?', 'What did you expect?', 'Steps to reproduce', 'Impact', 'Browser, device']) {
    assert.ok(draft.body.includes(`### ${heading}`));
  }
  assert.throws(() => buildIssueDraft({ ...input, steps: '' }), /Please answer/);
  assert.throws(() => reviewIssueDraft({ title: '', body: 'details' }), /required/);
  assert.throws(() => reviewIssueDraft({ title: 'x'.repeat(121), body: 'details' }), /too long/);
  assert.throws(() => sanitizeIssueText('broken %FF'), /Malformed/);
  assert.throws(() => sanitizeIssueText('%252525252541'), /excessively encoded/);
  assert.throws(() => sanitizeIssueText('\u0000'), /Unsupported/);
  assert.throws(() => reviewIssueDraft({ title: 'a', body: '\u754c'.repeat(1000) }), /link is too long/);
  assert.equal(sanitizeIssueText('Play \u{1F3B5} on mobile'), 'Play \u{1F3B5} on mobile');
});
