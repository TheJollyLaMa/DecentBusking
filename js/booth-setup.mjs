/**
 * Required booth setup before a performer's microphone starts, shared by the
 * private rehearsal and backstage rooms. Performers monitor locally (interface
 * direct monitor) or not at all. Browser monitoring is delayed, so it is offered
 * only in private practice (SHOW_MODES excludes it). The public radio is never a
 * performance monitor.
 */
export const BOOTH_MODES = Object.freeze({
  direct: 'Headphones in my interface · direct monitor on (recommended)',
  unplugged: 'No headphones · unplugged',
  browser: 'Browser monitor · delayed, practice only',
});
export const SHOW_MODES = Object.freeze(['direct', 'unplugged']);

const GUIDANCE = {
  '': 'Choose how you will hear yourself, then confirm the radio is off everywhere else.',
  direct: 'Plug your headphones into the interface and turn its direct monitor on. Effects belong in your interface or mixer so the radio hears them too. Hear my input stays off so you never hear yourself twice.',
  unplugged: 'No monitor: play to the room with no headphones. Hear my input stays off and no speaker plays the radio near your mic.',
  browser: 'Practice only: browser monitoring arrives late. Turn your interface’s direct monitor off, start your mic, then use Hear my input with headphones. Shows use your interface or unplugged.',
};

export function boothSetupProblem({ mode, radioOff } = {}, modes = Object.keys(BOOTH_MODES)) {
  if (!modes.includes(mode || '')) return 'Booth setup: choose how you will hear yourself first.';
  if (radioOff !== true) return 'Booth setup: confirm the radio is off on every other tab, phone and device first.';
  return '';
}

/**
 * mode is a <select> whose option values are '' and the allowed modes (a subset of
 * the BOOTH_MODES keys; pass SHOW_MODES for live shows); radioOff a checkbox; status an output. monitorToggle is
 * the Hear my input checkbox. onMonitorDisallowed must stop browser monitoring
 * without stopping the microphone. Choices persist for this tab only, so a
 * reload mid-show does not block republishing. Changing them never stops a mic.
 */
export function bindBoothSetup({ mode, radioOff, status, monitorToggle, onMonitorDisallowed, onChange,
  storage, key = 'dbusk-booth-setup', modes = Object.keys(BOOTH_MODES) }) {
  modes = modes.filter(value => Object.hasOwn(BOOTH_MODES, value));
  try {
    const saved = JSON.parse(storage?.getItem(key) || 'null');
    if (saved && modes.includes(saved.mode)) mode.value = saved.mode;
    if (saved?.radioOff === true) radioOff.checked = true;
  } catch { /* Missing or blocked storage only means choosing again. */ }

  const current = () => ({ mode: modes.includes(mode.value || '') ? mode.value : '', radioOff: radioOff.checked === true });
  function render() {
    const choice = current();
    const allowed = choice.mode === 'browser';
    if (!allowed && monitorToggle.checked) void Promise.resolve(onMonitorDisallowed?.()).catch(() => {});
    monitorToggle.disabled = !allowed;
    const problem = boothSetupProblem(choice, modes);
    status.textContent = !problem ? `✓ Booth ready. ${GUIDANCE[choice.mode]}`
      : choice.mode ? `${GUIDANCE[choice.mode]} ${problem}` : GUIDANCE[''];
    if (status.dataset) status.dataset.ready = String(!problem);
  }
  function changed() {
    try { storage?.setItem(key, JSON.stringify(current())); } catch { /* Choices still apply in this page. */ }
    render();
    onChange?.();
  }
  mode.addEventListener('change', changed);
  radioOff.addEventListener('change', changed);
  render();
  return { problem: () => boothSetupProblem(current(), modes), ready: () => !boothSetupProblem(current(), modes), mode: () => current().mode };
}
