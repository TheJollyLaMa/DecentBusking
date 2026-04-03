// js/mint.js — DecentBusking
// Handles minting an audio file as a DecentNFT on Optimism via the contract
// already deployed by DecentMarket (DecentNFT_v0.2, ERC-1155).
//
// Contract access model
// ─────────────────────
//   DEFAULT_ADMIN_ROLE  Can call registerToken() to create a new token ID and
//                       can call mintProduct() to issue editions.
//   MINTER_ROLE         Can call mintAchievement() to issue editions of a token
//                       ID that has already been registered by an admin.
//
// Busk minting flow (requires DEFAULT_ADMIN_ROLE on the contract)
// ──────────────────────────────────────────────────────────────
//  1. User opens guitar-case modal, fills in title + audio file.
//  2. Audio file is uploaded to IPFS via w3up.
//  3. A JSON metadata blob is created and uploaded to IPFS.
//  4. registerToken(0, metadataURI, Achievement, artist, 500) is called →
//     returns a new tokenId.
//  5. mintAchievement(artist, tokenId, 1) mints the single edition.
//  6. On success the new NFT is injected into the space field.
//
// If the connected wallet lacks DEFAULT_ADMIN_ROLE a clear error is shown
// and no transaction is sent.

import { addNFTToSpace } from './space.js';

// DecentNFT v0.2 ABI — ERC-1155 with role-based minting
// Source: https://github.com/TheJollyLaMa/DecentMarket/blob/main/abis/DecentNFT_v0.2.json
const DECENT_NFT_ABI = [
  // ── Role helpers ──────────────────────────────────────────────────────────
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',

  // ── Token registration — DEFAULT_ADMIN_ROLE only ─────────────────────────
  // kind_: 0 = Product, 1 = Achievement
  'function registerToken(uint256 maxSupply_, string calldata tokenURI_, uint8 kind_, address royaltyReceiver, uint96 royaltyFeeBps) external returns (uint256 tokenId)',

  // ── Minting ───────────────────────────────────────────────────────────────
  // Achievement editions — MINTER_ROLE (also usable by DEFAULT_ADMIN_ROLE)
  'function mintAchievement(address to, uint256 tokenId, uint256 amount) external',
  // Product editions — DEFAULT_ADMIN_ROLE only
  'function mintProduct(address to, uint256 tokenId, uint256 amount) external',

  // ── Read helpers ──────────────────────────────────────────────────────────
  'function nextTokenId() view returns (uint256)',
  'function uri(uint256 tokenId) view returns (string)',
  'function creatorOf(uint256 tokenId) view returns (address)',
  'function totalMinted(uint256 tokenId) view returns (uint256)',

  // ── Events ────────────────────────────────────────────────────────────────
  'event TokenRegistered(uint256 indexed tokenId, address indexed creator, uint256 maxSupply, uint8 kind, string uri)',
  'event EditionMinted(uint256 indexed tokenId, address indexed to, uint256 amount, address indexed minter)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
];

// ── Mint constants ────────────────────────────────────────────────────────────
const UNLIMITED_SUPPLY      = 0;   // maxSupply 0 = no edition cap
const TOKEN_KIND_ACHIEVEMENT = 1;  // TokenKind enum: 0 = Product, 1 = Achievement
const DEFAULT_ROYALTY_BPS   = 500; // 5 % secondary-sale royalty

// ── Public API ───────────────────────────────────────────────────────────
export function openMintModal() {
  const modal = document.getElementById('mint-modal');
  if (!modal) return;
  _resetForm();
  modal.classList.remove('hidden');
}

// ── DOM Wiring ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('mint-form');
  const cancelBtn = document.getElementById('mint-cancel-btn');
  const modal = document.getElementById('mint-modal');

  if (form) form.addEventListener('submit', _handleMint);

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => modal?.classList.add('hidden'));
  }

  // Close on backdrop click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }
});

