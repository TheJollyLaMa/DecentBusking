// decent.config.js
// DecentBusking — Global Application Configuration
//
// This file is loaded as a plain <script> (no ES modules) so it is available
// synchronously via window.DecentConfig before any module scripts run.
//
// Fields:
//   appName        — Display name shown in DecentHead
//   subtitle       — Subtitle beneath the app name
//   chainId        — EVM chain ID (137 = Polygon Mainnet, 80002 = Polygon Amoy testnet)
//   contractAddress— DecentNFT contract address (already deployed in DecentMarket)
//   w3upSpaceDID   — w3up IPFS space DID for audio file uploads
//   ipfsGateway    — IPFS HTTP gateway for playback and image display
//   tokenSymbol    — Native currency symbol used for tips
//   uniswapUrl     — (optional) Uniswap link shown in the right-ankh dropdown
//   tokenAddress   — (optional) ERC-20 token address for tips / right-ankh balance
//   discord        — Discord invite link (shown in DecentFoot)
//   github         — GitHub repo URL (shown in DecentFoot)

// DecentHead web component reads window.DECENT_CONFIG; alias both names.
window.DECENT_CONFIG =
window.DecentConfig = {
  appName: "DecentBusking",
  subtitle: "🎸 The Web3 Digital Town Square",

  // Chain — Polygon Mainnet
  chainId: 137,                                      // TODO: change to 80002 for Amoy testnet during dev

  // DecentNFT contract already deployed via DecentMarket
  contractAddress: "0x0000000000000000000000000000000000000000", // TODO: replace with DecentNFT contract address

  // IPFS / w3up
  w3upSpaceDID: "did:key:placeholder",               // TODO: replace with your w3up space DID
  ipfsGateway: "https://w3s.link/ipfs/",

  // Currency
  tokenSymbol: "MATIC",

  // Optional — right-ankh Uniswap link
  uniswapUrl: "",                                    // TODO: add Uniswap pool URL if desired
  tokenAddress: "",                                  // TODO: add ERC-20 tip token address if desired

  // Community links
  discord: "https://discord.gg/decentbusking",       // TODO: replace with actual Discord invite
  github: "https://github.com/TheJollyLaMa/DecentBusking",
};
