import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { Contract, Interface, id, verifyMessage, isAddress } from 'ethers';
import { PAYMENT_EVENT_ABI } from './payment-ledger.js';
import { currentPayrollPeriod } from '../js/payroll-week.mjs';
import { PROMOTIONS_FUND, PROMOTIONS_USDC, PROMOTIONS_ROUTER_ABI, PROMOTION_TEMPLATES,
  promotionAuthorization, promotionWorkReference } from '../js/promotions.mjs';

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
const statuses = new Set(['draft', 'published', 'paused', 'closed', 'archived']);
const held = claim => ['approved', 'payment-pending', 'paid'].includes(claim.status);
const paymentInterface = new Interface([
  ...PAYMENT_EVENT_ABI,
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const lower = value => String(value || '').toLowerCase();

function validateCheckpoint(value) {
  const fail = () => { throw new Error('Invalid promotions checkpoint; restore a verified backup before accepting writes'); };
  const validDate = date => typeof date === 'string' && Number.isFinite(Date.parse(date));
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  const validWallet = wallet => typeof wallet === 'string' && isAddress(wallet) && wallet === wallet.toLowerCase() && !/^0x0{40}$/.test(wallet);
  if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !['campaigns', 'claims', 'members', 'votes'].every(key => Array.isArray(value[key])) ||
      value.campaigns.length > 1000 || value.claims.length > 10000 || value.members.length > 10000 || value.votes.length > 30000) fail();
  const campaigns = new Map(), claims = new Set(), members = new Set(), votes = new Set(), browsers = new Map();
  for (const c of value.campaigns) {
    if (!c || !validId(c.id) || campaigns.has(c.id) || !statuses.has(c.status) ||
        c.version !== 1 || c.fund !== PROMOTIONS_FUND || !PROMOTION_TEMPLATES.some(t => t.id === c.template) ||
        !validDate(c.startsAt) || !validDate(c.endsAt) || !validDate(c.claimDeadline) ||
        !(Date.parse(c.startsAt) < Date.parse(c.endsAt) && Date.parse(c.endsAt) <= Date.parse(c.claimDeadline)) ||
        !Number.isSafeInteger(c.maxAwards) || c.maxAwards < 1 || c.maxAwards > 10000) fail();
    text(c.title, 'Checkpoint title', 100); text(c.criteria, 'Checkpoint criteria'); text(c.terms, 'Checkpoint terms');
    units(c.rewardUnits); units(c.budgetUnits);
    if (BigInt(c.budgetUnits) < BigInt(c.rewardUnits)) fail();
    campaigns.set(c.id, c);
  }
  for (const m of value.members) {
    const key = `${m?.campaignId}:${m?.wallet}`;
    if (!m || !campaigns.has(m.campaignId) || !validWallet(m.wallet) || !validDate(m.joinedAt) || members.has(key) ||
        m.referrer !== '' && (!validWallet(m.referrer) || m.referrer === m.wallet)) fail();
    members.add(key);
  }
  if (value.members.some(m => m.referrer && !members.has(`${m.campaignId}:${m.referrer}`))) fail();
  const participantClaims = new Set();
  for (const c of value.claims) {
    const campaign = campaigns.get(c?.campaignId);
    const participant = `${c?.campaignId}:${c?.wallet}`;
    if (!c || !validId(c.id) || claims.has(c.id) || !campaign || !members.has(participant) || participantClaims.has(participant) ||
        c.amountUnits !== campaign.rewardUnits || c.termsVersion !== campaign.version ||
        !['submitted', 'needs-evidence', 'rejected', 'approved', 'payment-pending', 'paid'].includes(c.status) ||
        !Array.isArray(c.history) || !validDate(c.createdAt) ||
        c.txHash && !/^0x[0-9a-f]{64}$/.test(c.txHash) || c.status === 'paid' && !c.txHash) fail();
    text(c.evidence, 'Checkpoint evidence');
    for (const h of c.history) {
      if (!h || !validDate(h.at) || !validWallet(h.reviewer) || !['approved', 'rejected', 'needs-evidence'].includes(h.action)) fail();
      text(h.reason, 'Checkpoint review reason');
    }
    claims.add(c.id); participantClaims.add(participant);
  }
  for (const c of value.campaigns) {
    const reserved = value.claims.filter(q => q.campaignId === c.id && held(q));
    if (reserved.length > c.maxAwards || reserved.reduce((n, q) => n + BigInt(q.amountUnits), 0n) > BigInt(c.budgetUnits)) fail();
  }
  for (const v of value.votes) {
    const key = `${v?.wallet}:${v?.week}`;
    if (!v || !validWallet(v.wallet) || !value.members.some(m => m.wallet === v.wallet) ||
        !/^0x[0-9a-f]{64}$/.test(v.browser) || !validDate(v.at) ||
        currentPayrollPeriod(Date.parse(v.at)).week !== v.week || votes.has(key) ||
        browsers.has(v.browser) && browsers.get(v.browser) !== v.wallet) fail();
    votes.add(key); browsers.set(v.browser, v.wallet);
  }
}

export function promotionCheckpointCodec(keyHex) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex || '')) throw new Error('PROMOTIONS_STORAGE_KEY must be 32 random bytes in hex; retain it for recovery');
  const key = Buffer.from(keyHex, 'hex');
  return {
    serialize(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from('decentbusking-promotions-v1'));
      const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return { schema: 'encrypted-promotions-v1', iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'), data: bytes.toString('base64') };
    },
    deserialize(value) {
      if (value?.schema !== 'encrypted-promotions-v1') throw new Error('Invalid encrypted promotions checkpoint');
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
      cipher.setAAD(Buffer.from('decentbusking-promotions-v1'));
      cipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString());
    },
  };
}

