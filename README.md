# 🎸 DecentBusking
**The Web3 Digital Town Square** — mint audio NFTs, tip artists, fly through space

> Busk live. Mint your sound. Let it drift into the cosmos.

---

## What Is This?

DecentBusking is a decentralised audio busking platform on **Optimism**. Artists **mint audio NFTs** that appear at the centre of a 3-D space field the moment they're minted — playing live, right in the town square. As they age they drift further and further back into space. After a month they fade from view but can still be flown to and purchased.

Anyone who records a busker can **add a track on top**, referencing the original NFT. Royalties flow back through the chain automatically.

---

## Architecture

```
DecentBusking/
├── index.html              ← Main stage
├── decent.config.js        ← App identity, token, IPFS config
├── js/
│   ├── main.js             ← Boot: loads head, foot, stage, space
│   ├── stage.js            ← Hat + guitar case + tip flow
│   ├── space.js            ← Three.js NFT asteroid field
│   ├── mint.js             ← Minting audio → DecentNFT contract
│   ├── nft-card.js         ← NFT detail panel (mirrors DecentMarket)
│   ├── w3upClient.js       ← w3up/Storacha IPFS client (connect + auto-restore)
│   └── components/
│       ├── about-override.js         ← DecentBusking About Modal (Peacock 🦚)
│       ├── header-ipfs-inject.js     ← Injects 🔗 IPFS Connect into header dropdown
│       └── header-payroll-inject.js  ← Injects 💸 Payroll into header dropdown
├── css/
│   └── styles.css
├── img/
│   ├── hat.svg
│   └── guitar-case.svg
├── .github/
│   └── workflows/
│       ├── bounty-bot.yml      ← Queues merged and recovered ART payouts
│       ├── testing-bounty.yml  ← Handles tester completion and approval
│       └── settle-payroll.yml  ← Records external ART/legacy ETH settlement
├── bounty-bot-config.json
├── contributor-accounts.json
└── README.md
```

---

## The Stage

| UI Element | Action |
|---|---|
| 🎩 Hat button | Open tip modal — throw pocket change in the jar (MetaMask → ETH on Optimism) |
| 💼 Guitar Case button | Open mint modal — busk your audio onto the blockchain |
| NFT tile in space | Click to open details, listen, and buy |
| Tab key | Toggle orbit ↔ fly-through spaceship mode |
| WASD / Arrow keys | Navigate the space field in fly-through mode |

---

## Getting Started

### 1. Configure `decent.config.js`

Fill in the `TODO` fields:

```js
window.DecentConfig = {
  chainId: 10,                           // Optimism Mainnet
  rpcUrl: "https://mainnet.optimism.io", // Public Optimism RPC (no API key required)
  contractAddress: "0x...",              // DecentNFT contract from DecentMarket
  w3upSpaceDID: "did:key:...",           // w3up IPFS space DID
  ipfsGateway: "https://w3s.link/ipfs/",
  tokenSymbol: "ETH",
  discord: "https://discord.gg/...",
  github: "https://github.com/TheJollyLaMa/DecentBusking",
};
```

### 2. Serve Locally

Any static file server works:

```bash
npx serve .
# or
python3 -m http.server 8080
```

### 3. Deploy

Push to `main` — GitHub Pages serves the site automatically.

---

## Bounty System

DecentBusking records new contributor rewards in ART through local Node automation.

- **Maintainer** labels issues with exactly `bounty: N ART` or `bounty: N $ART`.
- **Contributors** claim by commenting, getting assigned, and opening a PR with `Closes #N`.
- On merge the bot adds a currency-tagged ART entry to `payroll-queue.json`.
- **Maintainer** pays ART externally and records settlement with the workflow.
- Historical currency-less queue entries remain legacy ETH and can still use the existing MetaMask panel.
- ART entries are visible in that panel but guarded as ledger-only; they are never sent as ETH.

Use the Contributor Request issue form to register without an interview or biography. See [docs/PAYROLL.md](docs/PAYROLL.md) for labels, testing rewards, recovery, and settlement.

---

## Minting Access Model

