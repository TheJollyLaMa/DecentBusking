export async function addChartSongToPlaylist(track, {
  wallet = window._wallet,
  resolveNFT = async detail => {
    const { resolveNowPlayingNFT } = await import('./space.js?v=20261030-ad-cutoff');
    return resolveNowPlayingNFT(detail, { requireMediaMatch: true });
  },
  save = async nft => {
    const event = new CustomEvent('dbusk-playlist-add', { cancelable: true, detail: { nft } });
    if (document.dispatchEvent(event)) throw new Error('DJuke playlist controls are unavailable');
  },
} = {}) {
  if (!track.ipfsCid) throw new Error('This song does not have verified media for your playlist yet.');
  if (!wallet?.address || !wallet?.signer) await wallet?.connect?.();
  if (!wallet?.address || !wallet?.signer) throw new Error('Connect your wallet to add songs to your named playlist draft.');
  const nft = await resolveNFT({
    title: track.title,
    artist: track.artist || track.uploader,
    audioUrl: `ipfs://${track.ipfsCid}`,
    ipfsCid: track.ipfsCid,
  });
  if (!nft) throw new Error('No verified NFT was found for this song. It has not been added.');
  await save(nft);
  return nft;
}

export async function saveChartSongToWatchlist(track, {
  wallet = window._wallet,
  resolveNFT = async detail => {
    const { resolveNowPlayingNFT } = await import('./space.js?v=20261030-ad-cutoff');
    return resolveNowPlayingNFT(detail, { requireMediaMatch: true });
  },
  watchlist = async () => import('./watchlist.mjs?v=20261030-ad-cutoff'),
} = {}) {
  if (!track.ipfsCid) throw new Error('This song does not have verified media yet.');
  if (!wallet?.address || !wallet?.signer) await wallet?.connect?.();
  if (!wallet?.address || !wallet?.signer) throw new Error('Connect your wallet to save your watchlist.');
  const nft = await resolveNFT({ title: track.title, artist: track.artist || track.uploader,
    audioUrl: `ipfs://${track.ipfsCid}`, ipfsCid: track.ipfsCid });
  if (!nft) throw new Error('No verified NFT was found for this song.');
  const { saveCreatorWatchlist, isCreatorWatchlisted } = await watchlist();
  if (!isCreatorWatchlisted(nft)) await saveCreatorWatchlist(nft);
  return nft;
}
