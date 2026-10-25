# DecentBusking contracts (Base mainnet, chain 8453)

Every contract the site or worker asks a wallet to interact with. Legacy sources
were verified on Basescan and Sourcify (2026-10-14). DJuke v0.5 was deployed
2026-10-23; see its exact-source verification on Sourcify. Re-check
with `node scripts/verify-basescan.mjs` (needs only a free Etherscan V2 API key;
no private key).

| Contract | Address | Role | Source |
|---|---|---|---|
| ArtFi settlement router | `0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5` | Fund accounting: repo-dev, pinner, Top 10 funds and payroll payouts | `ArtFi_2.1.sol` (ArtFi repo) |
| DJuke v0.5 (live) | `0xf51D2F7892cF9D49e14DF4afDf227a59ee170A51` | USDC-only single/playlist purchases; standard Base network gas, no worker surcharge; 90/8/2 song settlement | `DecentMarket/contracts/DecentJukeBox_v0.5.sol` |
| DJuke sponsored playlist module | `0x093d2dbCcBA612d2B2aD9B620cA4d0A03D98fE11` | Immutable v0.5 module; $1 fee release per fourth delivery, unreleased-fee refunds | `DecentMarket/contracts/DJukeSponsoredPlaylistModule.sol` |
| DJuke v0.4 (retired, requests paused) | `0xBBCb7F7369978cbdc32C6719B1d24B07f3d55619` | Drained before v0.5 migration; historical receipts retain their original refund terms | `DecentMarket/contracts/DecentJukeBox_v0.4.sol` |
| DJuke v0.3 (retired) | `0x5d07489163feBCdB39C9F579CCC36dff5A067FF9` | Legacy song requests and listen purchases | `DecentJukeBox_v0.3.sol` (published on Basescan) |
| DeVert v0.2 (deployed, activation pending) | `0xc73c9623C6E8E9c43872b1883ae4A290F2BAdD6F` | USDC-only campaigns, platform-funded worker; unchanged 45/45/8/2 routing | `DecentMarket/contracts/DeVert_v0.2.sol` |
| DVert paid queue v0.2 (replacement, activation pending) | `0x3A771295af7F15B68c53251683916b65440eD8d3` | Two-tier priority for v0.2 campaigns | `DecentMarket/contracts/DeVertQueue_v0.2.sol` |
| DeVert v0.1 (retired, paused) | `0x135Cbc573F87637158eb3186C87c584fb0B34CD9` | Historical campaign purchases (45/45/8/2); original ETH contribution retained in old receipts | `DecentMarket/contracts/DeVert_v0.1.sol` |
| DVert paid queue v0.2 (legacy, paused) | `0xe54609f022A8D760417E7cc0Eea6360b6E1D11Bb` | Drained prior to campaign-contract replacement; retain historical receipts | `DecentMarket/contracts/DeVertQueue_v0.2.sol` |
| DecentNFT v0.3 | `0x64D5aDc50E5513975EfF7e9ba366B7eE58586fa3` | Song DNFT collection | `DecentMarket/contracts/DecentNFT_v0.3.sol` |
| DecentNFT v0.2 | `0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B` | Legacy song DNFT collection | `DecentMarket/contracts/DecentNFT_v0.2.sol` |
| LivePerformanceEscrow | `0x20C08F2e877389D68cFbcF49664211E8CE9554Ec` | Per-booking Friday Live escrow (Phase 1); no admin withdrawal, performer claim / funder refund only. Deployed 2026-10-22, block 52942855, Sourcify exact match | `DecentMarket/contracts/LivePerformanceEscrow.sol` |
| DecentEscrow v0.1 | `0x31b07b83e99A9bdF379bf40225b8A80d3804C89d` | Supporter DNFT sales (no listings yet) | `DecentMarket/contracts/DecentEscrow_v001.sol` |
| DJuke v0.2 (retired) | `0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59` | Superseded by v0.3 | `DecentMarket/contracts/DecentJukeBox_v0.2.sol` |
| BNUT | `0x25ACb773159Af5a5c672DEfe31C7Fff6a9A93736` | Governance and bounty token | `BigNuten.sol` |
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Payment token | Circle |

Explorers: `https://basescan.org/address/<address>#code` and
`https://repo.sourcify.dev/8453/<address>`.

## Approvals

The replacement campaign and queue were deployed at Base blocks 53048694 and
53048696 and verified as exact creation/runtime matches on Sourcify on
2026-10-25 UTC. Basescan's automatic source submission hit its daily limit;
Sourcify verification is confirmed independently. Activation remains gated on the
Render configuration and scheduler readiness. See [the cutover sequence](DVERT-PAID-QUEUE.md).

The site only requests exact-amount USDC approvals for the router, DJuke or
DeVert, never unlimited ones. The owner and worker wallets are
`0x807061DF657A7697c04045dA7d16D941861cAABc` (admin) and
`0x4894698f2B5cAF13Fad4Aa8fbaFE3618b960909F` (fulfiller/scheduler).

The Optimism DecentEscrow `0x23A457AD3C33d68E4fAd2FCa7c5d9a511E0C350e` has no
code on Base and is blocked as a payroll recipient.
