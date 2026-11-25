import { randomBytes, randomInt } from 'node:crypto';
import { id, verifyMessage } from 'ethers';
import { currentPayrollPeriod, payrollPeriodFromKey } from '../js/payroll-week.mjs';
import { BASE_USDC_ADDRESS } from '../js/settlement-funds.mjs';
import { allocatePinnerRewards, buildPinnerCommandMessage, buildPinnerReceipt, PINNER_FUND, PINNER_POLICY,
  pinnerWeekStats, validatePinnerCheckpoint } from '../js/pinner-rewards.mjs';
import { normalizePinnerPeerId } from './pinner-probe.js';
import { checkpointContentCid } from './checkpoint-mirror.js';

const statusAt = (pinner, at) => pinner.statusEvents.filter(event => Date.parse(event.at) <= at).at(-1)?.status || 'pending';

export function createPinnerNetwork({ restore, save, upload, router, ownerWallet, getManifest,
  verifyMember, probe, getClosingBalance, now = () => Date.now(), choose = randomInt }) {
  const routerAddress = String(router.target).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(routerAddress) || !/^0x[0-9a-fA-F]{40}$/.test(ownerWallet || '') ||
    typeof getClosingBalance !== 'function') throw new Error('Pinner rewards require the configured owner, router and closing-balance verifier');
  let state, ready = false, task = Promise.resolve(), lastError = '', lastCheckedAt = null;
  let paidReferences = new Set();
  let fund = { balanceUnits: '0', reservedUnits: '0', availableUnits: '0', exists: false, active: false };
  const serialize = operation => {
    const result = task.then(operation);
    task = result.catch(() => {});
    return result;
  };
  const requireReady = () => { if (!ready) throw new Error('Pinner rewards are restoring'); };
  const persist = async next => {
    next = { ...next, revision: next.revision + 1,
      nonces: next.nonces.filter(nonce => nonce.expiresAt > now()) };
    validatePinnerCheckpoint(next);
    const uri = await save(next);
    if (!/^ipfs:\/\/[^/\s]+$/.test(uri || '')) throw new Error('Pinner reward checkpoint did not confirm');
    state = next;
  };
  const pendingUnits = async () => {
    let units = 0n;
    const paid = new Set();
    for (const record of state.receipts) {
      for (const entry of record.allocation.entries) {
        if (!await router.completedWorkReferences(id(entry.workReferenceText))) units += BigInt(entry.amountUnits);
        else paid.add(entry.workReferenceText);
      }
    }
    paidReferences = paid;
    return units;
  };
  const refreshFund = async () => {
    if (Number((await router.runner.getNetwork()).chainId) !== 8453) throw new Error('Pinner rewards require Base');
    const definition = await router.funds(id(PINNER_FUND));
    const exists = Boolean(definition.exists ?? definition[2]);
    const active = Boolean(definition.active ?? definition[1]);
    const approved = await router.approvedAssets(BASE_USDC_ADDRESS);
    const balance = exists ? await router.fundBalances(id(PINNER_FUND), BASE_USDC_ADDRESS) : 0n;
    const reserved = await pendingUnits();
    fund = { exists, active, assetApproved: approved, balanceUnits: balance.toString(),
      reservedUnits: reserved.toString(), availableUnits: (balance > reserved ? balance - reserved : 0n).toString(),
      warning: !exists || !active ? 'The pinner fund must be created and active before awards are prepared'
        : !approved ? 'Base USDC must be approved' : balance < reserved ? 'Unpaid awards exceed the fund balance; replenish before settlement'
          : balance === reserved ? 'No unreserved USDC is available' : '' };
  };
  const publish = async (value, name) => {
    const json = JSON.stringify(value);
    const uri = await upload(Buffer.from(json), name, 'application/json');
    if (!/^ipfs:\/\/[^/\s]+$/.test(uri || '')) throw new Error('Pinner evidence did not receive an immutable IPFS URI');
    return { uri, hash: id(json) };
  };
  async function closeWeeks() {
    for (let count = 0; count < 12; count++) {
      const period = currentPayrollPeriod(Date.parse(state.nextWeekStartAt));
      const cutoff = Date.parse(period.endAt);
      if (cutoff > now()) return;
      const checks = state.checks.filter(check => Date.parse(check.at) >= Date.parse(period.startAt) && Date.parse(check.at) < cutoff);
      const pinners = state.pinners.filter(pinner => statusAt(pinner, cutoff - 1) === 'active')
        .map(pinner => pinnerWeekStats(checks, pinner.wallet, period));
      const closing = fund.exists && fund.active && fund.assetApproved
        ? await getClosingBalance({ report: period, fundSlug: PINNER_FUND, allocations: state.receipts }) : 0n;
      const available = BigInt(fund.availableUnits);
      const budgetUnits = closing < available ? closing : available;
      const evidence = await publish({ schema: 'pinner-checks/v1', ...period, checks }, `${period.week}-pinner-checks.json`);
      const allocation = buildPinnerReceipt({ week: period.week, budgetUnits, pinners, routerAddress,
        checksUri: evidence.uri, checksHash: evidence.hash, generatedAt: new Date(now()).toISOString() });
      const metadata = await publish(allocation, `${period.week}-pinner-rewards.json`);
      await persist({ ...state, nextWeekStartAt: period.endAt,
        checks: state.checks.filter(check => Date.parse(check.at) >= cutoff),
        receipts: [...state.receipts, { allocation, metadataUri: metadata.uri, metadataHash: metadata.hash }] });
      await refreshFund();
    }
  }
  async function update() {
    requireReady();
    await refreshFund();
    await closeWeeks();
    const due = state.pinners.find(pinner => statusAt(pinner, now()) === 'active' && Date.parse(pinner.nextCheckAt) <= now());
    if (due) {
      const manifest = await getManifest();
      if (!Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error('No public content is available for pinner checks');
      const rootCid = manifest.entries[choose(manifest.entries.length)].cid;
      const result = await probe.check({ peerId: due.peerId, rootCid, ownershipCid: due.ownershipCid });
      if (typeof result.ok !== 'boolean' || !Number.isSafeInteger(result.latencyMs) || result.latencyMs < 0) {
        throw new Error('Invalid independent pinner probe result');
      }
      const at = new Date(now()).toISOString();
      const nextCheckAt = new Date(now() + choose(45 * 60000, 75 * 60000)).toISOString();
      const check = { wallet: due.wallet, at, rootCid, blockCid: result.blockCid || '',
        ok: result.ok, latencyMs: result.latencyMs, ...(result.reason ? { reason: result.reason } : {}) };
      await persist({ ...state, checks: [...state.checks, check],
        pinners: state.pinners.map(pinner => pinner.wallet === due.wallet ? { ...pinner, nextCheckAt } : pinner) });
    }
    lastCheckedAt = new Date(now()).toISOString();
    lastError = '';
    return getState();
  }
  const guarded = operation => serialize(async () => {
    try { return await operation(); }
    catch (error) { lastError = error.message; throw error; }
  });
  function getState() {
    const period = currentPayrollPeriod(now());
    const participants = (state?.pinners || []).map(pinner => {
      const stats = pinnerWeekStats(state.checks, pinner.wallet, period);
      const total = stats.successfulChecks + stats.failedChecks;
      const age = now() - Date.parse(stats.lastVerifiedAt);
      const qualified = statusAt(pinner, now()) === 'active' && total >= PINNER_POLICY.minimumChecks &&
        stats.successfulChecks * 10000 >= total * PINNER_POLICY.minimumAvailabilityBps && age >= 0 && age <= PINNER_POLICY.staleAfterMs;
      return { wallet: pinner.wallet, peerId: pinner.peerId, status: statusAt(pinner, now()), ...stats, qualified,
        availabilityBps: total ? Math.floor(stats.successfulChecks * 10000 / total) : 0,
        nextCheckAt: pinner.nextCheckAt, lastCheck: state.checks.filter(check => check.wallet === pinner.wallet).at(-1) || null };
    });
    const estimate = allocatePinnerRewards({ fundBalanceUnits: BigInt(fund.availableUnits),
      pinners: participants.filter(pinner => pinner.status === 'active'), ...PINNER_POLICY, now: now() });
    return structuredClone({ ready, rewardStatus: !ready ? 'restoring' : lastError ? 'unavailable' : 'active',
      revision: state?.revision || 0, chainId: 8453, routerAddress, ownerWallet: ownerWallet.toLowerCase(),
      fundSlug: PINNER_FUND, policy: { ...PINNER_POLICY }, currentPeriod: period, nextCloseAt: period.endAt,
      startedAt: state?.startedAt, fund, participants: participants.map(pinner => ({ ...pinner,
        estimatedUnits: estimate.eligible.find(entry => entry.wallet === pinner.wallet)?.amountUnits.toString() || '0' })),
      receipts: (state?.receipts || []).map(record => ({ ...record,
        paidWorkReferences: record.allocation.entries.filter(entry => paidReferences.has(entry.workReferenceText))
          .map(entry => entry.workReferenceText) })), lastCheckedAt, lastError });
  }
  return {
    getState,
    initialize: () => guarded(async () => {
      if (!ready) {
        await probe.initialize();
        const restored = await restore();
        if (restored) {
          validatePinnerCheckpoint(restored);
          if (restored.routerAddress !== routerAddress) throw new Error('Pinner checkpoint belongs to another router');
          for (const record of restored.receipts) {
            if (id(JSON.stringify(record.allocation)) !== record.metadataHash) throw new Error('Pinner allocation digest mismatch');
          }
          state = restored;
        } else {
          await persist({ schema: 'pinner-network/v1', revision: 0, routerAddress,
            startedAt: new Date(now()).toISOString(), nextWeekStartAt: currentPayrollPeriod(now()).startAt,
            pinners: [], checks: [], receipts: [], nonces: [] });
        }
        ready = true;
      }
      return update();
    }),
    tick: () => guarded(update),
    command: (body, origin) => serialize(async () => {
      requireReady();
      const { action, revision, nonce, issuedAt } = body;
      const address = String(body.address || '').toLowerCase(), wallet = String(body.wallet || '').toLowerCase();
      if (!['enroll', 'approve', 'suspend'].includes(action) || !/^0x[0-9a-f]{40}$/.test(address) ||
        !/^0x[0-9a-f]{40}$/.test(wallet) || revision !== state.revision ||
        !/^[a-zA-Z0-9-]{16,80}$/.test(nonce || '') || !Number.isFinite(Date.parse(issuedAt || '')) ||
        Math.abs(now() - Date.parse(issuedAt)) > 300000) throw new Error('Invalid, stale or expired pinner authorization; refresh and sign again');
      const peerId = normalizePinnerPeerId(body.peerId);
      const message = buildPinnerCommandMessage({ ...body, origin });
      if (verifyMessage(message, body.signature).toLowerCase() !== address) throw new Error('Pinner signature does not match the signing wallet');
      const nonceHash = id(`${address}:${nonce}`);
      if (state.nonces.some(item => item.hash === nonceHash && item.expiresAt > now())) throw new Error('Pinner authorization already used');
      if (action === 'enroll' ? address !== wallet : address !== ownerWallet.toLowerCase()) throw new Error('Only the pinner may enroll; only the owner may approve or suspend');
      const previous = state.pinners.find(pinner => pinner.wallet === wallet);
      let next, ownership;
      if (action === 'enroll') {
        const memberHash = await verifyMember(wallet);
        if (!/^0x[0-9a-f]{64}$/.test(memberHash || '')) throw new Error('Discord membership verifier did not confirm a stable identity');
        if (state.pinners.some(pinner => pinner.wallet !== wallet && pinner.memberHash === memberHash &&
          statusAt(pinner, now()) !== 'suspended')) throw new Error('This Discord member already has a registered pinner wallet; ask the admin to suspend the old node before changing wallets');
        if (state.pinners.some(pinner => pinner.wallet !== wallet && pinner.peerId === peerId &&
          statusAt(pinner, now()) !== 'suspended')) throw new Error('This IPFS peer is already registered to another wallet');
        if (!previous && state.pinners.length >= 1000) throw new Error('Pinner registration capacity reached; contact the admin');
        const bytes = randomBytes(64);
        ownership = { cid: await checkpointContentCid(bytes), contentBase64: bytes.toString('base64') };
        next = { wallet, memberHash, peerId, ownershipCid: ownership.cid, nextCheckAt: new Date(now()).toISOString(),
          statusEvents: [...(previous?.statusEvents || []), { status: 'pending', at: new Date(now()).toISOString() }] };
      } else {
        if (!previous || previous.peerId !== peerId) throw new Error('Pinner registration changed; refresh before approval');
        if (action === 'approve') {
          if (await verifyMember(wallet) !== previous.memberHash) throw new Error('Discord identity changed; enroll again before approval');
          const ownershipCheck = await probe.check({ peerId, rootCid: previous.ownershipCid });
          if (ownershipCheck.ok !== true) throw new Error(`Node ownership could not be verified: ${ownershipCheck.reason || 'marker unavailable'}. Pin the enrollment marker and keep the node publicly reachable before approval.`);
        }
        next = { ...previous, nextCheckAt: new Date(now()).toISOString(),
          statusEvents: [...previous.statusEvents, { status: action === 'approve' ? 'active' : 'suspended', at: new Date(now()).toISOString() }] };
      }
      await persist({ ...state, pinners: [...state.pinners.filter(pinner => pinner.wallet !== wallet), next],
        nonces: [...state.nonces, { hash: nonceHash, expiresAt: now() + 300000 }] });
      return { ...getState(), ...(ownership ? { ownership } : {}) };
    }),
  };
}
