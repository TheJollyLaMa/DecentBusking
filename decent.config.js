// decent.config.js
// DecentBusking — Global Application Configuration
//
// This file is loaded as a plain <script> (no ES modules) so it is available
// synchronously via window.DecentConfig before any module scripts run.
//
// Fields:
//   appName        — Display name shown in DecentHead
//   subtitle       — Subtitle beneath the app name
//   chainId        — EVM chain ID (10 = Optimism Mainnet)
//   contractAddress— DecentNFT contract address (deployed via DecentMarket on Optimism)
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
  appName: "Decent Busking",
  subtitle: "🎸 The Web3 Digital Town Square",

  // Chain — Optimism Mainnet
  chainId: 10,
  rpcUrl: "https://mainnet.optimism.io",

  // DecentNFT contract deployed on Optimism via DecentMarket
  contractAddress: "0xe870f7b1D10C41dbc6b75598a5308B9a2Bb52958",

  // IPFS / w3up
  w3upSpaceDID: "did:key:z6MktU4rpHu5Z4nXjXufa4uivwBLN1DcK4r2xfGhizr4bndB",
  ipfsGateway: "https://w3s.link/ipfs/",

  // Currency
  tokenSymbol: "ETH",

  // Optional — right-ankh Uniswap link
  uniswapUrl: "",                                    // TODO: add Uniswap pool URL if desired
  tokenAddress: "",                                  // TODO: add ERC-20 tip token address if desired

  // Community links
  discord: "https://discord.gg/5XJtJYdhz",
  github: "https://github.com/TheJollyLaMa/DecentBusking",
};
