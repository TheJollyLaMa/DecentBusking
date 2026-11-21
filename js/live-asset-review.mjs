import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261015-mime-sniff';

export const ASSET_REVIEW_SCHEMA = 'decentbusking-asset-performance-review-v1';
export const ASSET_REVIEW_MAX_CHARACTERS = 500;
const REPORT_LINK = /^ipfs:\/\/[a-zA-Z0-9]+(?:\/[^\s]*)?$/;
const PINNED_LINK = /^ipfs:\/\/[a-zA-Z0-9]+$/;
const DECLINED = /user (rejected|denied)|rejected the request|request rejected|denied message signature|ACTION_REJECTED/i;
const reviewKey = id => `live-asset-review:${id}`;

// `nothingSent` lets the admin panel say plainly that no transaction exists yet.
function unsent(message) {
  return Object.assign(new Error(message), { nothingSent: true });
}

// A typed review is saved to IPFS for the producer; an existing ipfs:// report link is still accepted as-is.
export function readAssetApprovalInput(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).replace(/\s+/g, ' ').trim();
  if (REPORT_LINK.test(text)) return { uri: text };
  if (!text) throw unsent('Type a short review first, for example: fantastic!');
  if (/^ipfs:\/\//i.test(text)) throw unsent('That looks like an IPFS link but it is incomplete. Paste the full ipfs:// link, or just type a short review.');
  const length = [...text].length;
  if (length > ASSET_REVIEW_MAX_CHARACTERS) throw unsent(`Keep the review to ${ASSET_REVIEW_MAX_CHARACTERS} characters or fewer (yours is ${length}).`);
  return { review: text };
}

// No timestamps: the same review for the same booking always produces the same bytes.
export function assetReviewReport(b, review) {
  return {
    schema: ASSET_REVIEW_SCHEMA, bookingId: b.id, performerWallet: b.wallet,
    title: b.title, startUtc: b.startUtc, endUtc: b.endUtc, termsUri: b.termsUri, termsHash: b.termsHash,
    escrowAddress: b.escrowAddress, chainId: 8453,
    asset: { address: b.assetAddress, symbol: b.assetSymbol, decimals: b.assetDecimals, amountUnits: b.amountUnits },
    gift: b.gift ? { collection: b.gift.collection, tokenId: b.gift.tokenId, quantity: b.gift.quantity } : null,
    decision: 'approved', review,
    evidenceLimit: 'This is the producer’s typed review. It does not certify listening duration, recording publication or payment received. Contract approval, performer claim and gift release require separate confirmed events.',
  };
}

// The pinned link is remembered per booking, so a declined or failed wallet step never uploads the same review twice.
export async function pinAssetReview({ booking, review, serviceUrl, signer, address, origin, fetchImpl, upload, storage = globalThis.localStorage }) {
  const body = `${JSON.stringify(assetReviewReport(booking, review), null, 2)}\n`;
  const key = reviewKey(booking.id);
  try {
    const saved = JSON.parse(storage.getItem(key) || 'null');
    if (saved?.body === body && PINNED_LINK.test(saved.uri || '')) return saved.uri;
  } catch { /* an unreadable receipt only means the review is saved again */ }
  const send = upload || createBrowserIpfsUploader({ serviceUrl, signer, address, origin, fetchImpl });
  let uri;
  try {
    uri = await send(new File([body], 'asset-performance-review.json', { type: 'application/json' }));
  } catch (error) {
    throw unsent(DECLINED.test(`${error?.code || ''} ${error?.shortMessage || ''} ${error?.message || ''}`)
      ? 'You declined the free upload signature in your wallet.'
      : `Saving the review to IPFS failed: ${error?.shortMessage || error?.message || 'unknown error'}`);
  }
  if (!PINNED_LINK.test(uri || '')) throw unsent('The upload did not return a valid IPFS link.');
  try { storage.setItem(key, JSON.stringify({ body, uri })); } catch { /* retrying only saves the same review again */ }
  return uri;
}
