function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function formatUsdc(units) {
  try {
    const amount = BigInt(units);
    const whole = amount / 1_000_000n;
    const fraction = String(amount % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''} USDC offer`;
  } catch {
    return 'Offer unavailable';
  }
}

function activeCampaigns(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.chainId !== 8453 || !Array.isArray(snapshot.campaigns)) return [];
  return snapshot.campaigns.filter(campaign => {
    const start = Date.parse(campaign.startedAt);
    const end = Date.parse(campaign.expiresAt);
    return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
  }).sort((first, second) => Number(second.djukeBoosts || 0) - Number(first.djukeBoosts || 0) ||
    Number(first.mainRadioPlays || 0) - Number(second.mainRadioPlays || 0) ||
    (BigInt(second.offerUnits) > BigInt(first.offerUnits) ? 1 : BigInt(second.offerUnits) < BigInt(first.offerUnits) ? -1 : 0));
}

export function initDevertTab() {
  const panel = document.getElementById('devert-panel');
  const toggle = document.getElementById('devert-tab');
  if (!panel || !toggle) return;
  const closeButton = document.getElementById('devert-close');
  const refreshButton = document.getElementById('devert-refresh');
  const campaignList = document.getElementById('devert-campaigns');
  const campaignStatus = document.getElementById('devert-campaign-status');
  const broadcastStatus = document.getElementById('devert-broadcast-status');
  let generation = 0;
  let timer;

  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const close = () => {
    clearTimeout(timer);
    generation++;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open DVert advertising');
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    panel.inert = true;
    document.body.classList.remove('devert-open');
  };

  async function refresh() {
    clearTimeout(timer);
    if (!isOpen()) return;
    const request = ++generation;
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) {
      campaignStatus.textContent = 'DVert campaign service is not configured.';
      broadcastStatus.textContent = 'Audio broadcast is not live yet.';
      return;
    }
    campaignStatus.textContent = 'Loading confirmed campaigns…';
    try {
      const response = await fetch(`${service}/api/devert`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const snapshot = await response.json();
      if (request !== generation || !isOpen()) return;
      if (response.status === 404) throw new Error('Campaign contract is not deployed');
      if (!response.ok) throw new Error(snapshot.error || `Campaigns unavailable (${response.status})`);
      campaignList.replaceChildren();
      const campaigns = activeCampaigns(snapshot);
      for (const campaign of campaigns) {
        const item = node('li', undefined, 'devert-campaign');
        const details = node('span', undefined, 'devert-campaign-details');
        details.append(node('strong', campaign.title),
          node('span', `${formatUsdc(campaign.offerUnits)} · expires ${new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }).format(new Date(campaign.expiresAt))}`));
        item.append(details);
        campaignList.append(item);
      }
      campaignStatus.textContent = campaigns.length ? `${campaigns.length} active campaign${campaigns.length === 1 ? '' : 's'} · confirmed Base snapshot #${snapshot.blockNumber}` : 'No active campaigns right now.';
      broadcastStatus.textContent = 'Campaigns are readable; the 24/7 audio broadcast is not live yet.';
    } catch (error) {
      if (request !== generation || !isOpen()) return;
      campaignList.replaceChildren();
      campaignStatus.textContent = error.message;
      broadcastStatus.textContent = 'Audio broadcast is not live yet.';
    }
    if (isOpen()) timer = setTimeout(refresh, 30000);
  }

  toggle.addEventListener('click', event => {
    event.stopPropagation();
    if (isOpen()) { close(); return; }
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close DVert advertising');
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    panel.inert = false;
    document.body.classList.add('devert-open');
    document.dispatchEvent(new CustomEvent('left-drawer-open', { detail: 'devert' }));
    refresh();
  });
  closeButton?.addEventListener('click', () => { close(); toggle.focus(); });
  refreshButton?.addEventListener('click', refresh);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen()) { close(); toggle.focus(); }
  });
  document.addEventListener('left-drawer-open', event => { if (event.detail !== 'devert' && isOpen()) close(); });
  document.addEventListener('click', event => {
    if (isOpen() && !panel.contains(event.target) && !toggle.contains(event.target)) close();
  });
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initDevertTab, { once: true });
