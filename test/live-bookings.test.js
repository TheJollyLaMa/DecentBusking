const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Wallet, Interface, id } = require('../discord-bot/node_modules/ethers');
const owner = Wallet.createRandom();
const performer = Wallet.createRandom();
const outsider = Wallet.createRandom();
const when = Date.parse('2026-10-22T12:00:00Z');
const txHash = '0x'+'ab'.repeat(32);
const otherHash = '0x'+'cd'.repeat(32);
const input = () => ({ performer:'jose.metagame.wtf', displayName:'Jose', discordHandle:'joseacabrerav',
 eventId:'friday-live-performance:2026-10-23', title:'Friday Live Performance', startUtc:'2026-10-24T01:00:00Z', endUtc:'2026-10-24T02:00:00Z',
 amountUnits:'20000000', mode:'phase0', termsVersion:'DRAFT v1 pending approval', termsHash:id('specific terms'), termsUri:'ipfs://bafyterms',
 reviewWindow:259200, cancellationWindow:172800, killFeeBps:2500, claimDeadline:'2026-11-24T02:00:00Z' });
const routerAbi = [
 'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
 'event PayrollPaid(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount,bytes32 workReference,bytes32 repositoryIdHash,bytes32 contributorIdHash,string metadataUri,bytes32 metadataHash)',
];
async function fixture(options = {}) {
 const { createLiveBookings } = await import('../discord-bot/live-bookings.js');
 const shared = await import('../js/live-bookings.mjs');
 let stored, clock = when, receipt = null, head = 100;
 let schedule = { ready:true, events:[], weeklySchedule:{} };
 const provider = { getNetwork:async()=>({ chainId:8453n }), getTransactionReceipt:async()=>receipt,
   getBlockNumber:async()=>head, getLogs:async()=>[] };
 const cfg = { provider, ownerWallet:owner.address, now:()=>clock, ensResolver:{ resolveName:async()=>({ name:'jose.metagame.wtf',address:performer.address }) },
   restore:async()=>stored, save:async next=>{ stored=structuredClone(next); return 'ipfs://bafycheckpoint'; },
   getSchedule:async()=>schedule, saveSchedule:async next=>{ schedule={ ready:true,...next }; }, ...options };
 const service = createLiveBookings(cfg);
 async function exec(command) { return service.execute({ ...command, revision:(await service.getState()).revision }); }
 const create = (booking = input(), bookingId = 'live:jose:2026-10-23') => exec({ action:'create',id:bookingId,booking });
 const ack = async()=>{
   const b=(await service.getState()).bookings[0];
   return exec({ action:'acknowledge',id:b.id,stewardApproved:true,performerSignature:await performer.signMessage(shared.liveAcknowledgement(b)) });
 };
 function funding(hash=txHash, overrides={}) {
   const iface=new Interface(routerAbi);
   const log=iface.encodeEventLog('FundFunded',[id(shared.LIVE_FUND),shared.LIVE_USDC,owner.address,20000000]);
   receipt={ status:1,to:shared.LIVE_ROUTER,blockNumber:99,logs:[{...log,address:shared.LIVE_ROUTER}],hash,...overrides };
 }
 return { service, exec, create, ack, funding, provider, cfg, shared, stored:()=>stored, schedule:()=>schedule,
   time:value=>{clock=value;}, receipt:value=>{receipt=value;}, head:value=>{head=value;} };
}
test('ENS booking, immutable per-booking terms, duplicate occurrence and restart recovery',async()=>{
 const f=await fixture(); const result=await f.create();
 assert.equal(result.bookings[0].wallet,performer.address.toLowerCase());
 assert.equal(result.bookings[0].status,'draft');
 assert.equal(result.escrowConfigured,false);
 await assert.rejects(f.create(input(),'different-id'),/Occurrence already/);
 await assert.rejects(f.exec({action:'transaction',id:result.bookings[0].id,txAction:'funding',txHash}),/acknowledge/);
 await f.ack(); assert.ok((await f.service.getState()).bookings[0].acknowledged);
 const {createLiveBookings}=await import('../discord-bot/live-bookings.js');
 const restored=createLiveBookings({...f.cfg,restore:async()=>f.stored()});
 assert.deepEqual((await restored.getState()).bookings,(await f.service.getState()).bookings);
 await assert.rejects(f.service.execute({action:'cancel',id:result.bookings[0].id,revision:0,reason:'x',confirm:true}),/Stale/);
});
test('stale create rebases against current state while preserving duplicate occurrence protection',async()=>{
 const f=await fixture();
 await f.create();
 const second={...input(),eventId:'friday-live-performance:2026-10-30',
  startUtc:'2026-10-31T01:00:00Z',endUtc:'2026-10-31T01:20:00Z'};
 const rebased=await f.service.execute({action:'create',id:'live:jose:2026-10-30',booking:second,revision:0});
 assert.equal(rebased.bookings.length,2);
 assert.equal(rebased.bookings[1].eventId,second.eventId);
 await assert.rejects(f.service.execute({action:'create',id:'live:jose:duplicate',booking:second,revision:0}),/Occurrence already has a booking/);
 await assert.rejects(f.service.execute({action:'cancel',id:rebased.bookings[1].id,revision:0,reason:'x',confirm:true}),/Stale/);
});
test('invalid ENS/slot/series/policy/terms and undeployed escrow fail closed',async()=>{
 const f=await fixture();
 for(const change of [{eventId:'friday-live-performance'},{eventId:'friday-live-performance:2026-10-24'},{amountUnits:'0'},
   {killFeeBps:10001},{reviewWindow:0},{termsHash:'fake'},{termsUri:'javascript:bad'},{mode:'phase1'}]) {
   await assert.rejects(f.create({...input(),...change}));
 }
 const noEns=await fixture({ensResolver:{resolveName:async()=>({address:null})}});
 await assert.rejects(noEns.create(),/could not be resolved/);
});
test('performer acknowledgement must be signed by performer, not owner/outsider',async()=>{
 const f=await fixture(); await f.create(); const b=(await f.service.getState()).bookings[0];
 await assert.rejects(f.exec({action:'acknowledge',id:b.id,stewardApproved:true,performerSignature:await outsider.signMessage(f.shared.liveAcknowledgement(b))}),/mismatch/);
 await assert.rejects(f.exec({action:'acknowledge',id:b.id,stewardApproved:false,performerSignature:await performer.signMessage(f.shared.liveAcknowledgement(b))}),/Steward/);
});
test('performer can accept only the invited wallet’s steward-approved immutable draft',async()=>{
 const f=await fixture({escrowAddress:'0x'+'ef'.repeat(20),escrowStartBlock:100});
 const draft=await f.create({...input(),mode:'phase1',stewardApproved:true},'live:jose:approved');
 const booking=draft.bookings[0];
 const signature=await performer.signMessage(f.shared.liveAcknowledgement(booking));
 await assert.rejects(f.service.acknowledgePerformer({id:booking.id,address:outsider.address,signature}),/invited performer wallet/);
 await assert.rejects(f.service.acknowledgePerformer({id:booking.id,address:performer.address,signature:await outsider.signMessage(f.shared.liveAcknowledgement(booking))}),/mismatch/);
 const accepted=await f.service.acknowledgePerformer({id:booking.id,address:performer.address,signature});
 assert.equal(accepted.bookings[0].acknowledged,true);
 assert.equal(accepted.bookings[0].acknowledgedAt,new Date(when).toISOString());
 assert.match(accepted.bookings[0].termsStatus,/awaiting escrow funding/);
 assert.equal(accepted.bookings[0].status,'draft');
 assert.equal(accepted.bookings[0].transactions.funding,undefined);
 assert.deepEqual(await f.service.acknowledgePerformer({id:booking.id,address:performer.address,signature}),accepted);
});
test('performer acceptance is unavailable until the steward explicitly approves the draft',async()=>{
 const f=await fixture({escrowAddress:'0x'+'ef'.repeat(20),escrowStartBlock:100});
 const draft=await f.create({...input(),mode:'phase1'});
 const b=draft.bookings[0];
 await assert.rejects(f.service.acknowledgePerformer({id:b.id,address:performer.address,
   signature:await performer.signMessage(f.shared.liveAcknowledgement(b))}),/steward has not approved/);
});
test('expired invitations reject direct and owner-relayed acceptance without changing the agreement',async()=>{
 for (const offset of [0, 1, 86400_000]) {
  const f=await fixture({escrowAddress:'0x'+'ef'.repeat(20),escrowStartBlock:100});
  const b=(await f.create({...input(),mode:'phase1',stewardApproved:true})).bookings[0];
  const signature=await performer.signMessage(f.shared.liveAcknowledgement(b));
  f.time(Date.parse(b.startUtc)+offset);
  await assert.rejects(f.service.acknowledgePerformer({id:b.id,address:performer.address,signature}),/expired/);
  await assert.rejects(f.exec({action:'acknowledge',id:b.id,stewardApproved:true,performerSignature:signature}),/expired/);
  const unchanged=(await f.service.getState()).bookings[0];
  assert.equal(unchanged.acknowledged,false);
  assert.equal(unchanged.termsHash,b.termsHash);
  assert.deepEqual(unchanged.transactions,{});
 }
});

