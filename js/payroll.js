/**
 * js/payroll.js — DecentBusking Payroll Panel
 *
 * Provides the owner with a browser-side payroll UI to:
 *   1. Load the pending payroll queue from payroll-queue.json.
 *   2. Verify the connected wallet is the repo owner.
 *   3. Settle configured ERC-20 rewards through the shared Base Settlement Router.
 *   4. Preserve direct Optimism ETH payouts for historical queue entries.
 *
 * Usage:
 *   - Owner clicks the 💸 Payroll button in the app.
 *   - Connects MetaMask; the payout action switches to Base for configured
 *     router assets or Optimism for historical ETH entries.
 *   - Sees pending payouts with amounts, contributors, and wallet addresses.
 *   - Clicks "Settle All" or individual "Pay" buttons to settle eligible work.
 *   - ART payments are recorded on-chain and cannot be paid twice.
 *
 * Security note:
 *   A warning is shown if the connected wallet does NOT match the repo owner's
 *   address in contributor-accounts.json.  Only the repo owner should settle
 *   payroll.
 */

import { createLegacyReceiptStore, verifyLegacyPayment } from './legacy-payroll.mjs';
import { isAdminWallet } from './admin-access.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAYROLL_QUEUE_URL =
  'https://raw.githubusercontent.com/TheJollyLaMa/DecentBusking/main/payroll-queue.json';

const ACCOUNTS_URL =
  'https://raw.githubusercontent.com/TheJollyLaMa/DecentBusking/main/contributor-accounts.json';

const BASE_CHAIN_ID = 8453;
const OPTIMISM_CHAIN_ID = 10;
const PAYROLL_ASSETS_URL = new URL('../payroll-assets.json', import.meta.url).toString();
const ROUTER_ABI = [
  'function PAYROLL_ROLE() view returns (bytes32)',
  'function CONTRIBUTOR_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function funds(bytes32 fundId) view returns (string metadataUri, bool active, bool exists)',
  'function fundBalances(bytes32 fundId, address asset) view returns (uint256)',
  'function approvedAssets(address asset) view returns (bool)',
  'function contributors(address wallet) view returns (bytes32 githubIdHash, bool approved, bool exists)',
  'function setContributorApproved(address wallet, bytes32 githubIdHash, bool approved)',
  'function completedWorkReferences(bytes32 workReference) view returns (bool)',
  'function payout(bytes32 fundId, address asset, address recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)',
];

// ─── Module state ─────────────────────────────────────────────────────────────

let _pendingEntries   = [];
let _ownerAddress     = null;
let _payrollAssetConfig = null;
let _settling = false;
let _legacyReceipts;

