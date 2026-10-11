const USDC = 1_000_000n;
export const DEVERT_MINIMUM_WEEKLY_PRICE = 5n * USDC;
export const DEVERT_MINIMUM_BID_INCREMENT = 10_000n;
export const DEVERT_CAMPAIGN_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEVERT_SONGS_PER_MAIN_AD = 10;
export const DEVERT_MAX_WEEKLY_CAMPAIGNS = 1000;

function validateCampaign(campaign) {
  if (!campaign || typeof campaign.campaignId !== 'string' || !campaign.campaignId ||
    typeof campaign.audioURI !== 'string' || !campaign.audioURI.startsWith('ipfs://') ||
    typeof campaign.title !== 'string' || !campaign.title || typeof campaign.advertiser !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(campaign.advertiser) || typeof campaign.offerUnits !== 'string' ||
    !/^\d+$/.test(campaign.offerUnits) || BigInt(campaign.offerUnits) < DEVERT_MINIMUM_WEEKLY_PRICE ||
    !Number.isFinite(Date.parse(campaign.startedAt)) || !Number.isFinite(Date.parse(campaign.expiresAt)) ||
    campaign.djukeBoosts !== undefined && (!Number.isSafeInteger(campaign.djukeBoosts) || campaign.djukeBoosts < 0) ||
    campaign.mainRadioPlays !== undefined && (!Number.isSafeInteger(campaign.mainRadioPlays) || campaign.mainRadioPlays < 0) ||
    campaign.devertPlays !== undefined && (!Number.isSafeInteger(campaign.devertPlays) || campaign.devertPlays < 0)) {
    throw new Error('Invalid DeVert campaign');
  }
  return campaign;
}

function comparePriority(first, second) {
  const boostDifference = (second.djukeBoosts || 0) - (first.djukeBoosts || 0);
  if (boostDifference) return boostDifference;
  const playDifference = (first.mainRadioPlays || 0) - (second.mainRadioPlays || 0);
  if (playDifference) return playDifference;
  const offerDifference = BigInt(second.offerUnits) - BigInt(first.offerUnits);
  if (offerDifference !== 0n) return offerDifference > 0n ? 1 : -1;
  return Date.parse(first.startedAt) - Date.parse(second.startedAt) || first.campaignId.localeCompare(second.campaignId);
}

export function quoteDevertCampaign({ campaigns, mainRadioSlots, minimumPriceUnits = DEVERT_MINIMUM_WEEKLY_PRICE,
  minimumBidIncrementUnits = DEVERT_MINIMUM_BID_INCREMENT }) {
  if (!Array.isArray(campaigns) || !Number.isSafeInteger(mainRadioSlots) || mainRadioSlots < 0 ||
    typeof minimumPriceUnits !== 'bigint' || minimumPriceUnits < DEVERT_MINIMUM_WEEKLY_PRICE ||
    typeof minimumBidIncrementUnits !== 'bigint' || minimumBidIncrementUnits < 1n) throw new Error('Invalid DeVert quote inputs');
  if (campaigns.length >= DEVERT_MAX_WEEKLY_CAMPAIGNS) throw new Error('Weekly DeVert campaign limit reached');
  const incumbents = campaigns.map(validateCampaign).sort(comparePriority);
  if (mainRadioSlots === 0 || incumbents.length < mainRadioSlots) return {
    minimumOfferUnits: minimumPriceUnits, bumpedCampaignId: null, mainRadioSlots,
  };
  const threshold = BigInt(incumbents[mainRadioSlots - 1].offerUnits) + minimumBidIncrementUnits;
  return { minimumOfferUnits: threshold > minimumPriceUnits ? threshold : minimumPriceUnits,
    bumpedCampaignId: incumbents[mainRadioSlots - 1].campaignId, mainRadioSlots };
}

export function planDevertQueues({ campaigns, completedSongPlays, now = Date.now(), songsPerMainAd = DEVERT_SONGS_PER_MAIN_AD }) {
  if (!Array.isArray(campaigns) || !Number.isSafeInteger(completedSongPlays) || completedSongPlays < 0 ||
    !Number.isSafeInteger(songsPerMainAd) || songsPerMainAd < 1) throw new Error('Invalid DeVert schedule inputs');
  const active = campaigns.map(validateCampaign).filter(campaign => {
    const start = Date.parse(campaign.startedAt);
    const end = Date.parse(campaign.expiresAt);
    if (end - start > DEVERT_CAMPAIGN_WEEK_MS || end <= start) throw new Error('DeVert campaign must last no longer than seven days');
    return start <= now && now < end;
  });
  const mainRadioSlots = Math.floor(completedSongPlays / songsPerMainAd);
  const ranked = [...active].sort(comparePriority);
  return { at: new Date(now).toISOString(), completedSongPlays, songsPerMainAd, mainRadioSlots,
    mainRadio: ranked.slice(0, mainRadioSlots),
    devertBroadcast: [...active].sort((first, second) =>
      (first.devertPlays || 0) - (second.devertPlays || 0) || comparePriority(first, second)),
    mainRadioOverflow: ranked.slice(mainRadioSlots) };
}

export function applyDevertDjukeBump(campaigns, campaignId, { purchaseId, at = new Date().toISOString() }) {
  if (!Array.isArray(campaigns) || !campaignId || !purchaseId) throw new Error('DJuke advert bump identity required');
  let found = false;
  const next = campaigns.map(campaign => {
    validateCampaign(campaign);
    if (campaign.campaignId !== campaignId) return { ...campaign };
    found = true;
    const purchases = campaign.djukePurchases || [];
    if (purchases.includes(purchaseId)) throw new Error('DJuke advert purchase already applied');
    return { ...campaign, djukeBoosts: (campaign.djukeBoosts || 0) + 1,
      djukePurchases: [...purchases, purchaseId], lastDjukeBumpAt: at };
  });
  if (!found) throw new Error('DeVert campaign not found');
  return next;
}
