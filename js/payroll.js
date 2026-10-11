/**
 * js/payroll.js — DecentBusking Payroll Panel
 *
 * Provides the owner with a browser-side payroll UI to:
 *   1. Load the pending payroll queue from payroll-queue.json.
 *   2. Verify the connected wallet is the repo owner.
 *   3. Settle configured ERC-20 rewards through the shared Base Settlement Router.
 *   4. Preview budget-capped artist and prize allocations on Base.
 *
 * Usage:
 *   - Owner clicks the 💸 Payroll button in the app.
 *   - Connects MetaMask; configured-token settlement uses Base.
 *   - Sees pending payouts with amounts, contributors, and wallet addresses.
 *   - Clicks "Settle All" or individual "Pay" buttons to settle eligible work.
 *   - ART payments are recorded on-chain and cannot be paid twice.
 *
 * Security note:
 *   A warning is shown if the connected wallet does NOT match the repo owner's
 *   address in contributor-accounts.json.  Only the repo owner should settle
 *   payroll.
 */

import { isAdminWallet } from './admin-access.mjs';
import { previewPlaybackPayroll, previewTopTenPayroll, finalizeRadioAllocation, settleRadioAllocation, validateRadioReceipt } from './radio-payroll.mjs';
import { configuredSettlementFunds, resolveSettlementFundSlug, validateSettlementFundSlug, defaultSettlementFundMetadata, buildSettlementFundMetadata, CUSTOM_FUND_OPTION, createConfiguredSettlementFund, depositSettlementUsdc, recoverSettlementUsdc, verifySettlementRecoveryReceipt } from './settlement-funds.mjs';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261005-upload-size-fix';

// ─── Constants ────────────────────────────────────────────────────────────────

const PAYROLL_QUEUE_URL =
  'https://raw.githubusercontent.com/TheJollyLaMa/DecentBusking/main/payroll-queue.json';

const ACCOUNTS_URL =
  'https://raw.githubusercontent.com/TheJollyLaMa/DecentBusking/main/contributor-accounts.json';

const BASE_CHAIN_ID = 8453;
const PAYROLL_ASSETS_URL = new URL('../payroll-assets.json', import.meta.url).toString();
const ROUTER_ABI = [
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function createFund(bytes32 fundId, string metadataUri)',
  'function paused() view returns (bool)',
  'function fundToken(bytes32 fundId, address asset, uint256 amount)',
  'function recoverFund(bytes32 fundId, address asset, address recipient, uint256 amount)',
  'event FundRecovered(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount)',
  'event FundFunded(bytes32 indexed fundId, address indexed asset, address indexed funder, uint256 amount)',
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
const USDC_ABI = ['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)'];
USDC_ABI.push('event Transfer(address indexed from, address indexed to, uint256 value)');

// ─── Module state ─────────────────────────────────────────────────────────────

let _pendingEntries   = [];
let _ownerAddress     = null;
let _payrollAssetConfig = null;
let _settling = false;
let _radioReports = [];
let _radioRefreshId = 0;
let _radioBalances = null;
let _routerRefreshId = 0;
let _routerCreateAllowed = false;
let _radioReviews = {};
let _radioRecipientStates = new Map();
let _recipientCheckId = 0;
let _paymentSyncTask = null;
let _weeklyPayflow = null;
let _weeklyPayflowTask = null;
let _weeklyHistoryRefreshedAt = 0;
let _fundMetadataRevision = 0;
const _customFundSlugs = new Set();

function _selectedFundSlug() {
  return resolveSettlementFundSlug(document.getElementById('router-fund-select')?.value,
    document.getElementById('router-custom-fund-slug')?.value, _payrollAssetConfig || {}, [..._customFundSlugs]);
}

function _customFundStorageKey() {
  return `decentbusking:custom-router-funds:v1:${String(_payrollAssetConfig?.routerAddress || '').toLowerCase()}`;
}

function _loadCustomFundSlugs() {
  _customFundSlugs.clear();
  try {
    const saved = JSON.parse(localStorage.getItem(_customFundStorageKey()) || '[]');
    if (!Array.isArray(saved)) return;
    const configured = new Set(configuredSettlementFunds(_payrollAssetConfig || {}).map(fund => fund.slug));
    for (const value of saved) {
      try {
        const slug = validateSettlementFundSlug(value);
        if (!configured.has(slug)) _customFundSlugs.add(slug);
      } catch {}
    }
  } catch {}
}

function _rememberCustomFund(slug) {
  _customFundSlugs.add(slug);
  try { localStorage.setItem(_customFundStorageKey(), JSON.stringify([..._customFundSlugs])); } catch {}
}

function _metadataUriReady() {
  const value = document.getElementById('router-fund-metadata')?.value.trim() || '';
  try {
    const uri = new URL(value);
    return value.length <= 2048 && ['https:', 'ipfs:'].includes(uri.protocol) && Boolean(uri.hostname);
  } catch { return false; }
}

function _invalidateFundMetadata() {
  ++_fundMetadataRevision;
  const input = document.getElementById('router-fund-metadata');
  if (input) { input.value = ''; input.dataset.autoValue = ''; }
  _setStatus(document.getElementById('router-metadata-status'), '');
}

function _customFundDraft() {
  return { slug: _selectedFundSlug(), name: document.getElementById('router-fund-name').value,
    description: document.getElementById('router-fund-purpose').value,
    website: document.getElementById('router-fund-website').value };
}

async function _saveFundMetadata() {
  const status = document.getElementById('router-metadata-status');
  const form = document.getElementById('router-custom-fund-form');
  if (_settling || !isAdminWallet() || document.getElementById('router-fund-select').value !== CUSTOM_FUND_OPTION) return;
  if (!form.reportValidity()) return;
  const revision = _fundMetadataRevision;
  try {
    const draft = _customFundDraft();
    const routerAddress = _payrollAssetConfig?.routerAddress;
    const metadata = buildSettlementFundMetadata({ ...draft, routerAddress, owner: _ownerAddress,
      fundId: ethers.id(draft.slug), createdAt: new Date().toISOString() });
    _settling = true;
    ++_routerRefreshId;
    _routerCreateAllowed = false;
    for (const id of ['router-save-metadata', 'router-create-fund', 'router-deposit-usdc']) document.getElementById(id).disabled = true;
    _setStatus(status, 'Checking Base owner and router permissions...');
    const signer = await _getSigner(BASE_CHAIN_ID);
    const address = await signer.getAddress();
    if (address.toLowerCase() !== _ownerAddress.toLowerCase()) throw new Error('Connect the configured owner wallet');
    if (Number((await signer.provider.getNetwork()).chainId) !== BASE_CHAIN_ID) throw new Error('Fund metadata is Base-only');
    if (await signer.provider.getCode(routerAddress) === '0x') throw new Error('Settlement router is not deployed');
    const router = new ethers.Contract(routerAddress, ROUTER_ABI, signer);
    if (!await router.hasRole(await router.DEFAULT_ADMIN_ROLE(), address)) throw new Error('This wallet lacks the settlement router DEFAULT_ADMIN_ROLE');
    const fund = await router.funds(metadata.fundId);
    if (fund.exists ?? fund[2]) throw new Error('This fund already exists; its creation metadata cannot be replaced here');
    const unchanged = () => revision === _fundMetadataRevision && isAdminWallet() &&
      window._wallet?.address?.toLowerCase() === address.toLowerCase() && _payrollAssetConfig?.routerAddress === routerAddress;
    if (!unchanged()) throw new Error('Fund details or wallet changed; save metadata again');
    const upload = createBrowserIpfsUploader({ provider: window.DecentConfig?.ipfsUploadProvider || 'pinata',
      serviceUrl: window.DecentConfig?.ipfsUploadServiceUrl, ipfsApiUrl: window.DecentConfig?.ipfsApiUrl,
      signer, address, origin: window.location.origin });
    _setStatus(status, 'Saving public fund metadata to IPFS; sign the upload authorization. No fund transaction is sent.');
    const uri = await upload(new File([JSON.stringify(metadata, null, 2)], `${draft.slug}-fund.json`, { type: 'application/json' }));
    if (!unchanged()) throw new Error('Fund details or wallet changed during upload; save metadata again');
    if (!/^ipfs:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(uri)) throw new Error('IPFS upload returned an invalid URI');
    document.getElementById('router-fund-metadata').value = uri;
    _setStatus(status, 'Metadata saved to IPFS. Ready for the separate Create Fund on Base confirmation.');
  } catch (error) {
    _setStatus(status, error.message || 'Metadata upload failed; retry saving', true);
  } finally {
    _settling = false;
    await _refreshSettlementFund();
  }
}

function _reviewKey(category, week) {
  return JSON.stringify([8453, _payrollAssetConfig.routerAddress.toLowerCase(), _ownerAddress.toLowerCase(), category, week]);
}

function _reviewRecords() {
  const result = JSON.parse(localStorage.getItem('decentbusking:radio-payroll-reviews:v1') || '{}');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Saved radio receipts are invalid; review them before settlement');
  return result;
}

function _depositKey() {
  return `decentbusking:deposit:v1:${_payrollAssetConfig.routerAddress.toLowerCase()}:${_ownerAddress.toLowerCase()}:${_selectedFundSlug()}`;
}

function _recoveryKey() {
  return `decentbusking:recovery:v1:8453:${_payrollAssetConfig.routerAddress.toLowerCase()}:${_ownerAddress.toLowerCase()}:${_selectedFundSlug()}`;
}

async function _recoverUsdc() {
  const status = document.getElementById('router-recovery-status');
  if (_settling || !isAdminWallet()) return;
  let operationKey;
  try {
    const slug = _selectedFundSlug();
    operationKey = _recoveryKey();
    if (localStorage.getItem(operationKey) || localStorage.getItem(_depositKey())) throw new Error('Resolve the pending recovery or deposit receipt first');
    const asset = _getAssetConfig('USDC');
    if (!asset || asset.decimals !== 6) throw new Error('Native Base USDC is not configured');
    const amountUnits = ethers.parseUnits(document.getElementById('router-recovery-amount').value || '0', 6);
    if (amountUnits <= 0n) throw new Error('Enter a positive recovery amount');
    if (!confirm(`Recover ${ethers.formatUnits(amountUnits, 6)} USDC from ${slug} to your owner wallet ${_ownerAddress}? This reduces the funds available for artist payouts.`)) return;
    _settling = true;
    document.getElementById('router-recover-usdc').disabled = true;
    const signer = await _getSigner(BASE_CHAIN_ID);
    const router = new ethers.Contract(_payrollAssetConfig.routerAddress, ROUTER_ABI, signer);
    const token = new ethers.Contract(asset.address, USDC_ABI, signer);
    const record = { owner: _ownerAddress, router: router.target, asset: token.target, fundId: ethers.id(slug), amountUnits: amountUnits.toString(), txHash: null };
    _setStatus(status, 'Verify the owner destination and confirm the recovery in your wallet.');
    const result = await recoverSettlementUsdc({ router, token, signer, owner: _ownerAddress, fundId: record.fundId, amountUnits,
      onStage: () => localStorage.setItem(operationKey, JSON.stringify(record)),
      onBroadcast: txHash => localStorage.setItem(operationKey, JSON.stringify({ ...record, txHash })) });
    localStorage.removeItem(operationKey);
    _setStatus(status, `Recovery confirmed to the owner wallet: ${result.txHash}`);
    await _refreshRadioPayroll();
  } catch (error) {
    if (operationKey && ['ACTION_REJECTED', 4001].includes(error.code)) {
      const record = JSON.parse(localStorage.getItem(operationKey) || 'null');
      if (record && !record.txHash) localStorage.removeItem(operationKey);
    }
    _setStatus(status, `${error.message}. Check any unresolved recovery receipt before retrying.`, true);
  } finally { _settling = false; await _refreshSettlementFund(); }
}

async function _checkRecoveryReceipt() {
  const status = document.getElementById('router-recovery-status');
  if (_settling || !isAdminWallet()) return;
  try {
    const key = _recoveryKey();
    const record = JSON.parse(localStorage.getItem(key) || 'null');
    if (!record) throw new Error('No unresolved recovery is recorded for this fund');
    const hash = document.getElementById('router-recovery-hash').value.trim() || record.txHash;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) throw new Error('Enter the recovery transaction hash from wallet history');
    const provider = new ethers.JsonRpcProvider(_payrollAssetConfig.rpcUrl, BASE_CHAIN_ID);
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt) throw new Error('Recovery remains unresolved; do not resend');
    if (receipt.status !== 1) {
      if (!record.txHash || hash.toLowerCase() !== record.txHash.toLowerCase()) throw new Error('Failed receipt does not match the recorded recovery');
    } else {
      const router = new ethers.Contract(record.router, ROUTER_ABI, provider);
      const token = new ethers.Contract(record.asset, USDC_ABI, provider);
      verifySettlementRecoveryReceipt({ receipt, router, token, owner: record.owner, fundId: record.fundId, amountUnits: BigInt(record.amountUnits) });
    }
    localStorage.removeItem(key);
    await _refreshSettlementFund(); await _refreshRadioPayroll();
    _setStatus(status, receipt.status === 1 ? 'Exact USDC recovery verified. Do not send it again.' : 'Recorded recovery reverted; no recovery occurred.');
  } catch (error) { _setStatus(status, error.message, true); }
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
    ? '✅ Repo owner connected — configured tokens settle on Base.'
    : '✅ Connected (read-only view — settle disabled for non-owner wallets).');

  // Load and display the payroll queue
  if (queueSection) queueSection.style.display = 'block';
  await loadPayrollQueue();
  _loadCustomFundSlugs();
  _populateSettlementFunds();
  await _refreshSettlementFund();
  await _refreshRadioPayroll();
  _syncPaymentLedger();
}