function _legacyStore() {
  _legacyReceipts ||= createLegacyReceiptStore(localStorage);
  return _legacyReceipts;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function _setStatus(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#ff6b6b' : '#00d4aa';
}

async function _fetchJSON(url) {
  const res = await fetch(url + '?t=' + Date.now());
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  return res.json();
}

// ─── Load owner address from contributor-accounts.json ────────────────────────

async function _loadOwnerAddress() {
  try {
    const data = await _fetchJSON(ACCOUNTS_URL);
    const owner = (data.contributors || []).find(c => c.role === 'owner');
    return owner ? owner.walletAddress : null;
  } catch (_) {
    return null;
  }
}

// ─── React to global wallet connection ────────────────────────────────────────

async function _onWalletConnected({ detail } = {}) {
  if (!isAdminWallet(detail?.address || window._wallet?.address)) {
    _onWalletDisconnected();
    return;
  }
  const statusEl  = document.getElementById('payroll-wallet-status');
  const addrEl    = document.getElementById('payroll-connected-addr');
  const warningEl = document.getElementById('payroll-owner-warning');
  const queueSection = document.getElementById('payroll-queue-section');

  const connectedAddress = detail?.address || window._wallet?.address || null;
  const chainId = detail?.chainId ?? window._wallet?.chainId ?? null;

  if (!connectedAddress) return;

  if (addrEl) addrEl.textContent = connectedAddress;

  // Check if connected wallet matches the owner's registered address
  if (!_ownerAddress) _ownerAddress = await _loadOwnerAddress();

  const isOwner = _ownerAddress &&
    _ownerAddress.toLowerCase() === connectedAddress.toLowerCase();

  if (warningEl) {
    if (!isOwner) {
      warningEl.textContent =
        '⚠️ Warning: Connected wallet is not the registered repo owner wallet. ' +
        'Only @TheJollyLaMa should settle payroll.';
      warningEl.style.display = 'block';
    } else {
      warningEl.style.display = 'none';
    }
  }

  _setStatus(statusEl, isOwner
    ? '✅ Repo owner connected — configured tokens settle on Base; legacy ETH settles on Optimism.'
    : '✅ Connected (read-only view — settle disabled for non-owner wallets).');

  // Load and display the payroll queue
  if (queueSection) queueSection.style.display = 'block';
  await loadPayrollQueue();
}

function _onWalletDisconnected() {
  document.getElementById('payroll-modal')?.classList.add('hidden');
  document.getElementById('payroll-overlay')?.classList.add('hidden');
  const addrEl    = document.getElementById('payroll-connected-addr');
  const statusEl  = document.getElementById('payroll-wallet-status');
  const warningEl = document.getElementById('payroll-owner-warning');
  const queueSection = document.getElementById('payroll-queue-section');

  if (addrEl)       addrEl.textContent = '';
  if (warningEl)    warningEl.style.display = 'none';
  if (queueSection) queueSection.style.display = 'none';
  _setStatus(statusEl, '');
}

// ─── Load and render payroll queue ────────────────────────────────────────────

export async function loadPayrollQueue() {
  const tableBody  = document.getElementById('payroll-table-body');
  const statusEl   = document.getElementById('payroll-queue-status');
  const settleBtn  = document.getElementById('payroll-settle-all-btn');
  const emptyMsg   = document.getElementById('payroll-empty-msg');

  if (!tableBody) return;
  tableBody.innerHTML = '<tr><td colspan="5" class="payroll-loading">⏳ Loading payroll queue…</td></tr>';
  if (statusEl) statusEl.textContent = '';

  try {
    _payrollAssetConfig = await _fetchJSON(PAYROLL_ASSETS_URL);
  } catch (err) {
    _payrollAssetConfig = null;
    if (statusEl) statusEl.textContent = `⚠️ Payroll asset configuration unavailable; Base-token settlements are disabled: ${_esc(err.message)}`;
  }

  try {
    const queue = await _fetchJSON(PAYROLL_QUEUE_URL);
    const pending = Array.isArray(queue.pending) ? queue.pending : [];
    _pendingEntries = pending;
    const optimism = new ethers.JsonRpcProvider('https://optimism-rpc.publicnode.com', OPTIMISM_CHAIN_ID);
    const verifiedLegacy = new Set();
    for (const entry of pending.filter(entry => _entryCurrency(entry) === 'ETH')) {
      const saved = _legacyStore().get(entry);
      if (!saved?.txHash) continue;
      try {
        const result = await verifyLegacyPayment({ provider: optimism, txHash: saved.txHash, owner: _ownerAddress,
          recipient: entry.contributor, amountWei: ethers.parseEther(String(entry.amount)) });
        _legacyStore().set(entry, { ...result, owner: _ownerAddress });
        if (result.status === 'confirmed') verifiedLegacy.add(entry);
      } catch {
        if (statusEl) statusEl.textContent = 'Some Optimism receipts could not be verified. Those entries remain locked; do not repay them.';
      }
    }
    _pendingEntries = pending.filter(entry => !verifiedLegacy.has(entry));

    if (_isRouterConfigured() && pending.some(entry => _entryCurrency(entry) !== 'ETH')) {
      try {
        const router = _readOnlyRouter();
        const visible = _pendingEntries;
        const paid = await Promise.all(visible.map(async entry => {
          if (_entryCurrency(entry) === 'ETH' || !_getAssetConfig(_entryCurrency(entry))) return false;
          return router.completedWorkReferences(_artWorkReference(entry));
        }));
        _pendingEntries = visible.filter((entry, index) => !paid[index]);
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = `⚠️ Could not check Base settlement status; configured-token entries remain visible: ${_esc(err.message)}`;
        }
      }
    }
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="5" class="payroll-loading payroll-error">❌ ${_esc(err.message)}</td></tr>`;
    return;
  }

  if (_pendingEntries.length === 0) {
    tableBody.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    if (settleBtn) settleBtn.disabled = true;
    return;
  }

  if (emptyMsg) emptyMsg.style.display = 'none';

  const isOwner = _ownerAddress && window._wallet?.address &&
    _ownerAddress.toLowerCase() === window._wallet.address.toLowerCase();

  tableBody.innerHTML = _pendingEntries.map((entry, i) => {
    const currency = _entryCurrency(entry);
    const isRouterEntry = currency !== 'ETH';
    const wallet = entry.contributor || '';
    const explorerBase = isRouterEntry ? 'https://basescan.org/address/' : 'https://optimistic.etherscan.io/address/';
    const walletDisplay = wallet
      ? `<a href="${explorerBase}${_esc(wallet)}" target="_blank" rel="noopener" class="payroll-addr-link" title="${_esc(wallet)}">${_esc(_shortAddr(wallet))}</a>`
      : '<span class="payroll-no-wallet">⚠️ No wallet</span>';
    const canPay = isOwner && _isPayableEntry(entry);
    const legacy = !isRouterEntry && isOwner;
    const receipt = legacy ? _legacyStore().get(entry) : null;
    return `
      <tr data-index="${i}" class="payroll-row${isRouterEntry ? ' payroll-row-art' : ''}">
        <td class="payroll-td">
          <a href="https://github.com/${_esc(entry.contributorGithub)}" target="_blank" rel="noopener" class="payroll-github-link">
            <img src="https://github.com/${_esc(entry.contributorGithub)}.png?size=20" class="payroll-avatar" onerror="this.style.display='none'" />
            @${_esc(entry.contributorGithub)}
          </a>
        </td>
        <td class="payroll-td">${walletDisplay}</td>
        <td class="payroll-td payroll-amount">
          <strong>${_esc(entry.amount)} ${_esc(currency)}</strong>
          ${isRouterEntry ? `<br><small>Base · ${_esc(entry.fund || _payrollAssetConfig?.fundSlug || '')}</small>` : ''}
        </td>
        <td class="payroll-td payroll-issue">
          <a href="https://github.com/${_esc(entry.issueRef.replace('#', '/issues/'))}" target="_blank" rel="noopener" class="payroll-issue-link">
            ${_esc(entry.issueRef)}
          </a>
        </td>
        <td class="payroll-td">
          ${canPay
            ? `<button class="payroll-pay-btn" data-index="${i}">💸 Pay</button>`
            : `<span class="payroll-pay-disabled">${!isOwner ? '🔒' : !wallet ? '⚠️ No wallet' : isRouterEntry ? '⚠️ Router/token not configured' : 'Review prior payment'}</span>`
          }
          ${legacy ? `<div class="payroll-legacy-review">
            <input class="payroll-tx-hash" data-index="${i}" aria-label="Existing Optimism transaction for ${_esc(entry.issueRef)}" placeholder="Existing Optimism tx hash" value="${_esc(receipt?.txHash || '')}" />
            <button class="payroll-verify-btn" data-index="${i}" type="button">Verify Existing Payment</button>
            ${!receipt || receipt.status === 'reviewed-unpaid' ? `<label><input class="payroll-reviewed-unpaid" data-index="${i}" type="checkbox" ${receipt?.status === 'reviewed-unpaid' ? 'checked' : ''} /> I checked history: this entry is unpaid</label>` : `<span>Payment ${_esc(receipt.status)}. Do not send again.</span>`}
          </div>` : ''}
        </td>
      </tr>`;
  }).join('');

  // Attach individual Pay button listeners
  const renderedEntries = _pendingEntries.slice();
  tableBody.querySelectorAll('.payroll-pay-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const entry = renderedEntries[Number(btn.dataset.index)];
      const idx = _pendingEntries.indexOf(entry);
      if (idx < 0) return;
      await _paySingle(idx, btn);
    });
  });
  tableBody.querySelectorAll('.payroll-verify-btn').forEach(button => button.addEventListener('click', async () => {
    const index = Number(button.dataset.index);
    const entry = _pendingEntries[index];
    const txHash = tableBody.querySelector(`.payroll-tx-hash[data-index="${index}"]`).value.trim();
    try {
      button.disabled = true;
      const provider = new ethers.JsonRpcProvider('https://optimism-rpc.publicnode.com', OPTIMISM_CHAIN_ID);
      const verified = await verifyLegacyPayment({ provider, txHash, owner: _ownerAddress,
        recipient: entry.contributor, amountWei: ethers.parseEther(String(entry.amount)) });
      _legacyStore().set(entry, { ...verified, owner: _ownerAddress });
      _showSettleWorkflowHint(txHash);
      await loadPayrollQueue();
    } catch (error) {
      _setStatus(statusEl, error.message, true);
      button.disabled = false;
    }
  }));
  tableBody.querySelectorAll('.payroll-reviewed-unpaid').forEach(checkbox => checkbox.addEventListener('change', async () => {
    const entry = _pendingEntries[Number(checkbox.dataset.index)];
    if (checkbox.checked) _legacyStore().set(entry, { status: 'reviewed-unpaid', owner: _ownerAddress });
    else _legacyStore().remove(entry);
    await loadPayrollQueue();
  }));

  // Enable/disable Settle All button
  const payableCount = _pendingEntries.filter(e => isOwner && _isPayableEntry(e)).length;
  if (settleBtn) {
    settleBtn.disabled = payableCount === 0;
    settleBtn.textContent = `💸 Settle All (${payableCount} payable)`;
  }
}

function isValidEthAddress(addr) {
  return !!addr && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function _entryCurrency(entry) {
  return String(entry?.currency || 'ETH').trim().toUpperCase();
}

function _isEthPayableEntry(entry) {
  return _entryCurrency(entry) === 'ETH' && isValidEthAddress(entry?.contributor) && _legacyStore().get(entry)?.status === 'reviewed-unpaid';
}

function _getAssetConfig(currency) {
  const asset = _payrollAssetConfig?.assets?.[String(currency || '').toUpperCase()];
  return asset && isValidEthAddress(asset.address) && Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 36
    ? asset
    : null;
}

function _isRouterConfigured() {
  return isValidEthAddress(_payrollAssetConfig?.routerAddress) && Number.isInteger(_payrollAssetConfig?.chainId);
}

function _isPayableEntry(entry) {
  return isValidEthAddress(entry?.contributor) && (
    _isEthPayableEntry(entry) || (_entryCurrency(entry) !== 'ETH' && _isRouterConfigured() && _getAssetConfig(_entryCurrency(entry)))
  );
}

function _readOnlyRouter() {
  const provider = new ethers.JsonRpcProvider(_payrollAssetConfig.rpcUrl, _payrollAssetConfig.chainId, { batchMaxCount: 1 });
  return new ethers.Contract(_payrollAssetConfig.routerAddress, ROUTER_ABI, provider);
}

function _artWorkReference(entry) {
  const role = entry.role || 'contributor';
  const base = `${entry.issueRef}:${entry.contributorGithub}:${role}`;
  const currency = _entryCurrency(entry);
  return ethers.keccak256(ethers.toUtf8Bytes(currency === 'ART' ? base : `${base}:${currency}`));
}

async function _switchNetwork(chainId) {
  if (!window.ethereum) throw new Error('MetaMask is not available.');
  const baseChainId = Number(_payrollAssetConfig?.chainId || BASE_CHAIN_ID);
  const chainHex = `0x${chainId.toString(16)}`;
  const activeChain = Number.parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
  if (activeChain === chainId) return;

  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
  } catch (err) {
    if (err.code !== 4902) throw err;
    const network = chainId === baseChainId
      ? { chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [_payrollAssetConfig?.rpcUrl || 'https://base-rpc.publicnode.com'], blockExplorerUrls: ['https://basescan.org'] }
      : { chainName: 'Optimism', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.optimism.io'], blockExplorerUrls: ['https://optimistic.etherscan.io'] };
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: chainHex, ...network }],
    });
  }
}

async function _getSigner(chainId) {
  await _switchNetwork(chainId);
  const provider = new ethers.BrowserProvider(window.ethereum);
  return provider.getSigner();
}

async function _payTokenEntry(entry) {
  if (!_isRouterConfigured()) throw new Error('Payroll Settlement Router is not configured.');
  const currency = _entryCurrency(entry);
  const asset = _getAssetConfig(currency);
  if (!asset) throw new Error(`No configured Base token matches ${currency}.`);
  const fundSlug = String(entry.fund || _payrollAssetConfig.fundSlug || '').trim().toLowerCase();
  if (!fundSlug || fundSlug !== String(_payrollAssetConfig.fundSlug || '').trim().toLowerCase()) {
    throw new Error(`Unexpected payroll fund: ${fundSlug || '(missing)'}`);
  }

  const statusEl = document.getElementById('payroll-queue-status');
  const signer = await _getSigner(Number(_payrollAssetConfig.chainId));
  const owner = await signer.getAddress();
  if (!_ownerAddress || owner.toLowerCase() !== _ownerAddress.toLowerCase()) {
    throw new Error('Connect the registered repo owner wallet before settling payroll.');
  }

  const router = new ethers.Contract(_payrollAssetConfig.routerAddress, ROUTER_ABI, signer);
  const provider = signer.provider;
  const routerCode = await provider.getCode(_payrollAssetConfig.routerAddress);
  if (!routerCode || routerCode === '0x') throw new Error('No Settlement Router contract is deployed at the configured Base address.');

  const [payrollRole, contributorAdminRole, fundId, assetApproved] = await Promise.all([
    router.PAYROLL_ROLE(),
    router.CONTRIBUTOR_ADMIN_ROLE(),
    ethers.keccak256(ethers.toUtf8Bytes(fundSlug)),
    router.approvedAssets(asset.address),
  ]);
  const hasPayrollRole = await router.hasRole(payrollRole, owner);
  if (!hasPayrollRole) throw new Error('The connected wallet does not have PAYROLL_ROLE on the shared Settlement Router.');
  if (!assetApproved) throw new Error(`${currency} is not approved as a payout asset on the shared Settlement Router.`);

  const workReference = _artWorkReference(entry);
  if (await router.completedWorkReferences(workReference)) {
    throw new Error('This work reference is already paid on-chain. Refresh the queue.');
  }

  const fund = await router.funds(fundId);
  if (!(fund.exists ?? fund[2])) throw new Error(`Create the ${fundSlug} allocation on the shared router before paying.`);
  if (!(fund.active ?? fund[1])) throw new Error(`The ${fundSlug} allocation is inactive.`);

  const recipient = ethers.getAddress(entry.contributor);
  const contributorHash = ethers.id(String(entry.contributorGithub).trim());
  const contributor = await router.contributors(recipient);
  const registeredHash = String(contributor.githubIdHash ?? contributor[0]).toLowerCase();
  if (registeredHash !== ethers.ZeroHash.toLowerCase() && registeredHash !== contributorHash.toLowerCase()) {
    throw new Error(`This wallet is already associated with a different GitHub identity on the shared router.`);
  }
  if (!(contributor.approved ?? contributor[1])) {
    if (!(await router.hasRole(contributorAdminRole, owner))) {
      throw new Error('The connected wallet cannot approve contributors on the shared Settlement Router.');
    }
    _setStatus(statusEl, `⏳ Approving @${entry.contributorGithub} on the shared router… confirm in MetaMask.`);
    await (await router.setContributorApproved(recipient, contributorHash, true)).wait();
  }

  const amount = ethers.parseUnits(String(entry.amount), asset.decimals);
  const available = await router.fundBalances(fundId, asset.address);
  if (available < amount) {
    throw new Error(`The ${fundSlug} fund has insufficient ${currency}. Available: ${ethers.formatUnits(available, asset.decimals)} ${currency}.`);
  }

  const repository = String(entry.issueRef).split('#')[0];
  const metadataUri = `https://github.com/${entry.issueRef.replace('#', '/issues/')}`;
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({
    issueRef: entry.issueRef,
    contributorGithub: entry.contributorGithub,
    role: entry.role || 'contributor',
    amount: String(entry.amount),
    currency,
    fund: fundSlug,
  })));
  const payoutArgs = [
    fundId,
    asset.address,
    recipient,
    amount,
    workReference,
    ethers.id(repository),
    contributorHash,
    metadataUri,
    metadataHash,
  ];

  await router.payout.staticCall(...payoutArgs);
  _setStatus(statusEl, `⏳ Paying ${entry.amount} ${currency} to @${entry.contributorGithub} from ${fundSlug}… confirm in MetaMask.`);
  const tx = await router.payout(...payoutArgs);
  await tx.wait();
  return tx.hash;
}

