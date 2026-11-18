import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Interface, id, verifyMessage } from 'ethers';
import { SETTLEMENT_ROUTER_ADDRESS as ROUTER } from '../js/fund-contribution.mjs';
import { BASE_USDC_ADDRESS as USDC } from '../js/settlement-funds.mjs';
import { DMTV_FUND_SLUG, DMTV_MAIN_RADIO_CREATOR_UNITS, DMTV_MAIN_RADIO_FUND_UNITS } from '../js/dmtv.mjs';
import { dmtvRadioAuthorization } from '../js/dmtv-radio.mjs';

const hashPattern = /^0x[0-9a-f]{64}$/i;
const addressPattern = /^0x[0-9a-f]{40}$/i;
const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
export function isDmtvRadioCheckpoint(snapshot) {
  return snapshot?.version === 1 && Array.isArray(snapshot.requests) && snapshot.requests.every(record =>
    record?.kind === 'dmtv' && /^dmtv:[a-f0-9-]{36}$/i.test(record.requestId) &&
    ['pending', 'reserved', 'played'].includes(record.state) &&
    hashPattern.test(record.creatorTx) && hashPattern.test(record.fundTx) &&
    !same(record.creatorTx, record.fundTx) && addressPattern.test(record.track?.creator) &&
    typeof record.track.nftId === 'string' && !!record.track.nftId &&
    typeof record.track.ipfsCid === 'string' && !!record.track.ipfsCid);
}
const fundId = id(DMTV_FUND_SLUG);
const abi = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
]);

export function verifyDmtvRadioReceipts(quote, creator, fund) {
  const { payer, track, block } = quote;
  for (const [receipt, to] of [[creator, USDC], [fund, ROUTER]]) {
    if (receipt?.status !== 1 || receipt.blockNumber <= block ||
        !same(receipt.from, payer) || !same(receipt.to, to)) {
      throw new Error('DMTv requires two successful Base payments made after checkout opened.');
    }
  }
  const has = (receipt, address, name, matches) => receipt.logs.some(log => {
    if (!same(log.address, address)) return false;
    const event = abi.parseLog(log);
    return event?.name === name && matches(event.args);
  });
  if (!has(creator, USDC, 'Transfer', a => same(a.from, payer) && same(a.to, track.creator) &&
      a.value === DMTV_MAIN_RADIO_CREATOR_UNITS) ||
      !has(fund, USDC, 'Transfer', a => same(a.from, payer) && same(a.to, ROUTER) && a.value === DMTV_MAIN_RADIO_FUND_UNITS) ||
      !has(fund, ROUTER, 'FundFunded', a => a.fundId === fundId && same(a.asset, USDC) &&
      same(a.funder, payer) && a.amount === DMTV_MAIN_RADIO_FUND_UNITS)) {
    throw new Error('The receipts do not prove the $1 creator share and $2 weekly Playback deposit.');
  }
}

