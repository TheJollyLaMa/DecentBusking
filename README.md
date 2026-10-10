# DecentBusking

**Drop a track. Join the loop. Mint it when you’re ready.**

DecentBusking is a community listening room, a 3D timeline of music NFTs, and a Discord radio built around the people who make the music. Listen, explore the archive, tip a performer, or bring a track into JukeLoop.

Read the [Decent Busking whitepaper](WHITEPAPER.md) for the vision, current architecture, payment mechanics, artist-rights limits, and roadmap. Implemented features are separated from future plans.

<p align="center">
  <a href="https://thejollylama.github.io/DecentBusking/"><img src="img/DBusker_in_Town_Square.jpeg" width="100%" alt="A DecentBusker performing in the town square" /></a>
</p>

## Come Listen

Open the [DecentBusking town square](https://thejollylama.github.io/DecentBusking/) and explore the 3D music timeline. Select a track in the archive to listen, inspect its NFT details, and tip the artist. Connect MetaMask on Base when you want to send a tip.

Join [DecentBusking on Discord](https://discord.gg/SCtcBggHPa), head to **#DecentJukebox**, and tune in to the **JukeLoop** voice channel. The radio rotates community uploads; listeners can react 👍 or 👎. The bot tracks cumulative votes and plays, and the ratings influence future rotation.

Open the **Top 10** pull-tab on the upper-left to see this New York week's most-voted songs. The live track is highlighted. This public song chart is a discovery view; Top 10 prize drafts rank artist wallets separately.

## Bring A Track

**New here? Start with one song.** Post audio or MP4 in [#DecentJukebox](https://discord.gg/SCtcBggHPa), or click the guitar case on the site. Discord attachments can be up to 10 MB. The site accepts files up to 50 MB, or an existing IPFS file CID for larger media. You do not need a Pinata account.

After a Discord upload is pinned, the bot replies with a **Request NFT** button. Click it to provide your Base artist wallet and optional artwork; submitting the private form automatically adds the request to the owner mint queue. For the site guitar case, connect your artist wallet, enter the track details, and submit. Neither flow mints automatically; the owner reviews and approves requests.

Artwork is optional. Attach PNG, JPEG, WebP, or GIF up to 10 MB, enter an IPFS image CID for a larger image, or leave it blank to use your Discord profile image. The owner reviews the request and mints approved NFTs directly to the artist wallet.

For Discord NFT requests, including `/jukebox submit` with a media CID, the profile image is queued as the default artwork. Admin shows that image in the preview; leave both replacement fields empty to keep it, choose a new image up to 10 MB, or enter an image/GIF file CID for larger artwork. CID mode references the existing file rather than re-uploading it. A valid CID is not a guarantee of availability; review the image preview before minting. Website-only submissions have no Discord profile association.

## Earn From Radio Plays

Use the same Base wallet for your music NFT and artist payout. A qualifying play is a completed, audible Discord playback of at least 30 seconds. Likes and dislikes influence rotation; they are not paid plays.

Playback rewards are paid only from a funded weekly USDC budget. The owner reviews the completed week's allocation before paying on Base. **Playback Tally counts activity; it does not guarantee a payout.** If no budget is funded or approved, no playback payment is due.

## Help Without Coding

You can help without writing code:

- **Make or share art:** offer original cover art, posters, or video assets. Artists can attach optional cover art to a mint request. For art used across the project, open an issue first and say how we may use it. Only share work you made or have permission to share.
- **Help shape a gallery:** suggest an artist spotlight, a themed listening playlist, or a way to show community artwork in the archive. A broader gallery is an idea to shape, not a separate paid feature today.
- **Test and welcome people:** listen to JukeLoop, vote, test the site on mobile, report a reproducible problem, invite an artist, or host a listening session.

These activities are welcome, but are **not automatically paid**. If you want payment for a specific art, testing, or outreach task, ask the maintainer to agree on the task and bounty before starting. The work must have an eligible GitHub issue and accepted submission to enter repo payroll.

## Build And Earn

1. [Choose an open issue](https://github.com/TheJollyLaMa/DecentBusking/issues) and ask to be assigned. If you are new to the project, start with a small issue and ask questions.
2. Work on it and open a pull request that includes `Closes #issue-number`.
3. Use the bounty amount and token shown on the issue, for example `bounty: 10 USDC` or `bounty: 10 ART`. Do not guess an amount or add a payout label yourself.
4. After the pull request is merged, an issue with an approved bounty label can enter the repo payout queue. The owner reviews and settles eligible rewards from the funded Base treasury.

Contributor payouts are separate from radio playback rewards. See [Contributor Payroll](docs/PAYROLL.md) and the [Contributor Request form](https://github.com/TheJollyLaMa/DecentBusking/issues/new?template=whitelist-request.yml) to add your payout wallet. Participating is free; rewards depend on an approved bounty, an accepted merged contribution, and a funded treasury.

## Owner Mint Queue

The contract owner opens **Admin** from the DecentBusking header menu, connects the `DEFAULT_ADMIN_ROLE` wallet on Base, and signs to load pending community requests. The queue shows the artist, destination wallet, track, and submitted artwork. Owners can mint requests one at a time or select several for batch processing in groups of up to 20.

New owner-approved mints use DecentNFT v0.3 and require one Base confirmation per batch. The owner wallet pays gas; each NFT is minted directly to its approved artist recipient. Existing v0.2 NFTs remain unchanged and continue to appear in the archive. After confirmation, the bot verifies the collection-qualified Base receipt, updates the durable queue, and announces the minted NFTs in Discord. Reviewed album imports are queued for owner review but never minted automatically.

## DecentNFT On Base

Existing DecentBusking music NFTs use the DecentNFT v0.2 ERC-1155 contract on Base Mainnet:

- Contract: [`0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B`](https://basescan.org/address/0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B)
- Network: [Base Mainnet](https://basescan.org/)
- Metadata and audio: IPFS, pinned through the DecentBusking service
- Artwork: optional IPFS image included in the NFT metadata
- Current royalty: 5% ERC-2981 royalty receiver set to the artist wallet

New owner-approved mints use the deployed DecentNFT v0.3 batch-capable collection. The v0.2 collection remains in the archive; v0.3 does not migrate or renumber existing v0.2 NFTs.

Minted music appears in the DecentBusking 3D timeline and archive for listening and selection. Marketplace purchase, resale, and richer multi-artist royalty splits are still being developed; a DecentMarket link does not necessarily mean a track is currently listed for sale.

## How It Works

- **JukeLoop:** Discord voice radio plays community tracks and applies vote-weighted rotation.
- **3D archive:** Base music NFTs are placed on a timeline by mint date; select an archive entry to listen and view details.
- **Pinata + IPFS:** Audio, artwork, and metadata use the shared upload service. The bot checkpoints playlist, vote, and mint-queue state to IPFS so the Render free-tier service does not require a persistent disk.
- **Owner controls:** Admin handles the NFT mint queue. Payroll shows repo rewards and weekly radio payout drafts; the owner approves reviewed payouts from funded Base funds. Discord `/jukeloop restart` reconnects the radio; `/jukeloop stats` shows track ratings.

## Build With Us

Everyone is welcome: code, testing, documentation, art, accessibility, and ideas all help make the town square better. Browse [open issues](https://github.com/TheJollyLaMa/DecentBusking/issues), ask to be assigned, and link your pull request with `Closes #N`.

Contributor rewards may be available in ART or USDC from the Base `dbusk-repo-dev` fund. See [Contributor Payroll](docs/PAYROLL.md) and the [Contributor Request form](https://github.com/TheJollyLaMa/DecentBusking/issues/new?template=whitelist-request.yml).

## Run Locally

```sh
npx serve .
```

The static dapp can be explored without a wallet. Connect MetaMask on Base for wallet features. Local IPFS upload can use Kubo/IPFS Desktop; production uploads use the Render service and Pinata.

## Links

- [Listen in the DecentBusking town square](https://thejollylama.github.io/DecentBusking/)
- [Join the Discord community](https://discord.gg/SCtcBggHPa)
- [View DecentNFT on BaseScan](https://basescan.org/address/0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B)
- [DecentMarket](https://thejollylama.github.io/DecentMarket/)
- [DecentBusking issues](https://github.com/TheJollyLaMa/DecentBusking/issues)
- [DecentMarket v0.3 contract plans](https://github.com/TheJollyLaMa/DecentMarket/issues/47)