async function _payEthEntry(entry) {
  if (_legacyStore().get(entry)?.status !== 'reviewed-unpaid') throw new Error('Review existing Optimism payments before sending ETH. Verify an existing receipt instead of paying again.');
  const signer = await _getSigner(OPTIMISM_CHAIN_ID);
  const owner = await signer.getAddress();
  if (!_ownerAddress || owner.toLowerCase() !== _ownerAddress.toLowerCase()) throw new Error('Connect the registered owner wallet before settling payroll');
  const { to, amountWei } = _buildTxParams(entry);
  if (!to) throw new Error(`No valid wallet address for @${entry.contributorGithub}.`);
  _legacyStore().set(entry, { status: 'awaiting-wallet', owner });
  let tx;
  try {
    tx = await signer.sendTransaction({ to, value: amountWei });
  } catch (error) {
    if (error.code === 4001 || error.code === 'ACTION_REJECTED') _legacyStore().remove(entry);
    throw error;
  }
  _legacyStore().set(entry, { status: 'pending', owner, txHash: tx.hash });
  await tx.wait();
  const verified = await verifyLegacyPayment({ provider: signer.provider, txHash: tx.hash, owner, recipient: to, amountWei });
  _legacyStore().set(entry, { ...verified, owner });
  return tx.hash;
}

