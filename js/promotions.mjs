export const PROMOTIONS_FUND = 'dbusk-promotionals';
export const REFERRALS_FUND = 'dbusk-referrals';
export const PROMOTIONS_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const PROMOTIONS_ETH = '0x0000000000000000000000000000000000000000';
export const CAMPAIGN_ASSETS = Object.freeze({
  usdc: Object.freeze({ id: 'usdc', address: PROMOTIONS_USDC, decimals: 6, symbol: 'USDC', icon: '💵' }),
  eth: Object.freeze({ id: 'eth', address: PROMOTIONS_ETH, decimals: 18, symbol: 'ETH', icon: 'Ξ' }),
});
export function campaignAsset(campaign) {
  return CAMPAIGN_ASSETS[campaign?.asset === 'eth' ? 'eth' : 'usdc'];
}
// Compact display: $12.50 for USDC, Ξ0.0025 for ETH.
export function formatAssetUnits(value, asset = CAMPAIGN_ASSETS.usdc) {
  const amount = BigInt(value || 0);
  const scale = 10n ** BigInt(asset.decimals);
  const whole = amount / scale;
  if (asset.id === 'usdc') {
    const cents = String((amount % scale) / 10000n).padStart(2, '0');
    return `$${whole.toLocaleString('en-US')}${cents === '00' ? '' : `.${cents}`}`;
  }
  const fraction = String(amount % scale).padStart(asset.decimals, '0').slice(0, 6).replace(/0+$/, '');
  return `Ξ${whole}${fraction ? `.${fraction}` : ''}`;
}
export function parseAssetAmount(value, asset = CAMPAIGN_ASSETS.usdc) {
  const places = asset.id === 'eth' ? 6 : 2;
  const match = new RegExp(`^[$Ξ]?\\s*(\\d{1,9})(?:\\.(\\d{1,${places}}))?$`).exec(String(value).trim());
  if (!match) return null;
  const scale = 10n ** BigInt(asset.decimals);
  return (BigInt(match[1]) * scale + BigInt((match[2] || '').padEnd(asset.decimals, '0'))).toString();
}
// Earned Supporter tokens are owed one per wallet per campaign and sent directly by the admin wallet from the
// dev payroll panel; the v2.1 Settlements Router cannot hold ERC-1155 tokens.
export const SUPPORTER_REWARD = Object.freeze({ chainId: 8453, contract: '0xe63ec9f8228720baac2fd528c0a6d06b3dc5439b',
  tokenId: '75', quantity: 1 });
export const SUPPORTER_REWARD_ABI = Object.freeze([
  'function balanceOf(address account,uint256 id) view returns (uint256)',
  'function safeTransferFrom(address from,address to,uint256 id,uint256 value,bytes data)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
]);
export function supporterRewardQueue(campaigns = []) {
  return campaigns.flatMap(campaign => (campaign.supporterToken?.eligibleWallets || []).map(wallet => {
    const delivery = (campaign.supporterToken.deliveries || []).find(item => item.wallet === wallet);
    return { campaignId: campaign.id, title: campaign.title, wallet,
      name: campaign.curatedReferrerNames?.[wallet] || '', status: delivery?.status || 'owed',
      txHash: delivery?.txHash || '', deliveredAt: delivery?.deliveredAt || '', earnedAt: campaign.supporterToken.evaluatedAt || '' };
  }));
}
export const CAMPAIGN_GIFT_TRIGGERS = Object.freeze(['participation', 'completion', 'top']);
export const CAMPAIGN_GIFT_ICONS = Object.freeze({ participation: '🎟', completion: '🏁', top: '🥇' });
export const CAMPAIGN_GIFT_LABELS = Object.freeze({ participation: 'Every referrer who converts a musician',
  completion: 'Every converting referrer when the campaign fills', top: 'Referrer who converts the most musicians' });
