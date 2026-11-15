const test = require('node:test');
const assert = require('node:assert/strict');
const { renderAfterpartyChecklist } = require('../js/live-afterparty-view.mjs');

const makeDocument = () => ({
  createElement(tag) {
    return {
      tag, children: [], attributes: {}, textContent: '', append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attributes[name] = value; },
    };
  },
});
const descendants = node => [node, ...(node.children || []).flatMap(descendants)];

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
