// js/components/about-override.js — DecentBusking
//
// Intercepts the CDN DecentHead 'about-modal' custom element definition and
// replaces it with a DecentBusking-specific version.
//
// The CDN's AboutModal.js hard-codes a filter for listings whose note field
// contains "decenthead", which causes BigNuten / DecentHead Supporter NFTs to
// appear instead of DecentBusking Supporter DNFTs.  This override replaces
// that filter with one that matches "decentbusking" so only the correct
// Supporter DNFTs minted under the DecentBusking collection are shown.
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

// ── Purchase constants (mirrors CDN AboutModal.js) ─────────────────────────
const _ESCROW_ADDRESS    = '0x23A457AD3C33d68E4fAd2FCa7c5d9a511E0C350e';
const _USDC_ADDRESS      = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const _ZERO_ADDRESS      = '0x0000000000000000000000000000000000000000';
const _OPTIMISM_CHAIN_ID = 10n;

const _ESCROW_ABI = [
  'function nextListingId() view returns (uint256)',
  'function getListing(uint256 listingId) view returns (tuple(address nftContract, uint256 tokenId, uint256 priceETH, address priceToken, uint256 priceAmount, uint256 available, bool active, string note))',
  'function getNFTBalance(address nftContract, uint256 tokenId) view returns (uint256)',
  'function purchaseWithETH(uint256 listingId, uint256 amount) payable',
  'function purchaseWithToken(uint256 listingId, uint256 amount)',
];

const _ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const _MSG_NFT_NOT_IN_ESCROW = '⚠ NFT stock not yet loaded into escrow — check back soon.';
const _DBUSKER_ABOUT_AVATAR = new URL('../../img/D_Busker.jpeg', import.meta.url).href;
const _ARTIZEN_LOGO = new URL('../../img/Artizen_LOGO.png', import.meta.url).href;