// Gifts are paid in the campaign asset from the same fund; null means invalid.
export function campaignGifts(value = []) {
  if (!Array.isArray(value) || value.length > CAMPAIGN_GIFT_TRIGGERS.length) return null;
  const seen = new Set();
  const gifts = [];
  for (const gift of value) {
    if (!gift || !CAMPAIGN_GIFT_TRIGGERS.includes(gift.trigger) || seen.has(gift.trigger) ||
        !/^(?:0|[1-9]\d{0,29})$/.test(gift.amountUnits ?? '') || typeof (gift.supporter ?? false) !== 'boolean' ||
        gift.amountUnits === '0' && !gift.supporter) return null;
    seen.add(gift.trigger);
    gifts.push({ trigger: gift.trigger, amountUnits: gift.amountUnits, supporter: !!gift.supporter });
  }
  return gifts.sort((a, b) => CAMPAIGN_GIFT_TRIGGERS.indexOf(a.trigger) - CAMPAIGN_GIFT_TRIGGERS.indexOf(b.trigger));
}
// Most a campaign's gifts can ever pay, so Run can require it to be funded up front.
export function campaignGiftReserveUnits(campaign) {
  const referrers = (campaign?.curatedReferrers || []).length;
  return (campaignGifts(campaign?.gifts || []) || []).reduce((total, gift) =>
    total + BigInt(gift.amountUnits) * (gift.trigger === 'top' ? 1n : BigInt(referrers)), 0n);
}
// Only curated referrers win gifts. Conversions are approved, payment-pending or paid claims.
export function campaignGiftWinners(campaign, claims = [], members = []) {
  const gifts = campaignGifts(campaign?.gifts || []) || [];
  const referrers = campaign?.curatedReferrers || [];
  const held = claims.filter(c => c.campaignId === campaign.id && ['approved', 'payment-pending', 'paid'].includes(c.status));
  const stats = referrers.map(wallet => ({ wallet, conversions: held.filter(c => c.wallet === wallet).length,
    registered: members.filter(m => m.campaignId === campaign.id && m.referrer === wallet).length }));
  const converting = stats.filter(s => s.conversions > 0);
  const filled = held.length >= (campaign.maxAwards || Infinity);
  const awards = [];
  for (const gift of gifts) {
    let winners = [];
    if (gift.trigger === 'participation') winners = converting;
    else if (gift.trigger === 'completion') winners = filled ? converting : [];
    else if (converting.length) {
      const best = converting.reduce((a, b) => b.conversions > a.conversions ||
        b.conversions === a.conversions && b.registered > a.registered ? b : a);
      winners = converting.filter(s => s.conversions === best.conversions && s.registered === best.registered);
    }
    const share = gift.trigger === 'top' && winners.length ? BigInt(gift.amountUnits) / BigInt(winners.length) : BigInt(gift.amountUnits);
    for (const winner of winners) {
      awards.push({ id: `gift-${gift.trigger}`, trigger: gift.trigger, wallet: winner.wallet,
        amountUnits: share.toString(), supporter: gift.supporter });
    }
  }
  return awards;
}
export function isPromotionsFund(value) {
  return typeof value === 'string' && value.length <= 64 &&
    /^dbusk-(?:promotionals|referrals)(?:-[a-z0-9]+)*$/.test(value);
}
export function referralCampaignTitle(value) {
  const title = String(value || '').trim().replace(/\s+/g, ' ');
  if (!title || /^referral campaign$/i.test(title)) return 'Referral Campaign';
  return /referral campaign$/i.test(title) ? title : `${title} Referral Campaign`;
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
export const PROMOTION_ACTIVITY_WINDOWS = [
  { id: 'current-week', label: 'Current New York payroll week' },
  { id: 'offer-window', label: 'During this offer after registration' },
];
export const MUSICIAN_REFERRAL_PILOT = Object.freeze({
  template: 'musician-referral',
  id: 'musician-referral-pilot-v1',
  title: 'First musician referral pilot',
  maxConversions: 6,
  requiredVotes: 10,
  rewardUnits: '25000000',
  budgetUnits: '150000000',
  rewardLegs: Object.freeze([
    Object.freeze({ id: 'referrer', kind: 'wallet', recipientRole: 'referrer', amountUnits: '10000000' }),
    Object.freeze({ id: 'musician', kind: 'wallet', recipientRole: 'musician', amountUnits: '5000000' }),
    Object.freeze({ id: 'dbusk-top10', kind: 'funding-needed', fund: 'dbusk-top10', amountUnits: '5000000' }),
    Object.freeze({ id: 'dbusk-playback', kind: 'funding-needed', fund: 'dbusk-playback', amountUnits: '5000000' }),
  ]),
});
export const MUSICIAN_REFERRAL_TERMS = 'Six conversions maximum at $25 each. Every conversion requires all four legs and a referred musician with a verified minted DecentBusking playlist track plus 10 distinct campaign-signed song votes. The $5 Top10 and $5 Playback legs remain funding-needed settlement obligations; this UI does not transfer them. An earned Supporter token joins the dev payroll queue and is sent from the admin wallet’s existing inventory; it is not escrowed or minted. No self-referrals, guaranteed payout, or silent term changes.';
const UNIT = /^(?:0|[1-9]\d{0,29})$/;
// Campaigns saved before custom breakdowns existed fall back to the $150 pilot terms.
export function musicianReferralConfig(campaign = {}) {
  const amounts = campaign.legAmounts ||
    Object.fromEntries(MUSICIAN_REFERRAL_PILOT.rewardLegs.map(leg => [leg.id, leg.amountUnits]));
  const baseBudgetUnits = campaign.baseBudgetUnits || MUSICIAN_REFERRAL_PILOT.budgetUnits;
  const requiredVotes = campaign.requiredVotes ?? MUSICIAN_REFERRAL_PILOT.requiredVotes;
  const legIds = MUSICIAN_REFERRAL_PILOT.rewardLegs.map(leg => leg.id);
  const validAmounts = amounts && typeof amounts === 'object' && !Array.isArray(amounts) &&
    Object.keys(amounts).length === legIds.length && legIds.every(id => UNIT.test(amounts[id] ?? ''));
  const rewardUnits = validAmounts ? legIds.reduce((sum, id) => sum + BigInt(amounts[id]), 0n) : 0n;
  const valid = validAmounts && BigInt(amounts.referrer) > 0n && rewardUnits > 0n &&
    /^[1-9]\d{0,29}$/.test(baseBudgetUnits) && BigInt(baseBudgetUnits) % rewardUnits === 0n &&
    BigInt(baseBudgetUnits) / rewardUnits <= 100n &&
    Number.isSafeInteger(requiredVotes) && requiredVotes >= 1 && requiredVotes <= 100;
  return { valid, amounts: { ...amounts }, baseBudgetUnits, requiredVotes,
    rewardUnits: rewardUnits.toString(), maxConversions: valid ? Number(BigInt(baseBudgetUnits) / rewardUnits) : 0 };
}
export function musicianReferralLegs(referrer, musician, campaign) {
  const { amounts } = musicianReferralConfig(campaign);
  return MUSICIAN_REFERRAL_PILOT.rewardLegs.filter(leg => BigInt(amounts[leg.id]) > 0n).map(leg => ({
    ...leg,
    amountUnits: amounts[leg.id],
    ...(leg.kind === 'wallet' ? { recipient: (leg.recipientRole === 'referrer' ? referrer : musician).toLowerCase() } : {}),
    status: leg.kind === 'wallet' ? 'pending' : 'funding-needed',
  }));
}
export function isMusicianReferralCampaign(campaign) {
  return campaign?.template === MUSICIAN_REFERRAL_PILOT.template;
}
export const PROMOTION_TEMPLATES = [
  { id: 'album', title: 'Bring your album', criteria: 'Bring an album with the stated minimum number of original tracks and rights to publish. Supply approved radio catalog and qualifying delivery evidence for admin review.' },
  { id: 'referral', title: 'Referral rush', criteria: 'Bring the stated number of new promotion participants. Each must register your invite before casting a signed song vote in the selected activity window. Final identity and evidence review is required.' },
  { id: 'sponsor', title: 'Sponsor scout', criteria: 'Introduce a new advertiser. Supply the purchaser wallet, campaign ID and confirmed DVert purchase transaction. Admin checks eligibility and refund/dispute status.' },
  { id: 'buddy', title: 'Bring a band buddy', criteria: 'Help a new musician complete onboarding and publish an approved recording. Supply the musician and recording references; no duplicate reward for the same work.' },
  { id: 'sponsor-match', title: 'First sponsor match', criteria: 'A capped match to the selected artist fund after a sponsor’s first qualifying contribution. Fund contributions are not refundable ad purchases. Draft only until a fund-to-fund settlement path is verified.' },
  { id: 'session', title: 'Village listening session', criteria: 'Organize a listening session and supply event and participation evidence. Never condition rewards on positive votes or claim anonymous activity proves unique humans.' },
  { id: 'musician-referral', title: MUSICIAN_REFERRAL_PILOT.title, criteria: 'For each new musician with a verified minted playlist track and 10 distinct campaign-scoped signed song votes. One conversion creates four auditable $25 allocation legs, capped at six conversions.' },
];
export function promotionAuthorization({ address, origin, issuedAt, command }) {
  return ['DecentBusking Promotions authorization v1', `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`, `Issued: ${issuedAt}`, `Command: ${JSON.stringify(command)}`].join('\n');
}
export function promotionWorkReference(claim, legId = '') {
  return `decentbusking:promotions:v1:8453:${claim.campaignId}:${claim.wallet.toLowerCase()}${legId ? `:${legId}` : ''}`;
}
export function promotionMoney(value, asset = CAMPAIGN_ASSETS.usdc) {
  if (asset.id === 'eth') return `${formatAssetUnits(value, asset).slice(1)} ETH`;
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
