const test = require('node:test');
const assert = require('node:assert/strict');
const { renderAfterpartyChecklist, renderCurtainCall, renderRecordingReleaseParty } = require('../js/live-afterparty-view.mjs');

const makeDocument = () => ({
  createElement(tag) {
    return {
      tag, children: [], attributes: {}, textContent: '', append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { this.focused = true; },
    };
  },
});

test('curtain call opens once, can be dismissed and explicitly replayed, and renders names as text', () => {
  const milestone = { id: 'curtain:booking', kind: 'completion', subtitle: '<Artist>’s set is finished.' };
  let seen = false;
  const calls = [];
  const celebrate = (item, { replay }) => {
    calls.push({ item, replay });
    const celebrated = !seen || replay;
    seen = true;
    return { celebrated };
  };
  const options = { documentRef: makeDocument(), celebrate };
  const firstView = renderCurtainCall(milestone, options);
  const first = firstView.element;
  assert.notEqual(first.open, true, 'building an offscreen card does not spend the celebration');
  firstView.activate();
  assert.equal(first.open, true);
  assert.equal(descendants(first).find(node => node.tag === 'h3').textContent, milestone.subtitle);
  const announcement = descendants(first).find(node => node.attributes.role === 'status');
  assert.equal(announcement.attributes['aria-live'], 'polite');
  assert.equal(announcement.textContent, `Curtain call: ${milestone.subtitle}`);
  const replay = descendants(first).find(node => node.textContent === 'Replay celebration');
  const dismiss = descendants(first).find(node => node.textContent === 'Dismiss');
  dismiss.onclick();
  assert.equal(first.open, false);
  assert.equal(first.children[0].focused, true);
  replay.onclick();
  assert.equal(first.open, true);
  assert.deepEqual(calls.map(call => call.replay), [false, true]);
  const returningView = renderCurtainCall(milestone, options);
  returningView.activate();
  const returning = returningView.element;
  assert.notEqual(returning.open, true, 'a refresh does not automatically replay the celebration');
  assert.equal(renderCurtainCall({ ...milestone, kind: 'payment' }, options), null);
});
const descendants = node => [node, ...(node.children || []).flatMap(descendants)];

test('recording release party uses exact recording links, truthful interrupted status and explicit replay without taking focus', () => {
  const doc = makeDocument();
  const milestone = { kind: 'radio-release', id: 'release:show:song', title: 'Your recording reached DBusk Radio',
    subtitle: '<Exact song title>', state: 'retrying', partial: true,
    evidence: { trackId: 'song', contractAddress: `0x${'12'.repeat(20)}`, tokenId: '9' } };
  const calls = [];
  let seen = false;
  const view = renderRecordingReleaseParty(milestone, { documentRef: doc, celebrate: (_, options) => {
    calls.push(options.replay);
    const celebrated = !seen || options.replay; seen = true;
    return { celebrated };
  } });
  let nodes = descendants(view.element);
  assert.ok(nodes.some(n => n.textContent === '<Exact song title>'));
  assert.match(nodes.find(n => n.tag === 'output').textContent, /interrupted.*safe radio slot.*partial recording/);
  assert.equal(nodes.filter(n => n.tag === 'a').length, 3);
  assert.equal(nodes.some(n => n.focused), false);
  view.activate();
  nodes.find(n => n.textContent === 'Dismiss celebration').onclick();
  assert.equal(nodes.find(n => n.textContent === 'Replay release celebration').focused, true);
  nodes.find(n => n.textContent === 'Replay release celebration').onclick();
  assert.deepEqual(calls, [false, true]);
  assert.equal(renderRecordingReleaseParty({ ...milestone, kind: 'payment' }, { documentRef: doc }), null);
});

test('afterparty checklist renders text, next steps and verified evidence links without HTML injection', () => {
  const section = renderAfterpartyChecklist([
    { id: 'payment', label: 'Payment', state: 'verified', text: 'Confirmed <not markup>', detail: 'Receipt verified.',
      next: '', links: [{ label: 'View receipt', href: 'https://basescan.org/tx/0x123' }] },
    { id: 'recording', label: 'Recording', state: 'unknown', text: 'Not verified', detail: '', next: 'Check the mint queue.', links: [] },
  ], { documentRef: makeDocument() });
  const nodes = descendants(section);
  assert.equal(section.tag, 'details');
  assert.equal(section.open, true);
  assert.equal(nodes.find(node => node.tag === 'summary').textContent, 'Show, fee and recording status');
  assert.ok(nodes.some(node => node.textContent === 'Payment: Confirmed <not markup>'));
  assert.ok(nodes.some(node => node.textContent === 'Next: Check the mint queue.'));
  assert.equal(nodes.find(node => node.tag === 'li').attributes['data-state'], 'verified');
  const link = nodes.find(node => node.tag === 'a');
  assert.equal(link.href, 'https://basescan.org/tx/0x123');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(renderAfterpartyChecklist([], { documentRef: makeDocument() }), null);
});