test('confirmed funding submitted before start can still be reconciled after start',async()=>{
 const f=await fixture(); await f.create(); await f.ack(); f.funding();
 const b=(await f.service.getState()).bookings[0];
 f.time(Date.parse(b.startUtc)+1);
 const state=await f.exec({action:'transaction',id:b.id,txAction:'funding',txHash});
 assert.equal(state.bookings[0].status,'funded','expiry guards must not hide an already-mined deposit');
});

test('next Friday defaults use future New York time across date rollover and daylight saving',async()=>{
 const {nextFridayLiveStart}=await import('../js/live-performance-admin.mjs');
 const {newYorkInputToUtc}=await import('../js/radio-calendar.mjs');
 for (const [instant,expected] of [
  ['2026-10-24T08:21:00Z','2026-10-30T21:00'],
  ['2026-10-24T00:59:59Z','2026-10-23T21:00'],
  ['2026-10-24T01:00:00Z','2026-10-30T21:00'],
  ['2026-10-31T01:00:00Z','2026-11-06T21:00'],
 ]) {
  const value=nextFridayLiveStart(Date.parse(instant));
  assert.equal(value,expected);
  assert.ok(Date.parse(newYorkInputToUtc(value))>Date.parse(instant));
 }
 assert.equal(newYorkInputToUtc(nextFridayLiveStart(Date.parse('2026-10-31T01:00:00Z'))),'2026-11-07T02:00:00.000Z');
});

