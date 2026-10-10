import { pinCommunityManifest } from './pinner-rewards.mjs';

export function initCommunityPinning({ fetchImpl = fetch } = {}) {
  const dialog = document.getElementById('community-pin-dialog');
  if (!dialog) return;
  const summary = document.getElementById('community-pin-summary');
  const progress = document.getElementById('community-pin-progress');
  const start = document.getElementById('community-pin-start');
  const key = document.getElementById('community-pin-key');
  const keyLabel = document.getElementById('community-pin-key-label');
  const rewardStatus = document.getElementById('community-pin-rewards-status');
  let manifest = null;
  let busy = false;
  const provider = () => document.querySelector('[name="community-pin-provider"]:checked')?.value || 'local';

  async function loadManifest() {
    manifest = null;
    start.disabled = true;
    summary.textContent = 'Loading the shared content manifest…';
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) { summary.textContent = 'Community pin manifest is not configured.'; return; }
    try {
      const response = await fetchImpl(`${service}/api/pinners/manifest`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error('Invalid pin manifest');
      manifest = value;
      summary.textContent = `${value.entryCount} unique CIDs · shared playlist, songs and albums`;
      rewardStatus.textContent = value.rewardStatus === 'not-active'
        ? 'Shared Pinata stays primary. Rewards are not active yet.' : value.rewardStatus;
      start.disabled = !value.entryCount;
    } catch (error) { summary.textContent = `Manifest unavailable: ${error.message}`; }
  }

  function updateProvider() {
    const pinata = provider() === 'pinata';
    key.hidden = !pinata;
    keyLabel.hidden = !pinata;
    start.textContent = pinata ? 'Pin to my Pinata' : 'Pin to IPFS Desktop';
    if (!busy) start.disabled = !manifest?.entryCount || (pinata && !key.value.trim());
  }

  document.querySelectorAll('[name="community-pin-provider"]').forEach(input => input.addEventListener('change', updateProvider));
  key.addEventListener('input', updateProvider);
  window.addEventListener('open-community-pinning', async () => {
    if (!dialog.open) dialog.showModal();
    await loadManifest();
    updateProvider();
  });
  document.getElementById('community-pin-cancel').addEventListener('click', () => { key.value = ''; dialog.close(); updateProvider(); });
  start.addEventListener('click', async () => {
    if (!manifest || busy) return;
    busy = true;
    updateProvider();
    const selectedProvider = provider();
    const pinataJwt = selectedProvider === 'pinata' ? key.value.trim() : '';
    try {
      const result = await pinCommunityManifest({ manifest, provider: selectedProvider, pinataJwt,
        ipfsApiUrl: window.DecentConfig?.ipfsApiUrl || 'http://127.0.0.1:5001', fetchImpl,
        onProgress: ({ completed, total }) => { progress.textContent = `Pinned ${completed} of ${total} CIDs…`; } });
      progress.textContent = `Pinned ${result.successes.length} of ${manifest.entryCount}. ${result.failures.length ? `${result.failures.length} could not be pinned; try again later.` : 'All selected CIDs are pinned.'}`;
      rewardStatus.textContent = 'Your pins add a community copy. Availability rewards are not active yet.';
    } catch (error) { progress.textContent = error.message; }
    finally { key.value = ''; busy = false; updateProvider(); }
  });
  dialog.addEventListener('close', () => { key.value = ''; });
  updateProvider();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => initCommunityPinning(), { once: true });
