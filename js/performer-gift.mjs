import { getBaseReadProvider } from './base-chain.mjs?v=20261018-shared-provider';

const HOLDING_ABI = ['function balanceOf(address account,uint256 id) view returns(uint256)'];
export const FIRST_LIVE_GIFT = Object.freeze({
  bookingId: 'friday-live-performance:2026-11-13:withinthevacuum',
  wallet: '0x405Bb3Cdf23833bb27BAD6629b7cd4f01688235f',
  contract: '0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B',
  tokenId: 75,
  chainId: 8453,
  name: 'DecentBusking v1.0.0 Supporter DNFT',
  imageCid: 'QmbMAoxqif263UUQmZPwNaaxaXycRKGCBf7rGe3kTAuzDe',
  backCid: 'QmUGSjeEv5wCv3zTjf5tdjjG2i1ZLGUPf1dPLcqKAiTpUq',
  metadataCid: 'QmZroFCEhaKoctVqW682Uzv5i6WWiQtuWvTAYkQBYfH6TD',
});
const opened = new Set();
const gateways = ['https://gateway.pinata.cloud/ipfs/', 'https://dweb.link/ipfs/'];

export function performerGiftFor(booking, wallet, now = Date.now()) {
  const gift = FIRST_LIVE_GIFT;
  return booking?.id === gift.bookingId &&
    booking.wallet?.toLowerCase() === gift.wallet.toLowerCase() &&
    wallet?.toLowerCase() === gift.wallet.toLowerCase() &&
    Date.parse(booking.endUtc) <= now ? gift : null;
}

export async function readSupporterHolding({ gift, ethers, provider }) {
  if (!provider || !ethers?.Contract) throw new Error('Base reader is unavailable');
  if (Number((await provider.getNetwork()).chainId) !== gift.chainId) throw new Error('Gift check requires Base');
  const block = await provider.getBlockNumber() - 1;
  if (!Number.isSafeInteger(block) || block < 0) throw new Error('Base confirmation block is unavailable');
  const nft = new ethers.Contract(gift.contract, HOLDING_ABI, provider);
  const balance = await nft.balanceOf(gift.wallet, gift.tokenId, { blockTag: block });
  if (typeof balance !== 'bigint' || balance < 0n) throw new Error('Base returned an invalid token balance');
  return { held: balance > 0n, block };
}

export function renderPerformerGift({ booking, wallet, ethers, config, onReveal = () => {},
  readHolding = gift => readSupporterHolding({ gift, ethers, provider: getBaseReadProvider({ ethers, config }) }) }) {
  const gift = performerGiftFor(booking, wallet);
  if (!gift) return null;
  const section = document.createElement('section');
  section.className = 'live-encore';
  section.setAttribute('aria-label', 'Your Decent encore');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'live-encore-eyebrow';
  eyebrow.textContent = '✦ The first live night · 13 November 2026';
  const title = document.createElement('h3');
  title.textContent = 'Your Decent encore';
  const thanks = document.createElement('p');
  thanks.textContent = 'withinthevacuum, you helped turn our little corner of the internet into a live stage. Thank you for the music, the patience, and the very first night.';
  const reveal = document.createElement('details');
  reveal.className = 'live-encore-reveal';
  reveal.open = opened.has(gift.bookingId);
  const summary = document.createElement('summary');
  summary.textContent = 'Open your encore ✦';
  const presentation = document.createElement('div');
  presentation.className = 'live-encore-presentation';
  const art = document.createElement('img');
  art.className = 'live-encore-art';
  art.loading = 'lazy';
  art.decoding = 'async';
  const artStatus = document.createElement('p');
  artStatus.className = 'live-encore-note';
  artStatus.setAttribute('role', 'status');
  let back = false, gateway = 0;
  const showArt = () => {
    gateway = 0;
    artStatus.textContent = '';
    art.alt = `${gift.name} · ${back ? 'back' : 'front'}`;
    art.src = `${gateways[gateway]}${back ? gift.backCid : gift.imageCid}`;
  };
  art.onerror = () => {
    if (++gateway < gateways.length) art.src = `${gateways[gateway]}${back ? gift.backCid : gift.imageCid}`;
    else artStatus.textContent = 'Collectible artwork is unavailable from the public gateways. The token details below are still available.';
  };
  showArt();
  const flip = document.createElement('button');
  flip.type = 'button';
  flip.textContent = 'Turn the card';
  flip.setAttribute('aria-pressed', 'false');
  flip.onclick = () => {
    back = !back;
    flip.setAttribute('aria-pressed', String(back));
    flip.textContent = back ? 'Show the front' : 'Turn the card';
    showArt();
  };
  const name = document.createElement('h4');
  name.textContent = gift.name;
  const dedication = document.createElement('p');
  dedication.textContent = 'One supporter edition, as a thank-you from Jolly. A keepsake of the code and community you helped bring to life.';
  const note = document.createElement('p');
  note.className = 'live-encore-note';
  note.textContent = 'This is a separate gift, not your performance fee or a mint of your recording. No purchase, signature or claim is needed to view it here.';
  presentation.append(art, artStatus, flip, name, dedication, note);
  reveal.append(summary, presentation);
  reveal.ontoggle = () => {
    if (!reveal.open || opened.has(gift.bookingId)) return;
    opened.add(gift.bookingId);
    if (window._wallet?.address?.toLowerCase() === gift.wallet.toLowerCase()) onReveal();
  };
  const status = document.createElement('output');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const refresh = document.createElement('button');
  refresh.className = 'live-encore-refresh';
  refresh.type = 'button';
  refresh.textContent = 'Check gift in wallet';
  const check = async () => {
    refresh.disabled = true;
    section.setAttribute('data-gift-state', 'checking');
    status.textContent = 'Checking your booked wallet on Base…';
    try {
      const holding = await readHolding(gift);
      section.setAttribute('data-gift-state', holding.held ? 'held' : 'not-held');
      status.textContent = holding.held
        ? `✦ In your wallet. Supporter token #${gift.tokenId} is held by your booked wallet at Base block ${holding.block}.`
        : 'Gift presentation ready. This edition is not in your booked wallet at the checked Base block yet. Jolly still needs to send it; nothing for you to sign.';
    } catch (error) {
      section.setAttribute('data-gift-state', 'unavailable');
      status.textContent = `Wallet check unavailable: ${error.shortMessage || error.message}. Try checking again; this is not confirmation of delivery.`;
    } finally { refresh.disabled = false; }
  };
  refresh.onclick = check;
  const token = document.createElement('a');
  token.href = `https://basescan.org/token/${gift.contract}?a=${gift.wallet}`;
  token.target = '_blank'; token.rel = 'noopener noreferrer';
  token.textContent = 'View collection & wallet on Base ↗';
  const metadata = document.createElement('a');
  metadata.href = `${gateways[0]}${gift.metadataCid}`;
  metadata.target = '_blank'; metadata.rel = 'noopener noreferrer';
  metadata.textContent = 'Token #75 metadata ↗';
  const links = document.createElement('div');
  links.className = 'live-encore-links';
  links.append(token, metadata);
  section.append(eyebrow, title, thanks, reveal, status, refresh, links);
  void check();
  return section;
}