// ── Mint Handler ─────────────────────────────────────────────────────────
async function _handleMint(e) {
  e.preventDefault();

  const cfg = window.DecentConfig || {};
  const titleInput = document.getElementById('mint-title');
  const fileInput = document.getElementById('mint-file');
  const parentInput = document.getElementById('mint-parent');
  const tipInput = document.getElementById('mint-tip-wallet');
  const submitBtn = document.getElementById('mint-submit-btn');

  const title = titleInput?.value.trim();
  const file = fileInput?.files?.[0];
  const parentId = parseInt(parentInput?.value || '0') || 0;
  const tipWallet = tipInput?.value.trim() || '';

  if (!title) {
    _setStatus('⚠️ Please enter a track title.', true);
    return;
  }
  if (!file) {
    _setStatus('⚠️ Please select an audio file.', true);
    return;
  }

  if (!window.ethereum) {
    _setStatus('🦊 MetaMask not detected. Install it to mint.', true);
    return;
  }

  if (!cfg.contractAddress || cfg.contractAddress === '0x0000000000000000000000000000000000000000') {
    _setStatus('⚠️ Contract address not configured in decent.config.js.', true);
    return;
  }

  submitBtn.disabled = true;

  try {
    // 1. Connect wallet
    _setStatus('⏳ Connecting wallet…');
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    const signer = await provider.getSigner();
    const address = await signer.getAddress();

    // 2. Check chain
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== (cfg.chainId || 10)) {
      _setStatus(`⚠️ Switch MetaMask to chain ID ${cfg.chainId || 10} (Optimism).`, true);
      submitBtn.disabled = false;
      return;
    }

    // 3. Upload audio to IPFS
    _setStatus('⏳ Uploading audio to IPFS…');
    const audioUrl = await _uploadToIPFS(file);
    if (!audioUrl) {
      _setStatus('❌ IPFS upload failed. Check your w3up connection.', true);
      submitBtn.disabled = false;
      return;
    }

    // 4. Build + upload metadata
    _setStatus('⏳ Uploading metadata to IPFS…');
    const metadata = {
      name: title,
      description: `Busked live on DecentBusking — ${new Date().toLocaleDateString()}`,
      animation_url: audioUrl,      // ERC-721 standard for audio/video NFTs
      audioUrl,                     // convenience duplicate
      artist: address,
      creator: address,
      tipWallet: tipWallet || address,
      mintedAt: new Date().toISOString(),
      ...(parentId > 0 ? { parentTokenId: parentId } : {}),
    };
    const metadataUrl = await _uploadMetadataToIPFS(metadata, `${_slugify(title)}.json`);
    if (!metadataUrl) {
      _setStatus('❌ Metadata upload failed.', true);
      submitBtn.disabled = false;
      return;
    }

    // 5. Role pre-flight check
    _setStatus('⏳ Checking on-chain permissions…');
    const contract = new ethers.Contract(cfg.contractAddress, DECENT_NFT_ABI, signer);

    const adminRole  = await contract.DEFAULT_ADMIN_ROLE();
    const minterRole = await contract.MINTER_ROLE();
    const isAdmin    = await contract.hasRole(adminRole,  address);
    const isMinter   = await contract.hasRole(minterRole, address);

    if (!isAdmin && !isMinter) {
      _setStatus(
        '❌ Your wallet lacks minting permission. ' +
        'The contract admin must grant your address MINTER_ROLE (or DEFAULT_ADMIN_ROLE) ' +
        'via the contract's grantRole() function before you can mint.',
        true,
      );
      submitBtn.disabled = false;
      return;
    }

    if (!isAdmin) {
      // MINTER_ROLE alone cannot register new token IDs — registration is admin-only.
      _setStatus(
        '❌ Your wallet has MINTER_ROLE but token registration requires DEFAULT_ADMIN_ROLE. ' +
        'Ask the contract admin to register a token ID for you first.',
        true,
      );
      submitBtn.disabled = false;
      return;
    }

    // 6. Register a new token on-chain (admin-only step that returns the tokenId)
    _setStatus('⏳ Registering token — confirm in MetaMask… (tx 1/2)');
    // TokenKind.Achievement = 1 — allows future MINTER_ROLE wallets to mint editions.
    // maxSupply 0 = unlimited; royalty 5 % to the artist's wallet.
    const regTx = await contract.registerToken(
      UNLIMITED_SUPPLY,       // maxSupply: 0 = unlimited
      metadataUrl,            // per-token URI — the IPFS metadata JSON
      TOKEN_KIND_ACHIEVEMENT, // kind: 1 = Achievement
      address,                // royaltyReceiver: the minting artist
      DEFAULT_ROYALTY_BPS,    // royaltyFeeBps: 5 %
    );

    _setStatus('⏳ Waiting for registration confirmation… (tx 1/2)');
    const regReceipt = await regTx.wait();

    const iface = new ethers.Interface(DECENT_NFT_ABI);
    let tokenId = null;
    for (const log of regReceipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'TokenRegistered') {
          tokenId = Number(parsed.args.tokenId);
          break;
        }
      } catch (_) {}
    }

    if (tokenId === null) {
      _setStatus('❌ Token registration failed — could not parse TokenRegistered event.', true);
      submitBtn.disabled = false;
      return;
    }

    // 7. Mint a single edition of the newly-registered token to the artist's wallet
    _setStatus(`⏳ Minting edition of token #${tokenId} — confirm in MetaMask… (tx 2/2)`);
    const mintTx = await contract.mintAchievement(address, tokenId, 1);

    _setStatus('⏳ Waiting for mint confirmation… (tx 2/2)');
    await mintTx.wait();

    _setStatus(`✅ Minted! Token #${tokenId} is now live in the town square. 🎵`);

    // 8. Inject into space field
    addNFTToSpace({
      tokenId,
      name: title,
      artist: address,
      creator: address,
      audioUrl,
      tipWallet: tipWallet || address,
      metadataUri: metadataUrl,
      mintedAt: new Date().toISOString(),
      parentTokenId: parentId || undefined,
    });

    // Close modal after a moment
    setTimeout(() => {
      document.getElementById('mint-modal')?.classList.add('hidden');
      _resetForm();
      submitBtn.disabled = false;
    }, 3000);

  } catch (err) {
    _setStatus(`❌ ${err.message || 'Minting failed'}`, true);
    submitBtn.disabled = false;
  }
}

// ── IPFS Uploads ──────────────────────────────────────────────────────────
async function _uploadToIPFS(file) {
  // Use w3up client if available (loaded via CDN in index.html)
  if (window.w3up && window._w3upClient) {
    try {
      // uploadFile returns the CID of the file itself — no path suffix needed
      const cid = await window._w3upClient.uploadFile(file);
      return `ipfs://${cid}`;
    } catch (err) {
      console.error('[mint] w3up upload failed:', err);
      return null;
    }
  }

  console.warn('[mint] w3up client not ready. Connect IPFS via the header first.');
  return null;
}

async function _uploadMetadataToIPFS(metadata, filename) {
  const blob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });

  if (window.w3up && window._w3upClient) {
    try {
      const cid = await window._w3upClient.uploadFile(file);
      return `ipfs://${cid}`;
    } catch (err) {
      console.error('[mint] w3up metadata upload failed:', err);
      return null;
    }
  }

  console.warn('[mint] w3up client not ready for metadata upload.');
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _setStatus(msg, isError = false) {
  const el = document.getElementById('mint-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function _resetForm() {
  const form = document.getElementById('mint-form');
  if (form) form.reset();
  _setStatus('');
}

function _slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