export function createPromotions({ restore, save, provider, routerAddress, ownerWallet,
  voteOnRadio, readFunding, devertContractAddress = '', now = Date.now, verifySignature = verifyMessage }) {
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
    if (!restore || !save) throw new Error('Promotions encrypted storage is not configured');
    const value = await restore();
    if (value) {
      validateCheckpoint(value);
      state = value;
    }
  })();
  const persist = async next => {
    if (fault) throw new Error(fault);
    next.revision = state.revision + 1;
    try {
      const uri = await save(structuredClone(next));
      if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Checkpoint receipt missing');
      state = next;
    } catch (error) {
      fault = `Promotions checkpoint is uncertain: ${error.message}. Writes stopped; restore/restart and reconcile before retrying.`;
      throw new Error(fault);
    }
  };
  function summary(campaign) {
    const claims = state.claims.filter(c => c.campaignId === campaign.id);
    const reserved = claims.filter(held);
    const committed = reserved.reduce((n, c) => n + BigInt(c.amountUnits), 0n);
    const paid = claims.filter(c => c.status === 'paid').reduce((n, c) => n + BigInt(c.amountUnits), 0n);
    return { ...campaign, committedUnits: committed.toString(), paidUnits: paid.toString(),
      remainingUnits: (BigInt(campaign.budgetUnits) - committed).toString(),
      remainingAwards: Math.max(0, Math.min(campaign.maxAwards - reserved.length,
        Number((BigInt(campaign.budgetUnits) - committed) / BigInt(campaign.rewardUnits)))),
      applications: claims.length };
  }
  const open = campaign => campaign.status === 'published' && Date.parse(campaign.startsAt) <= now() && now() < Date.parse(campaign.endsAt);
  async function funding() {
    if (readFunding) return readFunding();
    if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Promotions require Base');
    const token = new Contract(PROMOTIONS_USDC, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
    const fundId = id(PROMOTIONS_FUND);
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
    const event = receipt.logs.filter(l => lower(l.address) === lower(devertContractAddress)).map(l => {
      try { return events.parseLog(l); } catch { return null; }
    }).find(e => e?.name === 'CampaignCreated' && String(e.args.campaignId) === advertId && lower(e.args.advertiser) === purchaser &&
      e.args.offerUnits > 0n && Number(e.args.startedAt) * 1000 >= Date.parse(campaign.startsAt) &&
      Number(e.args.startedAt) * 1000 < Date.parse(campaign.endsAt));
    if (!event) throw new Error('No matching paid DVert campaign created within this promotion');
    return { purchaseHash, purchaser, advertId, amountUnits: String(event.args.offerUnits) };
  }
  function referralEvidence(next, claim) {
    const week = currentPayrollPeriod(now()).week;
    const joins = next.members.filter(m => m.campaignId === claim.campaignId && m.referrer === claim.wallet);
    const qualified = joins.filter(m => next.votes.some(v => v.wallet === m.wallet &&
      v.week === week && Date.parse(v.at) >= Date.parse(m.joinedAt)));
    if (qualified.length < 2) throw new Error('Two registered referrals must each vote on a song this New York week');
    return { week, wallets: qualified.slice(0, 2).map(m => m.wallet) };
  }
  async function snapshot(wallet, admin) {
    const campaigns = state.campaigns.filter(c => admin || c.status !== 'draft' && c.status !== 'archived').map(summary);
    let fund = null;
    let fundingError = '';
    try { fund = (await funding()).toString(); } catch (error) { fundingError = error.message; }
    return structuredClone({ revision: state.revision, viewerWallet: wallet, campaigns, fundSlug: PROMOTIONS_FUND, routerAddress,
      fundBalanceUnits: fund, fundingError, storageError: fault,
      claims: state.claims.filter(c => admin || c.wallet === wallet),
      members: state.members.filter(m => admin || m.wallet === wallet),
      referrals: wallet ? { registered: state.members.filter(m => m.referrer === wallet).length,
        activeThisWeek: state.members.filter(m => m.referrer === wallet && state.votes.some(v => v.wallet === m.wallet &&
          v.week === currentPayrollPeriod(now()).week && Date.parse(v.at) >= Date.parse(m.joinedAt))).length } : null,
      activity: wallet ? { week: currentPayrollPeriod(now()).week,
        voted: state.votes.some(v => v.wallet === wallet && v.week === currentPayrollPeriod(now()).week) } : null,
    });
  }
  async function reconcile(next, claim, hash) {
    if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Payment reconciliation requires Base');
    if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('Enter a valid Base transaction hash');
    if (next.claims.some(c => c.id !== claim.id && c.txHash === lower(hash))) throw new Error('Transaction already assigned');
    const receipt = await provider.getTransactionReceipt(hash);
    if (claim.txHash && claim.txHash !== lower(hash) && (!receipt || Number(receipt.status) !== 1)) {
      throw new Error('Original payment is unresolved; only a matching successful replacement may reconcile another hash');
    }
    if (!receipt || await provider.getBlockNumber() - receipt.blockNumber + 1 < 2) {
      claim.txHash = lower(hash);
      claim.status = 'payment-pending';
      return;
    }
    if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error('Payment is not in the canonical Base block');
    if (lower(receipt.to) !== lower(routerAddress)) throw new Error('Wrong payment transaction target');
    if (Number(receipt.status) !== 1) {
      if (claim.txHash && claim.txHash !== lower(hash)) throw new Error('Check the originally recorded payment before another hash');
      claim.txHash = '';
      claim.status = 'approved';
      claim.lastRevertedHash = lower(hash);
      return;
    }
    const events = receipt.logs.flatMap(log => {
      if (![lower(routerAddress), lower(PROMOTIONS_USDC)].includes(lower(log.address))) return [];
      try { return [{ emitter: lower(log.address), parsed: paymentInterface.parseLog(log) }]; } catch { return []; }
    });
    const reference = id(promotionWorkReference(claim));
    const match = events.some(({ emitter, parsed: e }) => emitter === lower(routerAddress) && e?.name === 'PayrollPaid' &&
      e.args.fundId === id(PROMOTIONS_FUND) && lower(e.args.asset) === lower(PROMOTIONS_USDC) &&
      lower(e.args.recipient) === claim.wallet && e.args.amount === BigInt(claim.amountUnits) && e.args.workReference === reference);
    const transfer = events.some(({ emitter, parsed: e }) => emitter === lower(PROMOTIONS_USDC) && e?.name === 'Transfer' &&
      lower(e.args.from) === lower(routerAddress) && lower(e.args.to) === claim.wallet && e.args.value === BigInt(claim.amountUnits));
    if (!match || !transfer) throw new Error('Missing matching Promotionals payout and USDC transfer proofs');
    claim.status = 'paid';
    claim.txHash = lower(hash);
    claim.paymentBlockNumber = receipt.blockNumber;
    claim.paymentBlockHash = receipt.blockHash;
    claim.paidAt = new Date(now()).toISOString();
  }
  return {
    async publicState() {
      await initialize();
      return { campaigns: state.campaigns.filter(c => !['draft', 'archived'].includes(c.status)).map(summary),
        notice: 'Rewards require evidence and admin approval. Budgets are earmarked, not escrowed. No unique-human or guaranteed-listening claim.' };
    },
    async execute(body, origin) {
      return run(async () => {
        await initialize();
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
        const adminActions = ['save', 'status', 'review', 'prepare-payment', 'reconcile'];
        if (adminActions.includes(command.action)) {
          if (!admin) throw new Error('Only the configured admin may manage promotions');
          if (command.revision !== state.revision) throw new Error('Promotions changed; refresh before retrying');
        }
        if (command.action === 'save') {
          if (!campaign && next.campaigns.length >= 1000) throw new Error('Promotion storage capacity reached; export and review before adding offers');
          if (campaign && campaign.status !== 'draft') throw new Error('Published terms are immutable; duplicate into a new draft');
          const input = command.campaign;
          if (!PROMOTION_TEMPLATES.some(t => t.id === input?.template)) throw new Error('Unknown promotion template');
          const startsAt = new Date(text(input.startsAt, 'Start')).toISOString();
          const endsAt = new Date(text(input.endsAt, 'End')).toISOString();
          const claimDeadline = new Date(text(input.claimDeadline, 'Claim deadline')).toISOString();
          if (!(Date.parse(startsAt) < Date.parse(endsAt) && Date.parse(endsAt) <= Date.parse(claimDeadline))) throw new Error('Start must precede end, and claim deadline must be at/after end');
          if (!Number.isSafeInteger(input.maxAwards) || input.maxAwards < 1 || input.maxAwards > 10000) throw new Error('Max awards must be 1-10000');
          const rewardUnits = units(input.rewardUnits), budgetUnits = units(input.budgetUnits);
          if (BigInt(budgetUnits) < BigInt(rewardUnits)) throw new Error('Budget must cover at least one reward');
          const saved = { id: campaign?.id || randomUUID(), status: 'draft', version: 1, title: text(input.title, 'Title', 100),
            template: input.template, criteria: text(input.criteria, 'Qualification terms'), terms: text(input.terms, 'Limits, privacy, disputes and refund terms'),
            rewardUnits, budgetUnits, maxAwards: input.maxAwards, startsAt, endsAt, claimDeadline,
            fund: PROMOTIONS_FUND, createdAt: campaign?.createdAt || at, updatedAt: at };
          if (campaign) Object.assign(campaign, saved);
          else next.campaigns.push(saved);
        } else if (command.action === 'status') {
          if (!campaign || !statuses.has(command.status)) throw new Error('Invalid campaign status');
          const allowed = { draft: ['published', 'archived'], published: ['paused', 'closed'], paused: ['published', 'closed'], closed: ['archived'], archived: [] };
          if (!allowed[campaign.status].includes(command.status)) throw new Error('Invalid campaign transition');
          if (command.status === 'published') {
            if (now() >= Date.parse(campaign.endsAt)) throw new Error('Offer has expired');
            const balance = await funding();
            const otherBudgets = next.campaigns.filter(c => c.id !== campaign.id && ['published', 'paused', 'closed'].includes(c.status))
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
          const referrer = command.referrer ? address(command.referrer) : '';
          if (next.members.length >= 10000) throw new Error('Promotion participant capacity reached');
          if (referrer && next.members.some(m => m.wallet === wallet)) throw new Error('Only new promotion participants can be referrals');
          if (referrer && (referrer === wallet || !next.members.some(m => m.wallet === referrer && m.campaignId === campaign.id))) throw new Error('Referrer must be a different registered participant in this promotion');
          next.members.push({ wallet, campaignId: campaign.id, referrer, joinedAt: at });
        } else if (command.action === 'vote') {
          if (next.votes.length >= 30000) throw new Error('Promotion activity capacity reached');
          if (!campaign || !open(campaign) || !next.members.some(m => m.wallet === wallet && m.campaignId === campaign.id)) throw new Error('Join an open promotion first');
          if (!/^[a-zA-Z0-9_-]{16,128}$/.test(command.voterId || '') || ![1, -1].includes(command.vote)) throw new Error('Invalid promotion vote');
          const browser = id(command.voterId);
          if (next.votes.some(v => v.browser === browser && v.wallet !== wallet)) throw new Error('This browser has already qualified a different wallet');
          if (!voteOnRadio) throw new Error('Radio voting is unavailable');
          const result = await voteOnRadio({ playId: command.playId, voterId: command.voterId, vote: command.vote });
          if (result.playId !== command.playId || ![1, -1].includes(result.vote)) throw new Error('Radio did not confirm a song vote');
          const week = currentPayrollPeriod(now()).week;
          if (!next.votes.some(v => v.wallet === wallet && v.week === week)) next.votes.push({ wallet, browser, week, playId: command.playId, at: new Date(now()).toISOString() });
        } else if (command.action === 'claim') {
          if (next.claims.length >= 10000) throw new Error('Promotion claim capacity reached');
          if (!campaign || !['published', 'paused', 'closed'].includes(campaign.status) || now() > Date.parse(campaign.claimDeadline)) throw new Error('Claim window is closed');
          const member = next.members.find(m => m.wallet === wallet && m.campaignId === campaign.id);
          if (!member) throw new Error('Register before the promotion closes');
          if (next.claims.some(c => c.campaignId === campaign.id && c.wallet === wallet)) throw new Error('One claim per participant per campaign');
          const claim = { id: randomUUID(), campaignId: campaign.id, wallet, amountUnits: campaign.rewardUnits,
            status: 'submitted', evidence: text(command.evidence, 'Evidence'), createdAt: at, termsVersion: campaign.version, history: [] };
          if (campaign.template === 'referral') claim.qualification = referralEvidence(next, claim);
          if (campaign.template === 'sponsor') {
            claim.purchaseHash = text(command.purchaseHash, 'Purchase hash', 66).toLowerCase();
            claim.purchaser = address(command.purchaser);
            claim.advertId = text(command.advertId, 'Advert campaign ID', 30);
            if (next.claims.some(c => c.purchaseHash === claim.purchaseHash && c.advertId === claim.advertId)) throw new Error('DVert conversion already claimed');
            claim.qualification = await sponsorEvidence(claim, campaign);
          }
          next.claims.push(claim);
        } else if (['review', 'prepare-payment', 'reconcile'].includes(command.action)) {
          const claim = next.claims.find(c => c.id === command.claimId);
          if (!claim) throw new Error('Claim not found');
          campaign = next.campaigns.find(c => c.id === claim.campaignId);
          if (command.action === 'review') {
            if (!['submitted', 'needs-evidence'].includes(claim.status) || !['approved', 'rejected', 'needs-evidence'].includes(command.decision)) throw new Error('Claim is not reviewable');
            const reason = text(command.reason, 'Review reason');
            if (command.decision === 'approved') {
              if (campaign.template === 'referral') claim.qualification = referralEvidence(next, claim);
              if (campaign.template === 'sponsor') claim.qualification = await sponsorEvidence(claim, campaign);
              const s = summary(campaign);
              if (!s.remainingAwards || BigInt(s.remainingUnits) < BigInt(claim.amountUnits)) throw new Error('Campaign reward capacity exhausted');
              const balance = await funding();
              const reserved = next.claims.filter(c => held(c) && c.status !== 'paid').reduce((n, c) => n + BigInt(c.amountUnits), 0n);
              if (balance < reserved + BigInt(claim.amountUnits)) throw new Error('Promotionals balance cannot cover reward commitments');
              // No automatic stacking of the same participant's promotional rewards.
              if (next.claims.some(c => c.id !== claim.id && c.wallet === claim.wallet && held(c))) throw new Error('Participant already has another approved promotional reward; review stacking outside this pilot');
            }
            claim.status = command.decision;
            claim.history.push({ at, action: command.decision, reason, reviewer: owner });
          } else if (command.action === 'prepare-payment') {
            if (claim.status !== 'approved' && !(claim.status === 'payment-pending' && !claim.txHash)) throw new Error('Reward is not approved or already has an unresolved payment');
            await funding();
            claim.status = 'payment-pending';
            claim.paymentPreparedAt = at;
          } else {
            if (!['approved', 'payment-pending'].includes(claim.status)) throw new Error('Claim does not need payment reconciliation');
            await reconcile(next, claim, command.txHash);
          }
        } else if (command.action === 'evidence') {
          const claim = next.claims.find(c => c.id === command.claimId && c.wallet === wallet);
          if (!claim || claim.status !== 'needs-evidence') throw new Error('Claim is not awaiting evidence');
          claim.evidence = text(command.evidence, 'Evidence');
          claim.status = 'submitted';
        } else throw new Error('Unknown promotion action');
        await persist(next);
        return snapshot(wallet, admin);
      });
    },
  };
}
