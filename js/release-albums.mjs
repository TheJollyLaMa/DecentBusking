export function memberships(nft) {
  const wallet = String(nft?.artist || nft?.creator || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || !Array.isArray(nft.releaseAlbums)) return [];
  return nft.releaseAlbums.filter(m => typeof m?.album === 'string' && m.album.trim() && m.album.length <= 100 &&
    Number.isSafeInteger(m.position) && m.position > 0).map(m => ({ ...m, wallet }));
}

export function catalogAlbums(nfts) {
  const albums = new Map();
  for (const nft of nfts) {
    for (const { album, wallet } of memberships(nft)) {
      const key = JSON.stringify([wallet, album.toLowerCase()]);
      if (!albums.has(key)) albums.set(key, { album, wallet });
    }
  }
  return [...albums.values()].sort((a, b) => a.album.localeCompare(b.album) || a.wallet.localeCompare(b.wallet));
}
