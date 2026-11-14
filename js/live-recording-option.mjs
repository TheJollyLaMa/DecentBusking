export function bindLiveRecordingOption({ container, toggle, output, renew, scopeOutput, requiredVersion, savePermission }) {
  let confirmed = false, busy = false, available = false, canChange = false;
  let needsRenewal = false;
  let generation = 0, error = '';
  const render = () => {
    container.hidden = !available;
    toggle.disabled = !available || !canChange || busy;
    if (!busy) toggle.checked = confirmed;
    if (renew) {
      renew.hidden = !available || !confirmed || !needsRenewal;
      renew.disabled = !available || !canChange || busy;
    }
  };
  const save = async (enabled, updating = false) => {
    if (!available || !canChange || busy) { render(); return; }
    const current = generation;
    busy = true; error = ''; render();
    output.textContent = updating ? 'Confirm the expanded recording scope in your wallet. Your previous permission has not changed yet.'
      : enabled ? 'Confirm recording permission in your wallet...' : 'Turning recording off...';
    try {
      const result = await savePermission(enabled);
      if (current !== generation) return;
      if (result?.consented !== enabled) throw new Error('Recording permission was not confirmed');
      if (enabled && requiredVersion && result.consentVersion !== requiredVersion) {
        throw new Error('Expanded recording permission was not confirmed. Your previous permission has not been widened; refresh and check its scope.');
      }
      confirmed = result.consented;
      if (!confirmed || result.consentVersion === requiredVersion) needsRenewal = false;
      output.textContent = result.message || (confirmed ? 'Your live set will be recorded. Soundchecks stay private.' : 'Recording is off.');
    } catch (failure) {
      if (current !== generation) return;
      error = failure.message || 'Recording permission could not be saved; try again.';
      output.textContent = error;
    } finally {
      if (current === generation) { busy = false; render(); }
    }
  };
  toggle.onchange = () => save(toggle.checked);
  if (renew) renew.onclick = () => save(true, true);
  return {
    update(state) {
      if (!state.available && available) { generation++; busy = false; error = ''; }
      available = state.available === true;
      canChange = state.canChange === true;
      if (!busy) confirmed = state.consented === true;
      needsRenewal = state.needsRenewal === true;
      if (scopeOutput) scopeOutput.textContent = state.scopeMessage || '';
      if (!busy && !error) output.textContent = state.message || (confirmed
        ? 'Your live set will be recorded. Soundchecks stay private.' : 'Recording is off.');
      render();
    },
  };
}