test('prefilled approved v2 terms match the immutable agreement file and still require per-booking approval',async()=>{
 const {readFileSync}=require('node:fs');
 const {keccak256}=require('../discord-bot/node_modules/ethers');
 const {LIVE_APPROVED_TERMS_V2}=await import('../js/live-bookings.mjs');
 assert.equal(LIVE_APPROVED_TERMS_V2.hash,keccak256(readFileSync(new URL('../docs/LIVE_PERFORMANCE_TERMS_V2.json',`file://${__filename}`))));
 assert.equal(LIVE_APPROVED_TERMS_V2.uri,'ipfs://bafkreidzxhbeub33romiprjlsjojgpitnwrqap52g6hpen3wowwhfi3zgq');
 const f=await fixture({escrowAddress:'0x'+'ef'.repeat(20),escrowStartBlock:100});
 const b=(await f.create({...input(),mode:'phase1',termsVersion:LIVE_APPROVED_TERMS_V2.version,
  termsUri:LIVE_APPROVED_TERMS_V2.uri,termsHash:LIVE_APPROVED_TERMS_V2.hash})).bookings[0];
 assert.equal(b.stewardApproved,false);
 await assert.rejects(f.service.acknowledgePerformer({id:b.id,address:performer.address,
  signature:await performer.signMessage(f.shared.liveAcknowledgement(b))}),/steward has not approved/);
});

