const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WEI = /^(0|[1-9][0-9]{0,99})$/;
const UNITS = /^[1-9][0-9]{0,77}$/;
const TOKEN_ID = /^(0|[1-9][0-9]{0,77})$/;
const SOURCES = ['Live performance', 'Radio recording', 'Archive recording'];
const KNOWN_TOKENS = { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 } };

function validAsset(entry, assets) {
  if (!entry.kind) return typeof entry.amountWei === 'string' && WEI.test(entry.amountWei);
  if (!assets) return false;
  if (entry.kind === 'token') return ADDRESS.test(entry.token || '') && UNITS.test(entry.amountUnits || '');
  return entry.kind === 'nft' && ADDRESS.test(entry.collection || '') && [0, 1].includes(entry.standard) &&
    TOKEN_ID.test(entry.tokenId || '') && UNITS.test(entry.amount || '');
}

function tokenAmount(ethers, token, units) {
  const known = KNOWN_TOKENS[String(token).toLowerCase()];
  return known ? `${ethers.formatUnits(units, known.decimals)} ${known.symbol}` : `${units} units of ${token}`;
}

export async function fetchTipLedger({ serviceUrl, routerAddress, address, offset = 0, fetchImpl = fetch }) {
  if (!serviceUrl || !ADDRESS.test(routerAddress || '') || !ADDRESS.test(address || '')) throw new Error('Tip ledger configuration is unavailable');
  const response = await fetchImpl(`${String(serviceUrl).replace(/\/$/, '')}/api/tips/ledger?${new URLSearchParams({
    wallet: address, router: routerAddress, offset, limit: 25,
  })}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const state = await response.json();
  if (!response.ok || state.ready !== true) throw new Error(state.error || state.lastError || `Tip ledger unavailable (${response.status})`);
  if (state.chainId !== 8453 || state.routerAddress?.toLowerCase() !== routerAddress.toLowerCase() ||
      !Array.isArray(state.entries) || state.entries.length > 25 ||
      typeof state.attributedWei !== 'string' || typeof state.unattributedWei !== 'string' ||
      !WEI.test(state.attributedWei) || !WEI.test(state.unattributedWei) ||
      !Number.isSafeInteger(state.total) || state.total < state.entries.length ||
      (state.nextOffset !== null && (!Number.isSafeInteger(state.nextOffset) || state.nextOffset <= offset)) ||
      (state.assets === true && (!state.tokenTotals || typeof state.tokenTotals !== 'object' ||
        Object.entries(state.tokenTotals).some(([token, total]) => !ADDRESS.test(token) ||
          !WEI.test(total?.attributedUnits || '') || !WEI.test(total?.unattributedUnits || '')) ||
        !Number.isSafeInteger(state.nftGifts?.attributed) || !Number.isSafeInteger(state.nftGifts?.unattributed)))) {
    throw new Error('Invalid tip ledger response');
  }
  for (const entry of state.entries) {
    if (entry.chainId !== 8453 || entry.routerAddress?.toLowerCase() !== routerAddress.toLowerCase() ||
        entry.recipient?.toLowerCase() !== address.toLowerCase() || !ADDRESS.test(entry.sender || '') ||
        !HASH.test(entry.txHash || '') || !Number.isSafeInteger(entry.logIndex) || entry.logIndex < 0 ||
        !validAsset(entry, state.assets === true) ||
        ![0, 1, 2].includes(entry.sourceKind) || typeof entry.contextRef !== 'string' || entry.contextRef.length > 256 ||
        typeof entry.chainVerified !== 'boolean' ||
        !['verified', 'unavailable', 'mismatch'].includes(entry.sourceVerification?.status)) {
      throw new Error('Invalid tip ledger event');
    }
  }
  return state;
}

export function renderTipLedger({ container, config, address, ethers, isCurrent = () => true }) {
  const sections = [renderRouterLedger({ container, config, address, ethers, isCurrent,
    routerAddress: config.tipRouterAddress, heading: 'Native ETH tips' })];
  if (config.tipRouterAddress && ADDRESS.test(config.tipSplitRouterAddress || '')) {
    sections.push(renderRouterLedger({ container, config, address, ethers, isCurrent,
      routerAddress: config.tipSplitRouterAddress, heading: '👥 Shared · $ USDC · 🎁 NFT tips' }));
  }
  container.replaceChildren(...sections);
}

function renderRouterLedger({ container, config, address, ethers, isCurrent, routerAddress, heading }) {
  const document = container.ownerDocument;
  const details = document.createElement('details'), summary = document.createElement('summary');
  const status = document.createElement('p'), list = document.createElement('ol'), more = document.createElement('button');
  const body = document.createElement('div');
  const title = document.createElement('span');
  title.className = 'creator-dropdown-title';
  details.className = 'creator-dropdown';
  body.className = 'creator-dropdown-body';
  title.textContent = heading;
  summary.append(title);
  details.style.overflowWrap = 'anywhere';
  status.setAttribute('role', 'status');
  more.type = 'button';
  more.textContent = 'More tip receipts';
  more.hidden = true;
  body.append(status, list, more);
  details.append(summary, body);
  if (routerAddress === '' || routerAddress === undefined) {
    status.textContent = 'Contract attribution is not enabled. Earlier direct wallet transfers are not included in this ledger.';
    return details;
  }
  let nextOffset = 0, loading = false, loaded = false;
  const seen = new Set();
  const load = async () => {
    if (loading || !isCurrent()) return;
    loading = true;
    more.disabled = true;
    status.textContent = 'Reading the separate native ETH tip ledger...';
    try {
      const state = await fetchTipLedger({ serviceUrl: config.ipfsUploadServiceUrl,
        routerAddress, address, offset: nextOffset });
      if (!isCurrent()) return;
      const totals = [`${ethers.formatEther(state.attributedWei)} ETH`,
        ...Object.entries(state.tokenTotals || {}).map(([token, total]) => tokenAmount(ethers, token, total.attributedUnits)),
        ...(state.nftGifts?.attributed ? [`${state.nftGifts.attributed} 🎁`] : [])];
      title.textContent = `${heading} - ${totals.join(' · ')} attributed`;
      status.textContent = `${state.total} tip receipt(s). ${ethers.formatEther(state.unattributedWei)} ETH has unverified source context. ` +
        `${!state.caughtUp || state.restoringCount ? 'Index recovery is in progress; totals are incomplete. ' : ''}` +
        `Checked ${state.lastCheckedAt || 'time unavailable'}. Not combined with USDC payroll or supporter gifts.`;
      for (const entry of state.entries) {
        const key = `${entry.txHash.toLowerCase()}:${entry.logIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const item = document.createElement('li'), label = document.createElement('p'), context = document.createElement('small');
        const proof = document.createElement('a');
        const verification = !entry.chainVerified ? 'chain comparison pending'
          : entry.sender === entry.recipient ? 'self-transfer, not earnings'
          : entry.sourceVerification.status === 'verified' ? 'recording/booking identity verified'
          : `source unverified: ${entry.sourceVerification.error || entry.sourceVerification.status}`;
        const what = entry.kind === 'token' ? tokenAmount(ethers, entry.token, entry.amountUnits)
          : entry.kind === 'nft' ? `🎁 NFT #${entry.tokenId}${entry.standard === 1 ? ` ×${entry.amount}` : ''} from ${entry.collection}`
          : `${ethers.formatEther(entry.amountWei)} ETH`;
        label.textContent = `${what} - ${SOURCES[entry.sourceKind] || 'Unknown source'} - ${entry.sourceVerification.label || ''} (${verification})`;
        context.textContent = entry.contextRef;
        context.style.overflowWrap = 'anywhere';
        proof.href = `https://basescan.org/tx/${entry.txHash}#eventlog`;
        proof.textContent = `On-chain proof, log ${entry.logIndex}`;
        proof.target = '_blank';
        proof.rel = 'noopener noreferrer';
        item.append(label, context, document.createElement('br'), proof);
        list.append(item);
      }
      nextOffset = state.nextOffset;
      more.hidden = nextOffset === null;
      loaded = true;
    } catch (error) {
      if (isCurrent()) {
        status.textContent = `Tip ledger unavailable: ${error.message}`;
        more.textContent = 'Retry tip ledger';
        more.hidden = false;
      }
    } finally {
      loading = false;
      more.disabled = false;
    }
  };
  details.addEventListener('toggle', () => { if (details.open && !loaded) void load(); });
  more.addEventListener('click', () => { more.textContent = 'More tip receipts'; void load(); });
  return details;
}
