// js/components/about-override.js — DecentBusking

import { announcePaymentCelebration } from '../payment-celebration.mjs';
import { formatUsdcUnits } from '../usdc-format.mjs?v=20261017-mercury-release';
//
// Intercepts the CDN DecentHead 'about-modal' custom element definition and
// replaces it with a DecentBusking-specific version.
//
import { startTutorial, syncTutorialLaunchButtons } from '../tutorial.js?v=20261025-split-surfaces';
import { workerEnsProvider } from '../ens-client.mjs?v=20261016-ens-worker';
import { renderFundsSection, resolveWalletLabel, renderWalletButton } from '../fund-display.mjs?v=20261024-djuke-labels';

// The CDN AboutModal lists generic escrow listings. This override pins the
// purchase card to the reviewed DecentBusking v1.0.0 Base listing in config.
//
// Loading order: this module must be loaded BEFORE the CDN Header.js script
// so the interception fires before customElements.define('about-modal') runs.

(function interceptAboutModal() {
  if (customElements.get('about-modal')) return;

  const originalDefine = CustomElementRegistry.prototype.define.bind(customElements);

  CustomElementRegistry.prototype.define = function (name, constructor, options) {
    if (name === 'about-modal') {
      CustomElementRegistry.prototype.define = originalDefine;
      return originalDefine(name, DecentBuskingAboutModal, options);
    }
    return originalDefine(name, constructor, options);
  };
})();

// ── Utility ────────────────────────────────────────────────────────────────
function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Base Supporter purchase constants ──────────────────────────────────────
const _NFT_ADDRESS       = '0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B';
const _ESCROW_ADDRESS    = '0x31b07b83e99A9bdF379bf40225b8A80d3804C89d';
const _USDC_ADDRESS      = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const _BASE_CHAIN_ID     = 8453n;

const _ESCROW_ABI = [
  'function getListing(uint256 listingId) view returns (tuple(address nftContract, uint256 tokenId, uint256 priceETH, address priceToken, uint256 priceAmount, uint256 available, bool active, string note))',
  'function getNFTBalance(address nftContract, uint256 tokenId) view returns (uint256)',
  'function purchaseWithToken(uint256 listingId, uint256 amount)',
  'event Purchased(uint256 indexed listingId,address indexed buyer,uint256 amount,address indexed paymentToken,uint256 totalPaid)',
];

const _ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const _MSG_NFT_NOT_IN_ESCROW = '⚠ NFT stock not yet loaded into escrow — check back soon.';
const _DBUSKER_ABOUT_AVATAR = new URL('../../img/D_Busker.jpeg', import.meta.url).href;