// ─── Settle a single queue entry ──────────────────────────────────────────────

async function _paySingle(index, btn) {
  if (_settling) return;
  const entry    = _pendingEntries[index];
  const statusEl = document.getElementById('payroll-queue-status');

  if (!entry) return;
  if (!_isPayableEntry(entry)) {
    _setStatus(statusEl, `⚠️ No supported payout route for @${entry.contributorGithub}.`, true);
    return;
  }
  if (!window.ethereum) {
    _setStatus(statusEl, '⚠️ Please connect MetaMask first.', true);
    return;
  }

  try {
    _settling = true;
    if (btn) btn.disabled = true;
    const txHash = _entryCurrency(entry) !== 'ETH'
      ? await _payTokenEntry(entry)
      : await _payEthEntry(entry);
    const explorer = _entryCurrency(entry) !== 'ETH' ? 'https://basescan.org/tx/' : 'https://optimistic.etherscan.io/tx/';
    _setStatus(statusEl, `✅ ${entry.amount} ${_entryCurrency(entry)} paid to @${entry.contributorGithub}. ${explorer}${txHash}`);

    _showSettleWorkflowHint(txHash);
    await loadPayrollQueue();

  } catch (err) {
    _setStatus(statusEl, `❌ ${_entryCurrency(entry)} settlement failed: ${err.message}`, true);
    if (btn) btn.disabled = _entryCurrency(entry) === 'ETH' && Boolean(_legacyStore().get(entry));
  } finally {
    _settling = false;
  }
}

