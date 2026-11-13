const test = require('node:test');
const assert = require('node:assert/strict');

test('recording option starts unchecked, waits for confirmation and preserves consent errors during polling', async () => {
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const container = {}, toggle = {}, output = {};
  let resolveSave, calls = 0;
  const option = bindLiveRecordingOption({ container, toggle, output, savePermission: async enabled => {
    calls++;
    assert.equal(enabled, true);
    return new Promise(resolve => { resolveSave = resolve; });
  } });
  option.update({ available: true, canChange: true, consented: false });
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  const saving = toggle.onchange();
  assert.equal(toggle.disabled, true);
  option.update({ available: true, canChange: true, consented: false });
  assert.equal(toggle.checked, true, 'polling cannot erase the active wallet choice');
  await toggle.onchange();
  assert.equal(calls, 1);
  resolveSave({ consented: true });
  await saving;
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);

  const failed = bindLiveRecordingOption({ container, toggle, output, savePermission: async () => { throw Error('Wallet declined'); } });
  failed.update({ available: true, canChange: true, consented: false });
  toggle.checked = true;
  await toggle.onchange();
  assert.equal(toggle.checked, false);
  failed.update({ available: true, canChange: true, consented: false });
  assert.equal(output.textContent, 'Wallet declined', 'polling never disguises a failed permission as successful recording');
});

test('wallet change cannot apply a late recording permission to a different room session', async () => {
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const container = {}, toggle = {}, output = {};
  let resolveSave;
  const option = bindLiveRecordingOption({ container, toggle, output,
    savePermission: () => new Promise(resolve => { resolveSave = resolve; }) });
  option.update({ available: true, canChange: true, consented: false });
  toggle.checked = true;
  const saving = toggle.onchange();
  option.update({ available: false, canChange: false, consented: false });
  resolveSave({ consented: true });
  await saving;
  assert.equal(container.hidden, true);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, true);
});
