import { pinCommunityManifest } from './pinner-rewards.mjs';
import { createPinnerRewardsView } from './pinner-rewards-ui.mjs?v=20261126-pinner-dashboard';
import { createPinnerNetworkView, monthlyPinnerCost } from './pinner-network-view.mjs?v=20261126-pinner-dashboard';

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
  const rewardsRoot = document.getElementById('community-pinner-rewards');
  const networkRoot = document.getElementById('community-pinner-network');
  const network = networkRoot ? createPinnerNetworkView({ root: networkRoot, fetchImpl }) : null;
  const pages = [...dialog.querySelectorAll('[data-pinner-page]')];
  const showPage = name => {
    pages.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.pinnerPage === name)));
    dialog.querySelectorAll('[data-pinner-panel]').forEach(panel => { panel.hidden = panel.dataset.pinnerPanel !== name; });
  };
  pages.forEach(button => button.addEventListener('click', () => {
    showPage(button.dataset.pinnerPage);
    if (button.dataset.pinnerPage === 'rewards') void rewardsView?.load();
  }));
  document.getElementById('community-pinner-network-refresh')?.addEventListener('click', () => network?.load());
  document.getElementById('pinner-cost-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const output = document.getElementById('pinner-cost-result');
    try {
      const cost = monthlyPinnerCost({ watts: values.get('watts'), hoursPerDay: values.get('hours'),
        pricePerKwh: values.get('rate'), hosting: values.get('hosting') });
      output.textContent = `About $${cost.toFixed(2)} / 30 days, excluding hardware, storage and bandwidth charges. Rewards fluctuate; profit is not guaranteed.`;
    } catch (error) { output.textContent = error.message; }
  });
  const rewardsView = rewardsRoot ? createPinnerRewardsView({ root: rewardsRoot, enrollment: true, fetchImpl,
    isBusy: () => busy, setBusy: value => { busy = value; updateProvider(); } }) : null;
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
      rewardStatus.textContent = value.rewardStatus === 'active'
        ? 'Shared Pinata stays primary. Open My node & rewards to join the approved pinner program.'
        : `Shared Pinata stays primary. Pinner reward status: ${value.rewardStatus}.`;
      start.disabled = !value.entryCount;
    } catch (error) { summary.textContent = `Manifest unavailable: ${error.message}`; }
  }

  function updateProvider() {
    const pinata = provider() === 'pinata';
    key.hidden = !pinata;
    keyLabel.hidden = !pinata;
    start.textContent = pinata ? 'Pin to my Pinata' : 'Pin to IPFS Desktop';
    start.disabled = busy || !manifest?.entryCount || (pinata && !key.value.trim());
  }

  document.querySelectorAll('[name="community-pin-provider"]').forEach(input => input.addEventListener('change', updateProvider));
  key.addEventListener('input', updateProvider);
  window.addEventListener('open-community-pinning', async () => {
    showPage('network');
    if (!dialog.open) dialog.showModal();
    await Promise.all([loadManifest(), network?.load(), rewardsView?.load()]);
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
      rewardStatus.textContent = 'Your pins add a community copy. Enroll in My node & rewards; only approved nodes with qualifying independent checks earn weekly awards.';
    } catch (error) { progress.textContent = error.message; }
    finally { key.value = ''; busy = false; updateProvider(); }
    await rewardsView?.load();
    await network?.load();
  });
  for (const event of ['wallet-connected', 'wallet-disconnected']) document.addEventListener(event, () => {
    if (dialog.open) { void rewardsView?.load(); void network?.load(); }
  });
  dialog.addEventListener('close', () => { key.value = ''; });
  updateProvider();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => initCommunityPinning(), { once: true });