test('expired invitation UI offers no signature or transaction controls and no fictional claim',async t=>{
 const {renderPerformerBookingInvite}=await import('../js/live-performance-profile.mjs');
 const {bookingGroup,claimState,liveBookingRows}=await import('../js/live-bookings.mjs');
 const b={...input(),id:'past',wallet:performer.address,mode:'phase1',status:'draft',stewardApproved:true};
 const now=Date.parse(b.startUtc);
 const original=global.document;
 t.after(()=>{ if(original===undefined) delete global.document; else global.document=original; });
 global.document={createElement:tag=>({tag,children:[],textContent:'',setAttribute(){},append(...children){this.children.push(...children);}})};
 const invite=renderPerformerBookingInvite({booking:b,wallet:b.wallet,serviceUrl:'https://worker.example',now});
 assert.equal(invite.children.some(node=>node.tag==='button'||node.tag==='input'),false);
 assert.match(invite.children[0].textContent,/new date and agreement/);
 assert.equal(bookingGroup(b,now),'completed');
 assert.match(liveBookingRows([b],{now}),/Invitation expired/);
 assert.equal(claimState(b,owner.address,b.wallet,now).enabled,false);
 assert.match(claimState(b,owner.address,b.wallet,now).label,/No confirmed escrow/);
 b.status='approved';
 assert.match(claimState(b,owner.address,b.wallet,Date.parse(b.claimDeadline)+1).label,/deadline passed/);
});
test('community schedule invite is scoped to the exact wallet and event occurrence',async()=>{
 const {performerBookingForOccurrence}=await import('../js/radio-schedule-ui.mjs');
 const booking={eventId:'friday-live-performance:2026-10-23',wallet:performer.address,mode:'phase1',status:'draft',cancelled:false};
 const bookings=[booking,{...booking,eventId:'friday-live-performance:2026-10-30'},
  {...booking,mode:'phase0'},{...booking,status:'funded'},{...booking,cancelled:true}];
 assert.equal(performerBookingForOccurrence(bookings,booking.eventId,performer.address.toUpperCase()),booking);
 assert.equal(performerBookingForOccurrence(bookings,booking.eventId,outsider.address),null);
 assert.equal(performerBookingForOccurrence(bookings,`${booking.eventId}-other`,performer.address),null);
 assert.equal(performerBookingForOccurrence(bookings,booking.eventId,''),null);
 assert.equal(performerBookingForOccurrence(null,booking.eventId,performer.address),null);
});
test('20-minute live offer requires the agreed fee and slot and signs its human-readable payout rule',async()=>{
 const f=await fixture({escrowAddress:'0x'+'ef'.repeat(20),escrowStartBlock:100});
 const offer={...input(),mode:'phase1',startUtc:'2026-10-24T01:00:00Z',endUtc:'2026-10-24T01:20:00Z',
   amountUnits:'20000000',airtimeMinutes:20,fullPayoutLiveMinutes:15,termsVersion:'LIVE PERFORMANCE v2'};
 const result=await f.create(offer,'live:jose:offer-v2');
 const booking=result.bookings[0];
 assert.equal(booking.airtimeMinutes,20);
 assert.equal(booking.fullPayoutLiveMinutes,15);
 assert.match(f.shared.liveAcknowledgement(booking),/full fee at 15 live-music minutes; below that, fee × verified live minutes ÷ 15/);
 const mismatchedSlot=await fixture();
 await assert.rejects(mismatchedSlot.create({...offer,endUtc:'2026-10-24T01:21:00Z'}),/current live-performance offer/);
 const mismatchedFee=await fixture();
 await assert.rejects(mismatchedFee.create({...offer,amountUnits:'21000000'}),/current live-performance offer/);
 const {livePerformancePayoutBps}=f.shared;
 assert.equal(livePerformancePayoutBps(0),0);
 assert.equal(livePerformancePayoutBps(7),4666);
 assert.equal(livePerformancePayoutBps(14),9333);
 assert.equal(livePerformancePayoutBps(15),10000);
 assert.equal(livePerformancePayoutBps(20),10000);
 assert.throws(()=>livePerformancePayoutBps(-1),/non-negative/);
});
test('20-minute offer calculates prorated payout from verified live minutes server-side',async()=>{
 const f=await fixture();
 const draft=await f.create({...input(),mode:'phase0',startUtc:'2026-10-24T01:00:00Z',endUtc:'2026-10-24T01:20:00Z',
   amountUnits:'20000000',airtimeMinutes:20,fullPayoutLiveMinutes:15,termsVersion:'LIVE PERFORMANCE v2'},'live:jose:prorated');
 const booking=draft.bookings[0];
 await f.ack();
 f.funding();
 await f.exec({action:'transaction',id:booking.id,txAction:'funding',txHash});
 f.time(Date.parse(booking.endUtc)+1000);
 const decision={action:'decision',id:booking.id,reason:'Seven verified live minutes',
   reportUri:'ipfs://bafyreport',reportHash:idHash('report'),
   remainderDisposition:'Return the unused amount to the funder'};
 await assert.rejects(f.exec({...decision,liveMusicMinutes:21}),/verified live-music minutes/);
 const result=await f.exec({...decision,liveMusicMinutes:7});
 const updated=result.bookings[0];
 assert.equal(updated.decision.liveMusicMinutes,7);
 assert.equal(updated.decision.payoutBps,4666);
 assert.equal(updated.approvedUnits,'9332000');
 assert.equal(updated.remainderUnits,'10668000');
});
test('pending, reverted, insufficient confirmation, successful funding and payout evidence',async()=>{
 const f=await fixture(); await f.create(); await f.ack();
 const id=(await f.service.getState()).bookings[0].id;
 const submit=hash=>f.exec({action:'transaction',id,txAction:'funding',txHash:hash});
 assert.equal((await submit(txHash)).bookings[0].status,'funding pending');
 f.funding(txHash,{status:0}); assert.equal((await submit(txHash)).bookings[0].status,'failed');
 f.funding(txHash,{blockNumber:100}); assert.equal((await submit(txHash)).bookings[0].status,'funding pending');
 f.funding(); assert.equal((await submit(txHash)).bookings[0].status,'funded');
 assert.equal((await submit(txHash)).bookings[0].status,'funded');
 await assert.rejects(submit(otherHash),/already confirmed/);
 f.time(Date.parse('2026-10-24T02:01:00Z'));
 await f.exec({action:'decision',id,payoutBps:5000,reason:'Shortened set',reportUri:'ipfs://bafyreport',reportHash:idHash('report'),remainderDisposition:'Remaining 10 USDC earmarked for future shows'});
 const b=(await f.service.getState()).bookings[0];
 assert.equal(b.approvedUnits,'10000000'); assert.equal(b.status,'funded');
 const iface=new Interface(routerAbi);
 const log=iface.encodeEventLog('PayrollPaid',[idHash(f.shared.LIVE_FUND),f.shared.LIVE_USDC,performer.address,10000000,idHash(f.shared.workReference(b)),idHash('repo'),idHash('jose'),'ipfs://bafyreport',b.termsHash]);
 f.receipt({status:1,to:f.shared.LIVE_ROUTER,blockNumber:99,logs:[{...log,address:f.shared.LIVE_ROUTER}]});
 const paid=await f.exec({action:'transaction',id,txAction:'payout',txHash:otherHash});
 assert.equal(paid.bookings[0].status,'paid'); assert.equal(paid.bookings[0].paidUnits,'10000000');
});
function idHash(s){ return id(s); }
test('wrong asset, amount, target, recipient, and stale funding evidence never mark funded',async()=>{
 const f=await fixture(); await f.create(); await f.ack(); const b=(await f.service.getState()).bookings[0];
 for(const overrides of [{to:outsider.address},{logs:[]}]) {
   f.funding(txHash,overrides);
   await assert.rejects(f.exec({action:'transaction',id:b.id,txAction:'funding',txHash}));
   assert.equal((await f.service.getState()).bookings[0].status,'draft');
 }
});
test('required reports, reason/remainder, review timing, and duplicate confirmations',async()=>{
 const f=await fixture(); await f.create(); await f.ack(); f.funding(); const b=(await f.service.getState()).bookings[0];
 await f.exec({action:'transaction',id:b.id,txAction:'funding',txHash});
 const decision={action:'decision',id:b.id,payoutBps:0,reason:'No show',reportUri:'ipfs://bafyreport',reportHash:idHash('report'),remainderDisposition:'Retained earmarked in fund'};
 await assert.rejects(f.exec(decision),/completed show/);
 f.time(Date.parse('2026-10-24T02:01:00Z'));
 for(const change of [{reason:''},{reportUri:''},{remainderDisposition:''},{payoutBps:10001}]) await assert.rejects(f.exec({...decision,...change}));
 const result=await f.exec(decision); assert.equal(result.bookings[0].approvedUnits,'0'); assert.equal(result.bookings[0].remainderUnits,'20000000');
});
test('dated occurrence links artist; cancellation persists reason and only cancels that Friday',async()=>{
 const f=await fixture(); const result=await f.create(); const b=result.bookings[0];
 await f.exec({action:'schedule',id:b.id}); assert.match(f.schedule().events[0].title,/Jose/);
 await assert.rejects(f.exec({action:'cancel',id:b.id,reason:'Unavailable'}),/confirmation/);
 const cancelled=await f.exec({action:'cancel',id:b.id,reason:'Artist unavailable',confirm:true});
 assert.equal(cancelled.bookings[0].scheduleStatus,'synced'); assert.equal(f.schedule().events[0].status,'cancelled');
 assert.equal(f.schedule().events[0].id,'friday-live-performance:2026-10-23');
 const { defaultRadioSchedule, resolveRadioEvent }=await import('../js/radio-schedule.mjs');
 assert.ok(defaultRadioSchedule().some(e=>e.id==='friday-live-performance'));
 assert.match(cancelled.bookings[0].financialStatus,/No confirmed deposit/);
});
test('schedule failure persists separate financial/schedule state and supports safe retry',async()=>{
 let fail=true;
 const f=await fixture({saveSchedule:async()=>{if(fail)throw Error('checkpoint offline');}});
 await f.create(); const b=(await f.service.getState()).bookings[0];
 const cancelled=await f.exec({action:'cancel',id:b.id,reason:'Public reason',confirm:true});
 assert.equal(cancelled.bookings[0].scheduleStatus,'failed'); assert.ok(cancelled.bookings[0].cancelled);
 fail=false; assert.equal((await f.exec({action:'schedule',id:b.id})).bookings[0].scheduleStatus,'synced');
});
test('failed checkpoint never publishes an undurable booking',async()=>{
 const f=await fixture({save:async()=>{throw Error('durability unavailable');}});
 await assert.rejects(f.create(),/durability/);
 assert.equal((await f.service.getState()).bookings.length,0);
});
test('claim UI and receipt states are gated, performer-only, no double receipt',async()=>{
 const {claimState,liveBookingRows}=await import('../js/live-bookings.mjs');
 const {liveReceiptEntry}=await import('../js/live-performance-profile.mjs');
 const b={...input(),id:'a',wallet:performer.address.toLowerCase(),status:'funded',mode:'phase1',transactions:{},paidUnits:'0'};
 assert.equal(claimState(b,'',b.wallet,when).enabled,false);
 assert.equal(claimState(b,owner.address,outsider.address,when).enabled,false);
 assert.equal(claimState(b,owner.address,b.wallet,Date.parse(b.endUtc)+b.reviewWindow*1000).enabled,true);
 b.status='approved'; assert.equal(claimState(b,owner.address,b.wallet,when).enabled,true);
 b.status='paid'; assert.equal(claimState(b,owner.address,b.wallet,when).enabled,false);
 b.paidUnits='20000000'; b.transactions.PerformancePaid={hash:txHash,blockNumber:99};
 assert.equal(liveReceiptEntry([b],b.wallet).units,20000000n);
 assert.match(liveBookingRows([{...b,displayName:'<script>',reason:'<bad>'}]),/&lt;script&gt;/);
});
test('configured escrow indexes confirmed events behind capability gate with exact partial refund accounting',async()=>{
 const {LIVE_ESCROW_ABI}=await import('../js/live-bookings.mjs');
 const iface=new Interface(LIVE_ESCROW_ABI);
 const f=await fixture({escrowAddress:owner.address,escrowStartBlock:1});
 await f.create({...input(),mode:'phase1'}); const b=(await f.service.getState()).bookings[0];
 const make=(name,args,index)=>({ ...iface.encodeEventLog(name,args),address:owner.address,blockNumber:101,index,transactionHash:txHash });
 const views=new Interface(['function bookings(bytes32) view returns ((address performer,address funder,uint256 amount,uint256 payoutAmount,uint64 showStart,uint64 showEnd,uint64 claimDeadline,uint32 reviewWindow,uint32 cancellationWindow,uint16 killFeeBps,bytes32 termsHash,uint8 status))']);
 f.provider.call=async()=>views.encodeFunctionResult('bookings',[[performer.address,owner.address,20000000,10000000,Date.parse(b.startUtc)/1000,Date.parse(b.endUtc)/1000,Date.parse(b.claimDeadline)/1000,b.reviewWindow,b.cancellationWindow,b.killFeeBps,b.termsHash,3]]);
 f.head(103);
 f.provider.getLogs=async()=>[
   make('BookingFunded',[id(b.id),performer.address,owner.address,20000000,b.termsHash,b.termsUri],0),
   make('PerformanceApproved',[id(b.id),5000,10000000,10000000,'ipfs://report',b.termsHash],1),
   make('BookingRefunded',[id(b.id),owner.address,10000000,'ipfs://report',b.termsHash],2),
   make('PerformancePaid',[id(b.id),performer.address,10000000,b.termsHash],3),
 ];
 const indexed=await f.service.getState();
 assert.equal(indexed.bookings[0].status,'paid'); assert.equal(indexed.bookings[0].refundUnits,'10000000');
 assert.equal(indexed.bookings[0].paidUnits,'10000000');
 assert.equal((await f.service.getState()).bookings[0].refundUnits,'10000000');
});
test('worker API enforces owner signatures, origin, signed command integrity and exposes honest funds rows',async()=>{
 const {createWorkerRequestHandler}=await import('../discord-bot/ipfs-worker.js');
 const {liveAuthorization,LIVE_FUND}=await import('../js/live-bookings.mjs');
 const f=await fixture();
 const handler=createWorkerRequestHandler({allowedOrigins:['https://decentbusking.org'],ownerWallet:owner.address,now:()=>when,liveBookings:f.service,
   getFunds:async()=>({ready:true,funds:{[LIVE_FUND]:{slug:LIVE_FUND}}})});
 const server=http.createServer(handler); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 try {
   const body={address:owner.address,origin:'https://decentbusking.org',issuedAt:new Date(when).toISOString(),command:{action:'create',revision:0,id:'new-booking',booking:{...input(),stewardApproved:true}}};
   body.signature=await owner.signMessage(liveAuthorization(body));
   const post=b=>fetch(url+'/api/live-bookings',{method:'POST',headers:{'content-type':'application/json',origin:body.origin},body:JSON.stringify(b)});
   const bad={...body,address:outsider.address}; bad.signature=await outsider.signMessage(liveAuthorization(bad));
   assert.equal((await post(bad)).status,400);
   const good=await post(body); assert.equal(good.status,200,JSON.stringify(await good.clone().json()));
   assert.equal((await post(body)).status,400);
   const draft=(await good.json()).bookings[0];
   const performerBody={id:draft.id,address:performer.address,signature:await performer.signMessage((await import('../js/live-bookings.mjs')).liveAcknowledgement(draft))};
   const accept=await fetch(url+'/api/live-bookings/acknowledge',{method:'POST',headers:{'content-type':'application/json',origin:body.origin},body:JSON.stringify(performerBody)});
   assert.equal(accept.status,200,JSON.stringify(await accept.clone().json()));
   assert.equal((await accept.json()).bookings[0].acknowledged,true);
   const funds=await (await fetch(url+'/api/funds')).json();
   assert.match(funds.funds[LIVE_FUND].description,/NOT escrowed/); assert.equal(funds.funds[LIVE_FUND].bookings.length,1);
 } finally {await new Promise(resolve=>server.close(resolve));}
});

