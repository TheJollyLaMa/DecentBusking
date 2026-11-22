import { randomBytes, randomUUID } from 'node:crypto';
import { Contract, Interface, id, verifyMessage, isAddress } from 'ethers';
import { PAYMENT_EVENT_ABI } from './payment-ledger.js';
import { currentPayrollPeriod } from '../js/payroll-week.mjs';
import { PROMOTIONS_FUND, PROMOTIONS_USDC, PROMOTIONS_ROUTER_ABI, PROMOTION_TEMPLATES, PROMOTION_ACTIVITY_WINDOWS,
  MUSICIAN_REFERRAL_PILOT, isMusicianReferralCampaign, musicianReferralLegs,
  isPromotionsFund, promotionAnnouncementDraft, promotionAuthorization, promotionWorkReference } from '../js/promotions.mjs';

const address = value => {
  if (!isAddress(value) || /^0x0{40}$/i.test(value)) throw new Error('A valid nonzero wallet is required');
  return value.toLowerCase();
};
const text = (value, label, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} is required (max ${max} characters)`);
  return value.trim();
};
const units = value => {
  if (!/^[1-9]\d{0,14}$/.test(String(value))) throw new Error('Invalid positive USDC units');
  return String(value);
};
const timestamp = (value, label) => {
  const raw = text(value, label, 40);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!parts) throw new Error(`${label} must include an explicit timezone`);
  const [year, month, day, hour, minute] = parts.slice(1, 6).map(Number);
  const second = parts[6] ? Number(parts[6]) : 0;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(raw))) {
    throw new Error(`Invalid ${label.toLowerCase()}`);
  }
  return new Date(raw).toISOString();
};
const statuses = new Set(['draft', 'published', 'paused', 'closed', 'archived']);
const held = claim => ['approved', 'payment-pending', 'paid'].includes(claim.status);
const unpaidReservedUnits = claim => claim.legs
  ? claim.legs.filter(leg => leg.status !== 'paid').reduce((total, leg) => total + BigInt(leg.amountUnits), 0n)
  : claim.status === 'paid' ? 0n : BigInt(claim.amountUnits);
const paymentInterface = new Interface([
  ...PAYMENT_EVENT_ABI,
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const routerInterface = new Interface(PROMOTIONS_ROUTER_ABI);
const fundInterface = new Interface([
  'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
]);
const lower = value => String(value || '').toLowerCase();

export function validatePromotionCheckpoint(value) {
  const fail = () => { throw new Error('Invalid promotions checkpoint; restore a verified backup before accepting writes'); };
  const validDate = date => typeof date === 'string' && Number.isFinite(Date.parse(date));
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  const validWallet = wallet => typeof wallet === 'string' && isAddress(wallet) && wallet === wallet.toLowerCase() && !/^0x0{40}$/.test(wallet);
  if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !['campaigns', 'claims', 'members', 'votes'].every(key => Array.isArray(value[key])) ||
      value.campaigns.length > 1000 || value.claims.length > 10000 || value.members.length > 10000 || value.votes.length > 30000) fail();
  const campaigns = new Map(), claims = new Set(), members = new Map(), votes = new Set(), browsers = new Map();
  for (const c of value.campaigns) {
    if (!c || !validId(c.id) || campaigns.has(c.id) || !statuses.has(c.status) ||
        c.version !== 1 || !isPromotionsFund(c.fund) || !PROMOTION_TEMPLATES.some(t => t.id === c.template) ||
        !validDate(c.startsAt) || !validDate(c.endsAt) || !validDate(c.claimDeadline) ||
        !(Date.parse(c.startsAt) < Date.parse(c.endsAt) && Date.parse(c.endsAt) <= Date.parse(c.claimDeadline)) ||
        !Number.isSafeInteger(c.maxAwards) || c.maxAwards < 1 || c.maxAwards > 10000) fail();
    text(c.title, 'Checkpoint title', 100); text(c.criteria, 'Checkpoint criteria'); text(c.terms, 'Checkpoint terms');
    units(c.rewardUnits); units(c.budgetUnits);
    if (c.template === 'album' && (!Number.isSafeInteger(c.minOriginalTracks) || c.minOriginalTracks < 1 || c.minOriginalTracks > 1000) ||
        c.template === 'referral' && (!Number.isSafeInteger(c.requiredReferrals) || c.requiredReferrals < 2 || c.requiredReferrals > 100 ||
          !PROMOTION_ACTIVITY_WINDOWS.some(window => window.id === c.activityWindow)) ||
        c.template === 'sponsor' && !/^[1-9]\d{0,14}$/.test(c.minPurchaseUnits || '') ||
        c.template === 'sponsor-match' && (c.status !== 'draft' && c.status !== 'archived' ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.matchTargetFund || '') ||
          !/^[1-9]\d{0,14}$/.test(c.minContributionUnits || ''))) fail();
    if (BigInt(c.budgetUnits) < BigInt(c.rewardUnits)) fail();
    if (isMusicianReferralCampaign(c) && (c.rewardUnits !== MUSICIAN_REFERRAL_PILOT.rewardUnits ||
        c.maxAwards !== MUSICIAN_REFERRAL_PILOT.maxConversions ||
        BigInt(c.budgetUnits) % BigInt(MUSICIAN_REFERRAL_PILOT.rewardUnits) !== 0n ||
        BigInt(c.budgetUnits) > BigInt(MUSICIAN_REFERRAL_PILOT.budgetUnits) + (c.amendments || []).reduce((n, a) => n + BigInt(a?.budgetIncreaseUnits || 0), 0n) ||
        !Array.isArray(c.curatedReferrers) || !Array.isArray(c.amendments) ||
        !c.supporterToken || c.supporterToken.status !== 'eligibility-only' ||
        !Array.isArray(c.supporterToken.eligibleWallets) ||
        c.supporterToken.eligibleWallets.some(w => !validWallet(w)))) fail();
    if (c.curatedReferrers && c.curatedReferrers.some(w => !validWallet(w))) fail();
    for (const curation of c.curationHistory || []) {
      if (!curation || !validId(curation.id) || !validWallet(curation.wallet) ||
          !validWallet(curation.reviewer) || !validDate(curation.at) ||
          !c.curatedReferrers.includes(curation.wallet)) fail();
      text(curation.reason, 'Checkpoint curation reason');
    }
    let amendmentBudget = BigInt(MUSICIAN_REFERRAL_PILOT.budgetUnits), amendmentEnd = null;
    for (const amendment of c.amendments || []) {
      if (!amendment || !validId(amendment.id) || !validWallet(amendment.reviewer) || !validDate(amendment.at) ||
          !validDate(amendment.before?.endsAt) || !validDate(amendment.after?.endsAt) ||
          !validDate(amendment.before?.claimDeadline) || !validDate(amendment.after?.claimDeadline) ||
          !/^(?:0|[1-9]\d{0,14})$/.test(amendment.budgetIncreaseUnits || '') ||
          Date.parse(amendment.after.endsAt) < Date.parse(amendment.before.endsAt) ||
          Date.parse(amendment.after.claimDeadline) < Date.parse(amendment.before.claimDeadline) ||
          BigInt(amendment.before.budgetUnits || 0) !== amendmentBudget ||
          BigInt(amendment.after.budgetUnits || 0) !== amendmentBudget + BigInt(amendment.budgetIncreaseUnits) ||
          amendmentEnd && Date.parse(amendment.before.endsAt) !== Date.parse(amendmentEnd)) fail();
      text(amendment.reason, 'Checkpoint amendment reason');
      amendmentBudget += BigInt(amendment.budgetIncreaseUnits);
      amendmentEnd = amendment.after.endsAt;
    }
    if (isMusicianReferralCampaign(c) && (BigInt(c.budgetUnits) !== amendmentBudget ||
        Date.parse(c.endsAt) !== Date.parse(amendmentEnd || c.endsAt))) fail();
    if (c.announcement) {
      const a = c.announcement;
      if (!['pending', 'sent'].includes(a.status) || !/^Promotion [0-9a-f]{32}$/.test(a.marker || '') ||
          !validDate(a.createdAt) || !validWallet(a.reviewer) || a.draft?.campaignId !== c.id ||
          a.draft?.version !== c.version) fail();
      const draft = promotionAnnouncementDraft({ ...a.draft, site: a.draft.link });
      if (JSON.stringify(draft) !== JSON.stringify(a.draft)) fail();
      if (a.status === 'sent' && (!/^\d+$/.test(a.messageId || '') ||
          !/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(a.messageUrl || '') ||
          !validDate(a.announcedAt))) fail();
    }
    campaigns.set(c.id, c);
  }
  for (const m of value.members) {
    const key = `${m?.campaignId}:${m?.wallet}`;
    if (!m || !campaigns.has(m.campaignId) || !validWallet(m.wallet) || !validDate(m.joinedAt) || members.has(key) ||
        m.referrer !== '' && (!validWallet(m.referrer) || m.referrer === m.wallet) ||
        m.termsVersion !== campaigns.get(m.campaignId).version || !validDate(m.acceptedAt) ||
        !Array.isArray(m.attributionHistory) ||
        m.uploadTrackIds !== undefined && (!Array.isArray(m.uploadTrackIds) ||
          m.uploadTrackIds.length > 100 || m.uploadTrackIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200))) fail();
    for (const h of m.attributionHistory) {
      if (!h || !validDate(h.at) || !validWallet(h.reviewer) ||
          h.from && !validWallet(h.from) || h.to && !validWallet(h.to)) fail();
      text(h.reason, 'Checkpoint attribution reason');
    }
    members.set(key, m);
  }
  if (value.members.some(m => m.referrer && !members.has(`${m.campaignId}:${m.referrer}`) &&
      !campaigns.get(m.campaignId)?.curatedReferrers?.includes(m.referrer))) fail();
  const participantClaims = new Set(), heldWallets = new Set(), heldSubjects = new Set(), transactionHashes = new Set();
  const reservations = new Map();
  const voteKey = (campaignId, wallet, week, playId, at) => JSON.stringify([campaignId, wallet, week, playId, at]);
  const recordedVotes = new Set(value.votes.map(v => voteKey(v?.campaignId, v?.wallet, v?.week, v?.playId, v?.at)));
  for (const c of value.claims) {
    const campaign = campaigns.get(c?.campaignId);
    const participant = `${c?.campaignId}:${c?.wallet}`;
    const conversion = isMusicianReferralCampaign(campaign);
    const participantClaimKey = conversion ? `${participant}:${c?.subjectWallet}` : participant;
    if (!c || !validId(c.id) || claims.has(c.id) || !campaign || !members.has(participant) || participantClaims.has(participantClaimKey) ||
        c.amountUnits !== campaign.rewardUnits || c.fund !== campaign.fund || c.termsVersion !== campaign.version ||
        !['submitted', 'needs-evidence', 'rejected', 'approved', 'payment-pending', 'paid'].includes(c.status) ||
        !Array.isArray(c.history) || !validDate(c.createdAt) ||
        c.txHash && (!/^0x[0-9a-f]{64}$/.test(c.txHash) || transactionHashes.has(c.txHash)) ||
        c.lastRevertedHash && !/^0x[0-9a-f]{64}$/.test(c.lastRevertedHash) ||
        c.status === 'paid' && !conversion && (!c.txHash || !Number.isSafeInteger(c.paymentBlockNumber) || c.paymentBlockNumber < 0 ||
          !/^0x[0-9a-f]{64}$/i.test(c.paymentBlockHash || '') || !validDate(c.paidAt))) fail();
    text(c.evidence, 'Checkpoint evidence');
    for (const h of c.history) {
      if (!h || !validDate(h.at) || !validWallet(h.reviewer) || !['approved', 'rejected', 'needs-evidence'].includes(h.action)) fail();
      text(h.reason, 'Checkpoint review reason');
    }
    if (campaign.template === 'buddy' && (!validWallet(c.subjectWallet) || c.subjectWallet === c.wallet)) fail();
    if (campaign.template === 'referral' && (!c.qualification || !/^NY-\d{4}-\d{2}-\d{2}$/.test(c.qualification.week || '') ||
        c.qualification.window !== campaign.activityWindow || !Array.isArray(c.qualification.wallets) ||
        c.qualification.wallets.length !== campaign.requiredReferrals ||
        c.qualification.wallets.some(w => !validWallet(w) || w === c.wallet || !members.has(`${c.campaignId}:${w}`)) ||
        new Set(c.qualification.wallets).size !== campaign.requiredReferrals ||
        !Array.isArray(c.qualification.activity) || c.qualification.activity.length !== campaign.requiredReferrals ||
        c.qualification.activity.some((v, index) => !v || v.wallet !== c.qualification.wallets[index] ||
          campaign.activityWindow === 'current-week' && v.week !== c.qualification.week ||
          !recordedVotes.has(voteKey(c.campaignId, v.wallet, v.week, v.playId, v.at))))) fail();
    if (conversion) {
      const expected = musicianReferralLegs(c.wallet, c.subjectWallet);
      const member = members.get(`${campaign.id}:${c.subjectWallet}`);
      if (!validWallet(c.subjectWallet) || c.subjectWallet === c.wallet || !member || member.referrer !== c.wallet ||
            !c.qualification || c.qualification.voteCount !== MUSICIAN_REFERRAL_PILOT.requiredVotes ||
            !Array.isArray(c.qualification.playIds) ||
            c.qualification.playIds.length !== MUSICIAN_REFERRAL_PILOT.requiredVotes ||
            new Set(c.qualification.playIds).size !== MUSICIAN_REFERRAL_PILOT.requiredVotes ||
            c.qualification.playIds.some(playId => !value.votes.some(v => v.campaignId === campaign.id && v.playId === playId &&
              v.subjectWallet === c.subjectWallet &&
              Date.parse(v.at) >= Date.parse(member.joinedAt) && Date.parse(v.at) < Date.parse(campaign.endsAt))) ||
            !c.qualification.track || c.qualification.track.mintStatus !== 'minted' ||
            !member.uploadTrackIds?.includes(c.qualification.track.trackId) ||
            !/^\d+$/.test(String(c.qualification.track.tokenId || '')) ||
            lower(c.qualification.track.mintRecipient) !== c.subjectWallet ||
            !Array.isArray(c.legs) || c.legs.length !== expected.length ||
            c.legs.some((leg, index) => leg.id !== expected[index].id || leg.kind !== expected[index].kind ||
              leg.amountUnits !== expected[index].amountUnits ||
              (leg.kind === 'wallet' && (!validWallet(leg.recipient) || leg.recipient !== expected[index].recipient ||
                !['pending', 'approved', 'payment-pending', 'paid'].includes(leg.status))) ||
              (leg.kind === 'funding-needed' && (leg.fund !== expected[index].fund ||
                !['funding-needed', 'paid'].includes(leg.status))) ||
              leg.txHash && !/^0x[0-9a-f]{64}$/.test(leg.txHash) ||
              leg.status === 'paid' && (!leg.txHash || !Number.isSafeInteger(leg.paymentBlockNumber) ||
                leg.paymentBlockNumber < 0 || !/^0x[0-9a-f]{64}$/i.test(leg.paymentBlockHash || '') || !validDate(leg.paidAt)))) fail();
    }
    if (campaign.template === 'sponsor' && (!/^0x[0-9a-f]{64}$/.test(c.purchaseHash || '') ||
        !validWallet(c.purchaser) || c.purchaser === c.wallet || !/^\d{1,30}$/.test(c.advertId || '') ||
        !c.qualification || c.qualification.purchaseHash !== c.purchaseHash || c.qualification.purchaser !== c.purchaser ||
        c.qualification.advertId !== c.advertId || !/^[1-9]\d{0,38}$/.test(c.qualification.amountUnits || '') ||
        BigInt(c.qualification.amountUnits) < BigInt(campaign.minPurchaseUnits))) fail();
    if (c.paymentHistory !== undefined) {
      if (!Array.isArray(c.paymentHistory)) fail();
      for (const h of c.paymentHistory) {
        if (!h || !validDate(h.at) || !validWallet(h.reviewer) || h.action !== 'no-broadcast-confirmed') fail();
        text(h.reason, 'Checkpoint payment review reason');
      }
    }
    for (const hash of [c.txHash, ...(c.legs || []).map(leg => leg.txHash)].filter(Boolean)) {
      if (transactionHashes.has(hash)) fail();
      transactionHashes.add(hash);
    }
    if (held(c)) {
      if (!conversion && heldWallets.has(c.wallet)) fail();
      if (!conversion) heldWallets.add(c.wallet);
      const reserved = reservations.get(c.campaignId) || { count: 0, units: 0n };
      reserved.count++;
      reserved.units += BigInt(c.amountUnits);
      reservations.set(c.campaignId, reserved);
      for (const subject of [c.subjectWallet, ...(campaign.template === 'referral' ? c.qualification.wallets : [])].filter(Boolean)) {
        if (heldSubjects.has(subject)) fail();
        heldSubjects.add(subject);
      }
    }
    claims.add(c.id); participantClaims.add(participantClaimKey);
  }
  for (const [campaignId, reserved] of reservations) {
    const campaign = campaigns.get(campaignId);
    if (reserved.count > campaign.maxAwards || reserved.units > BigInt(campaign.budgetUnits)) fail();
  }
  for (const v of value.votes) {
    const campaign = campaigns.get(v?.campaignId);
    const key = `${v?.campaignId}:${v?.wallet}:${isMusicianReferralCampaign(campaign) ? `${v?.subjectWallet}:${v?.playId}` : v?.week}`;
    const member = members.get(`${v?.campaignId}:${v?.wallet}`);
    if (!v || !validWallet(v.wallet) || !member || Date.parse(v.at) < Date.parse(member.joinedAt) ||
        isMusicianReferralCampaign(campaign) && (!validWallet(v.subjectWallet) || !members.has(`${v.campaignId}:${v.subjectWallet}`)) ||
        !/^0x[0-9a-f]{64}$/.test(v.browser) || !validDate(v.at) ||
        currentPayrollPeriod(Date.parse(v.at)).week !== v.week || votes.has(key) ||
        browsers.has(v.browser) && browsers.get(v.browser) !== v.wallet) fail();
    text(v.playId, 'Checkpoint play ID', 200);
    votes.add(key); browsers.set(v.browser, v.wallet);
  }
}

const validateCheckpoint = validatePromotionCheckpoint;

export function createPromotions({ restore, save, getCheckpointUri = () => '', provider, routerAddress, ownerWallet,
  voteOnRadio, readPlaylist = () => [], readFunding, announcements, siteUrl, devertContractAddress = '', now = Date.now, verifySignature = verifyMessage }) {
  const owner = address(ownerWallet);
  const router = new Contract(routerAddress, PROMOTIONS_ROUTER_ABI, provider);
  let state = { schemaVersion: 1, revision: 0, campaigns: [], claims: [], members: [], votes: [] };
  let initialization;
  let fault = '';
  let queue = Promise.resolve();
  const limits = new Map();
  const run = fn => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const initialize = () => initialization ||= (async () => {
    if (!restore || !save) throw new Error('Promotions public checkpoint storage is not configured');
    const value = await restore();
    if (value) {
      validateCheckpoint(value);
      state = value;
    }
  })();
  const refresh = async () => {
    await initialize();
    const latest = await restore();
    if (!latest) {
      if (state.revision !== 0) throw new Error('Promotions storage lost its current state; writes stopped');
      return;
    }
    validateCheckpoint(latest);
    if (latest.revision < state.revision ||
        latest.revision === state.revision && JSON.stringify(latest) !== JSON.stringify(state)) {
      fault = 'Promotions storage revision is inconsistent; restore a verified current backup before accepting writes.';
      throw new Error(fault);
    }
    state = latest;
  };
  const persist = async next => {
    if (fault) throw new Error(fault);
    next.revision = state.revision + 1;
    try {
      const uri = await save(structuredClone(next), state.revision);
      if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Public IPFS storage receipt missing');
      state = next;
    } catch (error) {
      if (error.code === 'PROMOTIONS_STALE') {
        await refresh();
        throw error;
      }
      fault = `Promotions checkpoint is uncertain: ${error.message}. Writes stopped; restore/restart and reconcile before retrying.`;
      throw new Error(fault);
    }
  };
  function summary(campaign, admin = false) {
    const claims = state.claims.filter(c => c.campaignId === campaign.id);
    const reserved = claims.filter(held);
    const committed = reserved.reduce((n, c) => n + BigInt(c.amountUnits), 0n);
    const total = status => claims.filter(c => c.status === status).reduce((n, c) => n + BigInt(c.amountUnits), 0n);
    const { announcement, ...offer } = campaign;
    const legTotal = status => claims.flatMap(c => c.legs || []).filter(leg => leg.kind === 'wallet' && leg.status === status)
      .reduce((n, leg) => n + BigInt(leg.amountUnits), 0n);
    const special = isMusicianReferralCampaign(campaign);
    return { ...offer, ...(admin && announcement ? { announcement } : {}),
      committedUnits: committed.toString(), approvedUnits: special ? legTotal('approved').toString() : total('approved').toString(),
      paymentPendingUnits: special ? legTotal('payment-pending').toString() : total('payment-pending').toString(),
      paidUnits: special ? legTotal('paid').toString() : total('paid').toString(),
      remainingUnits: (BigInt(campaign.budgetUnits) - committed).toString(),
      remainingAwards: Math.max(0, Math.min(campaign.maxAwards - reserved.length,
        Number((BigInt(campaign.budgetUnits) - committed) / BigInt(campaign.rewardUnits)))),
      applications: claims.length, awaitingReview: claims.filter(c => ['submitted', 'needs-evidence'].includes(c.status)).length,
      ...(isMusicianReferralCampaign(campaign) ? {
        qualifiedConversions: claims.filter(c => c.status !== 'rejected').length,
        fundingNeededUnits: claims.flatMap(c => c.legs || []).filter(leg => leg.kind === 'funding-needed' && leg.status !== 'paid')
          .reduce((n, leg) => n + BigInt(leg.amountUnits), 0n).toString(),
      } : {}) };
  }
  const open = campaign => campaign.status === 'published' && Date.parse(campaign.startsAt) <= now() && now() < Date.parse(campaign.endsAt);
  async function funding(fundSlug = PROMOTIONS_FUND) {
    if (!isPromotionsFund(fundSlug)) throw new Error('A dedicated Promotionals fund is required');
    if (readFunding) return readFunding(fundSlug);
    if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Promotions require Base');
    const token = new Contract(PROMOTIONS_USDC, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
    const fundId = id(fundSlug);
    const [fund, balance, actual, paused, role, decimals] = await Promise.all([
      router.funds(fundId), router.fundBalances(fundId, PROMOTIONS_USDC), token.balanceOf(routerAddress),
      router.paused(), router.hasRole(await router.DEFAULT_ADMIN_ROLE(), owner), token.decimals(),
    ]);
    if (!fund.exists || !fund.active || paused || !role || Number(decimals) !== 6) {
      throw new Error('Create and activate Promotionals in Settlements Router; verify owner role, USDC and unpaused router');
    }
    return balance < actual ? balance : actual;
  }
  async function sponsorEvidence(claim, campaign) {
    if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('DVert purchase verification requires Base');
    const { purchaseHash, purchaser, advertId } = claim;
    if (!isAddress(devertContractAddress) || !/^0x[0-9a-f]{64}$/i.test(purchaseHash || '')) throw new Error('Configured DVert source and purchase transaction required');
    const receipt = await provider.getTransactionReceipt(purchaseHash);
    if (!receipt || Number(receipt.status) !== 1 || await provider.getBlockNumber() - receipt.blockNumber + 1 < 2) throw new Error('DVert purchase needs two confirmed Base blocks');
    if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error('DVert purchase is not in the canonical Base block');
    const events = new Interface(['event CampaignCreated(uint256 indexed campaignId,address indexed advertiser,uint64 indexed weekId,string title,string audioURI,uint128 offerUnits,uint64 startedAt,uint64 expiresAt)']);
    const created = receipt.logs.map((log, index) => {
      if (lower(log.address) !== lower(devertContractAddress)) return null;
      try { return { index, event: events.parseLog(log) }; } catch { return null; }
    }).filter(item => item?.event?.name === 'CampaignCreated');
    const match = created.find(({ event: e }) => String(e.args.campaignId) === advertId && lower(e.args.advertiser) === purchaser &&
      e.args.offerUnits > 0n && Number(e.args.startedAt) * 1000 >= Date.parse(campaign.startsAt) &&
      Number(e.args.startedAt) * 1000 < Date.parse(campaign.endsAt));
    if (!match) throw new Error('No matching paid DVert campaign created within this promotion');
    const event = match.event;
    if (event.args.offerUnits < BigInt(campaign.minPurchaseUnits)) throw new Error('DVert purchase is below the published minimum');
    const preceding = Math.max(-1, ...created.filter(item => item.index < match.index).map(item => item.index));
    const paid = receipt.logs.slice(preceding + 1, match.index).some(log => {
      if (lower(log.address) !== lower(PROMOTIONS_USDC)) return false;
      try {
        const transfer = paymentInterface.parseLog(log);
        return transfer?.name === 'Transfer' && lower(transfer.args.from) === purchaser &&
          lower(transfer.args.to) === lower(devertContractAddress) && transfer.args.value === event.args.offerUnits;
      } catch { return false; }
    });
    if (!paid) throw new Error('Missing exact native Base USDC purchase transfer for this DVert campaign');
    return { purchaseHash, purchaser, advertId, amountUnits: String(event.args.offerUnits) };
  }
  async function setSponsorEvidence(next, claim, campaign, command) {
    claim.purchaseHash = text(command.purchaseHash, 'Purchase hash', 66).toLowerCase();
    claim.purchaser = address(command.purchaser);
    if (claim.purchaser === claim.wallet) throw new Error('Sponsor self-referrals are not eligible');
    claim.advertId = text(command.advertId, 'Advert campaign ID', 30);
    if (next.claims.some(c => c.id !== claim.id && c.purchaseHash === claim.purchaseHash && c.advertId === claim.advertId &&
        c.status !== 'rejected')) throw new Error('DVert conversion already claimed');
    claim.qualification = await sponsorEvidence(claim, campaign);
  }
  function setBuddySubject(next, claim, command) {
    claim.subjectWallet = address(command.subjectWallet);
    if (claim.subjectWallet === claim.wallet) throw new Error('The helper and musician must be different wallets');
    if (next.claims.some(c => c.id !== claim.id && c.subjectWallet === claim.subjectWallet && c.status !== 'rejected')) {
      throw new Error('This musician already has a buddy-onboarding claim');
    }
  }
  function referralEvidence(next, claim, campaign) {
    const week = currentPayrollPeriod(now()).week;
    const joins = next.members.filter(m => m.campaignId === claim.campaignId && m.referrer === claim.wallet);
    const active = new Map(next.votes.filter(v => v.campaignId === campaign.id &&
      (campaign.activityWindow === 'offer-window' || v.week === week)).map(v => [v.wallet, v]));
    const qualified = joins.filter(m => active.has(m.wallet));
    if (qualified.length < campaign.requiredReferrals) {
      const count = campaign.requiredReferrals === 2 ? 'Two' : campaign.requiredReferrals;
      const window = campaign.activityWindow === 'current-week' ? 'this New York week' : 'during this offer';
      throw new Error(`${count} registered referrals must each vote on a song ${window}`);
    }
    const wallets = qualified.slice(0, campaign.requiredReferrals).map(m => m.wallet);
    const activity = wallets.map(wallet => {
      const { playId, at, week: voteWeek } = active.get(wallet);
      return { wallet, playId, at, week: voteWeek };
    });
    return { week, window: campaign.activityWindow, wallets, activity };
  }
  function mintedTrackEvidence(wallet, uploadTrackIds = null) {
    const tracks = readPlaylist();
    if (!Array.isArray(tracks)) throw new Error('Playlist evidence is unavailable; do not qualify this conversion');
    const allowed = Array.isArray(uploadTrackIds) ? new Set(uploadTrackIds) : null;
    const track = tracks.find(item => item && item.mintStatus === 'minted' && (!allowed || allowed.has(item.trackId)) &&
      /^\d+$/.test(String(item.tokenId || '')) &&
      lower(item.mintRecipient) === wallet && item.trackId);
    if (!track) throw new Error('Referred musician needs a verified minted track in the DecentBusking playlist');
    return { trackId: track.trackId, tokenId: String(track.tokenId), mintStatus: track.mintStatus,
      mintRecipient: lower(track.mintRecipient), title: text(track.title || '', 'Minted track title', 120) };
  }
  function musicianReferralEvidence(next, claim, campaign) {
    const member = next.members.find(item => item.campaignId === campaign.id && item.wallet === claim.subjectWallet);
    if (!member || member.referrer !== claim.wallet) throw new Error('The musician must be attributed to this referrer');
    const votes = next.votes.filter(v => v.campaignId === campaign.id && v.subjectWallet === claim.subjectWallet &&
      Date.parse(v.at) >= Date.parse(member.joinedAt) && Date.parse(v.at) >= Date.parse(campaign.startsAt) &&
      Date.parse(v.at) < Date.parse(campaign.endsAt));
    const playIds = [...new Set(votes.map(v => v.playId))].sort();
    if (playIds.length < MUSICIAN_REFERRAL_PILOT.requiredVotes) {
      throw new Error(`${playIds.length}/${MUSICIAN_REFERRAL_PILOT.requiredVotes} distinct signed song votes recorded; qualification is all-or-nothing`);
    }
    playIds.splice(MUSICIAN_REFERRAL_PILOT.requiredVotes);
    return { voteCount: playIds.length, playIds, track: mintedTrackEvidence(member.wallet, member.uploadTrackIds) };
  }
  function participantStats(wallet) {
    const campaigns = state.campaigns.filter(c => isMusicianReferralCampaign(c));
    const result = [];
    for (const campaign of campaigns) {
      const memberWallets = state.members.filter(m => m.campaignId === campaign.id).map(m => m.wallet);
      if (!memberWallets.includes(wallet)) continue;
      const claims = state.claims.filter(c => c.campaignId === campaign.id);
      const earned = claims.filter(c => c.status !== 'rejected' && c.legs?.some(l => l.recipient === wallet));
      const totals = status => earned.flatMap(c => c.legs || []).filter(l => l.kind === 'wallet' && l.recipient === wallet && l.status === status)
        .reduce((n, l) => n + BigInt(l.amountUnits), 0n);
      const relevantMembers = state.members.filter(m => m.campaignId === campaign.id && (m.referrer === wallet || m.wallet === wallet));
      const reservedConversions = claims.filter(claim => ['approved', 'payment-pending', 'paid'].includes(claim.status)).length;
      const remainingConversions = Math.max(0, Math.min(
        campaign.maxAwards - reservedConversions,
        Number((BigInt(campaign.budgetUnits) - BigInt(summary(campaign).committedUnits)) /
          BigInt(MUSICIAN_REFERRAL_PILOT.rewardUnits))));
      const ownConversion = state.members.find(member => member.campaignId === campaign.id &&
        member.wallet === wallet && member.referrer);
      const referred = relevantMembers.map(member => {
        const track = (() => {
          try { return mintedTrackEvidence(member.wallet, member.uploadTrackIds); } catch { return null; }
        })();
        const progress = new Set(state.votes.filter(v => v.campaignId === campaign.id &&
          Date.parse(v.at) >= Date.parse(member.joinedAt) && (!isMusicianReferralCampaign(campaign) || v.subjectWallet === member.wallet) &&
          Date.parse(v.at) < Date.parse(campaign.endsAt)).map(v => v.playId));
        return { wallet: member.wallet, self: member.wallet === wallet,
          referrer: member.referrer, voteProgress: Math.min(MUSICIAN_REFERRAL_PILOT.requiredVotes, progress.size),
          track: track ? { trackId: track.trackId, tokenId: track.tokenId } : null, trackState: track ? 'minted' : 'missing-minted-track' };
      });
      result.push({ campaignId: campaign.id, qualifiedCount: earned.filter(c => c.status !== 'rejected').length,
        pendingUnits: (totals('pending') + totals('payment-pending')).toString(),
        approvedUnits: totals('approved').toString(), paidUnits: totals('paid').toString(),
        maxEarningsUnits: (BigInt(remainingConversions) * 10_000_000n +
          (ownConversion && !claims.some(claim => claim.subjectWallet === wallet) ? 5_000_000n : 0n)).toString(),
        referrers: campaign.curatedReferrers,
        attributedMusicians: state.members.filter(m => m.campaignId === campaign.id && m.referrer === wallet).map(m => m.wallet),
        referred, curated: campaign.curatedReferrers.includes(wallet),
        supporterToken: { status: campaign.supporterToken?.status || 'eligibility-only', eligible: !!campaign.supporterToken?.eligibleWallets?.includes(wallet),
          note: 'Eligibility only. No token is minted or transferred unless an exact edition and authority are separately configured.' } });
    }
    return result;
  }
  function updateSupporterEligibility(next, campaign) {
    if (!isMusicianReferralCampaign(campaign)) return;
    const qualifyingClaims = next.claims.filter(item => item.campaignId === campaign.id &&
      item.legs?.length === 4 && item.legs.every(leg => leg.status === 'paid' && leg.paidAt &&
        Date.parse(leg.paidAt) < Date.parse(campaign.endsAt)));
    if (qualifyingClaims.length !== MUSICIAN_REFERRAL_PILOT.maxConversions) return;
    campaign.supporterToken ||= { status: 'eligibility-only', eligibleWallets: [] };
    campaign.supporterToken.eligibleWallets = [...new Set(qualifyingClaims.map(item => item.wallet))];
    campaign.supporterToken.evaluatedAt = new Date(now()).toISOString();
  }
  async function snapshot(wallet, admin) {
    const campaigns = state.campaigns.filter(c => admin || c.status !== 'draft' && c.status !== 'archived').map(c => summary(c, admin));
    const week = currentPayrollPeriod(now()).week;
    const active = new Set(state.votes.filter(v => v.week === week).map(v => `${v.campaignId}:${v.wallet}`));
    const activeDuringOffer = new Set(state.votes.map(v => `${v.campaignId}:${v.wallet}`));
    const referralCounts = new Map();
    for (const member of state.members) {
      if (member.referrer !== wallet) continue;
      const count = referralCounts.get(member.campaignId) || { registered: 0, activeThisWeek: 0, activeDuringOffer: 0 };
      count.registered++;
      if (active.has(`${member.campaignId}:${member.wallet}`)) count.activeThisWeek++;
      if (activeDuringOffer.has(`${member.campaignId}:${member.wallet}`)) count.activeDuringOffer++;
      referralCounts.set(member.campaignId, count);
    }
    const participation = wallet ? state.members.filter(m => m.wallet === wallet).map(member => {
      return { campaignId: member.campaignId, week, voted: active.has(`${member.campaignId}:${member.wallet}`),
        votedDuringOffer: activeDuringOffer.has(`${member.campaignId}:${member.wallet}`),
        ...(referralCounts.get(member.campaignId) || { registered: 0, activeThisWeek: 0, activeDuringOffer: 0 }) };
    }) : [];
    const fundSlugs = admin ? [...new Set([PROMOTIONS_FUND, ...state.campaigns.map(c => c.fund)])] : [];
    const funds = await Promise.all(fundSlugs.map(async slug => {
      try { return { slug, balanceUnits: (await funding(slug)).toString(), error: '' }; }
      catch (error) { return { slug, balanceUnits: null, error: error.message }; }
    }));
    const defaultFund = funds.find(fund => fund.slug === PROMOTIONS_FUND);
    return structuredClone({ revision: state.revision, viewerWallet: wallet, campaigns, fundSlug: PROMOTIONS_FUND, routerAddress,
      funds, fundBalanceUnits: defaultFund?.balanceUnits ?? null, fundingError: defaultFund?.error || '', storageError: fault,
      checkpointUri: getCheckpointUri(),
      claims: state.claims,
      members: state.members,
      votes: state.votes,
      participation,
      participantStats: participantStats(wallet),
      activity: wallet ? { week, voted: state.votes.some(v => v.wallet === wallet && v.week === week) } : null,
    });
  }
  async function reconcile(next, claim, hash, leg = null) {
    if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Payment reconciliation requires Base');
    if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('Enter a valid Base transaction hash');
    const paymentTarget = leg || claim;
    const paymentWallet = leg?.recipient || claim.wallet;
    const paymentUnits = leg?.amountUnits || claim.amountUnits;
    if (next.claims.some(c => c.id !== claim.id && (c.txHash === lower(hash) ||
        c.legs?.some(item => item.txHash === lower(hash))))) throw new Error('Transaction already assigned');
    if (claim.legs?.some(item => item.id !== leg?.id && item.txHash === lower(hash))) throw new Error('Transaction already assigned');
    const receipt = await provider.getTransactionReceipt(hash);
    if (paymentTarget.txHash && paymentTarget.txHash !== lower(hash) && (!receipt || Number(receipt.status) !== 1)) {
      throw new Error('Original payment is unresolved; only a matching successful replacement may reconcile another hash');
    }
    if (!receipt || await provider.getBlockNumber() - receipt.blockNumber + 1 < 2) {
      paymentTarget.txHash = lower(hash);
      paymentTarget.status = 'payment-pending';
      if (leg) claim.status = claim.legs.filter(item => item.kind === 'wallet').every(item => item.status === 'paid') ? 'paid' : 'payment-pending';
      return;
    }
    if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error('Payment is not in the canonical Base block');
    if (lower(receipt.to) !== lower(routerAddress)) throw new Error('Wrong payment transaction target');
    if (Number(receipt.status) !== 1) {
      if (paymentTarget.txHash && paymentTarget.txHash !== lower(hash)) throw new Error('Check the originally recorded payment before another hash');
      const tx = await provider.getTransaction(hash);
      let parsed;
      try { parsed = tx && routerInterface.parseTransaction({ data: tx.data, value: tx.value || 0 }); } catch {}
      const args = parsed?.args;
      if (!tx || lower(tx.to) !== lower(routerAddress) || lower(tx.from) !== owner || parsed?.name !== 'payout' ||
          args[0] !== id(claim.fund) || lower(args[1]) !== lower(PROMOTIONS_USDC) ||
          lower(args[2]) !== paymentWallet || args[3] !== BigInt(paymentUnits) ||
          args[4] !== id(promotionWorkReference(claim, leg?.id))) {
        throw new Error('Reverted transaction does not prove this exact owner-authorized reward attempt');
      }
      paymentTarget.txHash = '';
      paymentTarget.status = 'approved';
      if (leg) claim.status = 'approved';
      claim.lastRevertedHash = lower(hash);
      return;
    }
    const events = receipt.logs.flatMap(log => {
      if (![lower(routerAddress), lower(PROMOTIONS_USDC)].includes(lower(log.address))) return [];
      try { return [{ emitter: lower(log.address), parsed: paymentInterface.parseLog(log) }]; } catch { return []; }
    });
    const reference = id(promotionWorkReference(claim, leg?.id));
    const match = events.some(({ emitter, parsed: e }) => emitter === lower(routerAddress) && e?.name === 'PayrollPaid' &&
      e.args.fundId === id(claim.fund) && lower(e.args.asset) === lower(PROMOTIONS_USDC) &&
      lower(e.args.recipient) === paymentWallet && e.args.amount === BigInt(paymentUnits) && e.args.workReference === reference);
    const transfer = events.some(({ emitter, parsed: e }) => emitter === lower(PROMOTIONS_USDC) && e?.name === 'Transfer' &&
      lower(e.args.from) === lower(routerAddress) && lower(e.args.to) === paymentWallet && e.args.value === BigInt(paymentUnits));
    if (!match || !transfer) throw new Error('Missing matching Promotionals payout and USDC transfer proofs');
    paymentTarget.status = 'paid';
    paymentTarget.txHash = lower(hash);
    paymentTarget.paymentBlockNumber = receipt.blockNumber;
    paymentTarget.paymentBlockHash = receipt.blockHash;
    paymentTarget.paidAt = new Date(now()).toISOString();
    if (leg) {
      claim.status = claim.legs.every(item => item.status === 'paid') ? 'paid' : 'approved';
      updateSupporterEligibility(next, next.campaigns.find(item => item.id === claim.campaignId));
    }
  }
  return {
    async publicState() {
      return run(async () => {
        await refresh();
        const participantProfiles = [...new Set(state.members.map(member => member.wallet))].flatMap(wallet =>
          participantStats(wallet).map(stats => ({ wallet, ...stats })));
        return structuredClone({ ...state, campaigns: state.campaigns.map(c => summary(c, true)),
          checkpointUri: getCheckpointUri(), participantProfiles,
          notice: 'All promotion records, including drafts, evidence, referral links, activity and review notes, are public and checkpointed to IPFS. Do not submit secrets or personal information about others. Drafts are not live offers. Rewards require admin approval; budgets are earmarked, not escrowed.' });
      });
    },
    async execute(body, origin) {
      return run(async () => {
        await refresh();
        const wallet = address(body.address);
        if (body.origin !== origin || Math.abs(now() - Date.parse(body.issuedAt)) > 300000 || !Number.isFinite(Date.parse(body.issuedAt)) ||
            lower(verifySignature(promotionAuthorization(body), body.signature)) !== wallet) throw new Error('Invalid or expired promotions authorization');
        const command = body.command;
        if (!command || typeof command.action !== 'string') throw new Error('Missing promotion action');
        const admin = wallet === owner;
        if (command.action === 'view') return snapshot(wallet, admin);
        for (const [key, entry] of limits) if (entry.until <= now()) limits.delete(key);
        const limit = limits.get(wallet) || { count: 0, until: now() + 3600000 };
        if (limit.count >= 60 || !limits.has(wallet) && limits.size >= 2000) throw new Error('Promotion request limit reached; retry later');
        limit.count++;
        limits.set(wallet, limit);
        if (fault) throw new Error(fault);
        const next = structuredClone(state);
        const at = new Date(now()).toISOString();
        let campaign = next.campaigns.find(c => c.id === command.campaignId);
        const adminActions = ['save', 'amend', 'curate-referrer', 'status', 'review', 'correct-attribution', 'prepare-payment', 'release-payment-preparation',
          'reconcile', 'reconcile-funding-leg', 'preview-discord', 'send-discord', 'reconcile-discord'];
        if (adminActions.includes(command.action)) {
          if (!admin) throw new Error('Only the configured admin may manage promotions');
          if (command.revision !== state.revision) throw new Error('Promotions changed; refresh before retrying');
        }
        if (command.action === 'preview-discord') {
          if (!announcements || !campaign || campaign.status !== 'published' || now() >= Date.parse(campaign.endsAt)) {
            throw new Error('Discord preview needs an available, published, unexpired offer');
          }
          const draft = promotionAnnouncementDraft({ campaignId: campaign.id, version: campaign.version,
            posterUrl: command.posterUrl, sentence: command.sentence, site: siteUrl });
          return { ...await snapshot(wallet, admin), announcementPreview: draft };
        } else if (command.action === 'send-discord') {
          if (!announcements || !campaign) throw new Error('Discord announcements are unavailable');
          if (campaign.announcement?.status === 'sent') return { ...await snapshot(wallet, admin), announcementDuplicate: true };
          if (campaign.announcement?.status === 'pending') throw new Error('Discord delivery is pending; reconcile instead of sending again');
          if (campaign.status !== 'published' || now() >= Date.parse(campaign.endsAt)) throw new Error('Offer is not available for announcement');
          const draft = promotionAnnouncementDraft({ campaignId: campaign.id, version: campaign.version,
            posterUrl: command.preview?.posterUrl, sentence: command.preview?.sentence, site: siteUrl });
          if (JSON.stringify(draft) !== JSON.stringify(command.preview)) throw new Error('Discord preview changed; preview and confirm again');
          await announcements.check();
          campaign.announcement = { status: 'pending', marker: `Promotion ${randomBytes(16).toString('hex')}`,
            createdAt: at, reviewer: owner, draft };
          const pending = structuredClone(campaign.announcement);
          await persist(next);
          try {
            await refresh();
            const current = state.campaigns.find(c => c.id === campaign.id);
            if (current?.status !== 'published' || now() >= Date.parse(current.endsAt) ||
                Math.abs(now() - Date.parse(body.issuedAt)) > 300000) {
              throw new Error('Offer or authorization changed before delivery');
            }
            const delivery = await announcements.send(draft, pending);
            await refresh();
            const completed = structuredClone(state);
            const target = completed.campaigns.find(c => c.id === campaign.id)?.announcement;
            if (target?.status !== 'pending' || target.marker !== pending.marker) throw new Error('Announcement journal changed');
            Object.assign(target, delivery, { status: 'sent' });
            validateCheckpoint(completed);
            await persist(completed);
          } catch (error) {
            throw new Error(`Discord delivery is uncertain; reconcile the journal before any retry. ${error.message}`);
          }
          return snapshot(wallet, admin);
        } else if (command.action === 'reconcile-discord') {
          if (!announcements || campaign?.announcement?.status !== 'pending') throw new Error('No pending Discord delivery to reconcile');
          Object.assign(campaign.announcement, await announcements.reconcile(campaign.announcement), { status: 'sent' });
          validateCheckpoint(next);
        } else if (command.action === 'save') {
          if (!campaign && next.campaigns.length >= 1000) throw new Error('Promotion storage capacity reached; export and review before adding offers');
          if (campaign && campaign.status !== 'draft') throw new Error('Published terms are immutable; duplicate into a new draft');
          const input = command.campaign;
          if (!PROMOTION_TEMPLATES.some(t => t.id === input?.template)) throw new Error('Unknown promotion template');
          const startsAt = timestamp(input.startsAt, 'Start');
          const endsAt = timestamp(input.endsAt, 'End');
          const claimDeadline = timestamp(input.claimDeadline, 'Claim deadline');
          if (!(Date.parse(startsAt) < Date.parse(endsAt) && Date.parse(endsAt) <= Date.parse(claimDeadline))) throw new Error('Start must precede end, and claim deadline must be at/after end');
          if (!Number.isSafeInteger(input.maxAwards) || input.maxAwards < 1 || input.maxAwards > 10000) throw new Error('Max awards must be 1-10000');
          const rewardUnits = units(input.rewardUnits), budgetUnits = units(input.budgetUnits);
          if (BigInt(budgetUnits) < BigInt(rewardUnits)) throw new Error('Budget must cover at least one reward');
          const fund = input.fund || PROMOTIONS_FUND;
          if (!isPromotionsFund(fund)) throw new Error('Use a dedicated dbusk-promotionals fund, not artist, pinner or repo funds');
          if (new Set([...next.campaigns.map(c => c.fund), fund]).size > 20) throw new Error('At most 20 dedicated promotional funds are supported');
          let qualification = {};
          if (input.template === 'album') {
            if (!Number.isSafeInteger(input.minOriginalTracks) || input.minOriginalTracks < 1 || input.minOriginalTracks > 1000) {
              throw new Error('Album offers need a minimum of 1–1000 original tracks');
            }
            qualification = { minOriginalTracks: input.minOriginalTracks };
          } else if (input.template === 'referral') {
            if (!Number.isSafeInteger(input.requiredReferrals) || input.requiredReferrals < 2 || input.requiredReferrals > 100) {
              throw new Error('Set the required referral count between 2 and 100');
            }
            if (!PROMOTION_ACTIVITY_WINDOWS.some(window => window.id === input.activityWindow)) {
              throw new Error('Choose a supported referral activity window');
            }
            qualification = { requiredReferrals: input.requiredReferrals, activityWindow: input.activityWindow };
          } else if (input.template === MUSICIAN_REFERRAL_PILOT.template) {
            const expectedBudget = campaign?.amendments?.length ? campaign.budgetUnits : MUSICIAN_REFERRAL_PILOT.budgetUnits;
            if (units(input.rewardUnits) !== MUSICIAN_REFERRAL_PILOT.rewardUnits ||
                units(input.budgetUnits) !== expectedBudget ||
                input.maxAwards !== MUSICIAN_REFERRAL_PILOT.maxConversions) {
              throw new Error('The musician referral pilot must use $25 per conversion, a $150 budget, and six conversions');
            }
            qualification = { campaignConfigId: MUSICIAN_REFERRAL_PILOT.id,
              curatedReferrers: campaign?.curatedReferrers || [], amendments: campaign?.amendments || [],
              supporterToken: campaign?.supporterToken || { status: 'eligibility-only', eligibleWallets: [],
                note: 'No exact edition or authority is configured; no NFT may be minted or transferred.' } };
          } else if (input.template === 'sponsor') {
            qualification = { minPurchaseUnits: units(input.minPurchaseUnits) };
          } else if (input.template === 'sponsor-match') {
            const target = text(input.matchTargetFund, 'Artist fund', 64);
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target) || target === fund) throw new Error('Choose a different valid artist fund');
            qualification = { matchTargetFund: target, minContributionUnits: units(input.minContributionUnits) };
          }
          const saved = { id: campaign?.id || randomUUID(), status: 'draft', version: 1, title: text(input.title, 'Title', 100),
            template: input.template, criteria: text(input.criteria, 'Qualification terms'), terms: text(input.terms, 'Limits, privacy, disputes and refund terms'),
            rewardUnits, budgetUnits, maxAwards: input.maxAwards, startsAt, endsAt, claimDeadline,
            fund, ...qualification, createdAt: campaign?.createdAt || at, updatedAt: at };
          if (campaign) Object.assign(campaign, saved);
          else next.campaigns.push(saved);
        } else if (command.action === 'curate-referrer') {
          if (!campaign || !isMusicianReferralCampaign(campaign) || !['draft', 'published', 'paused'].includes(campaign.status) ||
              now() > Date.parse(campaign.endsAt)) throw new Error('Curated referrers can only be changed in an active or draft pilot');
          const referrer = address(command.referrer);
          campaign.curatedReferrers ||= [];
          if (campaign.curatedReferrers.includes(referrer)) throw new Error('Referrer is already curated');
          campaign.curatedReferrers.push(referrer);
          campaign.curationHistory ||= [];
          campaign.curationHistory.push({ id: randomUUID(), wallet: referrer, at, reviewer: owner,
            reason: text(command.reason, 'Curator reason') });
        } else if (command.action === 'amend') {
          if (!campaign || !isMusicianReferralCampaign(campaign) || campaign.status === 'archived') throw new Error('Pilot amendment is unavailable');
          const budgetIncreaseUnits = command.budgetIncreaseUnits === undefined || command.budgetIncreaseUnits === '0'
            ? '0' : units(command.budgetIncreaseUnits);
          const endsAt = timestamp(command.endsAt || campaign.endsAt, 'Amended end');
          const claimDeadline = timestamp(command.claimDeadline || campaign.claimDeadline, 'Amended claim deadline');
          if (budgetIncreaseUnits === '0' && endsAt === campaign.endsAt && claimDeadline === campaign.claimDeadline) throw new Error('Amendment does not change the budget or dates');
          if (Date.parse(endsAt) < Date.parse(campaign.endsAt) || Date.parse(claimDeadline) < Date.parse(campaign.claimDeadline) ||
              Date.parse(campaign.startsAt) >= Date.parse(endsAt) || Date.parse(endsAt) > Date.parse(claimDeadline)) {
            throw new Error('An amendment may only extend end/claim dates and preserve date ordering');
          }
          const nextBudget = BigInt(campaign.budgetUnits) + BigInt(budgetIncreaseUnits);
          if (['published', 'paused', 'closed'].includes(campaign.status)) {
            const balance = await funding(campaign.fund);
            const paidCampaignUnits = item => next.claims.filter(claim => claim.campaignId === item.id)
              .reduce((total, claim) => total + (claim.legs
                ? claim.legs.filter(leg => leg.status === 'paid').reduce((sum, leg) => sum + BigInt(leg.amountUnits), 0n)
                : claim.status === 'paid' ? BigInt(claim.amountUnits) : 0n), 0n);
            const otherOutstanding = next.campaigns.filter(item => item.id !== campaign.id &&
                item.fund === campaign.fund && ['published', 'paused', 'closed'].includes(item.status))
              .reduce((total, item) => total + BigInt(item.budgetUnits) - paidCampaignUnits(item), 0n);
            const amendedPaid = paidCampaignUnits(campaign);
            if (balance < otherOutstanding + nextBudget - amendedPaid) {
              throw new Error('Promotionals balance cannot cover this amendment plus other campaign commitments');
            }
          }
          const amendment = { id: randomUUID(), at, reviewer: owner, reason: text(command.reason, 'Immutable amendment reason'),
            budgetIncreaseUnits, before: { budgetUnits: campaign.budgetUnits, endsAt: campaign.endsAt,
              claimDeadline: campaign.claimDeadline, status: campaign.status },
            after: { budgetUnits: nextBudget.toString(), endsAt, claimDeadline, status: campaign.status } };
          campaign.amendments ||= [];
          campaign.amendments.push(amendment);
          campaign.budgetUnits = nextBudget.toString();
          campaign.endsAt = endsAt;
          campaign.claimDeadline = claimDeadline;
          campaign.updatedAt = at;
        } else if (command.action === 'status') {
          if (!campaign || !statuses.has(command.status)) throw new Error('Invalid campaign status');
          const allowed = { draft: ['published', 'archived'], published: ['paused', 'closed'], paused: ['published', 'closed'], closed: ['archived'], archived: [] };
          if (!allowed[campaign.status].includes(command.status)) throw new Error('Invalid campaign transition');
          if (command.status === 'published') {
            if (campaign.template === 'sponsor-match') throw new Error('Sponsor matching is draft-only until fund-to-fund settlement is implemented and verified');
            if (now() >= Date.parse(campaign.endsAt)) throw new Error('Offer has expired');
            const balance = await funding(campaign.fund);
            const otherBudgets = next.campaigns.filter(c => c.id !== campaign.id && c.fund === campaign.fund && ['published', 'paused', 'closed'].includes(c.status))
              .reduce((n, c) => n + BigInt(c.budgetUnits) - next.claims.filter(q => q.campaignId === c.id && q.status === 'paid')
                .reduce((sum, q) => sum + BigInt(q.amountUnits), 0n), 0n);
            if (balance < otherBudgets + BigInt(campaign.budgetUnits) - next.claims.filter(c => c.campaignId === campaign.id && c.status === 'paid')
              .reduce((n, c) => n + BigInt(c.amountUnits), 0n)) throw new Error('Promotionals balance cannot cover campaign budgets already earmarked');
          }
          if (command.status === 'archived' && next.claims.some(c => c.campaignId === campaign.id && c.status !== 'paid' && c.status !== 'rejected')) throw new Error('Resolve outstanding claims before archiving');
          campaign.status = command.status;
          campaign.updatedAt = at;
        } else if (command.action === 'join') {
          if (!campaign || !open(campaign)) throw new Error('Promotion is not accepting participants');
          if (next.members.some(m => m.wallet === wallet && m.campaignId === campaign.id)) throw new Error('Already registered; referral attribution cannot be changed');
          if (command.acceptTerms !== true || command.termsVersion !== campaign.version) throw new Error('Accept the current published terms before registering');
          const referrer = command.referrer ? address(command.referrer) : '';
          if (next.members.length >= 10000) throw new Error('Promotion participant capacity reached');
          if (referrer && next.members.some(m => m.wallet === wallet)) throw new Error('Only new promotion participants can be referrals');
          const curated = isMusicianReferralCampaign(campaign) && campaign.curatedReferrers?.includes(referrer);
          if (referrer && (referrer === wallet || (!curated &&
              !next.members.some(m => m.wallet === referrer && m.campaignId === campaign.id)))) throw new Error('Referrer must be a different registered or curated participant in this promotion');
          const uploadTrackIds = command.trackId ? [text(command.trackId, 'Submitted track ID', 200)] : [];
          if (uploadTrackIds.length) {
            const track = readPlaylist().find(item => item?.trackId === uploadTrackIds[0] &&
              lower(item.mintRecipient) === wallet);
            if (!track) throw new Error('Submitted track is not owned by this connected musician wallet');
          }
          next.members.push({ wallet, campaignId: campaign.id, referrer, joinedAt: at,
            termsVersion: campaign.version, acceptedAt: at, attributionHistory: [], uploadTrackIds });
        } else if (command.action === 'vote') {
          if (next.votes.length >= 30000) throw new Error('Promotion activity capacity reached');
          if (!campaign || !open(campaign) || !next.members.some(m => m.wallet === wallet && m.campaignId === campaign.id)) throw new Error('Join an open promotion first');
          if (!/^[a-zA-Z0-9_-]{16,128}$/.test(command.voterId || '') || ![1, -1].includes(command.vote)) throw new Error('Invalid promotion vote');
          const subjectWallet = isMusicianReferralCampaign(campaign) ? address(command.subjectWallet) : '';
          if (subjectWallet && subjectWallet !== wallet) {
            throw new Error('A musician must sign each qualifying song vote with their own wallet');
          }
          if (subjectWallet && !next.members.some(item => item.campaignId === campaign.id && item.wallet === subjectWallet)) {
            throw new Error('Vote subject must be a registered musician in this pilot');
          }
          const playId = text(command.playId, 'Play ID', 200);
          const browser = id(command.voterId);
          if (next.votes.some(v => v.browser === browser && v.wallet !== wallet)) throw new Error('This browser has already qualified a different wallet');
          if (!voteOnRadio) throw new Error('Radio voting is unavailable');
          const result = await voteOnRadio({ playId, voterId: command.voterId, vote: command.vote });
          if (result.playId !== playId || ![1, -1].includes(result.vote)) throw new Error('Radio did not confirm a song vote');
          const week = currentPayrollPeriod(now()).week;
          const alreadyQualified = isMusicianReferralCampaign(campaign)
            ? next.votes.some(v => v.campaignId === campaign.id && v.wallet === wallet &&
                v.subjectWallet === subjectWallet && v.playId === playId)
            : next.votes.some(v => v.campaignId === campaign.id && v.wallet === wallet && v.week === week);
          if (result.duplicate && !alreadyQualified) throw new Error('An earlier anonymous or other-offer vote cannot qualify this offer; vote on the next song after registration');
          if (!alreadyQualified) {
            next.votes.push({ campaignId: campaign.id, wallet, browser, week, playId, at: new Date(now()).toISOString(),
              ...(isMusicianReferralCampaign(campaign) ? { subjectWallet } : {}) });
          }
        } else if (command.action === 'claim') {
          if (next.claims.length >= 10000) throw new Error('Promotion claim capacity reached');
          if (!campaign || !['published', 'paused', 'closed'].includes(campaign.status) || now() > Date.parse(campaign.claimDeadline)) throw new Error('Claim window is closed');
          const member = next.members.find(m => m.wallet === wallet && m.campaignId === campaign.id);
          if (!member) throw new Error('Register before the promotion closes');
          if (isMusicianReferralCampaign(campaign) && next.claims.filter(c =>
              c.campaignId === campaign.id && c.status !== 'rejected').length >= MUSICIAN_REFERRAL_PILOT.maxConversions) {
            throw new Error('All six musician referral conversion slots are already recorded');
          }
          const duplicate = next.claims.some(c => c.campaignId === campaign.id && c.wallet === wallet &&
            (!isMusicianReferralCampaign(campaign) || c.subjectWallet === address(command.musicianWallet)));
          if (duplicate) throw new Error(isMusicianReferralCampaign(campaign) ?
            'This musician conversion is already recorded' : 'One claim per participant per campaign');
          const claim = { id: randomUUID(), campaignId: campaign.id, wallet, fund: campaign.fund, amountUnits: campaign.rewardUnits,
            status: 'submitted', evidence: text(command.evidence, 'Evidence'), createdAt: at, termsVersion: campaign.version, history: [] };
          if (campaign.template === 'referral') claim.qualification = referralEvidence(next, claim, campaign);
          if (isMusicianReferralCampaign(campaign)) {
            claim.subjectWallet = address(command.musicianWallet);
            claim.qualification = musicianReferralEvidence(next, claim, campaign);
            claim.legs = musicianReferralLegs(claim.wallet, claim.subjectWallet);
          }
          if (campaign.template === 'sponsor') await setSponsorEvidence(next, claim, campaign, command);
          if (campaign.template === 'buddy') setBuddySubject(next, claim, command);
          next.claims.push(claim);
        } else if (command.action === 'correct-attribution') {
          if (!campaign) throw new Error('Promotion not found');
          const memberWallet = address(command.memberWallet);
          const member = next.members.find(m => m.campaignId === campaign.id && m.wallet === memberWallet);
          if (!member) throw new Error('Participant not found');
          const referrer = command.referrer ? address(command.referrer) : '';
          const reason = text(command.reason, 'Attribution correction reason');
          if (referrer === member.referrer && !command.trackId) throw new Error('Attribution is unchanged');
          const curated = isMusicianReferralCampaign(campaign) && campaign.curatedReferrers?.includes(referrer);
          if (referrer && (referrer === memberWallet || !curated &&
              !next.members.some(m => m.campaignId === campaign.id && m.wallet === referrer &&
                Date.parse(m.joinedAt) <= Date.parse(member.joinedAt)))) {
            throw new Error('Referrer must be a different participant already registered in this promotion');
          }
          if (referrer && next.members.find(m => m.wallet === memberWallet) !== member) {
            throw new Error('Only a participant’s first promotion registration can be referred');
          }
          if (next.claims.some(c => c.campaignId === campaign.id &&
              (c.subjectWallet === memberWallet || c.wallet === memberWallet || [member.referrer, referrer].includes(c.wallet)))) {
            throw new Error('Attribution and frozen evidence cannot change after this musician has any claim; resolve the dispute before submitting evidence');
          }
          member.attributionHistory.push({ at, reviewer: owner, from: member.referrer, to: referrer, reason });
          member.referrer = referrer;
        } else if (command.action === 'correct-my-attribution') {
          if (!campaign || !isMusicianReferralCampaign(campaign) || !open(campaign)) throw new Error('Retroactive attribution is only available during this pilot');
          const member = next.members.find(m => m.campaignId === campaign.id && m.wallet === wallet);
          if (!member) throw new Error('Register for this pilot before correcting attribution');
          const referrer = command.referrer ? address(command.referrer) : '';
          if (referrer === member.referrer && !command.trackId) throw new Error('Attribution is unchanged');
          const curated = campaign.curatedReferrers?.includes(referrer);
          if (referrer && (referrer === wallet || (!curated && !next.members.some(m => m.campaignId === campaign.id &&
              m.wallet === referrer && Date.parse(m.joinedAt) <= Date.parse(member.joinedAt))))) {
            throw new Error('Choose a different registered or curated referrer');
          }
          if (next.claims.some(c => c.campaignId === campaign.id && c.subjectWallet === wallet)) {
            throw new Error('This musician already has a claim; resolve the attribution dispute before changing frozen evidence');
          }
          member.attributionHistory.push({ at, reviewer: wallet, from: member.referrer, to: referrer,
            reason: text(command.reason, 'Attribution correction reason') });
          member.referrer = referrer;
          if (command.trackId) {
            const trackId = text(command.trackId, 'Submitted track ID', 200);
            const track = readPlaylist().find(item => item?.trackId === trackId &&
              lower(item.mintRecipient) === wallet);
            if (!track) throw new Error('Submitted track is not owned by this connected musician wallet');
            member.uploadTrackIds ||= [];
            if (!member.uploadTrackIds.includes(trackId)) member.uploadTrackIds.push(trackId);
          }
        } else if (['review', 'prepare-payment', 'release-payment-preparation', 'reconcile',
            'reconcile-funding-leg'].includes(command.action)) {
          const claim = next.claims.find(c => c.id === command.claimId);
          if (!claim) throw new Error('Claim not found');
          campaign = next.campaigns.find(c => c.id === claim.campaignId);
          if (command.action === 'reconcile-funding-leg') {
            if (!isMusicianReferralCampaign(campaign) || !admin || claim.status !== 'approved') {
              throw new Error('Funding reconciliation requires an approved conversion and authorized pilot admin');
            }
            const leg = claim.legs?.find(item => item.id === command.legId);
            if (!leg || leg.kind !== 'funding-needed' || leg.status === 'paid') throw new Error('Unknown or already reconciled funding leg');
            const hash = /^0x[0-9a-f]{64}$/i.test(command.txHash || '') ? lower(command.txHash) : '';
            if (!hash) throw new Error('Enter a valid Base funding transaction hash');
            const receipt = await provider.getTransactionReceipt(hash);
            if (!receipt || receipt.status !== 1 || lower(receipt.to) !== lower(routerAddress)) throw new Error('Funding transaction is not a confirmed router transaction');
            const head = await provider.getBlockNumber();
            if (head - receipt.blockNumber + 1 < 2) throw new Error('Funding transaction needs two confirmed Base blocks');
            const block = await provider.getBlock(receipt.blockNumber);
            if (block?.hash !== receipt.blockHash) throw new Error('Funding transaction is not in the canonical Base block');
            const event = receipt.logs.map(log => {
              if (lower(log.address) !== lower(routerAddress)) return null;
              try { return fundInterface.parseLog(log); } catch { return null; }
            }).find(parsed => parsed?.name === 'FundFunded' && parsed.args.fundId === id(leg.fund) &&
              lower(parsed.args.asset) === lower(PROMOTIONS_USDC) &&
              lower(parsed.args.funder) === owner && parsed.args.amount === BigInt(leg.amountUnits));
            if (!event) throw new Error('Transaction does not fund this exact allocation leg with native Base USDC');
            if (next.claims.some(item => item.id !== claim.id && item.legs?.some(existing => lower(existing.txHash) === hash)) ||
                claim.legs.some(item => item.id !== leg.id && lower(item.txHash) === hash)) throw new Error('Funding transaction was already assigned');
            Object.assign(leg, { status: 'paid', txHash: hash, paymentBlockNumber: Number(receipt.blockNumber),
              paymentBlockHash: receipt.blockHash, paidAt: at });
            claim.status = claim.legs.every(item => item.status === 'paid') ? 'paid' : 'approved';
            claim.history.push({ at, action: 'approved', reason: `Funding leg ${leg.id} verified from Base transaction ${hash}`,
              reviewer: owner });
            updateSupporterEligibility(next, campaign);
          }
          else if (command.action === 'review') {
            if (!(['submitted', 'needs-evidence'].includes(claim.status) ||
                claim.status === 'approved' && command.decision === 'rejected') ||
                !['approved', 'rejected', 'needs-evidence'].includes(command.decision)) throw new Error('Claim is not reviewable');
            if (isMusicianReferralCampaign(campaign) && command.decision !== 'approved' &&
                claim.legs.some(leg => leg.kind === 'wallet' && ['paid', 'payment-pending'].includes(leg.status))) {
              throw new Error('Do not reverse conversion evidence after a wallet leg has payment evidence or pending reconciliation');
            }
            const reason = text(command.reason, 'Review reason');
            if (command.decision === 'approved') {
              if (campaign.template === 'referral') claim.qualification = referralEvidence(next, claim, campaign);
              if (isMusicianReferralCampaign(campaign)) claim.qualification = musicianReferralEvidence(next, claim, campaign);
              if (campaign.template === 'sponsor') {
                if (command.confirmNewAdvertiser !== true || command.confirmRefundAndDisputeReview !== true) {
                  throw new Error('Review new-advertiser, refund and attribution-dispute eligibility before approval');
                }
                claim.qualification = await sponsorEvidence(claim, campaign);
              }
              const s = summary(campaign);
              if (!s.remainingAwards || BigInt(s.remainingUnits) < BigInt(claim.amountUnits)) throw new Error('Campaign reward capacity exhausted');
              const balance = await funding(campaign.fund);
              const reserved = next.claims.filter(c => c.fund === campaign.fund && held(c))
                .reduce((n, c) => n + unpaidReservedUnits(c), 0n);
              if (balance < reserved + BigInt(claim.amountUnits)) throw new Error('Promotionals balance cannot cover reward commitments');
              // No automatic stacking of the same participant's promotional rewards.
              if (!isMusicianReferralCampaign(campaign) &&
                  next.claims.some(c => c.id !== claim.id && c.wallet === claim.wallet && held(c))) throw new Error('Participant already has another approved promotional reward; review stacking outside this pilot');
              const subjects = new Set([claim.subjectWallet, ...(campaign.template === 'referral' ? claim.qualification.wallets : [])].filter(Boolean));
              if (subjects.size && next.claims.some(c => c.id !== claim.id && held(c) &&
                  [c.subjectWallet, ...(c.qualification?.wallets || [])].some(subject => subject && subjects.has(subject)))) {
                throw new Error('This musician or referred participant is already counted in another reserved reward');
              }
            }
            claim.status = command.decision;
            if (isMusicianReferralCampaign(campaign) && command.decision === 'approved') {
              for (const leg of claim.legs.filter(item => item.kind === 'wallet')) leg.status = 'approved';
            } else if (isMusicianReferralCampaign(campaign) && command.decision === 'rejected') {
              for (const leg of claim.legs.filter(item => item.kind === 'wallet')) leg.status = 'pending';
            }
            claim.history.push({ at, action: command.decision, reason, reviewer: owner,
              ...(campaign.template === 'sponsor' && command.decision === 'approved'
                ? { newAdvertiserReviewed: true, refundAndDisputeReviewed: true } : {}) });
          } else if (command.action === 'prepare-payment') {
            if (claim.status !== 'approved') throw new Error('Reward is not approved or already has an unresolved payment');
            const leg = isMusicianReferralCampaign(campaign)
              ? claim.legs.find(item => item.id === command.legId && item.kind === 'wallet')
              : null;
            if (isMusicianReferralCampaign(campaign) && (!leg || leg.status !== 'approved')) {
              throw new Error('Choose one approved wallet reward leg; funding-needed allocations cannot be paid by this router');
            }
            if (campaign.template === 'sponsor') {
              if (command.confirmRefundAndDisputeReview !== true) throw new Error('Recheck refund and dispute eligibility before preparing payment');
              claim.qualification = await sponsorEvidence(claim, campaign);
            }
            const balance = await funding(campaign.fund);
            const reserved = next.claims.filter(c => c.fund === campaign.fund && held(c))
              .reduce((n, c) => n + unpaidReservedUnits(c), 0n);
            if (balance < reserved) throw new Error('Promotionals balance cannot cover existing reward commitments');
            if (leg) {
              leg.status = 'payment-pending';
              leg.paymentPreparedAt = at;
              claim.status = 'payment-pending';
            } else {
              claim.status = 'payment-pending';
              claim.paymentPreparedAt = at;
            }
          } else if (command.action === 'release-payment-preparation') {
            if (claim.status !== 'payment-pending' || claim.txHash || command.confirmNoBroadcast !== true) {
              throw new Error('Only an unbroadcast preparation without a transaction hash can be released after wallet-history review');
            }
            const reason = text(command.reason, 'Wallet-history review reason');
            const leg = isMusicianReferralCampaign(campaign) ? claim.legs.find(item => item.id === command.legId) : null;
            if (isMusicianReferralCampaign(campaign) && (!leg || leg.kind !== 'wallet' || leg.status !== 'payment-pending' || leg.txHash)) {
              throw new Error('Choose the prepared wallet reward leg without a transaction hash');
            }
            claim.paymentHistory ||= [];
            claim.paymentHistory.push({ at, reviewer: owner, action: 'no-broadcast-confirmed', reason,
              ...(leg ? { legId: leg.id } : {}) });
            if (leg) {
              leg.status = 'approved';
              claim.status = 'approved';
            } else claim.status = 'approved';
          } else {
            const leg = isMusicianReferralCampaign(campaign)
              ? claim.legs.find(item => item.id === command.legId && item.kind === 'wallet')
              : null;
            if (isMusicianReferralCampaign(campaign) && !leg) throw new Error('Choose a wallet reward leg to reconcile');
            if (!leg && !['approved', 'payment-pending'].includes(claim.status) ||
                leg && !['approved', 'payment-pending'].includes(leg.status)) throw new Error('Claim or leg does not need payment reconciliation');
            await reconcile(next, claim, command.txHash, leg);
          }
        } else if (command.action === 'evidence') {
          const claim = next.claims.find(c => c.id === command.claimId && c.wallet === wallet);
          if (!claim || claim.status !== 'needs-evidence') throw new Error('Claim is not awaiting evidence');
          campaign = next.campaigns.find(c => c.id === claim.campaignId);
          if (campaign.template === 'sponsor') await setSponsorEvidence(next, claim, campaign, command);
          if (campaign.template === 'buddy') setBuddySubject(next, claim, command);
          claim.evidence = text(command.evidence, 'Evidence');
          claim.status = 'submitted';
        } else throw new Error('Unknown promotion action');
        if (['join', 'vote'].includes(command.action) && !open(campaign)) throw new Error('Promotion closed before participation could be recorded');
        if (command.action === 'claim' && now() > Date.parse(campaign.claimDeadline)) throw new Error('Claim window closed before submission completed');
        await persist(next);
        return snapshot(wallet, admin);
      });
    },
  };
}
