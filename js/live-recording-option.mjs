export function bindLiveRecordingOption({ container, toggle, output, savePermission }) {
  let confirmed = false, busy = false, available = false, canChange = false;
  let generation = 0, error = '';
  const render = () => {
    container.hidden = !available;
    toggle.disabled = !available || !canChange || busy;
    if (!busy) toggle.checked = confirmed;
  };
  toggle.onchange = async () => {
    if (!available || !canChange || busy) { render(); return; }
    const enabled = toggle.checked, current = generation;
    busy = true; error = ''; render();
    output.textContent = enabled ? 'Confirm recording permission in your wallet...' : 'Turning recording off...';
    try {
      const result = await savePermission(enabled);
      if (current !== generation) return;
      if (result?.consented !== enabled) throw new Error('Recording permission was not confirmed');
      confirmed = result.consented;
      output.textContent = result.message || (confirmed ? 'Your live set will be recorded. Soundchecks stay private.' : 'Recording is off.');
    } catch (failure) {
      if (current !== generation) return;
      error = failure.message || 'Recording permission could not be saved; try again.';
      output.textContent = error;
    } finally {
      if (current === generation) { busy = false; render(); }
    }
  };
  return {
    update(state) {
      if (!state.available && available) { generation++; busy = false; error = ''; }
      available = state.available === true;
      canChange = state.canChange === true;
      if (!busy) confirmed = state.consented === true;
      if (!busy && !error) output.textContent = state.message || (confirmed
        ? 'Your live set will be recorded. Soundchecks stay private.' : 'Recording is off.');
      render();
    },
  };
}
