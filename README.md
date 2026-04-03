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
│       ├── bounty-bot.yml      ← Auto-announces & queues $BNUT payouts
│       ├── bounty-audit.yml    ← Weekly scan for missed close tags
│       ├── bounty-label.yml    ← Label issues with bounty amounts
│       ├── bounty-payout.yml   ← Manual payout queue
│       └── idea-label.yml      ← Credit community ideas (20/80 split)
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

This repo uses the same `$BNUT` bounty bot as [BigNuten_Vanilla](https://github.com/TheJollyLaMa/BigNuten_Vanilla).

- **Maintainer** labels issues with `bounty: N BNUT` via the **Bounty Label** workflow.
- **Contributors** claim by commenting, getting assigned, and opening a PR with `Closes #N`.
- On merge the bot auto-queues the payout in `payroll-queue.json`.
- **Maintainer** settles weekly via MetaMask in the BigNuten Payroll panel.

To register as a contributor, contact `@TheJollyLaMa` directly.

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