// ─── Settle All ───────────────────────────────────────────────────────────────

async function _settleAll() {
  if (_settling) return;
  const statusEl = document.getElementById('payroll-queue-status');
  const settleBtn = document.getElementById('payroll-settle-all-btn');

  if (!window.ethereum) {
    _setStatus(statusEl, '⚠️ Please connect MetaMask first.', true);
    return;
  }

  const payable = _pendingEntries.filter(_isPayableEntry);
  if (payable.length === 0) {
    _setStatus(statusEl, '⚠️ No eligible configured-token or legacy ETH entries are available to settle.', true);
    return;
  }

  const counts = new Map();
  for (const entry of payable) counts.set(_entryCurrency(entry), (counts.get(_entryCurrency(entry)) || 0) + 1);
  const networks = [...counts].map(([currency, count]) => currency === 'ETH'
    ? `${count} legacy ETH on Optimism`
    : `${count} ${currency} on Base`).join(' and ');
  if (!confirm(`Settle ${networks}? Each transaction is final.`)) {
    return;
  }

  try {
    _settling = true;
    if (settleBtn) settleBtn.disabled = true;

    const hashes = [];
    for (const entry of payable) {
      const txHash = _entryCurrency(entry) !== 'ETH'
        ? await _payTokenEntry(entry)
        : await _payEthEntry(entry);
      hashes.push(txHash);
      console.log(`✅ Settled ${entry.amount} ${_entryCurrency(entry)} to ${entry.contributor} (${entry.contributorGithub}) — ${txHash}`);
    }

    _setStatus(statusEl, `✅ All ${payable.length} payroll transaction(s) confirmed.`);
    _showSettleWorkflowHint(hashes[hashes.length - 1]);

    await loadPayrollQueue();

  } catch (err) {
    _setStatus(statusEl, `❌ Settlement failed: ${err.message}`, true);
    if (settleBtn) settleBtn.disabled = false;
  } finally {
    _settling = false;
  }
}