function _onWalletDisconnected() {
  ++_recipientCheckId;
  _radioRecipientStates.clear();
  _invalidateFundMetadata();
  _radioReviews = {};
  document.getElementById('radio-reviewed-receipts')?.replaceChildren();
  for (const id of ['router-recover-usdc', 'router-save-metadata', 'router-deposit-usdc', 'radio-payroll-finalize', 'radio-settle-playback', 'radio-settle-top10']) {
    const button = document.getElementById(id); if (button) button.disabled = true;
  }
  ++_routerRefreshId;
  _routerCreateAllowed = false;
  const createButton = document.getElementById('router-create-fund');
  if (createButton) createButton.disabled = true;
  ++_radioRefreshId;
  _radioReports = [];
  _radioBalances = null;
  for (const id of ['radio-playback-balance', 'radio-prize-balance', 'radio-gas-balance']) {
    const element = document.getElementById(id);
    if (element) element.textContent = 'Not loaded';
  }
  document.getElementById('radio-playback-preview')?.replaceChildren();
  document.getElementById('radio-prize-preview')?.replaceChildren();
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
    const pending = Array.isArray(queue.pending) ? queue.pending.filter(entry => _entryCurrency(entry) !== 'ETH') : [];
    _pendingEntries = pending;

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
    const explorerBase = 'https://basescan.org/address/';
    const walletDisplay = wallet
      ? `<a href="${explorerBase}${_esc(wallet)}" target="_blank" rel="noopener" class="payroll-addr-link" title="${_esc(wallet)}">${_esc(_shortAddr(wallet))}</a>`
      : '<span class="payroll-no-wallet">⚠️ No wallet</span>';
    const canPay = isOwner && _isPayableEntry(entry);
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

function _getAssetConfig(currency) {
  const asset = _payrollAssetConfig?.assets?.[String(currency || '').toUpperCase()];
  return asset && isValidEthAddress(asset.address) && Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 36
    ? asset
    : null;
}

function _isRouterConfigured() {
  return isValidEthAddress(_payrollAssetConfig?.routerAddress) && _payrollAssetConfig?.chainId === BASE_CHAIN_ID;
}

function _isPayableEntry(entry) {
  return isValidEthAddress(entry?.contributor) && _entryCurrency(entry) !== 'ETH' && _isRouterConfigured() && Boolean(_getAssetConfig(_entryCurrency(entry)));
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
  if (chainId !== BASE_CHAIN_ID) throw new Error('Active payroll settlement is Base-only');
  if (!window.ethereum) throw new Error('MetaMask is not available.');
  const chainHex = `0x${chainId.toString(16)}`;
  const activeChain = Number.parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16);
  if (activeChain === chainId) return;

  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
  } catch (err) {
    if (err.code !== 4902) throw err;
    const network = { chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [_payrollAssetConfig?.rpcUrl || 'https://base-rpc.publicnode.com'], blockExplorerUrls: ['https://basescan.org'] };
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
  if ((await tx.wait())?.status !== 1) throw new Error('Repository payout was not confirmed successfully');
  _queuePaymentProof(tx.hash);
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
    const txHash = await _payTokenEntry(entry);
    const explorer = 'https://basescan.org/tx/';
    _setStatus(statusEl, `✅ ${entry.amount} ${_entryCurrency(entry)} paid to @${entry.contributorGithub}. ${explorer}${txHash}`);

    _showSettleWorkflowHint(txHash);
    await loadPayrollQueue();

  } catch (err) {
    _setStatus(statusEl, `❌ ${_entryCurrency(entry)} settlement failed: ${err.message}`, true);
    if (btn) btn.disabled = false;
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
    _setStatus(statusEl, 'No eligible Base token entries are available to settle.', true);
    return;
  }

  const counts = new Map();
  for (const entry of payable) counts.set(_entryCurrency(entry), (counts.get(_entryCurrency(entry)) || 0) + 1);
  const networks = [...counts].map(([currency, count]) => `${count} ${currency} on Base`).join(' and ');
  if (!confirm(`Settle ${networks}? Each transaction is final.`)) {
    return;
  }

  try {
    _settling = true;
    if (settleBtn) settleBtn.disabled = true;

    const hashes = [];
    for (const entry of payable) {
      const txHash = await _payTokenEntry(entry);
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

async function _refreshRadioPayroll() {
  _weeklyHistoryRefreshedAt = Date.now();
  const select = document.getElementById('radio-payroll-week');
  const status = document.getElementById('radio-payroll-status');
  if (!select || !isAdminWallet()) return;
  const selectedWeek = select.value;
  const refreshId = ++_radioRefreshId;
  _radioReports = [];
  _radioBalances = null;
  _radioReviews = {};
  document.getElementById('radio-reviewed-receipts')?.replaceChildren();
  for (const id of ['radio-payroll-finalize', 'radio-settle-playback', 'radio-settle-top10']) {
    const button = document.getElementById(id); if (button) button.disabled = true;
  }
  document.getElementById('radio-playback-preview')?.replaceChildren();
  document.getElementById('radio-prize-preview')?.replaceChildren();
  for (const id of ['radio-playback-balance', 'radio-prize-balance', 'radio-gas-balance']) {
    document.getElementById(id).textContent = 'Loading...';
  }
  _setStatus(status, 'Loading qualified weekly plays and Base treasury...');
  try {
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) throw new Error('Playback service is not configured');
    const response = await fetch(`${service}/api/radio/history?weeks=12&calendar=new-york`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Playback history unavailable (${response.status})`);
    const history = await response.json();
    if (refreshId !== _radioRefreshId) return;
    _radioReports = (history.weeks || []).filter(report => report.week !== 'all-time');
    for (const saved of Object.values(_reviewRecords())) {
      if (saved?.allocation && !_radioReports.some(report => report.week === saved.allocation.week)) {
        _radioReports.push({ week: saved.allocation.week, current: false, legacy: true, tracks: saved.allocation.entries });
      }
    }
    select.replaceChildren(..._radioReports.slice().reverse().map(report => {
      const option = document.createElement('option');
      option.value = report.week;
      option.textContent = `${report.week}${report.current ? ' · current estimate' : ' · completed'}${report.partial ? ' · partial migration week' : ''}${report.legacy ? ' · legacy receipt' : ''}`;
      return option;
    }));
    select.value = _radioReports.some(report => report.week === selectedWeek) ? selectedWeek
      : _radioReports.filter(report => !report.current && report.tracks?.length).at(-1)?.week || _radioReports.at(-1)?.week || '';
    _setStatus(status, 'New York weekly shares; payments still require owner wallet confirmation.');
    if (!_isRouterConfigured() || !_getAssetConfig('USDC')) throw new Error('Base USDC treasury configuration unavailable');
    const router = _readOnlyRouter();
    const asset = _getAssetConfig('USDC');
    const slugs = _payrollAssetConfig.radioFunds || {};
    const fundStatus = async slug => {
      if (!slug) return { available: 0n, active: false, exists: false };
      const id = ethers.id(slug);
      const fund = await router.funds(id);
      const exists = Boolean(fund.exists ?? fund[2]);
      const available = exists ? await router.fundBalances(id, asset.address) : 0n;
      return { available, exists, active: Boolean(fund.active ?? fund[1]) };
    };
    const [playback, prizes, approved, gas] = await Promise.all([
      fundStatus(slugs.playback), fundStatus(slugs.topTen), router.approvedAssets(asset.address), router.runner.getBalance(_ownerAddress),
    ]);
    if (refreshId !== _radioRefreshId) return;
    _radioBalances = { playback, prizes, approved };
    document.getElementById('radio-gas-balance').textContent = `${ethers.formatEther(gas)} ETH`;
    document.getElementById('radio-playback-balance').textContent = playback.exists ? `${ethers.formatUnits(playback.available, asset.decimals)} USDC` : 'Fund not created';
    document.getElementById('radio-prize-balance').textContent = prizes.exists ? `${ethers.formatUnits(prizes.available, asset.decimals)} USDC` : 'Fund not created';
    await _refreshWeeklyPayflow();
    _applyScheduledBudgets();
    _loadRadioReviews();
    _previewRadioPayroll();
  } catch (error) {
    if (refreshId === _radioRefreshId) _setStatus(status, `${error.message}. Refresh before finalizing or settling.`, true);
  }
}

function _applyScheduledBudgets() {
  const week = document.getElementById('radio-payroll-week')?.value;
  const automatic = Boolean(week?.startsWith('NY-'));
  for (const [category, id] of [['playback', 'radio-playback-budget'], ['top10', 'radio-prize-budget']]) {
    const input = document.getElementById(id);
    if (!input) continue;
    input.readOnly = automatic;
    if (automatic) {
      const receipt = _weeklyPayflow?.allocations?.find(record => record.allocation.week === week && record.allocation.category === category);
      const budget = receipt?.allocation.budgetUnits || (week === _weeklyPayflow?.currentPeriod.week ? _weeklyPayflow.funds?.[category]?.budgetUnits : '0') || '0';
      input.value = ethers.formatUnits(budget, 6);
    }
  }
  const minimum = document.getElementById('radio-minimum-payout');
  if (minimum) { minimum.readOnly = automatic; if (automatic) minimum.value = ethers.formatUnits(_weeklyPayflow?.minimumPayoutUnits || '10000', 6); }
}

async function _refreshWeeklyPayflow() {
  if (_weeklyPayflowTask || !isAdminWallet()) return _weeklyPayflowTask;
  const status = document.getElementById('radio-weekly-schedule-status');
  _weeklyPayflowTask = (async () => {
    try {
      const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
      const response = await fetch(`${service}/api/payroll/weekly`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Weekly preparation unavailable (${response.status})`);
      const state = await response.json();
      if (!isAdminWallet()) return;
      if (state.chainId !== BASE_CHAIN_ID || state.routerAddress?.toLowerCase() !== _payrollAssetConfig?.routerAddress.toLowerCase() || state.timeZone !== 'America/New_York') throw new Error('Weekly payflow does not match this Base router and New York schedule');
      _weeklyPayflow = state;
      const records = _reviewRecords();
      for (const saved of state.allocations || []) {
        validateRadioReceipt(saved.allocation, { routerAddress: _payrollAssetConfig.routerAddress, assetAddress: _getAssetConfig('USDC').address, funds: _payrollAssetConfig.radioFunds });
        if (saved.allocation.schemaVersion !== 3 || ethers.id(JSON.stringify(saved.allocation)) !== saved.metadataHash || !/^ipfs:\/\/[^/\s]+$/.test(saved.metadataUri)) throw new Error('Scheduled allocation proof is invalid');
        const key = _reviewKey(saved.allocation.category, saved.allocation.week);
        if (records[key] && records[key].metadataHash !== saved.metadataHash) throw new Error('A conflicting reviewed receipt exists; manual reconciliation required');
        records[key] = saved;
      }
      localStorage.setItem('decentbusking:radio-payroll-reviews:v1', JSON.stringify(records));
      const close = new Date(state.nextCloseAt).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
      _setStatus(status, !state.ready ? 'Weekly schedule restoring; no automatic payments.' :
        `Next close: ${close} · ${(state.fundShareBps / 100).toFixed(0)}% of unreserved closing funds · ${state.partial ? 'partial first week; old totals retained' : 'New York weeks'}${state.backupPending ? ' · receipt backup pending' : ''}${state.lastError ? ` · ${state.lastError}` : ''}`, Boolean(state.lastError));
      const target = document.getElementById('radio-funding-dashboard');
      target?.replaceChildren();
      for (const [category, fund] of Object.entries(state.funds || {})) {
        const block = document.createElement('div'); block.className = 'payroll-funding-band';
        const title = document.createElement('h4'); title.textContent = category === 'playback' ? 'Playback fund' : 'Top 10 prize fund';
        const balance = BigInt(fund.balanceUnits);
        const goal = BigInt(state.significantShareUnits) * BigInt(Math.max(1, fund.recipientCount || fund.estimatedShares?.length || 0));
        const meter = document.createElement('meter'); meter.min = 0; meter.max = 100; meter.value = Number((balance < goal ? balance : goal) * 10000n / goal) / 100;
        meter.setAttribute('aria-label', `${title.textContent}: balance toward ${ethers.formatUnits(goal, 6)} USDC significant-share target`);
        const text = document.createElement('p');
        text.textContent = `${ethers.formatUnits(balance, 6)} USDC balance · ${ethers.formatUnits(fund.reservedUnits, 6)} pending commitments · ${ethers.formatUnits(fund.availableUnits, 6)} unreserved · target ${ethers.formatUnits(goal, 6)} USDC`;
        const warning = document.createElement('p'); warning.className = 'payroll-funding-warning'; warning.textContent = fund.warning || '';
        block.append(title, meter, text, warning); target?.append(block);
      }
      _applyScheduledBudgets();
      _loadRadioReviews();
      _previewRadioPayroll();
    } catch (error) {
      _weeklyPayflow = null;
      _setStatus(status, `${error.message}. New York payouts require a saved server-prepared receipt.`, true);
    }
  })().finally(() => { _weeklyPayflowTask = null; });
  return _weeklyPayflowTask;
}

