/**
 * js/payroll.js — DecentBusking Payroll Panel
 *
 * Provides the owner with a browser-side payroll UI to:
 *   1. Load the pending payroll queue from payroll-queue.json.
 *   2. Connect MetaMask and verify the connected wallet is the repo owner.
 *   3. Send ETH directly to each contributor's Optimism wallet (no treasury
 *      contract needed — direct ETH transfers from owner's wallet).
 *   4. Mark settled entries after payment.
 *
 * Usage:
 *   - Owner clicks the 💸 Payroll button in the app.
 *   - Connects MetaMask (must be on Optimism Mainnet, chain ID 10).
 *   - Sees pending payouts with amounts, contributors, and wallet addresses.
 *   - Clicks "Settle All" or individual "Pay" buttons to send ETH.
 *   - After settling, runs the `settle-payroll.yml` workflow to update the repo.
 *
 * Security note:
 *   A warning is shown if the connected wallet does NOT match the repo owner's
 *   address in contributor-accounts.json.  Only the repo owner should settle
 *   payroll.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const PAYROLL_QUEUE_URL =
  'https://raw.githubusercontent.com/TheJollyLaMa/DecentBusking/main/payroll-queue.json';

const ACCOUNTS_URL =
  'https://raw.githubusercontent.com/TheJollyLaMa/DecentBusking/main/contributor-accounts.json';

/** Optimism Mainnet chain ID */
const OPTIMISM_CHAIN_ID = 10;

// ─── Module state ─────────────────────────────────────────────────────────────

let _connectedAddress = null;
let _pendingEntries   = [];
let _ownerAddress     = null;

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

// ─── Connect MetaMask ─────────────────────────────────────────────────────────

async function connectPayrollWallet() {
  const statusEl  = document.getElementById('payroll-wallet-status');
  const addrEl    = document.getElementById('payroll-connected-addr');
  const warningEl = document.getElementById('payroll-owner-warning');
  const connectBtn = document.getElementById('payroll-connect-btn');
  const queueSection = document.getElementById('payroll-queue-section');

  if (!window.ethereum) {
    _setStatus(statusEl, '⚠️ MetaMask not detected. Please install MetaMask.', true);
    return;
  }

  try {
    _setStatus(statusEl, '⏳ Connecting MetaMask…');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    _connectedAddress = accounts[0];

    const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
    const chainId = parseInt(chainIdHex, 16);
    if (chainId !== OPTIMISM_CHAIN_ID) {
      _setStatus(statusEl, `⚠️ Wrong network (chain ${chainId}). Please switch MetaMask to Optimism Mainnet (chain 10).`, true);
      return;
    }

    if (addrEl) addrEl.textContent = _connectedAddress;
    if (connectBtn) connectBtn.textContent = '✅ Connected';

    // Check if connected wallet matches the owner's registered address
    if (!_ownerAddress) _ownerAddress = await _loadOwnerAddress();

    const isOwner = _ownerAddress &&
      _ownerAddress.toLowerCase() === _connectedAddress.toLowerCase();

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
      ? '✅ Connected as repo owner — ready to settle payroll.'
      : '✅ Connected (read-only view — settle disabled for non-owner wallets).');

    // Load and display the payroll queue
    if (queueSection) queueSection.style.display = 'block';
    await loadPayrollQueue();

  } catch (err) {
    _setStatus(statusEl, `❌ ${err.message}`, true);
  }
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
    const queue = await _fetchJSON(PAYROLL_QUEUE_URL);
    _pendingEntries = Array.isArray(queue.pending) ? queue.pending : [];
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

  const isOwner = _ownerAddress && _connectedAddress &&
    _ownerAddress.toLowerCase() === _connectedAddress.toLowerCase();

  tableBody.innerHTML = _pendingEntries.map((entry, i) => {
    const wallet = entry.contributor || '';
    const walletDisplay = wallet
      ? `<a href="https://optimistic.etherscan.io/address/${_esc(wallet)}" target="_blank" rel="noopener" class="payroll-addr-link" title="${_esc(wallet)}">${_esc(_shortAddr(wallet))}</a>`
      : '<span class="payroll-no-wallet">⚠️ No wallet</span>';
    const canPay = isOwner && wallet && wallet.startsWith('0x') && wallet.length === 42;
    return `
      <tr data-index="${i}" class="payroll-row">
        <td class="payroll-td">
          <a href="https://github.com/${_esc(entry.contributorGithub)}" target="_blank" rel="noopener" class="payroll-github-link">
            <img src="https://github.com/${_esc(entry.contributorGithub)}.png?size=20" class="payroll-avatar" onerror="this.style.display='none'" />
            @${_esc(entry.contributorGithub)}
          </a>
        </td>
        <td class="payroll-td">${walletDisplay}</td>
        <td class="payroll-td payroll-amount"><strong>${_esc(entry.amount)} ETH</strong></td>
        <td class="payroll-td payroll-issue">
          <a href="https://github.com/${_esc(entry.issueRef.replace('#', '/issues/'))}" target="_blank" rel="noopener" class="payroll-issue-link">
            ${_esc(entry.issueRef)}
          </a>
        </td>
        <td class="payroll-td">
          ${canPay
            ? `<button class="payroll-pay-btn" data-index="${i}">💸 Pay</button>`
            : `<span class="payroll-pay-disabled">${isOwner ? '⚠️ No wallet' : '🔒'}</span>`
          }
        </td>
      </tr>`;
  }).join('');

  // Attach individual Pay button listeners
  tableBody.querySelectorAll('.payroll-pay-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.index);
      await _paySingle(idx, btn);
    });
  });

  // Enable/disable Settle All button
  const payableCount = _pendingEntries.filter(e => isOwner && e.contributor && ETH_ADDR_RE(e.contributor)).length;
  if (settleBtn) {
    settleBtn.disabled = payableCount === 0;
    settleBtn.textContent = `💸 Settle All (${payableCount} payable)`;
  }
}