class DecentBuskingAboutModal extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
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
      if (!ethers || !window.ethereum) {
        container.innerHTML = '<p style="color:#aaa;font-size:0.85em;">Connect MetaMask to see live availability.</p>';
        return;
      }

      const provider = new ethers.BrowserProvider(window.ethereum);
      const escrow   = new ethers.Contract(_ESCROW_ADDRESS, _ESCROW_ABI, provider);

      const count = Number(await escrow.nextListingId());

      const raws = await Promise.all(
        Array.from({ length: count }, (_, i) => escrow.getListing(i))
      );

      // Filter to only active DecentBusking Supporter DNFT listings
      const matched = raws
        .map((raw, i) => ({
          id:          i,
          nftContract: raw[0],
          tokenId:     raw[1],
          priceETH:    raw[2],
          priceToken:  raw[3],
          priceAmount: raw[4],
          available:   raw[5],
          active:      raw[6],
          note:        raw[7],
        }))
        .filter(l =>
          l.active &&
          l.available > 0n &&
          l.note.toLowerCase().includes('decentbusking')
        );

      if (matched.length === 0) {
        container.innerHTML = '<p style="color:#aaa;font-size:0.85em;">No editions currently listed — check back soon.</p>';
        return;
      }

      // Verify actual escrow NFT stock
      const nftBalances = await Promise.all(
        matched.map(l => escrow.getNFTBalance(l.nftContract, l.tokenId))
      );

      container.innerHTML = matched.map((l, idx) => {
        const nftInStock = nftBalances[idx] > 0n;

        let priceLabel;
        if (l.priceETH > 0n) {
          priceLabel = `${ethers.formatEther(l.priceETH)} ETH`;
        } else if (l.priceAmount > 0n) {
          const isUsdc = !l.priceToken
            || l.priceToken === _ZERO_ADDRESS
            || l.priceToken.toLowerCase() === _USDC_ADDRESS.toLowerCase();
          if (isUsdc) {
            priceLabel = `$${(Number(l.priceAmount) / 1e6).toFixed(2)} USDC`;
          } else {
            priceLabel = `${l.priceAmount.toString()} raw units (${l.priceToken.slice(0, 8)}…)`;
          }
        } else {
          priceLabel = 'Free';
        }

        return `
          <div class="buy-card">
            <div class="buy-card-label">${l.note}</div>
            <div class="buy-card-supply">${l.available} available</div>
            ${nftInStock
              ? `<button class="buy-btn" data-listing-id="${l.id}" data-price-eth="${l.priceETH.toString()}" data-price="${l.priceAmount.toString()}">
                   🎟️ Buy Now — ${priceLabel}
                 </button>`
              : `<span role="status" style="color:#ff8800;font-size:0.8em;">${_MSG_NFT_NOT_IN_ESCROW}</span>`
            }
          </div>
        `;
      }).join('');

      container.querySelectorAll('.buy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const listingId = parseInt(btn.dataset.listingId);
          const price     = BigInt(btn.dataset.price);
          this._handleBuy(listingId, price, btn, statusEl);
        });
      });

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

    if (!window.ethereum) {
      setStatus('⚠ MetaMask not found. Please install it to buy on-chain.', '#ff8800');
      return;
    }
    const ethers = window.ethers;
    if (!ethers) {
      setStatus('⚠ ethers.js not loaded.', '#ff8800');
      return;
    }

    try {
      btn.disabled = true;
      btn.textContent = '⏳ Connecting wallet…';

      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);

      const network = await provider.getNetwork();
      if (network.chainId !== _OPTIMISM_CHAIN_ID) {
        setStatus('⏳ Switching to Optimism…');
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0xa' }],
          });
        } catch (switchErr) {
          if (switchErr.code === 4902) {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: '0xa',
                chainName: 'Optimism Mainnet',
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                rpcUrls: ['https://mainnet.optimism.io'],
                blockExplorerUrls: ['https://optimistic.etherscan.io'],
              }],
            });
          } else {
            throw switchErr;
          }
        }
        const freshProvider = new ethers.BrowserProvider(window.ethereum);
        await this._doPurchase(freshProvider, ethers, listingId, price, btn, setStatus);
        return;
      }

      await this._doPurchase(provider, ethers, listingId, price, btn, setStatus);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '🎟️ Buy Now';
      const data = err?.data ?? err?.info?.error?.data ?? '';
      if (typeof data === 'string' && data.startsWith('0x03dee4c5')) {
        setStatus('⚠ NFT stock not in escrow — the seller needs to deposit NFTs before purchase.', '#ff8800');
      } else {
        setStatus(`⚠ ${err.reason || err.message || 'Unknown error'}`, '#ff4444');
      }
    }
  }

  async _doPurchase(provider, ethers, listingId, price, btn, setStatus) {
    const signer = await provider.getSigner();
    const buyer  = signer.address;

    setStatus('⏳ Checking listing…');
    const escrow  = new ethers.Contract(_ESCROW_ADDRESS, _ESCROW_ABI, signer);
    const listing = await escrow.getListing(listingId);

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
    if (nftBalance < 1n) {
      btn.disabled = false;
      btn.textContent = '🎟️ Buy Now';
      setStatus(`⚠ ${_MSG_NFT_NOT_IN_ESCROW}`, '#ff8800');
      return;
    }

    const tokenAmount = listing.priceAmount;
    const priceETH    = listing.priceETH ?? 0n;
    const rawToken    = listing.priceToken;

    let purchaseTx;

    if (priceETH > 0n) {
      setStatus('⏳ Confirm purchase in MetaMask…');
      btn.textContent = '⏳ Purchasing…';
      purchaseTx = await escrow.purchaseWithETH(listingId, 1, { value: priceETH });
    } else {
      const paymentToken = (rawToken && rawToken !== _ZERO_ADDRESS)
        ? rawToken
        : _USDC_ADDRESS;

      setStatus('⏳ Checking token allowance…');
      const token     = new ethers.Contract(paymentToken, _ERC20_ABI, signer);
      const allowance = await token.allowance(buyer, _ESCROW_ADDRESS);

      if (allowance < tokenAmount) {
        setStatus('⏳ Approving token spend (confirm in MetaMask)…');
        btn.textContent = '⏳ Approving…';
        const approveTx = await token.approve(_ESCROW_ADDRESS, tokenAmount);
        setStatus('⏳ Waiting for approval confirmation…');
        await approveTx.wait();
      }

      setStatus('⏳ Confirm purchase in MetaMask…');
      btn.textContent = '⏳ Purchasing…';
      purchaseTx = await escrow.purchaseWithToken(listingId, 1);
    }

    setStatus('⏳ Waiting for purchase confirmation…');
    await purchaseTx.wait();

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
        .about-status-row { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 11px; }
        .about-status { padding: 5px 9px; border: 1px solid rgba(124,222,207,.25); border-radius: 999px; color: #a4e5d9; background: rgba(72,166,154,.1); font-size: .7rem; font-weight: 650; }
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
        .about-status-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
        .about-status { padding: 5px 9px; color: #a6e8dd; background: rgba(87,195,179,.09); border: 1px solid rgba(105,221,204,.22); border-radius: 999px; font-size: .68rem; font-weight: 700; }
        .about-section { margin: 21px 0; color: #e2e2ec; line-height: 1.58; }
        .about-section h3 { margin: 0 0 9px; color: #d8c9ff; font-size: 1.05rem; }
        .about-section p { color: #c7c9d7; }
        .about-roadmap { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; margin: 10px 0 18px; }
        .about-roadmap section { padding: 14px 15px; background: rgba(10,14,28,.68); border: 1px solid rgba(171,163,225,.2); border-radius: 10px; }
        .about-roadmap h3 { margin: 0 0 9px; font-size: .92rem; }
        .about-roadmap .live h3 { color: #92e0d2; }
        .about-roadmap .next h3 { color: #e2a7e0; }
        .about-roadmap ul { margin: 0; padding-left: 1.15rem; color: #c6c8d5; font-size: .81rem; line-height: 1.55; }
        .about-callout { margin: 14px 0; padding: 12px 14px; color: #f2e7dd; background: linear-gradient(100deg,rgba(239,164,120,.12),rgba(137,119,208,.1),rgba(92,200,190,.08)); border-left: 2px solid #f1a576; line-height: 1.5; }
        .about-footer { margin: 22px 0 4px; color: #aaaabd; font-size: .8rem; text-align: center; }
        .artizen-support {
          position: relative;
          isolation: isolate;
          display: grid;
          grid-template-columns: 76px minmax(0,1fr);
          align-items: center;
          gap: 16px;
          overflow: hidden;
          margin: 22px 0 16px;
          padding: 18px;
          border: 1px solid rgba(45,222,132,.48);
          border-radius: 12px;
          background: linear-gradient(112deg,rgba(8,53,39,.91),rgba(9,32,34,.94) 58%,rgba(18,35,42,.92));
          box-shadow: 0 0 26px rgba(34,220,130,.13), inset 0 1px rgba(193,255,216,.08);
        }
        .artizen-energy {
          position: absolute;
          inset: 0;
          z-index: -1;
          width: 100%;
          height: 100%;
          pointer-events: none;
          opacity: .72;
        }
        .artizen-energy path { fill: none; stroke: rgba(96,244,166,.23); stroke-width: 1; }
        .artizen-energy .artizen-pulse {
          stroke: rgba(95,255,169,.96);
          stroke-width: 1.8;
          stroke-dasharray: 12 300;
          stroke-linecap: round;
          filter: drop-shadow(0 0 5px rgba(59,255,147,.78));
          animation: about-energy-flow var(--flow-time,7s) linear infinite;
          animation-delay: var(--flow-delay,0s);
        }
        .artizen-logo-wrap {
          display: grid;
          place-items: center;
          width: 70px;
          height: 70px;
          border: 1px solid rgba(85,245,159,.48);
          border-radius: 50%;
          background: radial-gradient(circle,rgba(30,240,131,.18),rgba(3,23,20,.85) 72%);
          box-shadow: 0 0 20px rgba(32,229,123,.2);
          animation: artizen-breathe 4s ease-in-out infinite;
        }
        .artizen-logo { width: 48px; height: 48px; object-fit: contain; filter: drop-shadow(0 0 8px rgba(64,255,151,.46)); }
        .artizen-copy { position: relative; z-index: 1; min-width: 0; }
        .artizen-kicker { margin: 0 0 5px; color: #81f0b0; font-size: .68rem; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
        .artizen-copy h3 { margin: 0 0 6px; color: #ecfff3; font-size: 1.16rem; }
        .artizen-copy p { margin: 0 0 11px; color: #c5e8d4; font-size: .84rem; line-height: 1.48; }
        .artizen-cta {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 38px;
          padding: 0 14px;
          color: #04160d;
          background: linear-gradient(100deg,#83f4ae,#48d78e);
          border: 1px solid rgba(207,255,222,.54);
          border-radius: 6px;
          font-size: .82rem;
          font-weight: 750;
          box-shadow: 0 0 16px rgba(54,232,132,.24);
        }
        .artizen-cta img { flex: none; width: 18px; height: 18px; object-fit: contain; }
        .artizen-cta:hover { text-decoration: none; filter: brightness(1.08); transform: translateY(-1px); }
        .supporter-remint {
          margin: 0 0 20px;
          padding: 15px 17px;
          border: 1px solid rgba(171,163,225,.22);
          border-radius: 9px;
          background: rgba(13,16,30,.62);
        }
        .supporter-remint h3 { margin: 0 0 6px; color: #e1d5ff; font-size: .98rem; }
        .supporter-remint p { margin: 0; color: #bfc1d0; font-size: .82rem; line-height: 1.5; }
        @keyframes artizen-breathe { 0%,100% { transform: scale(1); box-shadow: 0 0 16px rgba(32,229,123,.16); } 50% { transform: scale(1.045); box-shadow: 0 0 25px rgba(32,229,123,.34); } }
        @keyframes about-energy-flow { to { stroke-dashoffset: -372; } }
        @keyframes about-orbit { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .about-network .network-pulse, .about-avatar-wrap::before, .about-avatar-wrap::after, .artizen-energy .artizen-pulse, .artizen-logo-wrap { animation: none !important; } }
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
          .artizen-support { grid-template-columns: 54px minmax(0,1fr); gap: 12px; padding: 14px 12px; }
          .artizen-logo-wrap { width: 52px; height: 52px; }
          .artizen-logo { width: 36px; height: 36px; }
          .artizen-copy h3 { font-size: 1rem; }
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
                <p class="about-hero-copy">A community listening room, a living 3D music timeline, and a path from shared track to on-chain music NFT.</p>
                <div class="about-status-row"><span class="about-status">Base Mainnet</span><span class="about-status">IPFS · Pinata</span><span class="about-status">JukeLoop Radio</span></div>
              </div>
            </header>

            <div class="about-section">
              <h3>🎧 Make the loop</h3>
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
              <p>Pick an open GitHub issue, ask to be assigned, and submit a pull request that says <code>Closes #issue-number</code>. Add the bounty label shown on the issue, such as <code>bounty: 10 USDC</code> or <code>bounty: 10 ART</code>.</p>
              <p>After the pull request is merged, the reward enters the repo payout queue. The owner reviews and pays approved rewards from the funded Base treasury. Joining is free; a listed bounty is not paid until it is reviewed and settled.</p>
              <p><a href="https://github.com/TheJollyLaMa/DecentBusking/issues" target="_blank" rel="noopener noreferrer">Browse beginner-friendly issues ↗</a> · <a href="https://github.com/TheJollyLaMa/DecentBusking/blob/main/docs/PAYROLL.md" target="_blank" rel="noopener noreferrer">Read contributor payout details ↗</a></p>
            </div>

          <section class="artizen-support" aria-labelledby="artizen-support-title">
            <svg class="artizen-energy" viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 40 C180 220 300 5 500 130 S800 230 1000 28" />
              <path class="artizen-pulse" style="--flow-time:7s;--flow-delay:-2s" d="M0 40 C180 220 300 5 500 130 S800 230 1000 28" />
              <path d="M0 220 C210 30 340 245 560 90 S820 35 1000 205" />
              <path class="artizen-pulse" style="--flow-time:9s;--flow-delay:-5s" d="M0 220 C210 30 340 245 560 90 S820 35 1000 205" />
              <path d="M80 0 C280 160 650 170 920 0" />
              <path class="artizen-pulse" style="--flow-time:8s;--flow-delay:-3.6s" d="M80 0 C280 160 650 170 920 0" />
            </svg>
            <div class="artizen-logo-wrap"><img class="artizen-logo" src="${_ARTIZEN_LOGO}" alt="Artizen" /></div>
            <div class="artizen-copy">
              <p class="artizen-kicker">Primary way to support DecentBusking</p>
              <h3 id="artizen-support-title">🌱 Back Decent Jukebox on Artizen</h3>
              <p>Support the community radio, artist tools, and the next stage of the project. The Artizen project is the main support route now, and we’re preparing its connection with DecentJukebox for an upcoming merge.</p>
              <a class="artizen-cta" href="https://artizen.fund/index/p/decent-jukebox?season=7" target="_blank" rel="noopener noreferrer">
                <img src="${_ARTIZEN_LOGO}" alt="" aria-hidden="true" />
                <span>Support Decent Jukebox on Artizen ↗</span>
              </a>
            </div>
          </section>

          <section class="supporter-remint" aria-labelledby="supporter-remint-title">
            <h3 id="supporter-remint-title">🎟️ DecentBusking Supporter DNFTs</h3>
            <p>Supporter DNFTs are a separate thank-you from music NFTs. We’re preparing a fresh Base version for this DecentBusking release; the previous Optimism editions are not the purchase path for this launch.</p>
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
    this.shadowRoot.getElementById('paypal-btn-container')?.addEventListener('click', (e) => {
      if (e.target.id === 'paypal-launch-btn') this._handlePayPalLaunch();
    });
  }
}