function _populateSettlementFunds() {
  const select = document.getElementById('router-fund-select');
  if (!select) return;
  const previous = select.value;
  const funds = configuredSettlementFunds(_payrollAssetConfig || {});
  const options = funds.map(fund => {
    const option = document.createElement('option');
    option.value = fund.slug;
    option.textContent = `${fund.label} · ${fund.slug}`;
    return option;
  });
  for (const slug of _customFundSlugs) {
    const option = document.createElement('option'); option.value = slug; option.textContent = `Custom · ${slug}`; options.push(option);
  }
  const createCustom = document.createElement('option'); createCustom.value = CUSTOM_FUND_OPTION;
  createCustom.textContent = 'Create a custom fund…'; options.push(createCustom);
  select.replaceChildren(...options);
  select.value = [...funds.map(fund => fund.slug), ..._customFundSlugs].includes(previous) || previous === CUSTOM_FUND_OPTION
    ? previous : funds[0]?.slug || CUSTOM_FUND_OPTION;
  const customLabel = document.getElementById('router-custom-fund-label');
  if (customLabel) customLabel.hidden = select.value !== CUSTOM_FUND_OPTION;
  _setDefaultFundMetadata();
}

function _setDefaultFundMetadata() {
  const select = document.getElementById('router-fund-select');
  const input = document.getElementById('router-fund-metadata');
  if (!select || !input) return;
  const selection = select.value;
  const form = document.getElementById('router-custom-fund-form');
  if (form) form.hidden = selection !== CUSTOM_FUND_OPTION;
  const slug = selection === CUSTOM_FUND_OPTION ? document.getElementById('router-custom-fund-slug')?.value.trim().toLowerCase() : selection;
  if (selection === CUSTOM_FUND_OPTION) {
    if (slug) {
      try {
        const defaults = defaultSettlementFundMetadata(slug);
        const name = document.getElementById('router-fund-name');
        const purpose = document.getElementById('router-fund-purpose');
        if (name && (!name.value || name.value === name.dataset.autoValue)) name.value = defaults.name;
        if (purpose && (!purpose.value || purpose.value === purpose.dataset.autoValue)) purpose.value = defaults.description;
        if (name) name.dataset.autoValue = defaults.name;
        if (purpose) purpose.dataset.autoValue = defaults.description;
      } catch {}
    }
    const priorDefault = input.dataset.autoValue;
    if (!input.value || input.value === priorDefault) input.value = '';
    input.dataset.autoValue = '';
    return;
  }
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return;
  const uri = new URL(PAYROLL_ASSETS_URL.startsWith('https:') ? PAYROLL_ASSETS_URL
    : 'https://thejollylama.github.io/DecentBusking/payroll-assets.json');
  uri.hash = slug;
  const priorDefault = input.dataset.autoValue;
  if (!input.value || input.value === priorDefault) input.value = uri.toString();
  input.dataset.autoValue = uri.toString();
}