function ETH_ADDR_RE(addr) {
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// ─── Send a single ETH payment ────────────────────────────────────────────────

async function _paySingle(index, btn) {
  const entry    = _pendingEntries[index];
  const statusEl = document.getElementById('payroll-queue-status');

  if (!entry) return;
  if (!window.ethereum) {
    _setStatus(statusEl, '⚠️ MetaMask not available.', true);
    return;
  }

  const { to, amountWei } = _buildTxParams(entry);
  if (!to) {
    _setStatus(statusEl, `⚠️ No wallet address for @${entry.contributorGithub}.`, true);
    return;
  }

  try {
    if (btn) btn.disabled = true;
    _setStatus(statusEl, `⏳ Sending ${entry.amount} ETH to @${entry.contributorGithub}…`);

    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer   = await provider.getSigner();

    const tx = await signer.sendTransaction({ to, value: amountWei });
    _setStatus(statusEl, `⏳ Waiting for confirmation… tx: ${tx.hash.slice(0, 12)}…`);
    await tx.wait();

    _setStatus(statusEl,
      `✅ Sent ${entry.amount} ETH to @${entry.contributorGithub}! ` +
      `<a href="https://optimistic.etherscan.io/tx/${tx.hash}" target="_blank" rel="noopener">View on Etherscan ↗</a>`
    );

    // Mark row as paid
    const row = document.querySelector(`#payroll-table-body tr[data-index="${index}"]`);
    if (row) {
      row.classList.add('payroll-row-paid');
      if (btn) btn.textContent = '✅ Paid';
    }

    _showSettleWorkflowHint(tx.hash);

  } catch (err) {
    _setStatus(statusEl, `❌ Payment failed: ${err.message}`, true);
    if (btn) btn.disabled = false;
  }
}

// ─── Settle All ───────────────────────────────────────────────────────────────

async function _settleAll() {
  const statusEl = document.getElementById('payroll-queue-status');
  const settleBtn = document.getElementById('payroll-settle-all-btn');

  if (!window.ethereum) {
    _setStatus(statusEl, '⚠️ MetaMask not available.', true);
    return;
  }

  const payable = _pendingEntries.filter(e => ETH_ADDR_RE(e.contributor));
  if (payable.length === 0) {
    _setStatus(statusEl, '⚠️ No payable entries (all missing wallet addresses).', true);
    return;
  }

  if (!confirm(`Send ETH to ${payable.length} contributor(s) on Optimism Mainnet? This cannot be undone.`)) {
    return;
  }

  try {
    if (settleBtn) settleBtn.disabled = true;
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer   = await provider.getSigner();

    const hashes = [];
    for (const entry of payable) {
      const { to, amountWei } = _buildTxParams(entry);
      _setStatus(statusEl, `⏳ Sending ${entry.amount} ETH to @${entry.contributorGithub}…`);
      const tx = await signer.sendTransaction({ to, value: amountWei });
      await tx.wait();
      hashes.push(tx.hash);
      console.log(`✅ Sent ${entry.amount} ETH to ${entry.contributor} (${entry.contributorGithub}) — ${tx.hash}`);
    }

    _setStatus(statusEl, `✅ All ${payable.length} payment(s) sent! Tx hashes: ${hashes.map(h => h.slice(0,10)).join(', ')}…`);
    _showSettleWorkflowHint(hashes[hashes.length - 1]);

    // Reload to reflect updated state
    await loadPayrollQueue();

  } catch (err) {
    _setStatus(statusEl, `❌ Settlement failed: ${err.message}`, true);
    if (settleBtn) settleBtn.disabled = false;
  }
}

function _buildTxParams(entry) {
  const to = entry.contributor || '';
  if (!ETH_ADDR_RE(to)) return { to: null, amountWei: null };
  const amountWei = ethers.parseEther(String(entry.amount));
  return { to, amountWei };
}

// ─── Post-settlement hint ─────────────────────────────────────────────────────

function _showSettleWorkflowHint(txHash) {
  const hintEl = document.getElementById('payroll-settle-hint');
  if (!hintEl) return;
  const txParam = txHash ? `&tx_hash=${encodeURIComponent(txHash)}` : '';
  hintEl.innerHTML =
    `💡 Run the <a href="https://github.com/TheJollyLaMa/DecentBusking/actions/workflows/settle-payroll.yml" ` +
    `target="_blank" rel="noopener" class="payroll-link">Settle Payroll workflow</a> to mark entries as settled in the repo.` +
    (txHash ? `<br><small>Last tx: <code>${txHash}</code></small>` : '');
  hintEl.style.display = 'block';
}

// ─── Initialise the payroll panel ─────────────────────────────────────────────

export function initPayroll() {
  const connectBtn  = document.getElementById('payroll-connect-btn');
  const settleBtn   = document.getElementById('payroll-settle-all-btn');
  const refreshBtn  = document.getElementById('payroll-refresh-btn');
  const openBtn     = document.getElementById('payroll-open-btn');
  const closeBtn    = document.getElementById('payroll-close-btn');
  const modal       = document.getElementById('payroll-modal');
  const overlay     = document.getElementById('payroll-overlay');

  if (openBtn) {
    openBtn.addEventListener('click', () => {
      if (modal)   modal.classList.remove('hidden');
      if (overlay) overlay.classList.remove('hidden');
    });
  }

  function closePayroll() {
    if (modal)   modal.classList.add('hidden');
    if (overlay) overlay.classList.add('hidden');
  }

  if (closeBtn)  closeBtn.addEventListener('click', closePayroll);
  if (overlay)   overlay.addEventListener('click', closePayroll);
  if (connectBtn) connectBtn.addEventListener('click', connectPayrollWallet);
  if (settleBtn)  settleBtn.addEventListener('click', _settleAll);
  if (refreshBtn) refreshBtn.addEventListener('click', loadPayrollQueue);

  // Pre-load owner address in background
  _loadOwnerAddress().then(addr => { _ownerAddress = addr; });
}
