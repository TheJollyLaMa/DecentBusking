import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';

export function advertFundingHistory(state) {
  if (!state?.ready || state.lastError) throw new Error(state?.lastError || 'Advert funding history is still indexing');
  if (state.chainId !== 8453 || !/^0x[0-9a-f]{40}$/i.test(state.routerAddress || '') ||
      !state.funds || typeof state.funds !== 'object') throw new Error('Invalid advert funding ledger');
  const transactions = new Map();
  const seen = new Set();
  for (const [slug, fund] of Object.entries(state.funds)) {
    if (!Array.isArray(fund.sources)) throw new Error('Invalid advert funding sources');
    for (const source of fund.sources) {
      if (source.kind !== 'advert') continue;
      if (!/^0x[0-9a-f]{64}$/i.test(source.txHash || '') ||
          !/^0x[0-9a-f]{64}$/i.test(source.fundId || '') ||
          !/^\d+$/.test(source.amountUnits || '') || !Number.isSafeInteger(source.logIndex) ||
          !Number.isSafeInteger(source.blockNumber) || !Number.isFinite(source.timestamp)) {
        throw new Error('Invalid advert transaction record');
      }
      const hash = source.txHash.toLowerCase();
      const key = `${hash}:${source.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let entry = transactions.get(hash);
      if (!entry) {
        entry = { txHash: hash, blockNumber: source.blockNumber, timestamp: source.timestamp,
          totalUnits: 0n, paidAdvert: false, titles: [], campaignIds: [], requestIds: [], destinations: [] };
        transactions.set(hash, entry);
      }
      entry.totalUnits += BigInt(source.amountUnits);
      entry.paidAdvert ||= source.paidAdvert === true;
      for (const [field, value] of [['titles', source.title], ['campaignIds', source.campaignId], ['requestIds', source.requestId]]) {
        if (value != null && !entry[field].includes(String(value))) entry[field].push(String(value));
      }
      let destination = entry.destinations.find(item => item.fundId === source.fundId);
      if (!destination) {
        destination = { slug, fundId: source.fundId, label: fund.label || slug, units: 0n };
        entry.destinations.push(destination);
      }
      destination.units += BigInt(source.amountUnits);
    }
  }
  return { routerAddress: state.routerAddress, lastCheckedAt: state.lastCheckedAt,
    totalUnits: [...transactions.values()].reduce((total, entry) => total + entry.totalUnits, 0n),
    transactions: [...transactions.values()].sort((a, b) => b.blockNumber - a.blockNumber || a.txHash.localeCompare(b.txHash)) };
}

export function initDevertHistory(environment = {}) {
  const document = environment.document || globalThis.document;
  const window = environment.window || globalThis.window;
  const fetch = environment.fetch || globalThis.fetch;
  const listen = environment.listen || ((target, ...args) => target?.addEventListener(...args));
  const disclosure = document.getElementById('devert-history');
  if (!disclosure) return;
  const list = document.getElementById('devert-history-list');
  const status = document.getElementById('devert-history-status');
  const total = document.getElementById('devert-history-total');
  const more = document.getElementById('devert-history-more');
  let history = null;
  let limit = 10;
  let generation = 0;
  let loading = false;
  const node = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  const link = (text, href) => Object.assign(node('a', text), { href, target: '_blank', rel: 'noopener noreferrer' });
  const render = () => {
    list.replaceChildren();
    for (const entry of history.transactions.slice(0, limit)) {
      const item = document.createElement('li');
      const heading = document.createElement('div');
      heading.className = 'devert-history-heading';
      heading.append(node('strong', entry.titles.join(' · ') || (entry.campaignIds.length
        ? `Campaign ${entry.campaignIds.map(id => `#${id}`).join(', ')}` : 'Advert campaign funding')),
      node('strong', `${formatUsdcUnits(entry.totalUnits)} USDC`));
      item.append(heading, node('p', entry.paidAdvert
        ? `Paid advert playback${entry.requestIds.length ? ` · request ${entry.requestIds.map(id => `#${id}`).join(', ')}` : ''}`
        : `Campaign purchase${entry.titles.length ? '' : ' · advert title not recorded in the funding ledger'}`));
      const proof = link('View transaction ↗', `https://basescan.org/tx/${entry.txHash}`);
      proof.title = entry.txHash;
      const date = node('time', new Date(entry.timestamp * 1000).toLocaleString());
      date.dateTime = new Date(entry.timestamp * 1000).toISOString();
      item.append(date, proof);
      const destinations = document.createElement('ul');
      destinations.className = 'devert-history-destinations';
      for (const destination of entry.destinations) {
        const row = document.createElement('li');
        const anchor = link(destination.label, `https://basescan.org/tx/${entry.txHash}#eventlog`);
        anchor.title = `Fund ${destination.slug} · ${destination.fundId} · held at ${history.routerAddress}`;
        row.append(anchor, node('span', `${formatUsdcUnits(destination.units)} USDC`));
        destinations.append(row);
      }
      item.append(destinations);
      list.append(item);
    }
    more.hidden = limit >= history.transactions.length;
    total.textContent = `${formatUsdcUnits(history.totalUnits)} USDC funded · ${history.transactions.length} transaction${history.transactions.length === 1 ? '' : 's'}`;
    status.replaceChildren(node('span', 'Fund allocations held by the '),
      link('Base settlement router ↗', `https://basescan.org/address/${history.routerAddress}#tokentxns`),
      node('span', '. These are deposits, not final beneficiary payouts. Pending queue escrow is excluded.'));
    if (!history.transactions.length) status.append(node('p', 'No confirmed advert funding transactions yet.'));
  };
  const refresh = async () => {
    const check = ++generation;
    loading = true;
    status.textContent = 'Loading confirmed advert funding…';
    try {
      const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
      if (!service) throw new Error('Advert funding service is not configured');
      const response = await fetch(`${service}/api/funds`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Advert funding unavailable (${response.status})`);
      const result = advertFundingHistory(await response.json());
      if (check !== generation) return;
      history = result;
      limit = 10;
      render();
    } catch (error) {
      if (check !== generation) return;
      history = null;
      list.replaceChildren();
      more.hidden = true;
      total.textContent = '';
      status.textContent = `Funding history unavailable: ${error.message}`;
    } finally { if (check === generation) loading = false; }
  };
  listen(disclosure, 'toggle', () => { if (disclosure.open && !loading) refresh(); });
  listen(document.getElementById('devert-history-refresh'), 'click', refresh);
  listen(more, 'click', () => { if (history) { limit += 10; render(); } });
  return { destroy() { generation++; } };
}
