const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = file => readFileSync(join(root, file), 'utf8');

test('recording release room exposes accessible review and explicit performer choices', () => {
  const html = read('recording-edit.html');
  const editor = read('js/live-recording-editor.mjs');
  const profile = read('js/live-performance-profile.mjs');
  const css = read('css/live-recording-edit.css');

  for (const control of ['recording-edit-audio', 'recording-edit-waveform', 'recording-edit-save',
    'recording-edit-defer', 'recording-edit-full', 'recording-edit-split']) assert.ok(html.includes(control));
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /aria-label="Waveform of the preserved original recording"/);
  assert.match(html, /IPFS audio is public/);
  assert.match(editor, /scope: 'recording-edit'/);
  assert.match(editor, /signMessage\(message\)/);
  assert.match(editor, /recording-edit-approve/);
  assert.match(editor, /sourceSamples/);
  assert.match(profile, /recording-edit\.html\?booking=/);
  assert.match(profile, /Review your live recording/);
  assert.match(css, /@media/);
});
