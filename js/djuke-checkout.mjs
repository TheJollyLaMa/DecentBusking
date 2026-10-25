import { getPlaylistBatchAbi, quoteNamedPlaylist, supportsDJukePlaylistBatch, supportsDJukePlaylistRadio } from './djuke-playlists.mjs';
import { ensureBaseNetwork, approvalNotice, waitForAllowance } from './base-chain.mjs';
import { formatUsdcUnits } from './usdc-format.mjs';
import { BASE_USDC_ADDRESS } from './djuke-payment.mjs';
import { USDC_BROWSER_ABI } from './usdc-abi.mjs';

export const RADIO_PLAYLIST_SCHEDULING_WARNING = 'Play Live is queued radio playback, not an uninterrupted time slot. Protected radio hours and scheduled shows take priority: your playlist may wait or be set aside, then its remaining songs return to the queue when the protected block ends. Main paid requests may also cut in between songs. There is no refund solely for a protected-show delay or interruption; you do not pay again for the remaining songs. Separate refunds for failed delivery still apply. Exact start and finish times are not guaranteed.';

export async function checkoutRadioPlaylist({ playlist, signer, config, onStep = () => {}, fetchImpl = fetch,
  ethers: library = globalThis.ethers, signal, ensureChain = ensureBaseNetwork,
  confirmScheduling = () => globalThis.confirm(`${RADIO_PLAYLIST_SCHEDULING_WARNING}\n\nSelect OK to acknowledge and continue to checkout, or Cancel to keep your playlist without purchasing.`) }) {
  signal?.throwIfAborted();
  if (!supportsDJukePlaylistRadio(config)) throw new Error('Radio playlist checkout is unavailable');
  const songIds = playlist.songIds;
  quoteNamedPlaylist(songIds.length, 'radio');
  if (await confirmScheduling() !== true) throw new Error('Play Live checkout cancelled. No approval or purchase was requested; your playlist is unchanged.');
  signal?.throwIfAborted();
  await ensureChain(signer.provider);
  const listener = await signer.getAddress();
  const quoteUrl = new URL(`${String(config.ipfsUploadServiceUrl || '').replace(/\/$/, '')}/api/djuke/playlist-gas-quote`);
  quoteUrl.searchParams.set('listener', listener);
  songIds.forEach(songId => quoteUrl.searchParams.append('songId', songId));
  const response = await fetchImpl(quoteUrl, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
  const quote = await response.json();
  if (!response.ok) throw new Error(quote.error || 'Playlist gas quote is unavailable');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxTotal = BigInt(quote.maxTotal);
  const fulfillmentCostWei = BigInt(quote.fulfillmentCostWei);
  const contributionWei = BigInt(quote.contributionWei);
  if (quote.contractAddress?.toLowerCase() !== config.djukePlaylistBatchAddress?.toLowerCase() ||
      quote.listener?.toLowerCase() !== listener.toLowerCase() || !Number.isInteger(quote.deadline) ||
      quote.deadline < nowSeconds || quote.deadline > nowSeconds + 300 ||
      maxTotal !== quoteNamedPlaylist(songIds.length, 'radio').totalUnits ||
      contributionWei !== fulfillmentCostWei * 2n * BigInt(songIds.length)) throw new Error('Invalid or expired playlist payment quote');
  const djuke = new library.Contract(config.djukePlaylistBatchAddress, getPlaylistBatchAbi(), signer);
  if (config.djukePlaylistBatchVersion === '0.5') {
    if (contributionWei !== 0n || fulfillmentCostWei !== 0n || await djuke.CONTRACT_VERSION() !== '0.5') {
      throw new Error('DJuke v0.5 requires a verified USDC-only purchase quote');
    }
  } else if (contributionWei <= 0n) throw new Error('Legacy playlist checkout requires its disclosed worker gas contribution');
  const usdc = new library.Contract(BASE_USDC_ADDRESS, USDC_BROWSER_ABI, signer);
  if (Number(await usdc.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  if (await usdc.balanceOf(listener) < maxTotal) throw new Error(`You need ${formatUsdcUnits(maxTotal)} USDC on Base`);
  if (contributionWei > 0n && await signer.provider.getBalance(listener) < contributionWei) throw new Error('Not enough Base ETH for the legacy playback contribution');
  if (await usdc.allowance(listener, djuke.target) < maxTotal) {
    signal?.throwIfAborted();
    onStep(approvalNotice(formatUsdcUnits(maxTotal), { workerContribution: contributionWei > 0n }));
    if ((await (await usdc.approve(djuke.target, maxTotal)).wait())?.status !== 1) throw new Error('USDC approval did not confirm');
    await waitForAllowance(usdc, listener, djuke.target, maxTotal);
  }
  onStep(`${songIds.length} songs · ${formatUsdcUnits(maxTotal)} USDC · ${contributionWei === 0n
    ? 'standard Base network gas only' : `${library.formatEther(contributionWei)} ETH worker gas`}`);
  await djuke.requestPlaylistWithGas.staticCall(songIds, maxTotal, fulfillmentCostWei, quote.deadline, quote.signature, { value: contributionWei });
  onStep('Confirm radio playlist checkout in your wallet');
  signal?.throwIfAborted();
  const transaction = await djuke.requestPlaylistWithGas(songIds, maxTotal, fulfillmentCostWei, quote.deadline, quote.signature, { value: contributionWei });
  onStep('Waiting for Base confirmation…');
  if ((await transaction.wait())?.status !== 1) throw new Error('Radio playlist request did not confirm');
  return { txHash: transaction.hash, totalUnits: maxTotal, contributionWei };
}

export async function checkoutPrivatePlaylist({ playlist, signer, config, onStep = () => {}, onSubmitted = () => {},
  ethers: library = globalThis.ethers, signal, ensureChain = ensureBaseNetwork }) {
  signal?.throwIfAborted();
  if (!supportsDJukePlaylistBatch(config)) throw new Error('Private named-playlist checkout is unavailable until a compatible DJuke batch contract is configured');
  await ensureChain(signer.provider);
  quoteNamedPlaylist(playlist.songIds.length, 'private');
  const address = await signer.getAddress();
  const djuke = new library.Contract(config.djukePlaylistBatchAddress, getPlaylistBatchAbi(), signer);
  const usdc = new library.Contract(BASE_USDC_ADDRESS, USDC_BROWSER_ABI, signer);
  if (Number(await usdc.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  const chainQuote = await djuke.quotePlaylist(playlist.songIds, false);
  const totalUnits = BigInt(chainQuote.total ?? chainQuote[2]);
  if (await usdc.balanceOf(address) < totalUnits) throw new Error(`You need ${formatUsdcUnits(totalUnits)} USDC on Base`);
  if (await usdc.allowance(address, djuke.target) < totalUnits) {
    signal?.throwIfAborted();
    onStep(approvalNotice(formatUsdcUnits(totalUnits), { workerContribution: false }));
    if ((await (await usdc.approve(djuke.target, totalUnits)).wait())?.status !== 1) throw new Error('USDC approval did not confirm');
    await waitForAllowance(usdc, address, djuke.target, totalUnits);
  }
  onStep(`Private playlist · ${playlist.songIds.length} songs at creator listen prices · ${formatUsdcUnits(totalUnits)} USDC total`);
  await djuke.purchasePlaylistPrivate.staticCall(playlist.songIds, totalUnits);
  onStep('Confirm private playlist purchase in your wallet');
  signal?.throwIfAborted();
  const transaction = await djuke.purchasePlaylistPrivate(playlist.songIds, totalUnits);
  await onSubmitted({ payer: address, contract: djuke.target, txHash: transaction.hash });
  onStep('Waiting for Base confirmation…');
  if ((await transaction.wait())?.status !== 1) throw new Error('Private playlist purchase did not confirm');
  return { txHash: transaction.hash, totalUnits };
}