test('Phase 0 cancelled booking has separate kill-fee decision, payout and confirmed recovery',async()=>{
 const f=await fixture(); await f.create(); await f.ack(); f.funding();
 const b=(await f.service.getState()).bookings[0];
 await f.exec({action:'transaction',id:b.id,txAction:'funding',txHash});
 await f.exec({action:'cancel',id:b.id,reason:'Platform cancelled',confirm:true});
 const decision={action:'decision',id:b.id,cancellation:true,payoutBps:2500,reason:'Agreed late kill fee',reportUri:'ipfs://bafyreport',reportHash:idHash('report'),remainderDisposition:'15 USDC returned to original funder'};
 await assert.rejects(f.exec({...decision,payoutBps:10000}),/kill-fee/);
 const d=await f.exec(decision); assert.equal(d.bookings[0].approvedUnits,'5000000');
 assert.equal(d.bookings[0].remainderUnits,'15000000');
 const iface=new Interface(['event FundRecovered(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount)']);
 const log=iface.encodeEventLog('FundRecovered',[id(f.shared.LIVE_FUND),f.shared.LIVE_USDC,owner.address,15000000]);
 f.receipt({status:1,to:f.shared.LIVE_ROUTER,blockNumber:99,logs:[{...log,address:f.shared.LIVE_ROUTER}]});
 const recovered=await f.exec({action:'transaction',id:b.id,txAction:'recovery',txHash:otherHash});
 assert.equal(recovered.bookings[0].refundUnits,'15000000');
 assert.match(recovered.bookings[0].financialStatus,/confirmed/);
});
test('non-confirming checkpoint return is not a successful save',async()=>{
 const f=await fixture({save:async()=>undefined});
 await assert.rejects(f.create(),/did not confirm/);
 assert.equal((await f.service.getState()).bookings.length,0);
});
test('Live performances earnings group renders proof and exact total with fake document',async()=>{
 const {buildEarningsReceipt}=await import('../js/creator-profile.mjs');
 const {liveReceiptEntry}=await import('../js/live-performance-profile.mjs');
 const b={...input(),wallet:performer.address,mode:'phase1',paidUnits:'20000000',transactions:{PerformancePaid:{hash:txHash,blockNumber:99}}};
 const entry=liveReceiptEntry([b],performer.address);
 const make=tag=>{ const el={tag,children:[],_text:'',append(...nodes){this.children.push(...nodes);}}; Object.defineProperty(el,'textContent',{get(){return this._text+this.children.map(c=>c.textContent||'').join('');},set(v){this._text=v;}});return el; };
 const find=(node,tag)=>[...(node.tag===tag?[node]:[]),...node.children.flatMap(child=>find(child,tag))];
 const receipt=buildEarningsReceipt(entry,{createElement:make});
 assert.equal(find(receipt,'a')[0].href,`https://basescan.org/tx/${txHash}`);
 assert.match(find(receipt,'tfoot')[0].textContent,/20\.00 USDC/);
 assert.match(find(receipt,'tbody')[0].textContent,/Live performances/);
});

test('at-start and in-progress cancellation suppress recurring live slot and preserve next Friday',async()=>{
 const {resolveActiveShow}=await import('../js/radio-schedule.mjs');
 for(const offset of [0,30*60*1000]) {
   const f=await fixture(); await f.create(); const b=(await f.service.getState()).bookings[0];
   await f.exec({action:'schedule',id:b.id});
   const instant=Date.parse(b.startUtc)+offset; f.time(instant);
   await f.exec({action:'cancel',id:b.id,reason:'Platform incident',confirm:true});
   assert.notEqual(resolveActiveShow({now:instant,livePerformanceEvents:f.schedule().events}).type,'live_performance');
   const nextFriday=resolveActiveShow({now:instant+7*86400000,livePerformanceEvents:f.schedule().events});
   assert.equal(nextFriday.type,'normal_rotation');
   assert.ok(nextFriday.unbookedLiveOccurrenceId);
   assert.equal(nextFriday.cancelledOccurrenceId,undefined);
   assert.equal(f.schedule().events[0].cancellationReason,'Platform incident');
 }
});