function _buildTxParams(entry) {
  if (_entryCurrency(entry) !== 'ETH') return { to: null, amountWei: null };
  const to = entry.contributor || '';
  if (!isValidEthAddress(to)) return { to: null, amountWei: null };
  const amountWei = ethers.parseEther(String(entry.amount));
  return { to, amountWei };
}

// ─── Post-settlement hint ─────────────────────────────────────────────────────

function _showSettleWorkflowHint(txHash) {
  const hintEl = document.getElementById('payroll-settle-hint');
  if (!hintEl) return;
  hintEl.innerHTML =
    `Confirmed on-chain. Run the <a href="https://github.com/TheJollyLaMa/DecentBusking/actions/workflows/settle-payroll.yml" ` +
    `target="_blank" rel="noopener" class="payroll-link">Settle Payroll workflow</a> to mirror the transaction in the repository ledger.` +
    (txHash ? `<br><small>Last tx: <code>${txHash}</code></small>` : '');
  hintEl.style.display = 'block';
}

// ─── Initialise the payroll panel ─────────────────────────────────────────────

export function initPayroll() {
  const settleBtn   = document.getElementById('payroll-settle-all-btn');
  const refreshBtn  = document.getElementById('payroll-refresh-btn');
  const openBtn     = document.getElementById('payroll-open-btn');
  const closeBtn    = document.getElementById('payroll-close-btn');
  const modal       = document.getElementById('payroll-modal');
  const overlay     = document.getElementById('payroll-overlay');

  // Open via the legacy inline button (if still present) or via the
  // "open-payroll" custom event dispatched by the header dropdown link.
  function openPayroll() {
    if (!isAdminWallet()) return;
    if (modal)   modal.classList.remove('hidden');
    if (overlay) overlay.classList.remove('hidden');

    // If wallet is already connected when the panel opens, populate immediately.
    if (window._wallet?.address) {
      _onWalletConnected({ detail: { address: window._wallet.address, chainId: window._wallet.chainId } });
    }
  }

  if (openBtn) openBtn.addEventListener('click', openPayroll);
  document.addEventListener('open-payroll', openPayroll);

  function closePayroll() {
    if (modal)   modal.classList.add('hidden');
    if (overlay) overlay.classList.add('hidden');
  }

  if (closeBtn)  closeBtn.addEventListener('click', closePayroll);
  if (overlay)   overlay.addEventListener('click', closePayroll);
  if (settleBtn)  settleBtn.addEventListener('click', _settleAll);
  if (refreshBtn) refreshBtn.addEventListener('click', loadPayrollQueue);

  // React to global wallet events.
  document.addEventListener('wallet-connected',    _onWalletConnected);
  document.addEventListener('wallet-disconnected', _onWalletDisconnected);

  // Pre-load owner address in background
  _loadOwnerAddress().then(addr => { _ownerAddress = addr; });
}
