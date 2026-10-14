# DecentBusking contracts (Base mainnet, chain 8453)

Every contract the site or worker asks a wallet to interact with. All sources are
published and match the deployed bytecode exactly. All are verified on Basescan and Sourcify (2026-10-14). Re-check
with `node scripts/verify-basescan.mjs` (needs only a free Etherscan V2 API key;
no private key).

| Contract | Address | Role | Source |
|---|---|---|---|
| ArtFi settlement router | `0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5` | Fund accounting: repo-dev, pinner, Top 10 funds and payroll payouts | `ArtFi_2.1.sol` (ArtFi repo) |
| DJuke v0.3 (live) | `0x5d07489163feBCdB39C9F579CCC36dff5A067FF9` | Paid song requests and listen purchases (90% artist, 8% pinners, 2% repo-dev) | `DecentJukeBox_v0.3.sol` (published on Basescan; not yet in DecentMarket repo) |
| DeVert v0.1 | `0x135Cbc573F87637158eb3186C87c584fb0B34CD9` | Advert campaign purchases (45/45/8/2) | `DecentMarket/contracts/DeVert_v0.1.sol` |
| DecentNFT v0.3 | `0x64D5aDc50E5513975EfF7e9ba366B7eE58586fa3` | Song DNFT collection | `DecentMarket/contracts/DecentNFT_v0.3.sol` |
| DecentNFT v0.2 | `0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B` | Legacy song DNFT collection | `DecentMarket/contracts/DecentNFT_v0.2.sol` |
| DecentEscrow v0.1 | `0x31b07b83e99A9bdF379bf40225b8A80d3804C89d` | Supporter DNFT sales (no listings yet) | `DecentMarket/contracts/DecentEscrow_v001.sol` |
| DJuke v0.2 (retired) | `0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59` | Superseded by v0.3 | `DecentMarket/contracts/DecentJukeBox_v0.2.sol` |
| BNUT | `0x25ACb773159Af5a5c672DEfe31C7Fff6a9A93736` | Governance and bounty token | `BigNuten.sol` |
| USDC (Circle) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Payment token | Circle |

Explorers: `https://basescan.org/address/<address>#code` and
`https://repo.sourcify.dev/8453/<address>`.

## Approvals

The site only requests exact-amount USDC approvals for the router, DJuke or
DeVert, never unlimited ones. The owner and worker wallets are
`0x807061DF657A7697c04045dA7d16D941861cAABc` (admin) and
`0x4894698f2B5cAF13Fad4Aa8fbaFE3618b960909F` (fulfiller/scheduler).

The Optimism DecentEscrow `0x23A457AD3C33d68E4fAd2FCa7c5d9a511E0C350e` has no
code on Base and is blocked as a payroll recipient.
