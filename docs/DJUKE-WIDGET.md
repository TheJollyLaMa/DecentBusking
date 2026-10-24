# DJuke widget (S12)

The independently mountable paid jukebox is `js/djuke-widget.mjs`, demonstrated at
[`widget-djuke.html`](../widget-djuke.html). It is not an iframe or a link to the
full application. The cloneable product lives in
[A-Decent-Agency/DecentJukebox](https://github.com/A-Decent-Agency/DecentJukebox).
Display identity: **DJuke.decentagency.eth**; normalized ENS/DNS:
`djuke.decentagency.eth`.

```js
import { mount } from './js/djuke-widget.mjs';
const jukebox = mount(document.querySelector('#music'), {
  ethers, // ethers v6, supplied once by the host
  title: 'My community DJuke',
  config: {
    ipfsUploadServiceUrl: 'https://decentbusking.onrender.com',
    djukeContractAddress: '0xf51D2F7892cF9D49e14DF4afDf227a59ee170A51',
    djukeContractVersion: '0.5',
    djukePlaylistBatchAddress: '0xf51D2F7892cF9D49e14DF4afDf227a59ee170A51',
    djukePlaylistBatchVersion: '0.5',
    djukePlaylistBatchEnabled: true,
    djukePlaylistRadioReady: true
  }
});
// SPA route disposal:
jukebox.destroy(); // idempotent; can mount on the element again
```

The host installs one DecentHead v2 header. DJuke waits for `decenthead:ready`,
reads `getWallet().snapshot()` and uses its existing ethers BrowserProvider only
inside a user-initiated checkout/save/resume. It subscribes to `head.on('wallet')`
and unsubscribes at teardown. It never calls `connect`, `eth_requestAccounts`,
`ensureChain`, or a second login. Connect/switch to Base in the host header first.
`getIpfs()` is the same host session; DJuke does not request credentials, upload,
backup, or pin. Paid media resolution uses `options.ipfsGateway` (HTTPS, default
`https://ipfs.io/ipfs/`); this does not imply durable pinning. Optional `head`,
`fetch`, `storage` and `ethers` injection make native tests deterministic.

## Customization without removing principal controls

Shadow DOM isolates styles. Set inherited `--djuke-background`, `--djuke-text`,
`--djuke-accent`, `--djuke-control`, `--djuke-font`, `--djuke-radius` and
`--djuke-width` CSS variables on the mount element. The title is plain text.
Reduced-motion preferences disable motion. Keep accessible labels, visible
focus, the native audio player, pricing, artists/funds split, purchase status,
single replacement, ordered drafts, Save/Personal Play/Play Live and profile
receipts/recovery intact. Theme changes must not conceal payment disclosures.

## Platform dependencies and compatibility

Cloning static code does **not** deploy the paid platform. Production reads and
signed checkout quotes still use DecentBusking's existing worker; settlement,
durable journal/mirror, retries, EOF/PCM per-resource evidence (#274), milestone
fees, partial refunds and service funding remain there. This work does not alter
worker or contract logic. The host origin must be explicitly allowed by the
worker's CORS and signed profile authorization policy before saving playlists.
Missing/offline/mismatched config disables checkout with an explicit error.
This product requires the configured **v0.5 USDC-only** deployment. The legacy
platform drawer retains its v0.2–v0.5 behavior.

`djuke-payment.mjs` and `djuke-checkout.mjs` are shared by the existing platform
UI and widget. Existing celebration wrappers remain platform-only; importing the
widget never initializes the platform drawer or radio. The named-playlist client
accepts `getServiceUrl` without changing its platform default. Receipt records
stay under Profile → Playlists, not the public drawer. Private purchases save
transaction recovery before waiting for confirmation; storage must work first.
Resume verifies that purchase on Base and never buys again.

Support reports: include browser/version, configured public service and contract,
error text, transaction hash and affected playlist/lane. Never send keys, JWTs or
wallet recovery phrases. Use the product issue tracker; paid service incidents
also belong in DecentBusking. Fund dependencies: 90% artists/collaborators, 8%
pinning, 2% development on single-song payments; playlist fees and settlement use
the existing contract. Supporter editions fund maintenance and are not yield,
ownership of music, a service SLA or a guarantee that third-party gateways last.

## Verification and unsigned S11 release

Run native Node tests explicitly (`node --test test/djuke-widget.test.js` plus
DJuke/playlist/audio evidence suites); generic test discovery historically found
none. Fixtures are synthetic and never sign or send transactions. Demo browsing
may read public platform APIs but must not connect a wallet during validation.

The product prepares an **unminted, unreleased draft**, not a token/listing:
1,000 ERC-1155 supporter editions × 10 USDC on Base; 1,000 bps royalty. Before a
separately authorized release, freeze a reviewed tag/commit, verify deterministic
source and archive, capture a genuine rendered screenshot and its provenance,
verify artwork license/attribution, fill final metadata/release notes/license/
repo/tag/commit/archive CID and royalty recipient, check no duplicate mint or
registration, review fees and fund recipients, then obtain steward review and
explicit wallet signatures. Tagging, releasing, IPFS pinning, minting,
registering, transferring, listing and announcing are **not authorized here**.
Never invent token IDs, transaction hashes, screenshot claims or archive CIDs.
