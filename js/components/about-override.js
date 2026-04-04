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

class DecentBuskingAboutModal extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  open() {
    this.shadowRoot.querySelector('.modal-container').style.display = 'block';
    this._loadDecentBuskingListings();
    this._resetPayPalSection();
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
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          z-index: 99999;
          backdrop-filter: blur(6px);
          padding: 40px;
          box-sizing: border-box;
          overflow-y: auto;
        }
        .modal-box {
          background: #111;
          border: 2px solid #f0c040;
          border-radius: 16px;
          max-width: 720px;
          margin: auto;
          padding: 24px;
          color: white;
          font-family: 'Courier New', monospace;
          animation: fadeIn 0.4s ease;
          box-shadow: 0 0 20px #f0c04088;
        }
        .modal-box h2 {
          margin-top: 0;
          font-size: 1.8rem;
          color: #f0c040;
          text-align: center;
        }
        .about-section { margin: 1.5em 0; }
        .close-btn {
          float: right;
          background: #f0c040;
          color: black;
          border: none;
          padding: 6px 12px;
          font-weight: bold;
          cursor: pointer;
          border-radius: 8px;
          margin-bottom: 12px;
        }
        a { color: #f0c040; text-decoration: none; }
        a:hover { text-decoration: underline; }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .future-note { margin-top: 1em; font-size: 0.85em; color: #aaa; }
        .buy-section {
          margin: 1.5em 0;
          text-align: center;
          border: 1px solid #f0c04088;
          border-radius: 12px;
          padding: 1.2em 1em;
          background: #1a1200;
        }
        .buy-section h3 { color: #f0c040; margin-top: 0; }
        .buy-card {
          margin: 0.8em auto;
          padding: 0.8em 1em;
          border: 1px solid #f0c04055;
          border-radius: 10px;
          background: #281e00;
          max-width: 420px;
        }
        .buy-card-label { font-size: 0.95em; color: #f0c040; margin-bottom: 0.3em; font-weight: bold; }
        .buy-card-supply { font-size: 0.82em; color: #aaa; margin-bottom: 0.6em; }
        .buy-btn {
          display: inline-block;
          background: linear-gradient(135deg, #f0c040, #00d4aa);
          color: black;
          font-weight: bold;
          font-size: 1.1rem;
          padding: 12px 28px;
          border-radius: 10px;
          border: none;
          cursor: pointer;
          letter-spacing: 0.04em;
          box-shadow: 0 0 16px #f0c04088;
          transition: box-shadow 0.2s, transform 0.1s;
          font-family: 'Courier New', monospace;
        }
        .buy-btn:hover:not(:disabled) { box-shadow: 0 0 28px #f0c040aa; transform: translateY(-2px); }
        .buy-btn:disabled { opacity: 0.7; cursor: not-allowed; }
        #buy-status { font-size: 0.82em; color: #aaa; margin-top: 0.8em; min-height: 1.2em; overflow-wrap: break-word; }
        .escrow-note { font-size: 0.78em; color: #888; margin-top: 0.6em; }
        .escrow-note a { color: #f0c040; }
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
          border: 1px solid #f0c04055;
          border-radius: 12px;
          padding: 1em;
          background: #281e00;
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
          <button class="close-btn" id="close-about">Close</button>
          <h2>🎸 About ${appName} 🎸</h2>

          <div class="about-section">
            <p><strong>${appName}</strong> is a Web3 digital town square where musicians mint their audio busks directly to the Optimism blockchain as Decent NFTs.</p>
            <p>Each busk minted here is a live, on-chain audio NFT — visible in the asteroid field the moment it's minted, playable by anyone, and purchasable trustlessly via the DecentEscrow contract.</p>
            <p>Built on <strong>Optimism Mainnet</strong>, powered by <strong>IPFS / Web3.Storage</strong>, and integrated with <strong>MetaMask</strong> for seamless wallet connectivity.</p>
          </div>

          <div class="buy-section">
            <h3>🎟️ Own a DecentBusking Supporter DNFT</h3>
            <p style="font-size:0.88em;color:#ccc;margin-bottom:1em;">
              Early supporters receive a limited-edition v1.0.0 Supporter DNFT — a permanent on-chain badge recognizing your role in funding the open Web3 music commons.
            </p>
            <div class="buy-options">

              <!-- ── PayPal option ───────────────────────────────────────── -->
              <div class="buy-option-card paypal-option">
                <div class="buy-option-title">💳 Buy with PayPal</div>
                <div class="buy-option-price">$100 one-time payment</div>
                <p class="buy-option-desc">Enter your wallet address — admin will transfer your Supporter DNFT within 24 hours of verifying your payment.</p>
                <input
                  id="paypal-wallet-address"
                  type="text"
                  placeholder="0x… your receiving wallet address"
                  autocomplete="off"
                  spellcheck="false"
                />
                <div id="paypal-btn-container">
                  <button class="buy-btn paypal-launch-btn" id="paypal-launch-btn">
                    💳 Buy with PayPal — $100
                  </button>
                </div>
                <div id="paypal-status"></div>
              </div>

              <!-- ── Crypto option ───────────────────────────────────────── -->
              <div class="buy-option-card crypto-option">
                <div class="buy-option-title">🔗 Buy with Crypto</div>
                <div class="buy-option-price">On Optimism — instant &amp; trustless</div>
                <div id="buy-cards">⏳ Loading…</div>
                <div id="buy-status"></div>
                <p class="escrow-note">
                  Sold via <a href="https://optimistic.etherscan.io/address/${_ESCROW_ADDRESS}" target="_blank" rel="noopener">DecentEscrow on Optimism</a> — instant, trustless, on-chain.
                </p>
              </div>

            </div>
          </div>

          <div class="about-section">
            <h3>🔗 Key Links:</h3>
            <ul>
              ${github  ? `<li>🐙 <a href="${github}"  target="_blank" rel="noopener">GitHub — DecentBusking</a></li>` : ''}
              ${discord ? `<li>💬 <a href="${discord}" target="_blank" rel="noopener">Discord — Join the community</a></li>` : ''}
              <li>🛒 <a href="https://github.com/TheJollyLaMa/DecentMarket" target="_blank" rel="noopener">DecentMarket</a></li>
              <li>🦊 <a href="https://metamask.io/" target="_blank" rel="noopener">MetaMask</a></li>
            </ul>
          </div>

          <div class="about-section">
            <h3>✨ v1.0.0 Features:</h3>
            <ul>
              <li>🎵 Mint audio busks directly to Optimism as ERC-1155 Decent NFTs</li>
              <li>🚀 Live asteroid field — each busk spawns in the 3-D space the moment it's minted</li>
              <li>🎩 Tip buskers wallet-to-wallet with ETH</li>
              <li>🎟️ Supporter DNFTs available on DecentEscrow</li>
              <li>📡 IPFS audio &amp; metadata via Web3.Storage (W3Up)</li>
            </ul>
          </div>

          <div class="about-section">
            <p>Built with a ton of ❣️💗❣️ by</p>
            <p>⚕️ 🦚 ⚸ The Jolly LaMa 📜 &amp; 📜 The RoboSoul 🤖 🦚 ⚕️</p>
          </div>
        </div>
      </div>
    `;

    this.shadowRoot.getElementById('close-about').addEventListener('click', () => this.close());
    this.shadowRoot.getElementById('paypal-btn-container').addEventListener('click', (e) => {
      if (e.target.id === 'paypal-launch-btn') this._handlePayPalLaunch();
    });
  }
}
