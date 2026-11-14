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

test('legacy checked consent needs explicit renewal and never widens while a wallet request is pending', async () => {
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const container = {}, toggle = {}, output = {}, renew = {}, scopeOutput = {};
  let resolveSave, calls = 0;
  const option = bindLiveRecordingOption({ container, toggle, output, renew, scopeOutput,
    requiredVersion: 'dbusk-live-recording-v2', savePermission: enabled => {
      assert.equal(enabled, true);
      calls++;
      return new Promise(resolve => { resolveSave = resolve; });
    } });
  const legacy = { available: true, canChange: true, consented: true, needsRenewal: true,
    scopeMessage: 'Legacy v1: original scheduled set only.' };
  option.update(legacy);
  assert.equal(calls, 0);
  assert.equal(toggle.checked, true);
  assert.equal(renew.hidden, false);
  const saving = renew.onclick();
  assert.equal(renew.disabled, true);
  assert.match(output.textContent, /previous permission has not changed/);
  option.update(legacy);
  assert.match(scopeOutput.textContent, /original scheduled/);
  resolveSave({ consented: true, consentVersion: 'dbusk-live-recording-v2' });
  await saving;
  assert.equal(calls, 1);
  assert.equal(toggle.checked, true);
  assert.equal(renew.hidden, true);
});

test('renewal rejection or a legacy-only response cannot masquerade as expanded permission', async () => {
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  for (const response of ['rejected', 'missing-version', 'legacy-version']) {
    const container = {}, toggle = {}, output = {}, renew = {}, scopeOutput = {};
    const option = bindLiveRecordingOption({ container, toggle, output, renew, scopeOutput,
      requiredVersion: 'dbusk-live-recording-v2', savePermission: async () => {
        if (response === 'rejected') throw Error('Wallet declined');
        return { consented: true, ...(response === 'legacy-version' ? { consentVersion: 'dbusk-live-recording-v1' } : {}) };
      } });
    const legacy = { available: true, canChange: true, consented: true, needsRenewal: true, scopeMessage: 'Legacy v1 only' };
    option.update(legacy);
    await renew.onclick();
    option.update(legacy);
    assert.equal(toggle.checked, true, 'The previous signed permission remains visible');
    assert.equal(renew.hidden, false);
    assert.match(output.textContent, /declined|not confirmed/);
    assert.match(scopeOutput.textContent, /Legacy v1 only/);
  }
});

test('locked legacy scope offers no enabled update and revocation does not require a new grant version', async () => {
  const { bindLiveRecordingOption } = await import('../js/live-recording-option.mjs');
  const container = {}, toggle = {}, output = {}, renew = {}, scopeOutput = {};
  const option = bindLiveRecordingOption({ container, toggle, output, renew, scopeOutput,
    requiredVersion: 'dbusk-live-recording-v2', savePermission: async enabled => ({ consented: enabled }) });
  option.update({ available: true, canChange: false, consented: true, needsRenewal: true });
  assert.equal(renew.hidden, false);
  assert.equal(renew.disabled, true);
  option.update({ available: true, canChange: true, consented: true, needsRenewal: true });
  toggle.checked = false;
  await toggle.onchange();
  assert.equal(toggle.checked, false);
  assert.equal(renew.hidden, true);
});