async function _refreshSettlementFund() {
  const select = document.getElementById('router-fund-select');
  const status = document.getElementById('router-fund-status');
  const createButton = document.getElementById('router-create-fund');
  if (!select || !createButton) return;
  const refreshId = ++_routerRefreshId;
  _routerCreateAllowed = false;
  createButton.disabled = true;
  const depositButton = document.getElementById('router-deposit-usdc');
  if (depositButton) depositButton.disabled = true;
  const recoverButton = document.getElementById('router-recover-usdc');
  if (recoverButton) recoverButton.disabled = true;
  const saveButton = document.getElementById('router-save-metadata');
  if (saveButton) saveButton.disabled = true;
  if (select.value === CUSTOM_FUND_OPTION && !document.getElementById('router-custom-fund-slug')?.value.trim()) {
    _setStatus(status, 'Enter a purpose slug to preview this new fund. Project defaults above already have their own permanent slugs.');
    return;
  }
  _setStatus(status, 'Checking Base router and fund permissions...');
  try {
    if (!isAdminWallet() || !_isRouterConfigured()) throw new Error('Connect the configured admin wallet; Base router configuration is required');
    const slug = _selectedFundSlug();
    const router = _readOnlyRouter();
    const id = ethers.id(slug);
    const address = window._wallet.address;
    const [role, fund] = await Promise.all([router.DEFAULT_ADMIN_ROLE(), router.funds(id)]);
    const allowed = await router.hasRole(role, address);
    const usdc = _getAssetConfig('USDC');
    const exists = Boolean(fund.exists ?? fund[2]);
    const active = Boolean(fund.active ?? fund[1]);
    const balance = exists && usdc ? await router.fundBalances(id, usdc.address) : 0n;
    if (refreshId !== _routerRefreshId || !isAdminWallet(address) || window._wallet?.address?.toLowerCase() !== address.toLowerCase()) return;
    const link = document.getElementById('router-address-link');
    link.href = `https://basescan.org/address/${_payrollAssetConfig.routerAddress}`;
    link.textContent = _shortAddr(_payrollAssetConfig.routerAddress);
    document.getElementById('router-fund-id').textContent = id;
    document.getElementById('router-admin-role').textContent = allowed ? 'DEFAULT_ADMIN_ROLE verified' : 'DEFAULT_ADMIN_ROLE required';
    document.getElementById('router-fund-state').textContent = exists ? active ? 'Created · active' : 'Created · inactive' : 'Not created';
    document.getElementById('router-fund-balance').textContent = usdc ? `${ethers.formatUnits(balance, usdc.decimals)} USDC` : 'USDC not configured';
    _routerCreateAllowed = allowed && !exists && _metadataUriReady();
    if (saveButton) saveButton.disabled = !allowed || exists || _settling || select.value !== CUSTOM_FUND_OPTION;
    createButton.disabled = !_routerCreateAllowed || _settling;
    const pendingDeposit = localStorage.getItem(_depositKey());
    const pendingRecovery = localStorage.getItem(_recoveryKey());
    if (depositButton) depositButton.disabled = !exists || !active || _settling || Boolean(pendingDeposit || pendingRecovery);
    if (recoverButton) recoverButton.disabled = !allowed || !exists || balance <= 0n || _settling || Boolean(pendingDeposit || pendingRecovery);
    const recoveryOwner = document.getElementById('router-recovery-owner');
    if (recoveryOwner) recoveryOwner.textContent = _ownerAddress || '';
    const recoveryPending = document.getElementById('router-recovery-pending');
    if (recoveryPending) recoveryPending.textContent = pendingRecovery ? 'Unresolved recovery. Check its receipt before another withdrawal or deposit.' : '';
    const pendingText = document.getElementById('router-deposit-pending');
    if (pendingText) pendingText.textContent = pendingDeposit ? 'A prior deposit/approval is unresolved. Check its receipt before sending again.' : '';
    _setStatus(status, exists ? 'Fund exists. USDC deposits and reviewed closed-week settlements are separate transactions.'
      : !allowed ? 'The connected wallet cannot create funds on this router.'
      : !_metadataUriReady() ? 'Enter an HTTPS or IPFS metadata URI describing this fund purpose before creation.'
      : `Ready to create empty fund ${slug}. Confirm once on Base; this does not deposit funds.`);
  } catch (error) {
    if (refreshId === _routerRefreshId) _setStatus(status, error.message, true);
  }
}

