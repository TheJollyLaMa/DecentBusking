export async function loadMintedToken({ contract, tokenId, fetchMetadata }) {
  const minted = Number(await contract.totalMinted(tokenId));
  if (minted === 0) return null;

  const uri = await contract.uri(tokenId);
  const [meta, creator] = await Promise.all([
    fetchMetadata(uri),
    contract.creatorOf(tokenId).catch(() => ''),
  ]);
  if (!meta) return null;
  return {
    tokenId,
    ...meta,
    creator: creator || meta.creator || meta.artist || '',
  };
}
