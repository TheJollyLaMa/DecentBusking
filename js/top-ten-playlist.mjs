export async function addChartSongToPlaylist(track, {
  wallet = window._wallet,
  resolveNFT = async detail => {
    const { resolveNowPlayingNFT } = await import('./space.js?v=20261019-fund-tour');
    return resolveNowPlayingNFT(detail, { requireMediaMatch: true });
  },
  save = async nft => {
    const { saveCreatorWatchlist, isCreatorWatchlisted } = await import('./watchlist.mjs?v=20261017-mercury-release');
    if (!isCreatorWatchlisted(nft)) await saveCreatorWatchlist(nft);
  },
} = {}) {
  if (!track.ipfsCid) throw new Error('This song does not have verified media for your playlist yet.');
  if (!wallet?.address || !wallet?.signer) await wallet?.connect?.();
  if (!wallet?.address || !wallet?.signer) throw new Error('Connect your wallet to add songs to your personal playlist.');
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