async function _depositUsdc() {
  const status = document.getElementById('router-fund-status');
  const button = document.getElementById('router-deposit-usdc');
  if (_settling || !isAdminWallet()) return;
  let failed = false;
  try {
    const slug = _selectedFundSlug();
    const asset = _getAssetConfig('USDC');
    if (!asset || asset.decimals !== 6) throw new Error('Native Base USDC is not configured');
    const amountUnits = ethers.parseUnits(document.getElementById('router-deposit-amount').value || '0', 6);
    if (amountUnits <= 0n) throw new Error('Enter a positive USDC deposit amount');
    const operationKey = _depositKey();
    if (localStorage.getItem(operationKey)) throw new Error('A prior deposit is unresolved; verify it before retrying');
    if (!confirm(`Deposit ${ethers.formatUnits(amountUnits, 6)} USDC into ${slug} on Base? This moves funds from your wallet; it does not pay artists.`)) return;
    _settling = true; button.disabled = true;
    const operationDetails = { owner: _ownerAddress, router: _payrollAssetConfig.routerAddress,
      asset: asset.address, fundId: ethers.id(slug), amountUnits: amountUnits.toString() };
    const signer = await _getSigner(BASE_CHAIN_ID);
    const router = new ethers.Contract(_payrollAssetConfig.routerAddress, ROUTER_ABI, signer);
    const token = new ethers.Contract(asset.address, USDC_ABI, signer);
    const result = await depositSettlementUsdc({ router, token, signer, owner: _ownerAddress, fundId: ethers.id(slug), amountUnits,
      onStep: message => _setStatus(status, message), onBroadcast: record => {
        const operation = JSON.parse(localStorage.getItem(operationKey));
        localStorage.setItem(operationKey, JSON.stringify({ ...operation, ...record }));
      }, onStage: stage => {
        localStorage.setItem(operationKey, JSON.stringify({ ...operationDetails, stage, txHash: null }));
      } });
    localStorage.removeItem(operationKey);
    await _refreshSettlementFund(); await _refreshRadioPayroll();
    _setStatus(status, `USDC deposit confirmed: ${result.txHash}`);
  } catch (error) {
    failed = true;
    const key = _depositKey();
    const operation = JSON.parse(localStorage.getItem(key) || 'null');
    if (operation && !operation.txHash && (error.code === 4001 || error.code === 'ACTION_REJECTED')) localStorage.removeItem(key);
    _setStatus(status, `${error.message}. Check any unresolved receipt before depositing again.`, true);
  }
  finally {
    _settling = false;
    const message = status.textContent;
    await _refreshSettlementFund();
    _setStatus(status, message, failed);
  }
}

async function _checkPendingDeposit() {
  const status = document.getElementById('router-fund-status');
  if (!isAdminWallet() || _settling) return;
  try {
    const key = _depositKey();
    const operation = JSON.parse(localStorage.getItem(key) || 'null');
    if (!operation) throw new Error('No unresolved deposit is recorded for this fund');
    const txHash = document.getElementById('router-deposit-recovery-hash').value.trim() || operation.txHash;
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) throw new Error('Enter the transaction hash from your wallet history; do not repeat an uncertain transfer');
    const provider = new ethers.JsonRpcProvider(_payrollAssetConfig.rpcUrl, BASE_CHAIN_ID);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error('Transaction is still unresolved; deposit remains locked');
    if (receipt.status !== 1) {
      if (!operation.txHash || txHash.toLowerCase() !== operation.txHash.toLowerCase()) throw new Error('Unmatched failed receipt; the operation remains locked');
      localStorage.removeItem(key);
      await _refreshSettlementFund();
      _setStatus(status, 'Recorded transaction reverted; no USDC was deposited by that transaction. Review before retrying.');
      return;
    }
    const iface = new ethers.Interface([...ROUTER_ABI, ...USDC_ABI]);
    let deposit = false;
    let approval = false;
    for (const log of receipt.logs) {
      let event; try { event = iface.parseLog(log); } catch { continue; }
      if (log.address.toLowerCase() === operation.router.toLowerCase() && event?.name === 'FundFunded' &&
          event.args.fundId === operation.fundId && event.args.asset.toLowerCase() === operation.asset.toLowerCase() &&
          event.args.funder.toLowerCase() === operation.owner.toLowerCase() && event.args.amount === BigInt(operation.amountUnits)) deposit = true;
      if (log.address.toLowerCase() === operation.asset.toLowerCase() && event?.name === 'Approval' &&
          event.args.owner.toLowerCase() === operation.owner.toLowerCase() && event.args.spender.toLowerCase() === operation.router.toLowerCase() &&
          event.args.value === BigInt(operation.amountUnits)) approval = true;
    }
    if (!deposit && !(approval && operation.stage !== 'deposit')) throw new Error('Receipt does not match this recorded operation; deposit remains locked');
    localStorage.removeItem(key);
    await _refreshSettlementFund(); await _refreshRadioPayroll();
    _setStatus(status, deposit ? 'Matching USDC deposit confirmed. Do not send it again.' : 'Approval confirmed, but no deposit occurred. Continue Deposit; existing allowance will be reused.');
  } catch (error) { _setStatus(status, error.message, true); }
}

function _queuePaymentProof(txHash) {
  try {
    const hashes = JSON.parse(localStorage.getItem('decentbusking:pending-payment-proofs:v1') || '[]');
    localStorage.setItem('decentbusking:pending-payment-proofs:v1', JSON.stringify([...new Set([...hashes, txHash])]));
  } catch (error) { console.warn('Payment confirmed, but local proof queue could not be saved:', error.message); }
  document.dispatchEvent(new CustomEvent('payroll-updated', { detail: { txHash, chainId: BASE_CHAIN_ID } }));
  _syncPaymentLedger();
}