class DecentBuskingAboutModal extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  async _prepareFund(fund, sponsorAliases, provider, aliasCache) {
    const sources = [];
    for (const source of fund.sources || []) {
      const address = source.funder || source.advertiser || source.payer || '';
      const wallet = address && provider ? await resolveWalletLabel(address, provider, sponsorAliases, aliasCache)
        : { address, label: address || '', aliases: [] };
      const walletHtml = renderWalletButton(wallet, { role: source.kind });
      const advertiser = source.kind === 'advert' && source.advertiser
        ? await resolveWalletLabel(source.advertiser, provider, sponsorAliases, aliasCache) : null;
      sources.push({
        ...source,
        displayLabel: wallet.label,
        walletHtml,
        advertiserHtml: advertiser ? renderWalletButton(advertiser, { role: 'advertiser' }) : '',
        advertiserLabel: advertiser?.label || '',
        payerHtml: source.kind === 'djuke' ? walletHtml : '',
        payerLabel: source.kind === 'djuke' ? wallet.label : '',
      });
    }
    const bookings = [];
    for (const booking of fund.bookings || []) {
      const walletDisplay = await resolveWalletLabel(booking.wallet, provider, sponsorAliases, aliasCache);
      bookings.push({ ...booking, walletDisplay });
    }
    return { ...fund, sources, bookings };
  }

  async _loadCommunityFunds() {
    const container = this.shadowRoot.getElementById('community-funds');
    if (!container) return;
    const service = (window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
    if (!service) {
      container.innerHTML = '<p class="community-funds-unavailable">Fund balances unavailable right now</p>';
      return;
    }
    try {
      const response = await fetch(`${service}/api/funds`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      const state = await response.json().catch(() => null);
      if (!response.ok || !state?.ready || state.lastError) throw new Error(state?.lastError || `Fund balances unavailable (${response.status})`);
      const provider = workerEnsProvider;
      const aliasCache = new Map();
      const funds = [];
      for (const slug of ['dbusk-playback', 'dbusk-top10', 'dbusk-repo-dev', 'dbusk-pinners', 'dbusk-live-performers']) {
        const fund = state.funds?.[slug];
        if (!fund) continue;
        funds.push(await this._prepareFund(fund, state.sponsorAliases || {}, provider, aliasCache));
      }
      container.innerHTML = renderFundsSection(funds, 'Community Funds');
    } catch (error) {
      container.innerHTML = '<p class="community-funds-unavailable">Fund balances unavailable right now</p>';
    }
  }

  open() {
    this.shadowRoot.querySelector('.modal-container').style.display = 'grid';
  }

  close() {
    this.shadowRoot.querySelector('.modal-container').style.display = 'none';
  }

  // ── Escrow listings — filtered to DecentBusking Supporter DNFTs ───────────
  async _loadDecentBuskingListings() {
    const container = this.shadowRoot.getElementById('buy-cards');
    const statusEl  = this.shadowRoot.getElementById('buy-status');

    container.innerHTML = '<p style="color:#aaa;font-size:0.85em;">⏳ Loading available editions…</p>';

    try {
      const ethers = window.ethers;
      const config = window.DecentConfig?.supporterDnft;
      if (!ethers || !config || config.chainId !== Number(_BASE_CHAIN_ID)
        || config.contract?.toLowerCase() !== _NFT_ADDRESS.toLowerCase()
        || config.escrowAddress?.toLowerCase() !== _ESCROW_ADDRESS.toLowerCase()
        || config.paymentToken?.toLowerCase() !== _USDC_ADDRESS.toLowerCase()
        || !/^(0|[1-9]\d*)$/.test(config.tokenId || '')
        || !/^(0|[1-9]\d*)$/.test(config.listingId || '')
        || !/^\d+$/.test(config.expectedPriceAmount || '')) {
        container.innerHTML = '<p style="color:#aaa;font-size:0.85em;">Base Supporter purchase details are not configured or verified.</p>';
        return;
      }

      const provider = new ethers.JsonRpcProvider(window.DecentConfig.rpcUrl || 'https://mainnet.base.org');
      try {
        if ((await provider.getNetwork()).chainId !== _BASE_CHAIN_ID) throw new Error('Public listing provider is not on Base.');
        const escrow = new ethers.Contract(_ESCROW_ADDRESS, _ESCROW_ABI, provider);
        const id = BigInt(config.listingId);
        const l = await escrow.getListing(id);
        const matches = l.nftContract.toLowerCase() === _NFT_ADDRESS.toLowerCase()
          && l.tokenId === BigInt(config.tokenId) && l.priceETH === 0n
          && l.priceToken.toLowerCase() === _USDC_ADDRESS.toLowerCase()
          && l.priceAmount === BigInt(config.expectedPriceAmount);
        if (!matches || !l.active || l.available < 1n) {
          container.innerHTML = '<p style="color:#aaa;font-size:0.85em;">The configured Base Supporter listing is unavailable or its terms changed.</p>';
          return;
        }
        const stock = await escrow.getNFTBalance(_NFT_ADDRESS, BigInt(config.tokenId));
        if (stock < l.available) throw new Error('Escrow NFT balance is below the advertised listing availability.');
        const priceLabel = `$${formatUsdcUnits(l.priceAmount)} USDC`;
        container.innerHTML = `
          <div class="buy-card">
            <div class="buy-card-label">DecentBusking v1.0.0 Supporter DNFT · Base listing #${id}</div>
            <div class="buy-card-supply">${l.available} available · ${priceLabel} each</div>
            <button class="buy-btn" data-listing-id="${id}" data-price-eth="0" data-price="${l.priceAmount}">
              🎟️ Buy Now — ${priceLabel}
            </button>
          </div>
        `;

        container.querySelectorAll('.buy-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            this._handleBuy(id, BigInt(btn.dataset.price), btn, statusEl);
          });
        });
      } finally {
        provider.destroy();
      }
    } catch (err) {
      console.warn('[about-override] _loadDecentBuskingListings failed:', err);
      container.innerHTML = '<p style="color:#aaa;font-size:0.85em;">Could not load listings — please refresh.</p>';
    }
  }

  async _handleBuy(listingId, price, btn, statusEl) {
    const setStatus = (msg, color = '#aaa') => {
      statusEl.style.color = color;
      statusEl.textContent = msg;
    };

    const ethers = window.ethers;
    if (!ethers) {
      setStatus('⚠ ethers.js not loaded.', '#ff8800');
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = '⏳ Connecting wallet…';

      const wallet = window.DecentHead?.getWallet?.();
      let address;
      if (wallet && !wallet.snapshot().connected) await wallet.connect();
      const raw = wallet ? wallet.rawProvider : window.ethereum;
      if (!raw) throw new Error('No wallet provider found. Connect a wallet and try again.');
      if (wallet) {
        address = wallet.snapshot().address;
      } else {
        const accounts = await raw.request({ method: 'eth_requestAccounts' });
        address = accounts?.[0];
      }
      if (!address) throw new Error('No wallet account is available.');
      const generation = wallet?.generation;
      if (BigInt(await raw.request({ method: 'eth_chainId' })) !== _BASE_CHAIN_ID) {
        setStatus('⏳ Switching to Base…');
        const chain = window.DecentConfig.supporterDnft.chain;
        if (wallet?.ensureChain) {
          await wallet.ensureChain(chain);
        } else {
          const chainId = `0x${BigInt(chain.chainId).toString(16)}`;
          try {
            await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
          } catch (switchError) {
            if (Number(switchError.code ?? switchError.data?.originalError?.code) !== 4902) throw switchError;
            await raw.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId,
                chainName: chain.chainName,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: chain.rpcUrls,
                blockExplorerUrls: chain.blockExplorerUrls,
              }],
            });
            await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
          }
        }
      }
      if (BigInt(await raw.request({ method: 'eth_chainId' })) !== _BASE_CHAIN_ID) throw new Error('Wallet did not switch to Base.');
      const assertWallet = async expectedAddress => {
        const current = wallet?.snapshot();
        const accounts = await raw.request({ method: 'eth_accounts' });
        if ((wallet && (wallet.rawProvider !== raw || wallet.generation !== generation
            || current.address?.toLowerCase() !== expectedAddress.toLowerCase()))
          || accounts?.[0]?.toLowerCase() !== expectedAddress.toLowerCase()
          || BigInt(await raw.request({ method: 'eth_chainId' })) !== _BASE_CHAIN_ID) {
          throw new Error('Wallet account or network changed. Review this purchase again.');
        }
      };
      await assertWallet(address);
      const provider = new ethers.BrowserProvider(raw, 'any');
      await this._doPurchase(provider, ethers, listingId, price, btn, setStatus, {
        assertWallet,
      });
    } catch (err) {
      const submissionUncertain = err?.purchaseSubmitted === true;
      btn.disabled = submissionUncertain;
      btn.textContent = submissionUncertain ? '⚠ Check transaction' : '🎟️ Buy Now';
      const data = err?.data ?? err?.info?.error?.data ?? '';
      if (submissionUncertain) {
        setStatus(`⚠ Purchase was submitted but its final result is uncertain. Check the transaction before trying again. ${err.message}`, '#ff8800');
      } else if (typeof data === 'string' && data.startsWith('0x03dee4c5')) {
        setStatus('⚠ NFT stock not in escrow — the seller needs to deposit NFTs before purchase.', '#ff8800');
      } else {
        setStatus(`⚠ ${err.reason || err.message || 'Unknown error'}`, '#ff4444');
      }
    }
  }

  async _doPurchase(provider, ethers, listingId, price, btn, setStatus, session) {
    const signer = await provider.getSigner();
    const buyer  = await signer.getAddress();
    const guard = () => session.assertWallet(buyer);
    await guard();

    setStatus('⏳ Checking listing…');
    const escrow  = new ethers.Contract(_ESCROW_ADDRESS, _ESCROW_ABI, signer);
    const listing = await escrow.getListing(listingId);

    const config = window.DecentConfig.supporterDnft;
    if (listing.nftContract.toLowerCase() !== config.contract.toLowerCase()
      || listing.tokenId !== BigInt(config.tokenId) || listing.priceETH !== 0n
      || listing.priceToken.toLowerCase() !== config.paymentToken.toLowerCase()
      || listing.priceAmount !== BigInt(config.expectedPriceAmount) || listing.priceAmount !== price) {
      throw new Error('The live listing differs from the reviewed Base Supporter terms.');
    }
    if (!listing.active) {
      btn.disabled = false;
      btn.textContent = '🎟️ Buy Now';
      setStatus('⚠ This listing is no longer active.', '#ff8800');
      return;
    }
    if (listing.available === BigInt(0)) {
      btn.disabled = false;
      btn.textContent = '🎟️ Buy Now';
      setStatus('⚠ Sold out — no tokens remaining.', '#ff8800');
      return;
    }

    setStatus('⏳ Verifying NFT stock…');
    const nftBalance = await escrow.getNFTBalance(listing.nftContract, listing.tokenId);
    if (nftBalance < listing.available) {
      btn.disabled = false;
      btn.textContent = '🎟️ Buy Now';
      setStatus(`⚠ ${_MSG_NFT_NOT_IN_ESCROW}`, '#ff8800');
      return;
    }

    const tokenAmount = listing.priceAmount;
    const priceETH    = listing.priceETH ?? 0n;
    const rawToken    = listing.priceToken;

    const purchaseToken = rawToken;
    if (priceETH !== 0n || purchaseToken.toLowerCase() !== _USDC_ADDRESS.toLowerCase()
      || tokenAmount !== price || tokenAmount !== BigInt(config.expectedPriceAmount)) {
      throw new Error('Only the configured exact-price Base USDC listing can be purchased here.');
    }

    setStatus('⏳ Checking token allowance…');
    const token = new ethers.Contract(_USDC_ADDRESS, _ERC20_ABI, signer);
    if (await token.balanceOf(buyer) < tokenAmount) throw new Error('Insufficient Base USDC for this edition.');
    const allowance = await token.allowance(buyer, _ESCROW_ADDRESS);

    if (allowance !== tokenAmount) {
      await guard();
      setStatus('⏳ Approving exact USDC spend (confirm in wallet)…');
      btn.textContent = '⏳ Approving…';
      const approveTx = await token.approve(_ESCROW_ADDRESS, tokenAmount);
      setStatus('⏳ Waiting for approval confirmation…');
      const approvalReceipt = await approveTx.wait();
      if (approvalReceipt?.status !== 1) throw new Error('USDC approval did not confirm.');
    }

    await guard();
    const currentListing = await escrow.getListing(listingId);
    if (!currentListing.active || currentListing.available < 1n
      || currentListing.priceETH !== 0n || currentListing.priceAmount !== tokenAmount
      || currentListing.nftContract.toLowerCase() !== config.contract.toLowerCase()
      || currentListing.tokenId !== BigInt(config.tokenId)
      || currentListing.priceToken.toLowerCase() !== config.paymentToken.toLowerCase()
      || await escrow.getNFTBalance(config.contract, config.tokenId) < 1n
      || await token.balanceOf(buyer) < tokenAmount
      || await token.allowance(buyer, _ESCROW_ADDRESS) !== tokenAmount) {
      throw new Error('Listing or exact USDC approval changed; no purchase submitted.');
    }
    await guard();
    setStatus('⏳ Confirm purchase in wallet…');
    btn.textContent = '⏳ Purchasing…';
    const purchaseTx = await escrow.purchaseWithToken(listingId, 1);

    setStatus('⏳ Waiting for purchase confirmation…');
    let receipt;
    try {
      receipt = await purchaseTx.wait();
    } catch (error) {
      error.purchaseSubmitted = true;
      throw error;
    }
    if (receipt?.status !== 1) throw new Error('Supporter DNFT purchase did not confirm');
    const iface = escrow.interface;
    const purchaseEvent = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== _ESCROW_ADDRESS.toLowerCase()) return false;
      try {
        const event = iface.parseLog(log);
        return event?.name === 'Purchased' && event.args.listingId === listingId
          && event.args.buyer.toLowerCase() === buyer.toLowerCase() && event.args.amount === 1n
          && event.args.paymentToken.toLowerCase() === _USDC_ADDRESS.toLowerCase()
          && event.args.totalPaid === price;
      } catch { return false; }
    });
    if (!purchaseEvent) {
      const error = new Error('Purchase confirmed but the expected Base Purchased event was not found.');
      error.purchaseSubmitted = true;
      throw error;
    }
    if (tokenAmount > 0n) {
      announcePaymentCelebration({
        chainId: Number(_BASE_CHAIN_ID),
        txHash: receipt.hash || purchaseTx.hash,
        amountText: formatUsdcUnits(tokenAmount),
        assetText: 'USDC',
        summary: 'Supporter DNFT purchase confirmed',
        txLabel: 'Supporter DNFT transferred',
      });
    }

    btn.disabled = false;
    btn.textContent = '✅ Purchased!';
    setStatus(
      `✅ Success! Supporter DNFT transferred to your wallet. Tx: ${purchaseTx.hash.slice(0, 10)}…`,
      '#00e5ff'
    );

    this._loadDecentBuskingListings();
  }

  // ── PayPal purchase flow ──────────────────────────────────────────────────
  _loadPayPalSDK(clientId) {
    return new Promise((resolve, reject) => {
      if (window.paypal) { resolve(window.paypal); return; }
      const script = document.createElement('script');
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture`;
      script.onload  = () => resolve(window.paypal);
      script.onerror = () => reject(new Error('Failed to load PayPal SDK'));
      document.head.appendChild(script);
    });
  }

  _resetPayPalSection() {
    const walletInput  = this.shadowRoot.getElementById('paypal-wallet-address');
    const btnContainer = this.shadowRoot.getElementById('paypal-btn-container');
    const statusEl     = this.shadowRoot.getElementById('paypal-status');
    if (!walletInput) return;
    walletInput.value    = '';
    statusEl.textContent = '';
    btnContainer.innerHTML = `
      <button class="buy-btn paypal-launch-btn" id="paypal-launch-btn">
        💳 Buy with PayPal — $100
      </button>`;
  }

  async _handlePayPalLaunch() {
    const walletInput  = this.shadowRoot.getElementById('paypal-wallet-address');
    const launchBtn    = this.shadowRoot.getElementById('paypal-launch-btn');
    const btnContainer = this.shadowRoot.getElementById('paypal-btn-container');
    const statusEl     = this.shadowRoot.getElementById('paypal-status');

    const walletAddress = (walletInput?.value || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
      statusEl.textContent = '⚠ Please enter a valid Ethereum wallet address (0x… 40 hex chars).';
      statusEl.style.color = '#ff8800';
      walletInput?.focus();
      return;
    }

    statusEl.textContent = '⏳ Loading PayPal…';
    statusEl.style.color = '#aaa';
    if (launchBtn) launchBtn.disabled = true;

    try {
      const cfg        = window.DECENT_CONFIG || {};
      const clientId   = cfg.paypalClientId;
      const adminEmail = cfg.paypalDnftEmail || '';

      if (!clientId) {
        statusEl.textContent = '⚠ PayPal is not configured for this app. Use the Crypto option or contact the admin.';
        statusEl.style.color = '#ff8800';
        if (launchBtn) launchBtn.disabled = false;
        return;
      }

      const paypal = await this._loadPayPalSDK(clientId);

      btnContainer.innerHTML = '<div id="paypal-sdk-buttons"></div>';
      const sdkContainer = this.shadowRoot.getElementById('paypal-sdk-buttons');
      statusEl.textContent = '';

      await paypal.Buttons({
        style: { layout: 'horizontal', color: 'blue', shape: 'rect', label: 'pay' },

        createOrder(data, actions) {
          return actions.order.create({
            purchase_units: [{
              description: `DecentBusking Supporter DNFT — Wallet: ${walletAddress}`,
              custom_id: walletAddress,
              amount: { currency_code: 'USD', value: '100.00' },
            }],
          });
        },

        onApprove: async (data, actions) => {
          const details = await actions.order.capture();
          const txId    = details.id;
          const paidAt  = details.update_time || details.create_time || new Date().toISOString();
          // Build success message with escaped API/user values to prevent XSS
          statusEl.innerHTML = `
            ✅ <strong>Payment confirmed!</strong><br>
            PayPal Transaction: <code>${_esc(txId)}</code><br>
            Wallet: <code>${_esc(walletAddress)}</code><br>
            <em>Admin has been notified — your Supporter DNFT will arrive within 24 h.</em>`;
          statusEl.style.color = '#00e5ff';
          btnContainer.innerHTML = '';

          if (adminEmail) {
            const subject = encodeURIComponent('DecentBusking Supporter DNFT Purchase — PayPal');
            const body    = encodeURIComponent(
              `PayPal Transaction ID: ${txId}\n` +
              `Wallet Address: ${walletAddress}\n` +
              `Amount: $100 USD\n` +
              `Timestamp: ${paidAt}`
            );
            window.location.href = `mailto:${adminEmail}?subject=${subject}&body=${body}`;
          }
        },

        onCancel: () => {
          statusEl.textContent = 'Payment cancelled. Try again when ready.';
          statusEl.style.color = '#aaa';
          this._resetPayPalSection();
        },

        onError: (err) => {
          console.error('[about-override] PayPal error:', err);
          statusEl.textContent = '⚠ PayPal encountered an error. Please try again.';
          statusEl.style.color = '#ff4444';
          this._resetPayPalSection();
        },
      }).render(sdkContainer);

    } catch (err) {
      console.error('[about-override] PayPal init error:', err);
      statusEl.textContent = '⚠ Could not load PayPal. Check your internet connection.';
      statusEl.style.color = '#ff4444';
      this._resetPayPalSection();
    }
  }

  render() {
    const cfg     = window.DECENT_CONFIG || {};
    const appName = cfg.appName   || 'Decent Busking';
    const discord = cfg.discord   || '';
    const github  = cfg.github    || '';

    this.shadowRoot.innerHTML = `
      <style>
        .modal-container {
          display: none;
          position: fixed;
          inset: 0;
          z-index: 99999;
          place-items: center;
          background: rgba(4, 6, 16, 0.82);
          backdrop-filter: blur(12px);
          padding: 18px;
          box-sizing: border-box;
          overflow-y: auto;
        }
        .modal-box {
          position: relative;
          isolation: isolate;
          overflow: hidden;
          width: min(900px, 100%);
          max-height: min(92vh, 940px);
          overflow-y: auto;
          box-sizing: border-box;
          background: linear-gradient(145deg, rgba(15,19,36,.98), rgba(20,20,39,.97) 48%, rgba(24,17,35,.98));
          border: 1px solid rgba(190,174,255,.38);
          border-radius: 20px;
          margin: auto;
          padding: clamp(20px, 4vw, 36px);
          color: white;
          font-family: 'Segoe UI', system-ui, sans-serif;
          animation: about-arrive .42s cubic-bezier(.2,.8,.2,1) both;
          box-shadow: 0 26px 90px rgba(0,0,0,.62), 0 0 34px rgba(139,111,226,.12);
          scrollbar-width: thin;
          scrollbar-color: rgba(186,166,255,.5) transparent;
        }
        .about-network {
          position: absolute;
          inset: 0;
          z-index: -1;
          width: 100%;
          height: 100%;
          pointer-events: none;
          opacity: .62;
        }
        .about-network .network-rail { fill: none; stroke: rgba(169,181,255,.16); stroke-width: 1; }
        .about-network .network-pulse {
          fill: none;
          stroke: url(#about-energy-gradient);
          stroke-width: 1.7;
          stroke-linecap: round;
          stroke-dasharray: 10 260;
          filter: drop-shadow(0 0 4px rgba(136,220,212,.72));
          animation: about-energy-flow var(--flow-time, 9s) linear infinite;
          animation-delay: var(--flow-delay, 0s);
        }
        .about-network .network-node { fill: #111625; stroke: rgba(191,174,255,.7); stroke-width: 1.2; }
        .about-inner-content { position: relative; z-index: 1; }
        .about-hero {
          display: grid;
          grid-template-columns: auto minmax(0,1fr);
          align-items: center;
          gap: 18px;
          padding: 12px 48px 22px 4px;
          border-bottom: 1px solid rgba(255,255,255,.1);
        }
        .about-avatar-wrap { position: relative; width: 82px; height: 82px; }
        .about-avatar-wrap::before, .about-avatar-wrap::after {
          content: '';
          position: absolute;
          inset: -6px;
          border: 1px solid rgba(126,221,211,.48);
          border-radius: 50%;
          animation: about-orbit 8s linear infinite;
        }
        .about-avatar-wrap::after { inset: -11px; border-color: rgba(197,136,233,.34); animation-direction: reverse; animation-duration: 13s; }
        .about-avatar { position: relative; z-index: 1; width: 82px; height: 82px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(255,198,145,.9); box-shadow: 0 0 22px rgba(255,135,85,.22); }
        .about-kicker { margin: 0 0 5px; color: #91ddd3; font-size: .72rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
        .about-hero h2 { margin: 0; color: #fff2e4; font-size: clamp(1.55rem, 4vw, 2.25rem); line-height: 1.08; }
        .about-hero-copy { margin: 7px 0 0; color: #c4c7d8; font-size: .92rem; line-height: 1.45; }
        .about-status-row { display: flex; align-items: center; justify-content: center; gap: 7px; flex-wrap: wrap; margin-top: 11px; }
        .about-status { padding: 5px 9px; border: 1px solid rgba(124,222,207,.25); border-radius: 999px; color: #a4e5d9; background: rgba(72,166,154,.1); font-size: .7rem; font-weight: 650; }
        .about-tutorial-btn { padding: 5px 10px; border: 1px solid rgba(145,221,211,.34); border-radius: 999px; color: #d7fff5; background: rgba(145,221,211,.1); font-size: .72rem; font-weight: 700; cursor: pointer; }
        .about-tutorial-btn:hover { background: rgba(145,221,211,.18); }
        .about-section { margin: 22px 0; color: #e5e3ee; line-height: 1.56; }
        .about-section h3 { margin: 0 0 10px; color: #e9d5ff; font-size: 1.08rem; }
        .about-section p { color: #c8cad7; }
        .about-roadmap { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
        .about-roadmap section { padding: 14px 15px; border: 1px solid rgba(172,164,228,.18); border-radius: 10px; background: rgba(12,15,29,.58); }
        .about-roadmap h3 { margin: 0 0 9px; font-size: .95rem; }
        .about-roadmap ul { margin: 0; padding-left: 1.25rem; color: #c7cad8; font-size: .82rem; line-height: 1.55; }
        .about-roadmap .live h3 { color: #91ddd3; }
        .about-roadmap .next h3 { color: #e1a9e8; }
        .about-callout { margin-top: 18px; padding: 13px 15px; border-left: 2px solid #f3a36e; background: linear-gradient(90deg,rgba(243,163,110,.12),rgba(130,113,193,.06)); color: #f1e5d9; }
        .about-footer { margin-top: 22px; color: #aaaabd; font-size: .8rem; text-align: center; }
        @keyframes about-arrive { from { opacity: 0; transform: translateY(12px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes about-energy-flow { to { stroke-dashoffset: -270; } }
        @keyframes about-orbit { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .modal-box, .network-pulse, .about-avatar-wrap::before, .about-avatar-wrap::after { animation: none !important; } }
        .modal-box > .about-inner-content > h2 { margin: 0; font-size: 1.8rem; }
        .about-network {
          position: absolute;
          inset: 0;
          z-index: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          opacity: .72;
        }
        .about-network .network-rail { fill: none; stroke: rgba(166,174,235,.2); stroke-width: 1; }
        .about-network .network-pulse {
          fill: none;
          stroke: url(#about-energy-gradient);
          stroke-width: 1.7;
          stroke-linecap: round;
          stroke-dasharray: 12 360;
          filter: drop-shadow(0 0 4px rgba(110,225,210,.72));
          animation: about-energy-flow var(--flow-time, 8s) linear infinite;
          animation-delay: var(--flow-delay, 0s);
        }
        .about-network .network-pulse.pink { stroke: rgba(235,157,220,.9); filter: drop-shadow(0 0 4px rgba(235,157,220,.7)); }
        .about-network .network-node { fill: #151a2b; stroke: rgba(193,177,255,.85); stroke-width: 1.4; filter: drop-shadow(0 0 5px rgba(141,124,247,.75)); }
        .about-inner-content { position: relative; z-index: 1; }
        .about-hero {
          display: grid;
          grid-template-columns: 82px minmax(0,1fr);
          align-items: center;
          gap: 18px;
          padding: 8px 52px 22px 4px;
          border-bottom: 1px solid rgba(255,255,255,.1);
        }
        .about-avatar-wrap { position: relative; width: 74px; height: 74px; }
        .about-avatar-wrap::before, .about-avatar-wrap::after {
          content: '';
          position: absolute;
          inset: -6px;
          border: 1px solid rgba(111,222,210,.52);
          border-radius: 50%;
          animation: about-orbit 9s linear infinite;
        }
        .about-avatar-wrap::after { inset: -11px; border-color: rgba(214,146,224,.42); animation-duration: 15s; animation-direction: reverse; }
        .about-avatar { position: relative; z-index: 1; width: 74px; height: 74px; border: 2px solid rgba(255,193,143,.9); border-radius: 50%; object-fit: cover; box-shadow: 0 0 20px rgba(255,133,86,.24); }
        .about-kicker { margin: 0 0 5px; color: #91ddd3; font-size: .7rem; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
        .about-hero h1 { margin: 0; color: #fff0e3; font: 700 clamp(1.65rem, 4vw, 2.35rem)/1.05 'Segoe UI',system-ui,sans-serif; }
        .about-hero-copy { margin: 7px 0 0; color: #c9cad8; font-size: .92rem; line-height: 1.45; }
        .about-status-row { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
        .about-status { display: inline-flex; align-items: center; justify-content: center; padding: 5px 9px; color: #a6e8dd; background: rgba(87,195,179,.09); border: 1px solid rgba(105,221,204,.22); border-radius: 999px; font-size: .68rem; font-weight: 700; line-height: 1.3; text-align: center; }
        .about-tutorial-btn { padding: 5px 10px; border: 1px solid rgba(145,221,211,.34); border-radius: 999px; color: #d7fff5; background: rgba(145,221,211,.1); font-size: .72rem; font-weight: 700; cursor: pointer; }
        .about-tutorial-btn:hover { background: rgba(145,221,211,.18); }
        .about-section { margin: 21px 0; color: #e2e2ec; line-height: 1.58; }
        .about-section h3 { margin: 0 0 9px; color: #d8c9ff; font-size: 1.05rem; }
        .about-section p { color: #c7c9d7; }
        .community-funds-section {
          margin: 18px 0 22px;
          padding: 14px 15px;
          border: 1px solid rgba(171,163,225,.22);
          border-radius: 12px;
          background: rgba(10,14,28,.72);
        }
        .community-funds-section h3 { margin: 0 0 10px; color: #91ddd3; font-size: 1rem; }
        .fund-disclosure { margin: 0 0 10px; padding: 10px 12px; border: 1px solid rgba(171,163,225,.16); border-radius: 10px; background: rgba(20,23,42,.78); }
        .fund-disclosure summary { cursor: pointer; color: #f7eef7; list-style: none; }
        .fund-disclosure summary::-webkit-details-marker { display: none; }
        .fund-disclosure-body { margin-top: 10px; }
        .fund-description { margin: 0 0 10px; color: #c8cad7; }
        .fund-wallet-link { border: 0; background: transparent; color: #91ddd3; font: inherit; cursor: pointer; padding: 0; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
        .fund-wallet-aliases { margin-left: 6px; color: #a8a8bd; font-size: .82rem; }
        .fund-source-table { margin-top: 8px; width: 100%; }
        .fund-source-table th, .fund-source-table td { padding: 7px 8px; vertical-align: top; }
        .fund-source-table td { color: #d8dbe8; }
        .fund-source-table a { color: #98ded6; }
        .fund-source-empty, .community-funds-unavailable { margin: 0; color: #b8bac9; }
        .about-roadmap { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; margin: 10px 0 18px; }
        .about-roadmap section { padding: 14px 15px; background: rgba(10,14,28,.68); border: 1px solid rgba(171,163,225,.2); border-radius: 10px; }
        .about-roadmap h3 { margin: 0 0 9px; font-size: .92rem; }
        .about-roadmap .live h3 { color: #92e0d2; }
        .about-roadmap .next h3 { color: #e2a7e0; }
        .about-roadmap ul { margin: 0; padding-left: 1.15rem; color: #c6c8d5; font-size: .81rem; line-height: 1.55; }
        .about-callout { margin: 14px 0; padding: 12px 14px; color: #f2e7dd; background: linear-gradient(100deg,rgba(239,164,120,.12),rgba(137,119,208,.1),rgba(92,200,190,.08)); border-left: 2px solid #f1a576; line-height: 1.5; }
        .about-footer { margin: 22px 0 4px; color: #aaaabd; font-size: .8rem; text-align: center; }
        .supporter-remint {
          margin: 0 0 20px;
          padding: 15px 17px;
          border: 1px solid rgba(171,163,225,.22);
          border-radius: 9px;
          background: rgba(13,16,30,.62);
        }
        .supporter-remint h3 { margin: 0 0 6px; color: #e1d5ff; font-size: .98rem; }
        .supporter-remint p { margin: 0; color: #bfc1d0; font-size: .82rem; line-height: 1.5; }
        @keyframes about-energy-flow { to { stroke-dashoffset: -372; } }
        @keyframes about-orbit { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .about-network .network-pulse, .about-avatar-wrap::before, .about-avatar-wrap::after { animation: none !important; } }
        .close-btn {
          position: absolute;
          top: 15px;
          right: 15px;
          z-index: 2;
          width: 36px;
          height: 36px;
          display: grid;
          place-items: center;
          background: rgba(255,255,255,.06);
          color: #eee8f7;
          border: 1px solid rgba(255,255,255,.14);
          cursor: pointer;
          border-radius: 50%;
        }
        a { color: #98ded6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        @media (max-width: 600px) {
          .modal-container { padding: 10px; }
          .modal-box { width: 100%; max-height: calc(100vh - 20px); padding: 18px 15px; }
          .about-hero { gap: 13px; padding-right: 38px; }
          .about-avatar-wrap,.about-avatar { width: 62px; height: 62px; }
          .about-roadmap { grid-template-columns: 1fr; }
          .buy-options { display: grid; grid-template-columns: minmax(0,1fr); }
          .buy-option-card { min-width: 0; max-width: none; width: 100%; }
        }
        .future-note { margin-top: 1em; font-size: 0.85em; color: #aaa; }
        .buy-section {
          margin: 1.5em 0;
          text-align: center;
          border: 1px solid rgba(164,151,224,.24);
          border-radius: 12px;
          padding: 1.2em 1em;
          background: rgba(12,16,31,.78);
        }
        .buy-section h3 { color: #d7c7ff; margin-top: 0; }
        .buy-card {
          margin: 0.8em auto;
          padding: 0.8em 1em;
          border: 1px solid rgba(164,151,224,.22);
          border-radius: 10px;
          background: rgba(20,23,42,.86);
          max-width: 420px;
        }
        .buy-card-label { font-size: 0.95em; color: #f0c040; margin-bottom: 0.3em; font-weight: bold; }
        .buy-card-supply { font-size: 0.82em; color: #aaa; margin-bottom: 0.6em; }
        .buy-btn {
          display: inline-block;
          background: linear-gradient(135deg, #b8a1ff, #73dcca, #f0a0ce);
          color: black;
          font-weight: bold;
          font-size: 1.1rem;
          padding: 12px 28px;
          border-radius: 10px;
          border: none;
          cursor: pointer;
          letter-spacing: 0.04em;
          box-shadow: 0 0 16px rgba(155,137,232,.42);
          transition: box-shadow 0.2s, transform 0.1s;
          font-family: 'Courier New', monospace;
        }
        .buy-btn:hover:not(:disabled) { box-shadow: 0 0 28px rgba(155,137,232,.62); transform: translateY(-2px); }
        .buy-btn:disabled { opacity: 0.7; cursor: not-allowed; }
        #buy-status { font-size: 0.82em; color: #aaa; margin-top: 0.8em; min-height: 1.2em; overflow-wrap: break-word; }
        .escrow-note { font-size: 0.78em; color: #888; margin-top: 0.6em; }
        .escrow-note a { color: #a9e9dd; }
        .buy-options {
          display: flex;
          gap: 1em;
          flex-wrap: wrap;
          justify-content: center;
          margin-top: 0.6em;
        }
        .buy-option-card {
          flex: 1;
          min-width: 220px;
          max-width: 320px;
          border: 1px solid rgba(164,151,224,.22);
          border-radius: 12px;
          padding: 1em;
          background: rgba(20,23,42,.86);
          text-align: center;
        }
        .buy-option-card.paypal-option { border-color: #0070ba55; background: #001a2c; }
        .buy-option-title { font-size: 1em; font-weight: bold; color: #f0c040; margin-bottom: 0.3em; }
        .buy-option-card.paypal-option .buy-option-title { color: #5bc6f7; }
        .buy-option-price { font-size: 0.82em; color: #aaa; margin-bottom: 0.5em; }
        .buy-option-desc  { font-size: 0.8em; color: #888; margin: 0 0 0.8em; }
        #paypal-wallet-address {
          width: 100%;
          box-sizing: border-box;
          background: #000d1a;
          border: 1px solid #0070ba;
          border-radius: 8px;
          color: #5bc6f7;
          font-family: 'Courier New', monospace;
          font-size: 0.82em;
          padding: 8px 10px;
          margin-bottom: 0.6em;
          outline: none;
        }
        #paypal-wallet-address::placeholder { color: #3a6080; }
        #paypal-wallet-address:focus { border-color: #5bc6f7; box-shadow: 0 0 8px #0070ba55; }
        .paypal-launch-btn { background: linear-gradient(135deg, #0070ba, #003087); box-shadow: 0 0 16px #0070ba55; color: white; }
        .paypal-launch-btn:hover:not(:disabled) { box-shadow: 0 0 28px #5bc6f7aa; }
        #paypal-status {
          font-size: 0.82em;
          color: #aaa;
          margin-top: 0.8em;
          min-height: 1.2em;
          overflow-wrap: break-word;
          text-align: left;
          line-height: 1.5;
        }
        #paypal-status code { font-size: 0.9em; color: #f0c040; word-break: break-all; }
      </style>

      <div class="modal-container">
        <div class="modal-box">
          <svg class="about-network" viewBox="0 0 1000 900" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="about-energy-gradient" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#91ded3" />
                <stop offset=".5" stop-color="#b9a3ff" />
                <stop offset="1" stop-color="#ef9dca" />
              </linearGradient>
            </defs>
            <path class="network-rail" d="M0 175 C180 90 210 350 420 275 S760 90 1000 185" />
            <path class="network-pulse" style="--flow-time:8s;--flow-delay:-2.4s" d="M0 175 C180 90 210 350 420 275 S760 90 1000 185" />
            <path class="network-rail" d="M0 430 C190 330 285 600 500 455 S790 305 1000 470" />
            <path class="network-pulse pink" style="--flow-time:10s;--flow-delay:-5.1s" d="M0 430 C190 330 285 600 500 455 S790 305 1000 470" />
            <path class="network-rail" d="M0 730 C210 570 340 850 560 700 S825 560 1000 740" />
            <path class="network-pulse" style="--flow-time:9s;--flow-delay:-3.2s" d="M0 730 C210 570 340 850 560 700 S825 560 1000 740" />
            <path class="network-rail" d="M120 0 C250 220 90 330 250 500 S390 740 330 900" />
            <path class="network-pulse pink" style="--flow-time:11s;--flow-delay:-6s" d="M120 0 C250 220 90 330 250 500 S390 740 330 900" />
            <path class="network-rail" d="M720 0 C590 210 850 340 700 530 S650 780 820 900" />
            <path class="network-pulse" style="--flow-time:12s;--flow-delay:-7.3s" d="M720 0 C590 210 850 340 700 530 S650 780 820 900" />
            <circle class="network-node" cx="250" cy="500" r="4" />
            <circle class="network-node" cx="500" cy="455" r="4" />
            <circle class="network-node" cx="700" cy="530" r="4" />
          </svg>
          <div class="about-inner-content">
            <button class="close-btn" id="close-about" aria-label="Close About">✕</button>
            <header class="about-hero">
              <div class="about-avatar-wrap"><img class="about-avatar" src="${_DBUSKER_ABOUT_AVATAR}" alt="DBusker" /></div>
              <div>
                <p class="about-kicker">Listen · Loop · Busk</p>
                <h1>${_esc(appName)}</h1>
                <p class="about-hero-copy">A community listening room, a 3D music archive, and direct artist support using Base and public IPFS.</p>
                <div class="about-status-row"><span class="about-status">Base Mainnet</span><span class="about-status">IPFS · Pinata</span><span class="about-status">JukeLoop Radio</span><button class="about-tutorial-btn" type="button" data-tutorial-launch>Start Tutorial</button><button class="about-tutorial-btn" type="button" data-split-tutorial-launch>🐇 Collaborators &amp; payments guide</button></div>
              </div>
            </header>

            <div id="community-funds"></div>

            <div class="about-section">
              <h3>🎧 Make the loop</h3>
              <p>Listen and explore without a wallet. Artists submit tracks for owner review; listeners can support the chosen artist wallet directly. This is a hybrid system: Discord and the operator run the radio, while Base records NFTs and treasury payments.</p>
              <p>Minting does not itself transfer copyright. Public IPFS can be copied by others, and plays or votes do not guarantee income. Our whitepaper explains the architecture, current safeguards, and what is still planned.</p>
              <p><a id="whitepaper-link" href="https://github.com/TheJollyLaMa/DecentBusking/blob/main/WHITEPAPER.md" target="_blank" rel="noopener noreferrer">Read Full Whitepaper</a></p>
              <p>Upload audio or a video in <strong>#DecentJukebox</strong>, or use the guitar case on this site. Discord files can be up to 10 MB; the site supports uploads up to 50 MB or an existing IPFS file CID.</p>
              <p>After a Discord upload is pinned, click <strong>Request NFT</strong>. Confirm your Base wallet, then attach an image up to 10 MB or enter an IPFS image CID. Leave artwork blank to use your Discord profile image. The owner reviews every request before minting.</p>
            </div>

            <div class="about-section">
              <h3>🎙️ Earn from radio plays</h3>
              <p>Use the same artist wallet on your mint request. A radio play counts after at least 30 seconds of completed, audible Discord playback. Votes help guide the rotation; they do not add paid plays.</p>
              <p>When a weekly budget is funded, the owner reviews and settles eligible payouts in USDC on Base. A tally is not a promise of payment: no funded budget means no playback payout. Check <strong>My Playback Tally</strong> for recorded plays and the Payroll panel for the current weekly draft.</p>
            </div>

            <div class="about-section">
              <h3>🛠️ Build and earn</h3>
              <p>Pick an open GitHub issue, ask to be assigned, and submit a pull request that says <code>Closes #issue-number</code>. Only work with a bounty label, such as <code>bounty: 10 USDC</code> or <code>bounty: 10 ART</code>, enters the repo payout queue after the pull request merges.</p>
              <p>The owner reviews and settles eligible rewards from the funded Base treasury. No bounty label means no automatic repo payout; never add or guess a bounty amount yourself.</p>
              <p><a href="https://github.com/TheJollyLaMa/DecentBusking/issues" target="_blank" rel="noopener noreferrer">Browse beginner-friendly issues ↗</a> · <a href="https://github.com/TheJollyLaMa/DecentBusking/blob/main/docs/PAYROLL.md" target="_blank" rel="noopener noreferrer">Read contributor payout details ↗</a></p>
            </div>

            <div class="about-section">
              <h3>🎨 Help without coding</h3>
              <p><strong>Make or share art:</strong> offer original, shareable cover art, posters, or video assets. Artists can add optional cover art to a mint request. For project-wide art, open an issue first and tell us how we may use it.</p>
              <p><strong>Help with the gallery:</strong> suggest an artist spotlight, a themed listening playlist, or a better way to show community artwork in the archive. The gallery is an idea to help shape, not a separate paid feature today.</p>
              <p><strong>Test and welcome people:</strong> listen, vote, try the site on your phone, report a clear bug, invite an artist, or host a listening session. These are welcome contributions, but are not automatically paid.</p>
              <p>Want payment for a specific art, testing, or outreach task? Ask the maintainer to agree on the task and bounty <strong>before starting</strong>. It must be tracked through an eligible GitHub issue and accepted submission; repo payroll does not pay for informal activity.</p>
            </div>

          <section class="supporter-remint" aria-labelledby="supporter-remint-title">
            <h3 id="supporter-remint-title">🎟️ DecentBusking Supporter DNFTs</h3>
            <p>Supporter DNFTs are a separate thank-you from music NFTs. The v1.0.0 edition is listed on Base for $100 USDC. Review the live listing and stock below; each purchase requires an exact USDC approval and a separate wallet confirmation.</p>
            <div id="buy-cards" aria-live="polite"></div>
            <p id="buy-status" role="status" aria-live="polite"></p>
          </section>

          <div class="about-section">
            <h3>🔗 Find us</h3>
            <ul>
              ${github  ? `<li>🐙 <a href="${github}"  target="_blank" rel="noopener">GitHub — DecentBusking</a></li>` : ''}
              ${discord ? `<li>💬 <a href="${discord}" target="_blank" rel="noopener">Discord — Join the community</a></li>` : ''}
              <li>🧾 <a href="https://basescan.org/address/0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B" target="_blank" rel="noopener">DecentNFT v0.2 on BaseScan</a></li>
              <li>🛒 <a href="https://thejollylama.github.io/DecentMarket/" target="_blank" rel="noopener">DecentMarket</a> <span class="future-note">Music listing integration is in progress.</span></li>
              <li>🦊 <a href="https://metamask.io/" target="_blank" rel="noopener">MetaMask</a></li>
            </ul>
          </div>

          <div class="about-roadmap" aria-label="DecentBusking feature status">
            <section class="live">
              <h3>✨ Live now</h3>
              <ul>
                <li>🎙️ Discord uploads join the Pinata-backed JukeLoop playlist.</li>
                <li>🗳️ Votes shape radio rotation; all-time ratings survive restarts.</li>
                <li>🪐 Base music NFTs appear in the 3D timeline and archive.</li>
                <li>🎩 Listen, select tracks, and tip artists.</li>
                <li>🎨 Artist artwork is pinned with the mint request.</li>
              </ul>
            </section>
            <section class="next">
              <h3>🔭 On the roadmap</h3>
              <ul>
                <li>🛒 Music NFT marketplace listings and resale.</li>
                <li>⚡ DecentNFT v0.3 creator permissions and atomic batch minting.</li>
                <li>🎼 Enforceable multi-artist royalty splits.</li>
                <li>💚 Auditable playback accounting and seasonal artist payouts.</li>
              </ul>
            </section>
          </div>

          <p class="about-callout">Bring a track to <strong>#DecentJukebox</strong>, join the radio, and help shape the next verse of the project.</p>
          <p class="about-footer">Built with care by The Jolly LaMa and The RoboSoul.</p>
          </div>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById('close-about').addEventListener('click', () => this.close());
    this.shadowRoot.querySelectorAll('[data-tutorial-launch]').forEach((button) => {
      button.addEventListener('click', () => {
        this.close();
        startTutorial();
      });
    });
    syncTutorialLaunchButtons(this.shadowRoot);
    this.shadowRoot.querySelector('[data-split-tutorial-launch]').addEventListener('click', () => {
      this.close();
      startTutorial({ card: 'splits' });
    });
    this._loadCommunityFunds();
    this._loadDecentBuskingListings();
    this.shadowRoot.getElementById('paypal-btn-container')?.addEventListener('click', (e) => {
      if (e.target.id === 'paypal-launch-btn') this._handlePayPalLaunch();
    });
  }
}
