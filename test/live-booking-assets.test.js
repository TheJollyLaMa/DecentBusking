const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('../discord-bot/node_modules/ethers');
const owner = ethers.Wallet.createRandom(), performer = ethers.Wallet.createRandom(), outsider = ethers.Wallet.createRandom();
const escrow = '0x1111111111111111111111111111111111111111';
const treasury = '0x2222222222222222222222222222222222222222';
const collection = '0x3333333333333333333333333333333333333333';
const token = '0x4444444444444444444444444444444444444444';
const now = Date.parse('2026-10-22T12:00:00Z');
const bookingId = 'live:asset:2026-10-23';

async function fixture(enabled = true) {
 const shared = await import('../js/live-bookings.mjs');
 const { createLiveBookings } = await import('../discord-bot/live-bookings.js');
 const iface = new ethers.Interface(shared.LIVE_ASSET_ESCROW_ABI);
 let state, head = 99, epoch = 0, logs = [], receipts = new Map(), chain = 8453n, online = true;
 const blockHash = n => ethers.id(`block:${epoch}:${n}`);
 const provider = {
  getNetwork:async () => ({ chainId:chain }), getCode:async () => online ? '0x01' : '0x',
  getBlockNumber:async () => head, getBlock:async n => ({ hash:blockHash(n) }),
  getLogs:async ({ fromBlock,toBlock }) => logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
  getTransactionReceipt:async hash => receipts.get(hash) || null,
 };
 const config = { provider, ownerWallet:owner.address, assetEscrowAddress:escrow,
  assetEscrowStartBlock:100, assetBookingsEnabled:enabled, giftTreasuryAddress:treasury, now:() => now,
  assetReader:async address => address === shared.LIVE_ZERO_ADDRESS
   ? { decimals:18,symbol:'ETH',approved:true } : { decimals:6,symbol:'USDC',approved:address === token },
  save:async value => { state = structuredClone(value); return 'ipfs://checkpoint'; },
  restore:async () => state, getSchedule:async () => ({ ready:true,events:[],weeklySchedule:{} }),
  saveSchedule:async () => {},
 };
 const service = createLiveBookings(config);
 const input = { performer:performer.address, displayName:'Artist', title:'Set', eventId:'friday-live-performance:2026-10-23',
  startUtc:'2026-10-24T01:00:00Z', endUtc:'2026-10-24T01:20:00Z', airtimeMinutes:20,
  mode:'phase1', escrowVersion:shared.LIVE_ASSET_VERSION, payoutPolicy:shared.LIVE_ASSET_POLICY,
  assetAddress:token, assetDecimals:6, assetSymbol:'USDC', amountUnits:'20000000',
  gift:{ collection,tokenId:'75',quantity:'1',treasury },
  termsVersion:'LIVE PERFORMANCE ASSETS v1', termsUri:'ipfs://assetterms', termsHash:ethers.id('fresh asset terms'),
  stewardApproved:true, reviewWindow:3600, cancellationWindow:0, killFeeBps:0, claimDeadline:'2026-10-29T01:20:00Z',
 };
 async function exec(command) {
  return service.execute({ ...command, revision:(await service.getState()).revision });
 }
 async function create(overrides = {}) { return exec({ action:'create',id:bookingId,booking:{...input,...overrides} }); }
 async function acknowledge() {
  const b = (await service.getState()).bookings[0];
  return service.acknowledgePerformer({ id:bookingId,address:performer.address,signature:await performer.signMessage(shared.liveAcknowledgement(b)) });
 }
 function add(block, name, args, index = 0) {
  const hash = ethers.id(`${epoch}:${block}:${name}:${index}`);
  const data = iface.encodeEventLog(iface.getEvent(name), args);
  const log = { ...data,address:escrow,blockNumber:block,index,transactionHash:hash };
  logs.push(log);
  receipts.set(hash,{ status:1,to:escrow,blockNumber:block,blockHash:blockHash(block),logs:[log] });
  return hash;
 }
 return { shared,service,input,create,acknowledge,exec,add,provider,iface, state:() => state,
  restart:enabled => createLiveBookings({ ...config,assetBookingsEnabled:enabled }),
  head:n => { head = n; }, chain:n => { chain = n; }, online:v => { online = v; },
  receipt:(hash,value) => { if (value) receipts.set(hash,value); else receipts.delete(hash); },
  blockHash,
  replace:() => { epoch++; logs = []; receipts = new Map(); } };
}
test('new terms require configured Base asset, exact decimals and signed wallet/edition/treasury', async () => {
 const f = await fixture();
 await assert.rejects(f.create({ assetDecimals:18 }), /decimals/);
 await assert.rejects(f.create({ assetAddress:outsider.address }), /approved/);
 await assert.rejects(f.create({ gift:{ ...f.input.gift,treasury:outsider.address } }), /gift/);
 f.chain(1n); await assert.rejects(f.create(), /unavailable|Base/); f.chain(8453n);
 const b = (await f.create()).bookings[0];
 assert.match(f.shared.liveAcknowledgement(b), /20 USDC/);
 assert.match(f.shared.liveAcknowledgement(b), /token ID: 75; quantity: 1/);
 assert.match(f.shared.liveAcknowledgement(b), /administrator can recover/i);
 const wrong = await performer.signMessage(f.shared.liveAcknowledgement({ ...b,amountUnits:'20000001' }));
 await assert.rejects(f.service.acknowledgePerformer({id:bookingId,address:performer.address,signature:wrong}), /mismatch/);
 await f.acknowledge();
 const identity = await f.service.getBookingIdentity(bookingId);
 assert.equal(identity.version,'assets-v1');
 assert.equal(identity.terms.quantity,'1');
});
test('native ETH is fixed exact units and no gift is falsely reserved', async () => {
 const f = await fixture();
 const b = (await f.create({ assetAddress:f.shared.LIVE_ZERO_ADDRESS, assetDecimals:18, assetSymbol:'ETH',
  amountUnits:'20000000000000000',gift:null })).bookings[0];
 assert.match(f.shared.liveAcknowledgement(b), /0\.02 ETH/);
 assert.equal(b.giftStatus,'none');
 assert.equal(f.shared.formatLiveAsset(b.amountUnits,18,'ETH'),'0.02 ETH');
});
test('new asset invitations default off independently of an available escrow index', async () => {
 const f = await fixture(false);
 const state = await f.service.getState();
 assert.equal(state.assetEscrowConfigured,true);
 assert.equal(state.assetBookingCreationEnabled,false);
 await assert.rejects(f.create(), /disabled/);
});
test('disabling new invitations leaves existing asset funding and indexing available', async () => {
 const f = await fixture(); await f.create(); await f.acknowledge();
 const b = (await f.service.getState()).bookings[0], t = f.shared.assetBookingTerms(b);
 const disabled = f.restart(false);
 let state = await disabled.getState();
 assert.equal(state.assetBookingCreationEnabled,false);
 const receipt = f.add(100,'Funded',[ethers.id(bookingId),b.wallet,owner.address,Object.values(t),b.termsUri]);
 f.head(101); state = await disabled.getState();
 assert.equal(state.bookings[0].status,'funded');
 state = await disabled.execute({action:'transaction',id:bookingId,txAction:'funding',txHash:receipt,revision:state.revision});
 assert.equal(state.bookings[0].transactions.funding.status,'confirmed');
});
test('funding, approval, paid fee and gift receipt index independently; reorg clears evidence', async () => {
 const f = await fixture(); await f.create(); await f.acknowledge();
 const b = (await f.service.getState()).bookings[0], t = f.shared.assetBookingTerms(b), key = ethers.id(bookingId);
 const funded = f.add(100,'Funded',[key,b.wallet,owner.address,Object.values(t),b.termsUri]);
 f.head(100);
 let result = await f.exec({ action:'transaction',id:bookingId,txAction:'funding',txHash:funded });
 assert.equal(result.bookings[0].status,'funding pending');
 f.head(101); result = await f.service.getState();
 assert.equal(result.bookings[0].status,'funded');
 assert.equal(result.bookings[0].giftStatus,'reserved');
 const approve = f.add(102,'FeeDecision',[key,2,'ipfs://report'],0);
 f.add(102,'GiftDecision',[key,2,'ipfs://report'],1);
 f.head(103); result = await f.service.getState();
 assert.equal(result.bookings[0].status,'approved');
 assert.equal(result.bookings[0].giftStatus,'approved');
 assert.equal(result.bookings[0].paidUnits,undefined);
 await f.exec({ action:'transaction',id:bookingId,txAction:'approve',txHash:approve });
 f.add(104,'FeeSettled',[key,3,b.wallet,b.amountUnits]);
 f.head(105); result = await f.service.getState();
 assert.equal(result.bookings[0].status,'paid');
 assert.equal(result.bookings[0].giftStatus,'approved');
 assert.match(f.shared.liveBookingRows(result.bookings), /approved.*Approval is not delivery/);
 f.add(106,'GiftSettled',[key,4,b.wallet,collection,75,1]);
 f.head(107); result = await f.service.getState();
 assert.equal(result.bookings[0].giftStatus,'received');
 f.replace(); result = await f.service.getState();
 assert.equal(result.bookings[0].status,'funding pending');
 assert.equal(result.bookings[0].giftStatus,'not funded');
 assert.equal(result.bookings[0].paidUnits,undefined);
});
test('mismatched funding receipt is rejected; index outages do not present asset custody as available', async () => {
 const f = await fixture(); await f.create(); await f.acknowledge();
 const b = (await f.service.getState()).bookings[0], t = f.shared.assetBookingTerms(b);
 const bad = f.add(100,'Funded',[ethers.id(bookingId),b.wallet,owner.address,Object.values({...t,quantity:'2'}),b.termsUri]);
 f.head(101);
 await assert.rejects(f.exec({action:'transaction',id:bookingId,txAction:'funding',txHash:bad}), /unavailable|catching up|mismatch/);
 const unavailable = (await f.service.getState()).bookings[0];
 assert.equal(unavailable.status,'unavailable');
 assert.equal(unavailable.giftStatus,'unavailable');
 f.online(false);
 assert.equal((await f.service.getState()).assetEscrowConfigured,false);
});
test('gift release stays pending or approved after rejection and can be independently retried', async () => {
 const f = await fixture(); await f.create(); await f.acknowledge();
 const b = (await f.service.getState()).bookings[0], key = ethers.id(bookingId), t = f.shared.assetBookingTerms(b);
 f.add(100,'Funded',[key,b.wallet,owner.address,Object.values(t),b.termsUri]); f.head(101); await f.service.getState();
 f.add(102,'FeeDecision',[key,2,'ipfs://report'],0); f.add(102,'GiftDecision',[key,2,'ipfs://report'],1);
 f.head(103); await f.service.getState();
 const hash = ethers.id('pending gift');
 let result = await f.exec({action:'transaction',id:bookingId,txAction:'giftRelease',txHash:hash});
 assert.equal(result.bookings[0].transactions.giftRelease.status,'pending');
 assert.match(f.shared.liveBookingRows(result.bookings), /release pending; not yet received/);
 f.receipt(hash,{status:0,to:escrow,blockNumber:103,blockHash:f.blockHash(103),logs:[]});
 result = await f.exec({action:'transaction',id:bookingId,txAction:'giftRelease',txHash:hash});
 assert.equal(result.bookings[0].giftStatus,'approved');
 assert.equal(result.bookings[0].transactions.giftRelease.status,'reverted');
 f.add(104,'FeeSettled',[key,3,b.wallet,b.amountUnits],0);
 f.add(104,'GiftSettled',[key,4,b.wallet,collection,75,1],1);
 f.head(105); result = await f.service.getState();
 assert.equal(result.bookings[0].status,'paid');
 assert.equal(result.bookings[0].giftStatus,'received');
});
test('fault returns the gift without reducing the fee, and administrator recovery is explicit', async () => {
 const f = await fixture(); await f.create(); await f.acknowledge();
 const b = (await f.service.getState()).bookings[0], key = ethers.id(bookingId), t = f.shared.assetBookingTerms(b);
 f.add(100,'Funded',[key,b.wallet,owner.address,Object.values(t),b.termsUri]); f.head(101); await f.service.getState();
 f.add(102,'FeeDecision',[key,2,'ipfs://fault'],0);
 f.add(102,'GiftDecision',[key,3,'ipfs://fault'],1);
 f.head(103); let result = await f.service.getState();
 assert.equal(result.bookings[0].status,'approved');
 assert.equal(result.bookings[0].giftStatus,'returning');
 f.add(104,'GiftSettled',[key,5,treasury,collection,75,1],0);
 f.add(104,'Recovery',[key,outsider.address,true,false,'ipfs://recovery'],1);
 f.head(105); result = await f.service.getState();
 assert.equal(result.bookings[0].status,'recovered');
 assert.equal(result.bookings[0].giftStatus,'returned');
 assert.equal(f.shared.claimState(result.bookings[0],escrow,performer.address,Date.parse(b.endUtc)+1000).enabled,false);
 assert.match(f.shared.liveBookingRows(result.bookings), /recovered · not paid/i);
});
test('on-chain performer cancellation updates the calendar and does not invent a gift return', async () => {
 const f = await fixture(); await f.create(); await f.acknowledge();
 const b = (await f.service.getState()).bookings[0], key = ethers.id(bookingId), t = f.shared.assetBookingTerms(b);
 f.add(100,'Funded',[key,b.wallet,owner.address,Object.values(t),b.termsUri]); f.head(101); await f.service.getState();
 f.add(102,'FeeDecision',[key,4,'ipfs://cancel'],0);
 f.add(102,'GiftDecision',[key,3,'ipfs://cancel'],1);
 f.head(103);
 const state = await f.service.getState(), canceled = state.bookings[0];
 assert.equal(canceled.status,'refunding');
 assert.equal(canceled.giftStatus,'returning');
 assert.equal(canceled.cancelled,true);
 assert.equal(canceled.scheduleStatus,'synced');
 assert.doesNotMatch(f.shared.liveBookingRows([canceled]), /Gift: returned/);
});
test('a second performer on the same night gets its own slot occurrence and cannot overlap', async () => {
 const { liveOccurrenceId, overlappingLiveBooking } = await import('../js/live-performance-admin.mjs');
 const first = { eventId:'friday-live-performance:2026-11-20', startUtc:'2026-11-21T02:00:00Z', endUtc:'2026-11-21T02:30:00Z', displayName:'A' };
 assert.equal(liveOccurrenceId('2026-11-20T21:00', []), 'friday-live-performance:2026-11-20');
 assert.equal(liveOccurrenceId('2026-11-20T21:30', [first]), 'friday-live-performance-2130:2026-11-20');
 assert.equal(liveOccurrenceId('2026-11-20T21:30', [{ ...first, cancelled:true }]), 'friday-live-performance:2026-11-20');
 assert.equal(overlappingLiveBooking([first], '2026-11-21T02:30:00Z', '2026-11-21T03:00:00Z'), null);
 assert.equal(overlappingLiveBooking([first], '2026-11-21T02:20:00Z', '2026-11-21T02:50:00Z'), first);
});
test('listing preflight and receipt proof reject wrong inventory and recipient', async () => {
 const f = await fixture();
 const { assertGiftListingsBacked } = await import('../js/live-performance-admin.mjs');
 const { verifyAssetFeeReceipt, verifyAssetCancellationReceipt, assetReceiptCanonical } = await import('../js/live-performance-profile.mjs');
 const gift = f.input.gift;
 const listing = { active:true,nftContract:collection,tokenId:75n,available:77n };
 const market = { target:'0x31b07b83e99A9bdF379bf40225b8A80d3804C89d', nextListingId:async()=>2n,
  getListing:async i => i ? { ...listing, tokenId:76n } : listing };
 const held = n => ({ balanceOf:async (owner,id) => owner === market.target && BigInt(id) === 75n ? n : 0n });
 await assertGiftListingsBacked(market,held(77n),gift);
 await assert.rejects(assertGiftListingsBacked(market,held(76n),gift), /not fully stocked/);
 await assertGiftListingsBacked({...market,getListing:async()=>({...listing,active:false})},held(0n),gift);
 await f.create(); const b = (await f.service.getState()).bookings[0];
 const event = f.iface.encodeEventLog(f.iface.getEvent('FeeSettled'),[ethers.id(b.id),3,b.wallet,b.amountUnits]);
 const receipt = {status:1,to:escrow,logs:[{...event,address:escrow}]};
 assert.equal(verifyAssetFeeReceipt(receipt,b,ethers),true);
 assert.equal(verifyAssetFeeReceipt(receipt,{...b,wallet:outsider.address},ethers),false);
 assert.equal(verifyAssetFeeReceipt({...receipt,to:token},b,ethers),false);
 assert.equal(await assetReceiptCanonical({getBlock:async()=>({hash:'canonical'})},{blockNumber:1,blockHash:'old'}),false);
 assert.equal(await assetReceiptCanonical({getBlock:async()=>({hash:'canonical'})},{blockNumber:1,blockHash:'canonical'}),true);
 const cancel = f.iface.encodeEventLog(f.iface.getEvent('FeeDecision'),[ethers.id(b.id),4,'ipfs://cancel']);
 assert.equal(verifyAssetCancellationReceipt({status:1,to:escrow,logs:[{...cancel,address:escrow}]},b,ethers),true);
});
test('prefilled asset terms hash matches the committed pinned agreement bytes', async () => {
 const { LIVE_ASSET_TERMS_V1 } = await import('../js/live-performance-admin.mjs');
 const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname, '../docs/LIVE_PERFORMANCE_ASSET_TERMS_V1.json'));
 assert.equal(ethers.keccak256(bytes), LIVE_ASSET_TERMS_V1.hash);
 assert.equal(JSON.parse(bytes).version, LIVE_ASSET_TERMS_V1.version);
});
test('gift funding rechecks Market backing after operator approval before sending ETH', async t => {
 const f = await fixture();
 const created = (await f.create({ assetAddress:f.shared.LIVE_ZERO_ADDRESS, assetDecimals:18,
  assetSymbol:'ETH', amountUnits:'20000000000000000' })).bookings[0];
 const booking = { ...created, acknowledged:true, startUtc:new Date(Date.now()+3600_000).toISOString(),
  endUtc:new Date(Date.now()+4800_000).toISOString() };
 const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../js/live-performance-admin.mjs'), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';\n/gm, '').replace(/^export /gm, '');
 for (const losesBacking of [false,true]) await t.test(losesBacking ? 'inventory changed during approval' : 'active listing remains fully backed', async () => {
  const marketAddress = '0x5555555555555555555555555555555555555555';
  let stock = 77n, checks = 0, approvals = 0;
  const funding = [], commands = [], pending = new Map(), hash = ethers.id('funding fixture');
  const initialState = { assetEscrowConfigured:true, assetEscrowAddress:escrow, giftTreasuryAddress:treasury,
   revision:0, bookings:[booking] };
  const market = { target:marketAddress, nextListingId:async () => { checks++; return 1n; },
   getListing:async () => ({ active:true,nftContract:collection,tokenId:75n,available:77n }) };
  const nft = {
   balanceOf:async address => {
    assert.ok([marketAddress,owner.address].includes(address));
    return address === marketAddress ? stock : 12n;
   },
   isApprovedForAll:async () => false,
   setApprovalForAll:async (operator, allowed) => {
    assert.equal(operator,escrow); assert.equal(allowed,true); approvals++;
    return { wait:async () => { if (losesBacking) stock = 76n; } };
   },
  };
  const contracts = {
   [marketAddress]:market, [collection]:nft,
   [escrow]:{ createBooking:async (...args) => { funding.push(args); return { hash,wait:async () => ({hash}) }; } },
  };
  const signer = { getAddress:async () => owner.address, signMessage:async () => 'fixture-signature' };
  const run = () => require('node:vm').runInNewContext(`${source}
   state = initialState;
   section = { querySelector: () => ({ textContent:'' }) };
   render = () => {};
   action('fund', booking);`, {
    ...f.shared, initialState, booking,
    window:{ ethereum:{}, DecentConfig:{ supporterDnft:{escrowAddress:marketAddress} }, ethers:{ ...ethers,
     BrowserProvider:class { async getSigner() { return signer; } async getNetwork() { return {chainId:8453n}; } },
     Contract:function(address) { assert.ok(contracts[address],`Unexpected contract: ${address}`); return contracts[address]; },
    } },
    isAdminWallet:address => address === owner.address,
    document:{ readyState:'loading',addEventListener(){},dispatchEvent(){} }, CustomEvent:class {},
    location:new URL('https://radio.example'), confirm:() => true, publishLiveBookingState(){},
    localStorage:{ getItem:key => pending.get(key) ?? null, setItem:(key,value) => pending.set(key,value),
     removeItem:key => pending.delete(key) },
    fetch:async (_url, options) => {
     const {command} = JSON.parse(options.body); commands.push(command);
     return { ok:true,json:async () => ({ ...initialState,bookings:[{...booking,
      transactions:{funding:{status:commands.length === 1 ? 'pending' : 'confirmed'}}}] }) };
    },
   });
  if (losesBacking) await assert.rejects(run(), /not fully stocked/);
  else {
   await run();
   assert.equal(funding[0][0],ethers.id(booking.id));
   assert.deepEqual(funding[0][1],f.shared.assetBookingTerms(booking));
   assert.equal(funding[0][2],booking.termsUri);
   assert.equal(funding[0][3].value,booking.amountUnits);
  }
  assert.equal(checks,2);
  assert.equal(approvals,1);
  assert.equal(funding.length,losesBacking ? 0 : 1);
  assert.equal(commands.length,losesBacking ? 0 : 2);
  assert.equal(pending.size,0);
 });
});
