const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = file => readFileSync(join(root, file), 'utf8');

test('recording release room exposes accessible review and explicit performer choices', () => {
  const html = read('recording-edit.html');
  const index = read('index.html');
  const editor = read('js/live-recording-editor.mjs');
  const panel = read('js/recording-edit-panel.mjs');
  const profile = read('js/live-performance-profile.mjs');
  const cards = read('js/nft-card.js');
  const css = read('css/live-recording-edit.css');
  const appCss = read('css/styles.css');

  for (const control of ['recording-edit-audio', 'recording-edit-waveform', 'recording-edit-save',
    'recording-edit-defer', 'recording-edit-full', 'recording-edit-split']) assert.ok(html.includes(control));
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /aria-label="Waveform of the preserved original recording"/);
  assert.match(html, /IPFS audio is public/);
  assert.match(editor, /scope: 'recording-edit'/);
  assert.match(editor, /signMessage\(message\)/);
  assert.match(editor, /recording-edit-approve/);
  assert.match(editor, /catalog-recording-edit/);
  assert.match(editor, /markDraftChanged/);
  assert.match(editor, /flush-recording-draft/);
  assert.match(editor, /validateCatalogRecordingDraft/);
  assert.match(editor, /sourceSamples/);
  assert.match(profile, /recording-edit\.html\?booking=/);
  assert.match(profile, /Review your live recording/);
  assert.match(css, /@media/);
  assert.match(index, /id="recording-edit-panel"/);
  assert.match(index, /id="recording-edit-frame"/);
  assert.match(panel, /data-recording-edit/);
  assert.match(panel, /data-catalog-recording-edit/);
  assert.match(panel, /decentbusking:flush-recording-draft/);
  assert.match(cards, /canEditCatalogRecording/);
  assert.match(appCss, /#recording-edit-panel\.is-open/);
});