DecentBusking uses **[DecentNFT v0.2](https://github.com/TheJollyLaMa/DecentMarket/blob/main/contracts/DecentNFT_v0.2.sol)** — an ERC-1155 contract with role-based minting on Optimism.

### Roles

| Role | Who | Capabilities |
|------|-----|--------------|
| `DEFAULT_ADMIN_ROLE` | Contract deployer / Decent Agency admin | Register new token IDs (`registerToken`), mint Product editions (`mintProduct`), manage all roles |
| `MINTER_ROLE` | Authorised dapp / artist wallets | Mint Achievement editions (`mintAchievement`) for pre-registered token IDs |

### Busk Minting Flow

Minting a new audio busk requires **two on-chain transactions** and `DEFAULT_ADMIN_ROLE`:

1. **`registerToken(0, metadataURI, Achievement, artistWallet, 500)`** — creates a unique token ID on-chain, stores the IPFS metadata URI, and sets the artist as the ERC-2981 royalty receiver (5 %).
2. **`mintAchievement(artistWallet, tokenId, 1)`** — issues the single edition to the artist's wallet.

### Granting Minting Access to Artists

An artist's wallet must hold `DEFAULT_ADMIN_ROLE` to self-register new token IDs (required for the full busk flow). To grant access via [Remix](https://remix.ethereum.org) or the [block explorer write tab](https://optimistic.etherscan.io/address/0xe870f7b1D10C41dbc6b75598a5308B9a2Bb52958#writeContract):

```solidity
// Connect the deployer/admin wallet, then call:
// 1. Get the role hash (or use the hex value directly)
bytes32 adminRole = DEFAULT_ADMIN_ROLE(); // 0x0000...0000
// 2. Grant the role to the artist's wallet
grantRole(adminRole, <artistWalletAddress>)
```

> ⚠️ Granting `DEFAULT_ADMIN_ROLE` gives full contract control. For a least-privilege setup, have the platform admin run the two-step registration + mint on behalf of artists, or explore a future contract upgrade that allows public token registration.

### Why the Old `mint(string)` Call Failed

The contract does **not** expose a `mint(string tokenURI)` function. Calling it caused an immediate revert because no matching function selector exists on the ERC-1155 contract. The correct call sequence is `registerToken` → `mintAchievement` (or `mintProduct`).

---

## NFT Royalty Chain

```
Original busk (Token #1)
  └── Cover/remix (Token #2, parentTokenId: 1)
        └── Another layer (Token #3, parentTokenId: 2)
```

Each token references its parent. Royalty distribution is handled by the DecentNFT contract already deployed via DecentMarket.

---

## Links

- 💬 Discord: https://discord.gg/5XJtJYdhz
- 🐙 GitHub: https://github.com/TheJollyLaMa/DecentBusking
- 🛒 DecentMarket: https://github.com/TheJollyLaMa/DecentMarket
- 🔗 Optimism Explorer: https://optimistic.etherscan.io

---

## Developer Notes

### RPC / CORS

`js/space.js` loads all minted NFTs on start-up using a read-only `ethers.JsonRpcProvider`.
The provider URL is read from `window.DecentConfig.rpcUrl`, falling back to the **public Optimism RPC** (`https://mainnet.optimism.io`).

> ⚠️ **Do NOT use a Polygon or Alchemy "demo" key** here.  The contract is deployed on Optimism,
> not Polygon.  Using the wrong chain causes a CORS error because `polygon-mainnet.g.alchemy.com`
> rejects cross-origin requests from browser frontends without a valid paid API key.

If you need a private/high-throughput RPC, set `rpcUrl` in `decent.config.js` to your own
Alchemy/Infura/QuickNode Optimism endpoint.

### IPFS / w3up Connection

Minting audio to IPFS is handled by the [Storacha / web3.storage w3up client](https://web3.storage).
The browser bundle is loaded via CDN in `index.html` and exposes `window.w3up`.

The connection flow is wired through three files:

| File | Role |
|---|---|
| `js/w3upClient.js` | `connectW3upClient()` (email login) + `tryAutoRestoreW3upClient()` (silent restore) |
| `js/components/header-ipfs-inject.js` | Injects **🔗 Connect IPFS** into the left-ankh dropdown; calls the above on click |
| `index.html` line 17 | Loads the w3up browser bundle from IPFS |

On first visit a user must click **☥ → 🔗 Connect IPFS** and enter their web3.storage email.
On subsequent visits the session is restored silently from local IndexedDB.

`window._w3upClient` and `window._w3upSpaceDid` are set on successful connection and are
read by `js/mint.js` during the upload steps.
