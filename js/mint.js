// js/mint.js — DecentBusking
// Handles minting an audio file as a DecentNFT on Optimism via the contract
// already deployed by DecentMarket.
//
// Flow:
//  1. User opens guitar-case modal, fills in title + audio file.
//  2. Audio file is uploaded to IPFS via w3up.
//  3. A JSON metadata blob is created and uploaded to IPFS.
//  4. mint(metadataURI, parentTokenId) is called on the DecentNFT contract.
//  5. On success the new NFT is injected into the space field.

import { addNFTToSpace } from './space.js';

// Minimal DecentNFT ABI — only what we need for minting
const DECENT_NFT_ABI = [
  // Standard ERC-721 mint with tokenURI
  'function mint(string memory tokenURI) external returns (uint256)',
  // Extended: mint with parent reference for royalty chain
  'function mintWithParent(string memory tokenURI, uint256 parentTokenId) external returns (uint256)',
  // Read total supply so we can determine new tokenId optimistically
  'function totalSupply() view returns (uint256)',
  // Events
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

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

    // 5. Mint on-chain
    _setStatus('⏳ Minting NFT — confirm in MetaMask…');
    const contract = new ethers.Contract(cfg.contractAddress, DECENT_NFT_ABI, signer);

    let tx;
    if (parentId > 0) {
      tx = await contract.mintWithParent(metadataUrl, parentId);
    } else {
      tx = await contract.mint(metadataUrl);
    }

    _setStatus('⏳ Waiting for confirmation…');
    const receipt = await tx.wait();

    // Parse tokenId from Transfer event
    const iface = new ethers.Interface(DECENT_NFT_ABI);
    let tokenId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === 'Transfer') {
          tokenId = Number(parsed.args.tokenId);
          break;
        }
      } catch (_) {}
    }

    _setStatus(`✅ Minted! Token #${tokenId ?? '?'} is now live in the town square. 🎵`);

    // 6. Inject into space field
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
