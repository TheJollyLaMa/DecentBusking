// decent.config.js
// DecentBusking — Global Application Configuration
//
// This file is loaded as a plain <script> (no ES modules) so it is available
// synchronously via window.DecentConfig before any module scripts run.
//
// Fields:
//   appName        — Display name shown in the app header
//   subtitle       — Subtitle beneath the app name
//   chainId        — EVM chain ID (8453 = Base Mainnet)
//   contractAddress— DecentNFT contract address deployed via DecentMarket
//   ipfsUploadProvider — "pinata" in production or "local" for IPFS Desktop
//   ipfsUploadServiceUrl — Render worker URL; approval links can override it
//   ipfsApiUrl     — local Kubo API URL used when provider is "local"
//   ipfsGateway    — IPFS HTTP gateway for playback and image display
//   tokenSymbol    — Native currency symbol used for tips
//   uniswapUrl     — (optional) Uniswap link shown in the right-ankh dropdown
//   tokenAddress   — (optional) ERC-20 token address for tips / right-ankh balance
//   discord        — Discord invite link (shown in the footer)
//   github         — GitHub repo URL (shown in the footer)

// The header web component reads window.DECENT_CONFIG; alias both names.
window.DECENT_CONFIG =
window.DecentConfig = {
  appName: "Decent Busking",
  subtitle: "🎙️⚸ ♀︎🎸 The Web3 Digital Town Square 🔊 🎶 🎶 🎶",

  // Chain — Base Mainnet
  chainId: 8453,
  chainName: "Base Mainnet",
  rpcUrl: "https://mainnet.base.org",
  blockExplorerUrl: "https://basescan.org",

  // v0.3 receives new batch mints; keep v0.2 in the archive and reconciliation scan.
  contractAddress: "0x64D5aDc50E5513975EfF7e9ba366B7eE58586fa3",
  additionalNftContractAddresses: ["0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B"],
  nftBatchMintEnabled: true,
  // Deployed DJuke v0.2 address.
  djukeContractAddress: "0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59",
  djukeContractVersion: "0.2",
  ensRpcUrl: "https://ethereum-rpc.publicnode.com",
  adminWalletAddress: "0x807061DF657A7697c04045dA7d16D941861cAABc",
  marketUrl: "https://thejollylama.github.io/DecentMarket/",

  // IPFS uploads. This public URL never contains the server-side Pinata JWT.
  ipfsUploadProvider: "pinata",
  ipfsUploadServiceUrl: "https://decentbusking.onrender.com",
  ipfsApiUrl: "http://127.0.0.1:5001",
  ipfsGateway: "https://gateway.pinata.cloud/ipfs/",

  // Currency
  tokenSymbol: "ETH",

  // Optional — right-ankh Uniswap link
  uniswapUrl: "",                                    // TODO: add Uniswap pool URL if desired
  tokenAddress: "",                                  // TODO: add ERC-20 tip token address if desired

  // Community links
  discord: "https://discord.gg/SCtcBggHPa",
  github: "https://github.com/TheJollyLaMa/DecentBusking",
};
