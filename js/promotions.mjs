export const PROMOTIONS_FUND = 'dbusk-promotionals';
export const PROMOTIONS_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export function isPromotionsFund(value) {
  return typeof value === 'string' && value.length <= 64 &&
    /^dbusk-promotionals(?:-[a-z0-9]+)*$/.test(value);
}
export const PROMOTIONS_ROUTER_ABI = [
  'function funds(bytes32) view returns (string metadataUri,bool active,bool exists)',
  'function fundBalances(bytes32,address) view returns (uint256)',
  'function completedWorkReferences(bytes32) view returns (bool)',
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function PAYROLL_ROLE() view returns (bytes32)',
  'function CONTRIBUTOR_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function paused() view returns (bool)',
  'function approvedAssets(address) view returns (bool)',
  'function contributors(address) view returns (bytes32 githubIdHash,bool approved,bool exists)',
  'function setContributorApproved(address,bytes32,bool)',
  'function payout(bytes32,address,address,uint256,bytes32,bytes32,bytes32,string,bytes32)',
];
export const PROMOTION_TEMPLATES = [
  { id: 'album', title: 'Bring your album', criteria: 'Bring an album with the stated minimum number of original tracks and rights to publish. Supply approved radio catalog and qualifying delivery evidence for admin review.' },
  { id: 'referral', title: 'Referral rush', criteria: 'Bring two new promotion participants. Both must register your invite before voting and each cast a signed song vote this New York week. Final identity and evidence review is required.' },
  { id: 'sponsor', title: 'Sponsor scout', criteria: 'Introduce a new advertiser. Supply the purchaser wallet, campaign ID and confirmed DVert purchase transaction. Admin checks eligibility and refund/dispute status.' },
  { id: 'buddy', title: 'Bring a band buddy', criteria: 'Help a new musician complete onboarding and publish an approved recording. Supply the musician and recording references; no duplicate reward for the same work.' },
  { id: 'sponsor-match', title: 'First sponsor match', criteria: 'A capped match to the selected artist fund after a sponsor’s first qualifying contribution. Fund contributions are not refundable ad purchases. Draft only until a fund-to-fund settlement path is verified.' },
  { id: 'session', title: 'Village listening session', criteria: 'Organize a listening session and supply event and participation evidence. Never condition rewards on positive votes or claim anonymous activity proves unique humans.' },
];
export function promotionAuthorization({ address, origin, issuedAt, command }) {
  return ['DecentBusking Promotions authorization v1', `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`, `Issued: ${issuedAt}`, `Command: ${JSON.stringify(command)}`].join('\n');
}
export function promotionWorkReference(claim) {
  return `decentbusking:promotions:v1:8453:${claim.campaignId}:${claim.wallet.toLowerCase()}`;
}
export function promotionMoney(value) {
  const amount = BigInt(value);
  const fraction = String(amount % 1000000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${amount / 1000000n}.${fraction} USDC`;
}
export function promotionLink(campaignId, referrer = '', site = globalThis.location?.href) {
  const url = new URL(site);
  url.search = '';
  url.hash = '';
  url.searchParams.set('promotion', campaignId);
  if (referrer) url.searchParams.set('ref', referrer);
  return url.href;
}
export function promotionAnnouncementDraft({ campaignId, version, posterUrl, sentence, site }) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(campaignId || '') || version !== 1) throw new Error('Invalid published offer');
  if (typeof posterUrl !== 'string' || posterUrl.length > 2048) throw new Error('Choose an HTTPS poster image URL');
  let poster, base;
  try { poster = new URL(posterUrl); base = new URL(site); } catch { throw new Error('Choose a valid HTTPS poster and campaign site'); }
  if (poster.protocol !== 'https:' || poster.username || poster.password || base.protocol !== 'https:' || base.username || base.password) {
    throw new Error('Poster and campaign links must use HTTPS without credentials');
  }
  const support = typeof sentence === 'string' ? sentence.trim() : '';
  if (!support || support.length > 180 || /[\r\n]|[.!?]\s+\S|https?:\/\/|www\.|@everyone|@here|<@/i.test(support)) {
    throw new Error('Use one brief supporting sentence without links or mentions');
  }
  return { campaignId, version, posterUrl: poster.href, sentence: support, link: promotionLink(campaignId, '', base.href) };
}
export function promotionUnits(value) {
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(String(value))) throw new Error('Enter a USDC amount with up to six decimals');
  const [whole, fraction = ''] = String(value).split('.');
  const units = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (units <= 0n) throw new Error('USDC amount must be positive');
  return units.toString();
}