async function _syncPaymentLedger() {
  if (_paymentSyncTask || !isAdminWallet()) return _paymentSyncTask;
  const status = document.getElementById('payroll-ledger-status');
  const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  if (!service) return;
  _paymentSyncTask = (async () => {
    try {
      const hashes = JSON.parse(localStorage.getItem('decentbusking:pending-payment-proofs:v1') || '[]');
      for (const txHash of hashes) {
        const response = await fetch(`${service}/api/payroll/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ txHash }), signal: AbortSignal.timeout(15000) });
        if (!response.ok) continue;
        const result = await response.json();
        if (result.pending || result.backupPending) continue;
        const current = JSON.parse(localStorage.getItem('decentbusking:pending-payment-proofs:v1') || '[]');
        localStorage.setItem('decentbusking:pending-payment-proofs:v1', JSON.stringify(current.filter(hash => hash !== txHash)));
      }
      const response = await fetch(`${service}/api/payroll/ledger`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Payment ledger unavailable (${response.status}); confirmed payments remain protected on-chain`);
      const ledger = await response.json();
      if (!isAdminWallet()) return;
      if (ledger.chainId !== BASE_CHAIN_ID || ledger.routerAddress?.toLowerCase() !== _payrollAssetConfig?.routerAddress.toLowerCase()) throw new Error('Payment ledger does not match this Base router');
      const target = document.getElementById('payroll-ledger-entries');
      target?.replaceChildren();
      for (const entry of (ledger.entries || []).slice().sort((first, second) => second.blockNumber - first.blockNumber)) {
        const row = document.createElement('div'); row.className = 'radio-payroll-artist';
        const asset = Object.entries(_payrollAssetConfig.assets || {}).find(([, value]) => value.address.toLowerCase() === entry.asset.toLowerCase());
        const fund = [...configuredSettlementFunds(_payrollAssetConfig), ...[..._customFundSlugs].map(slug => ({ slug, label: slug }))].find(value => ethers.id(value.slug) === entry.fundId);
        const label = document.createElement('span');
        label.textContent = `${entry.paidAt} · ${fund?.label || _shortAddr(entry.fundId)} · ${_shortAddr(entry.recipient)} · ${asset ? `${ethers.formatUnits(entry.amountUnits, asset[1].decimals)} ${asset[0]}` : `${entry.amountUnits} base units`} · ${entry.verification}`;
        const link = document.createElement('a'); link.className = 'payroll-link'; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.href = `https://basescan.org/tx/${entry.txHash}`; link.textContent = 'Base proof';
        row.append(label, link); target?.append(row);
      }
      const backup = document.getElementById('payroll-ledger-backup');
      if (backup) { backup.hidden = !ledger.snapshotUri; backup.href = (ledger.snapshotUri || '').replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/'); }
      _setStatus(status, !ledger.ready ? 'Payment ledger restoring; awaiting chain comparison.'
        : `${ledger.entries.length} recorded payments · compared ${ledger.lastCheckedAt || 'not yet'} · blocks ${ledger.scannedFrom}-${ledger.scannedThrough}` +
          (ledger.backupPending || !ledger.snapshotUri ? ' · IPFS backup pending' : ' · IPFS backup saved') +
          (ledger.repositorySync ? ` · Repo ledger: ${ledger.repositorySync}` : '') + (ledger.lastError ? ` · ${ledger.lastError}` : ''), Boolean(ledger.lastError));
      document.dispatchEvent(new CustomEvent('payroll-ledger-synced', { detail: ledger }));
    } catch (error) { if (isAdminWallet()) _setStatus(status, error.message, true); }
  })().finally(() => { _paymentSyncTask = null; });
  return _paymentSyncTask;
}

async function _checkRadioRecipients() {
  const check = ++_recipientCheckId;
  _radioRecipientStates.clear();
  _renderRadioReviews();
  try {
    const router = _readOnlyRouter();
    const states = await Promise.all(Object.values(_radioReviews).flatMap(saved => saved.allocation.entries).map(async entry => {
      const [paid, recipient] = await Promise.all([router.completedWorkReferences(ethers.id(entry.workReferenceText)), router.contributors(entry.wallet)]);
      return [entry.workReferenceText, { paid, approved: Boolean(recipient.approved ?? recipient[1]) }];
    }));
    if (check !== _recipientCheckId || !isAdminWallet()) return;
    _radioRecipientStates = new Map(states);
    _renderRadioReviews();
  } catch (error) { _setStatus(document.getElementById('radio-payroll-status'), `Recipient checks failed: ${error.message}`, true); }
}

function _loadRadioReviews() {
  const week = document.getElementById('radio-payroll-week')?.value;
  if (!week || !isAdminWallet() || !_ownerAddress) return;
  const records = _reviewRecords();
  _radioReviews = {};
  for (const category of ['playback', 'top10']) {
    const saved = records[_reviewKey(category, week)];
    if (saved) _radioReviews[category] = saved;
  }
  _checkRadioRecipients();
}

function _renderRadioReviews() {
  const target = document.getElementById('radio-reviewed-receipts');
  if (!target) return;
  target.replaceChildren();
  const report = _radioReports.find(entry => entry.week === document.getElementById('radio-payroll-week').value);
  const finalize = document.getElementById('radio-payroll-finalize');
  const positiveBudget = ['radio-playback-budget', 'radio-prize-budget'].some(id => Number(document.getElementById(id)?.value) > 0);
  if (finalize) finalize.disabled = !report || report.current || !positiveBudget || _settling;
  if (finalize && report?.week.startsWith('NY-')) { finalize.disabled = true; finalize.textContent = 'Weekly allocations prepared automatically'; }
  else if (finalize) finalize.textContent = 'Save Allocation & Review Recipients';
  for (const category of ['playback', 'top10']) {
    const button = document.getElementById(`radio-settle-${category}`);
    const saved = _radioReviews[category];
    const unpaid = saved?.allocation.entries.filter(entry => !_radioRecipientStates.get(entry.workReferenceText)?.paid) || [];
    const ready = saved && unpaid.length > 0 && unpaid.every(entry => _radioRecipientStates.get(entry.workReferenceText)?.approved);
    if (button) { button.disabled = !ready || _settling; button.textContent = `${category === 'playback' ? 'Playback' : 'Top 10'}: Pay ${unpaid.length} / Resume Batch`; }
    if (button && report?.week.startsWith('NY-')) { button.hidden = !saved; if (!_weeklyPayflow?.ready || _weeklyPayflow.lastError) button.disabled = true; }
    else if (button) button.hidden = false;
    if (!saved) {
      const empty = document.createElement('p'); empty.className = 'payroll-status';
      empty.textContent = `${category === 'playback' ? 'Playback' : 'Top 10'}: no saved allocation for ${report?.week || 'the selected week'}.`;
      target.append(empty);
      continue;
    }
    const heading = document.createElement('h4'); heading.textContent = `${category === 'playback' ? 'Playback' : 'Top 10'} · ${saved.allocation.week} · frozen receipt`;
    const link = document.createElement('a'); link.className = 'payroll-link'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.href = saved.metadataUri.replace('ipfs://', window.DecentConfig?.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/');
    link.textContent = 'Open reviewed allocation';
    const exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.className = 'payroll-btn payroll-btn-secondary'; exportButton.textContent = 'Export Receipt Backup';
    exportButton.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${saved.allocation.week}-${category}-receipt.json`; anchor.click(); URL.revokeObjectURL(url);
    });
    target.append(heading, link, exportButton);
    const summary = document.createElement('p'); summary.className = 'payroll-status';
    summary.textContent = `${saved.allocation.entries.length - unpaid.length} paid · ${unpaid.length} unpaid · ${saved.allocation.ranking || 'legacy play-ranked receipt'}`;
    target.append(summary);
    for (const entry of saved.allocation.entries) {
      const row = document.createElement('div'); row.className = 'radio-payroll-artist';
      const label = document.createElement('span'); label.textContent = `${entry.artist} · ${_shortAddr(entry.wallet)} · ${ethers.formatUnits(entry.amountUnits, 6)} USDC`;
      const state = _radioRecipientStates.get(entry.workReferenceText);
      label.textContent += state?.paid ? ' · Paid on Base' : state?.approved ? ' · Approved / unpaid' : state ? ' · Approval required' : ' · Checking Base';
      row.append(label);
      if (!state || state.paid || state.approved) { target.append(row); continue; }
      const identity = document.createElement('input'); identity.type = 'text'; identity.placeholder = 'Verified contributor identity';
      identity.setAttribute('aria-label', `Contributor identity for ${entry.wallet}`);
      const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'payroll-btn payroll-btn-secondary'; approve.textContent = 'Approve Recipient';
      approve.addEventListener('click', () => _approveRadioRecipient(entry.wallet, identity.value));
      row.append(identity, approve); target.append(row);
    }
  }
}

async function _finalizeRadioPayroll() {
  const status = document.getElementById('radio-payroll-status');
  if (_settling || !isAdminWallet()) return;
  try {
    const report = _radioReports.find(entry => entry.week === document.getElementById('radio-payroll-week').value);
    const asset = _getAssetConfig('USDC');
    if (!report || report.current || report.week === 'all-time') throw new Error('Select a completed week');
    if (report.week.startsWith('NY-')) throw new Error('New York allocations are prepared automatically; use the published weekly receipt');
    if (!asset || asset.decimals !== 6) throw new Error('Native Base USDC is required');
    const minimumUnits = ethers.parseUnits(document.getElementById('radio-minimum-payout').value || '0', 6);
    const records = _reviewRecords();
    const plans = [];
    for (const [category, input, slug] of [['playback', 'radio-playback-budget', _payrollAssetConfig.radioFunds?.playback], ['top10', 'radio-prize-budget', _payrollAssetConfig.radioFunds?.topTen]]) {
      const budgetUnits = ethers.parseUnits(document.getElementById(input).value || '0', 6);
      if (budgetUnits === 0n) continue;
      if (records[_reviewKey(category, report.week)]) continue;
      plans.push(finalizeRadioAllocation({ report, category, budgetUnits, minimumUnits, fundSlug: slug,
        routerAddress: _payrollAssetConfig.routerAddress, assetAddress: asset.address }));
    }
    if (!plans.length) throw new Error('Set a positive budget, or use the saved reviewed receipt');
    if (!confirm(`Freeze ${plans.length} allocation receipt(s) for ${report.week}? Recipient amounts will be saved; no payouts are sent yet.`)) return;
    _settling = true;
    const signer = await _getSigner(BASE_CHAIN_ID);
    const address = await signer.getAddress();
    if (address.toLowerCase() !== _ownerAddress.toLowerCase()) throw new Error('Connect the owner wallet');
    const upload = createBrowserIpfsUploader({ provider: window.DecentConfig?.ipfsUploadProvider || 'pinata',
      serviceUrl: window.DecentConfig?.ipfsUploadServiceUrl, signer, address, origin: window.location.origin });
    for (const allocation of plans) {
      const json = JSON.stringify(allocation);
      _setStatus(status, `Uploading frozen ${allocation.category} receipt — sign the IPFS upload authorization`);
      const metadataUri = await upload(new File([json], `${allocation.week}-${allocation.category}.json`, { type: 'application/json' }));
      records[_reviewKey(allocation.category, allocation.week)] = { allocation, metadataUri, metadataHash: ethers.id(json) };
      localStorage.setItem('decentbusking:radio-payroll-reviews:v1', JSON.stringify(records));
    }
    _loadRadioReviews();
    _setStatus(status, 'Reviewed receipts saved. Approve any missing recipients, then settle each funded category.');
  } catch (error) { _setStatus(status, error.message, true); }
  finally { _settling = false; _checkRadioRecipients(); }
}

async function _approveRadioRecipient(wallet, rawIdentity) {
  const status = document.getElementById('radio-payroll-status');
  if (_settling || !isAdminWallet()) return;
  try {
    const identity = rawIdentity.trim();
    _settling = true;
    const signer = await _getSigner(BASE_CHAIN_ID);
    const owner = await signer.getAddress();
    if (owner.toLowerCase() !== _ownerAddress.toLowerCase()) throw new Error('Connect the owner wallet');
    const router = new ethers.Contract(_payrollAssetConfig.routerAddress, ROUTER_ABI, signer);
    const current = await router.contributors(wallet);
    if (current.approved ?? current[1]) { _setStatus(status, 'Recipient already approved; no transaction needed.'); return; }
    if (!identity || identity.length > 100) throw new Error('Enter the verified contributor identity first');
    const hash = String(current.githubIdHash ?? current[0]);
    const desired = ethers.id(identity);
    if (hash !== ethers.ZeroHash && hash.toLowerCase() !== desired.toLowerCase()) throw new Error('This wallet is already registered to a different identity; do not overwrite it');
    if (!await router.hasRole(await router.CONTRIBUTOR_ADMIN_ROLE(), owner)) throw new Error('CONTRIBUTOR_ADMIN_ROLE is required');
    _setStatus(status, 'Confirm the recipient approval transaction in your wallet');
    if ((await (await router.setContributorApproved(wallet, desired, true)).wait())?.status !== 1) throw new Error('Recipient approval did not confirm');
    _setStatus(status, 'Recipient approved on the shared router.');
  } catch (error) { _setStatus(status, error.message, true); }
  finally { _settling = false; _checkRadioRecipients(); }
}

async function _settleRadioPayroll(category) {
  const status = document.getElementById('radio-payroll-status');
  if (_settling || !isAdminWallet()) return;
  try {
    const saved = _radioReviews[category];
    if (!saved || ethers.id(JSON.stringify(saved.allocation)) !== saved.metadataHash) throw new Error('The frozen receipt is missing or changed; do not pay');
    validateRadioReceipt(saved.allocation, { routerAddress: _payrollAssetConfig.routerAddress,
      assetAddress: _getAssetConfig('USDC').address, funds: _payrollAssetConfig.radioFunds });
    if (!confirm(`Settle reviewed ${category} for ${saved.allocation.week}? Each unpaid recipient requires a Base transaction. Already-paid references are skipped.`)) return;
    _settling = true;
    const signer = await _getSigner(BASE_CHAIN_ID);
    const router = new ethers.Contract(_payrollAssetConfig.routerAddress, ROUTER_ABI, signer);
    const result = await settleRadioAllocation({ ...saved, router, signer, owner: _ownerAddress, hashReference: ethers.id,
      onStep: message => _setStatus(status, message), onConfirmed: entry => { _queuePaymentProof(entry.txHash); _checkRadioRecipients(); } });
    await _refreshRadioPayroll();
    _setStatus(status, `${result.confirmed.length} payouts confirmed; ${result.skipped} already-paid references skipped. Frozen IPFS receipt retained.`);
  } catch (error) { _setStatus(status, `${error.message}. Retry only the same reviewed receipt; on-chain paid references are protected.`, true); }
  finally { _settling = false; await _checkRadioRecipients(); _syncPaymentLedger(); }
}

async function _importRadioReceipt(file) {
  const status = document.getElementById('radio-payroll-status');
  if (!file || !isAdminWallet() || _settling) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Receipt backup is too large');
    const saved = JSON.parse(await file.text());
    const allocation = validateRadioReceipt(saved.allocation, { routerAddress: _payrollAssetConfig.routerAddress,
      assetAddress: _getAssetConfig('USDC').address, funds: _payrollAssetConfig.radioFunds });
    if (!/^ipfs:\/\/[^/\s]+$/.test(saved.metadataUri || '') || ethers.id(JSON.stringify(allocation)) !== saved.metadataHash) throw new Error('Backup hash or IPFS receipt is invalid');
    const records = _reviewRecords();
    const key = _reviewKey(allocation.category, allocation.week);
    if (records[key] && records[key].metadataHash !== saved.metadataHash) throw new Error('A different receipt for this category/week is already stored; review before replacing');
    records[key] = saved;
    localStorage.setItem('decentbusking:radio-payroll-reviews:v1', JSON.stringify(records));
    document.getElementById('radio-payroll-week').value = allocation.week;
    _loadRadioReviews();
    _setStatus(status, 'Receipt backup restored. Review it before settlement; on-chain references will skip paid recipients.');
  } catch (error) { _setStatus(status, error.message, true); }
}

async function _createSettlementFund() {
  const status = document.getElementById('router-fund-status');
  const button = document.getElementById('router-create-fund');
  if (_settling || !_routerCreateAllowed || !isAdminWallet()) return;
  try {
    const slug = _selectedFundSlug();
    const metadataUri = document.getElementById('router-fund-metadata').value.trim();
    _settling = true;
    button.disabled = true;
    _setStatus(status, `Creating ${slug} on Base — confirm the fund creation transaction in your wallet...`);
    const signer = await _getSigner(BASE_CHAIN_ID);
    const router = new ethers.Contract(_payrollAssetConfig.routerAddress, ROUTER_ABI, signer);
    const result = await createConfiguredSettlementFund({ router, signer, owner: _ownerAddress,
      fundId: ethers.id(slug), metadataUri });
    if (document.getElementById('router-fund-select').value === CUSTOM_FUND_OPTION) {
      _rememberCustomFund(slug);
      _populateSettlementFunds();
      document.getElementById('router-fund-select').value = slug;
      document.getElementById('router-custom-fund-label').hidden = true;
      _setDefaultFundMetadata();
    }
    await _refreshRadioPayroll();
    await _refreshSettlementFund();
    _setStatus(status, result.alreadyExists ? `${slug} already exists; no creation transaction sent.`
      : `${slug} created. Empty fund; no USDC deposited.${result.txHash ? ` Transaction: ${result.txHash}` : ''}`);
  } catch (error) {
    _setStatus(status, error.message || 'Fund creation failed', true);
  } finally {
    _settling = false;
    button.disabled = !_routerCreateAllowed;
  }
}

function _previewRadioPayroll() {
  if (!isAdminWallet()) return;
  const status = document.getElementById('radio-payroll-status');
  try {
    const report = _radioReports.find(report => report.week === document.getElementById('radio-payroll-week').value);
    if (!report) throw new Error('Refresh playback history before previewing');
    const asset = _getAssetConfig('USDC');
    if (!asset || asset.decimals !== 6) throw new Error('USDC precision is not configured correctly');
    const units = id => ethers.parseUnits(document.getElementById(id).value || '0', asset.decimals);
    const minimumUnits = units('radio-minimum-payout');
    const playbackBudget = units('radio-playback-budget');
    const prizeBudget = units('radio-prize-budget');
    const playback = previewPlaybackPayroll({ tracks: report.tracks, budgetUnits: playbackBudget, minimumUnits });
    const prizes = previewTopTenPayroll({ tracks: report.tracks, budgetUnits: prizeBudget, minimumUnits });
    const render = (id, plan) => {
      const target = document.getElementById(id);
      target.replaceChildren();
      const total = document.createElement('p');
      total.textContent = `${ethers.formatUnits(plan.allocatedUnits, 6)} USDC allocated · ${ethers.formatUnits(plan.remainderUnits, 6)} USDC held/unallocated`;
      target.append(total);
      for (const entry of plan.entries) {
        const row = document.createElement('div');
        row.className = 'radio-payroll-artist';
        const name = document.createElement('span');
        name.textContent = `${entry.rank ? `${entry.rank}. ` : ''}${entry.artist || _shortAddr(entry.wallet)} · ${entry.votes !== undefined ? `${entry.votes} weekly net votes` : `${entry.plays} plays`} · ${_shortAddr(entry.wallet)}`;
        const amount = document.createElement('strong');
        amount.textContent = `${ethers.formatUnits(entry.amountUnits, 6)} USDC${entry.payable ? '' : entry.amountUnits === 0n ? ' · no payout' : ' · held below minimum'}`;
        row.append(name, amount);
        target.append(row);
      }
    };
    render('radio-playback-preview', playback);
    render('radio-prize-preview', prizes);
    const funded = _radioBalances?.approved &&
      (playbackBudget === 0n || (_radioBalances.playback.active && _radioBalances.playback.available >= playbackBudget)) &&
      (prizeBudget === 0n || (_radioBalances.prizes.active && _radioBalances.prizes.available >= prizeBudget));
    const excluded = report.tracks.filter(track => !isValidEthAddress(track.wallet)).length;
    _setStatus(status, `Draft ${report.week}${report.current ? ' (week still in progress)' : ''}. ` +
      `${funded ? 'Budgets within available funds' : 'Budgets are not confirmed funded'}. ` +
      `${excluded ? `${excluded} tracks excluded for missing verified wallets. ` : ''}Preview only; settlement uses the frozen reviewed receipt.`);
    _renderRadioReviews();
  } catch (error) {
    _setStatus(status, error.message, true);
  }
}

// ─── Initialise the payroll panel ─────────────────────────────────────────────

export function initPayroll() {
  document.getElementById('router-recover-usdc')?.addEventListener('click', _recoverUsdc);
  document.getElementById('router-recovery-check')?.addEventListener('click', _checkRecoveryReceipt);
  document.getElementById('radio-receipt-import')?.addEventListener('change', event => _importRadioReceipt(event.target.files?.[0]));
  document.getElementById('router-deposit-usdc')?.addEventListener('click', _depositUsdc);
  document.getElementById('router-deposit-check')?.addEventListener('click', _checkPendingDeposit);
  document.getElementById('radio-payroll-finalize')?.addEventListener('click', _finalizeRadioPayroll);
  document.getElementById('radio-settle-playback')?.addEventListener('click', () => _settleRadioPayroll('playback'));
  document.getElementById('radio-settle-top10')?.addEventListener('click', () => _settleRadioPayroll('top10'));
  document.getElementById('router-create-fund')?.addEventListener('click', _createSettlementFund);
  document.getElementById('router-fund-refresh')?.addEventListener('click', _refreshSettlementFund);
  document.getElementById('router-fund-select')?.addEventListener('change', () => {
    _invalidateFundMetadata();
    const customLabel = document.getElementById('router-custom-fund-label');
    if (customLabel) customLabel.hidden = document.getElementById('router-fund-select').value !== CUSTOM_FUND_OPTION;
    _setDefaultFundMetadata();
    _refreshSettlementFund();
  });
  document.getElementById('router-custom-fund-slug')?.addEventListener('input', () => {
    _invalidateFundMetadata();
    const input = document.getElementById('router-custom-fund-slug');
    try {
      input.setCustomValidity('');
      _selectedFundSlug();
    } catch (error) {
      input.setCustomValidity(error.message);
    }
    _setDefaultFundMetadata();
    _refreshSettlementFund();
  });
  document.getElementById('router-fund-metadata')?.addEventListener('input', () => {
    ++_fundMetadataRevision;
    _refreshSettlementFund();
  });
  document.getElementById('router-custom-fund-form')?.addEventListener('submit', event => {
    event.preventDefault();
    _saveFundMetadata();
  });
  for (const id of ['router-fund-name', 'router-fund-purpose', 'router-fund-website']) {
    document.getElementById(id)?.addEventListener('input', () => {
      _invalidateFundMetadata();
      _refreshSettlementFund();
    });
  }
  document.getElementById('radio-payroll-refresh')?.addEventListener('click', _refreshRadioPayroll);
  document.getElementById('radio-payroll-preview')?.addEventListener('click', _previewRadioPayroll);
  document.getElementById('radio-payroll-week')?.addEventListener('change', () => {
    document.getElementById('radio-playback-preview')?.replaceChildren();
    document.getElementById('radio-prize-preview')?.replaceChildren();
    _loadRadioReviews();
    _applyScheduledBudgets();
    _previewRadioPayroll();
  });
  for (const id of ['radio-playback-budget', 'radio-prize-budget', 'radio-minimum-payout']) {
    document.getElementById(id)?.addEventListener('input', _previewRadioPayroll);
  }
  document.getElementById('payroll-ledger-refresh')?.addEventListener('click', () => { _syncPaymentLedger(); _checkRadioRecipients(); });
  setInterval(() => {
    if (!isAdminWallet() || _settling) return;
    const payrollOpen = !document.getElementById('payroll-modal')?.classList.contains('hidden');
    const adminOpen = !document.getElementById('admin-modal')?.classList.contains('hidden');
    if (!payrollOpen && !adminOpen) return;
    if (document.getElementById('radio-reviewed-receipts')?.contains(document.activeElement)) return;
    _syncPaymentLedger();
    _refreshWeeklyPayflow();
    if (payrollOpen && Date.now() - _weeklyHistoryRefreshedAt > 60000) _refreshRadioPayroll();
    if (payrollOpen) _checkRadioRecipients();
  }, 5000);
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