export function createDmtvRadioQueue({ provider, store, secret, findTrack, enabled }) {
  let state;
  let serial = Promise.resolve();
  const run = fn => {
    const result = serial.then(fn);
    serial = result.catch(() => {});
    return result;
  };
  async function restore() {
    if (state) return;
    const saved = await store.restore();
    if (saved != null && !isDmtvRadioCheckpoint(saved)) {
      throw new Error('Invalid DMTv radio checkpoint.');
    }
    state = (saved?.requests || []).map(record => record.state === 'reserved'
      ? { ...record, state: 'pending' } : record);
  }
  async function save(requests) {
    if (!await store.save({ version: 1, requests })) throw new Error('DMTv radio checkpoint did not persist.');
    state = requests;
  }
  const sign = payload => createHmac('sha256', secret).update(`dmtv-radio/v1:${payload}`).digest();
  function decode(ticket) {
    if (typeof ticket !== 'string' || ticket.length > 5000 || !/^[\w-]+\.[\w-]+$/.test(ticket)) {
      throw new Error('Invalid DMTv checkout.');
    }
    const [payload, signature] = ticket.split('.');
    const bytes = Buffer.from(signature, 'base64url');
    if (bytes.length !== 32 || !timingSafeEqual(bytes, sign(payload))) throw new Error('Invalid DMTv checkout.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  }
  function update(requestId, fields) {
    return save(state.map(request => request.requestId === requestId ? { ...request, ...fields } : request));
  }
  return {
    async status() {
      if (!enabled()) return { enabled: false };
      await run(restore);
      return { enabled: true };
    },
    async quote({ payer, nftId }) {
      if (!enabled()) throw new Error('DMTv main-radio checkout is unavailable.');
      if (!addressPattern.test(payer || '') || typeof nftId !== 'string' || nftId.length > 128) {
        throw new Error('Select an archive video and connect your Base wallet.');
      }
      await run(restore);
      const track = await findTrack(nftId);
      if (!track || !addressPattern.test(track.creator) || same(track.creator, payer)) {
        throw new Error('This archive video is not eligible for a paid main-radio spot.');
      }
      const block = await provider.getBlockNumber();
      const payload = Buffer.from(JSON.stringify({ quoteId: randomUUID(), payer, nftId, track, block })).toString('base64url');
      return { ticket: `${payload}.${sign(payload).toString('base64url')}`, creator: track.creator };
    },
    async submit({ ticket, creatorTx, fundTx, signature }) {
      const quote = decode(ticket);
      if (!hashPattern.test(creatorTx || '') || !hashPattern.test(fundTx || '') || same(creatorTx, fundTx) ||
          !same(verifyMessage(dmtvRadioAuthorization(ticket, creatorTx, fundTx), signature), quote.payer)) {
        throw new Error('DMTv radio submission must be signed by the paying wallet.');
      }
      const requestId = `dmtv:${quote.quoteId}`;
      const result = record => ({ requestId, state: record.state, title: record.track.title });
      return run(async () => {
        await restore();
        const existing = state.find(record => record.requestId === requestId);
        if (existing && same(existing.creatorTx, creatorTx) && same(existing.fundTx, fundTx)) return result(existing);
        if (existing || state.some(record => [record.creatorTx, record.fundTx].some(hash =>
          same(hash, creatorTx) || same(hash, fundTx)))) throw new Error('A DMTv payment is already assigned to a request.');
        const [creator, fund, block] = await Promise.all([
          provider.getTransactionReceipt(creatorTx), provider.getTransactionReceipt(fundTx), provider.getBlockNumber(),
        ]);
        if (!creator || !fund || block - Math.max(creator.blockNumber, fund.blockNumber) < 1) {
          throw new Error('Wait for two Base confirmations, then resume this purchase.');
        }
        verifyDmtvRadioReceipts(quote, creator, fund);
        const record = { requestId, creatorTx, fundTx, track: quote.track, kind: 'dmtv', state: 'pending' };
        await save([...state, record]);
        return result(record);
      });
    },
    nextPaid() {
      return run(async () => {
        await restore();
        const entry = state.find(record => record.state === 'pending' && (record.retryAfter || 0) <= Date.now());
        if (!entry) return null;
        const eligibility = await findTrack(entry.track.nftId);
        if (!eligibility || eligibility.ipfsCid !== entry.track.ipfsCid) {
          await update(entry.requestId, { retryAfter: Date.now() + 60_000 });
          throw new Error(`DMTv request ${entry.requestId} is awaiting archive media verification.`);
        }
        await update(entry.requestId, { state: 'reserved' });
        return { record: { requestId: entry.requestId, kind: entry.kind }, track: entry.track };
      });
    },
    complete(record, play) {
      return run(async () => {
        await restore();
        if (!state.some(entry => entry.requestId === record.requestId && entry.state === 'reserved')) return;
        await update(record.requestId, play?.finished && play.audibleMs > 0
          ? { state: 'played', playId: play.playId }
          : { state: 'pending', retryAfter: Date.now() + 60_000 });
      });
    },
    fail(record, error) {
      return run(async () => {
        await restore();
        if (!state.some(entry => entry.requestId === record.requestId && entry.state === 'reserved')) return;
        await update(record.requestId, { state: 'pending', retryAfter: Date.now() + 60_000, lastError: String(error.message).slice(0, 250) });
      });
    },
    release(record) {
      return run(async () => {
        await restore();
        if (!state.some(entry => entry.requestId === record.requestId && entry.state === 'reserved')) return;
        await update(record.requestId, { state: 'pending' });
      });
    },
  };
}
