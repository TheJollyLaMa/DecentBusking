import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Interface, Transaction, keccak256 } from 'ethers';
import { createCalendarRewardWorker, CALENDAR_REWARD_ABI } from './calendar-rewards.js';
import { createWorkerSigningCoordinator } from './worker-signing.js';
const REGISTRY='0xa61869FD9C4376fF1DA9E7dF48b5Ba746d4bD048',NFT='0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B';
function setup() {
  const signer=Wallet.createRandom();signer.populateTransaction=async tx=>({...tx,type:2});
  const address='0x'+'11'.repeat(20),recipient='0x'+'22'.repeat(20),code='0x6000';
  let stored=null,sent=[],receipt=null,balance=10_000_000_000_000_000n,next=2n,failure=false,fee=1n;
  const provider={
    send:async method=>{
      if(method==='eth_chainId')return '0x2105';
      if(method==='eth_getTransactionCount')return '0x0';
      if(method==='eth_getTransactionReceipt')return {l1Fee:'0x1'};
      throw new Error(`Unexpected method ${method}`);
    },
    getCode:async()=>code,getBalance:async()=>balance,
    getFeeData:async()=>({maxFeePerGas:fee,maxPriorityFeePerGas:0n}),
    broadcastTransaction:async raw=>{if(failure)throw new Error('network interrupted');sent.push(raw);return {hash:keccak256(raw)};},
    getTransactionReceipt:async()=>receipt,getTransaction:async()=>sent.length?{}:null,
  };
  const contract={interface:new Interface(CALENDAR_REWARD_ABI),VERSION:async()=> 'dcal-first-booking-rewards-1',
    LIMIT:async()=>10n,appointments:async()=>REGISTRY,nft:async()=>NFT,tokenId:async()=>77n,
    enabled:async()=>true,awarded:async()=>0n,startAppointmentId:async()=>1n,eligible:async()=>recipient,
    award:{estimateGas:async()=>100000n}};
  const coordinator=createWorkerSigningCoordinator({enabled:true});
  const options={provider,signer,coordinator,address,runtimeCodeHash:keccak256(code),contract,
    registry:{nextAppointmentId:async()=>next},restore:async()=>structuredClone(stored),
    save:async state=>{stored=structuredClone(state);return 'ipfs://checkpoint';},log:{info(){},error(){}}};
  return {options,provider,contract,coordinator,signer,sent,get stored(){return stored;},
    balance:value=>{balance=value;},fee:value=>{fee=value;},fail:value=>{failure=value;},
    next:value=>{next=value;},
    mined:()=>{receipt={status:1,gasUsed:100000n,gasPrice:1n,confirmations:async()=>2};},
    storedState:value=>{stored=value;}};
}
test('worker journals fixed-recipient transaction before broadcast and holds shared nonce until confirmation',async()=>{
  const f=setup(),worker=createCalendarRewardWorker(f.options);
  const result=await worker.check();
  assert.equal(result.pending,f.stored.entries[0].hash);
  const tx=Transaction.from(f.sent[0]);
  assert.equal(tx.to,f.options.address);assert.equal(tx.value,0n);
  assert.equal(tx.chainId,8453n);
  await assert.rejects(f.coordinator.exclusive(f.signer,async()=>true),/signing paused/);
  f.mined();assert.equal((await worker.check()).confirmed,tx.hash);
  assert.equal(f.stored.entries[0].status,'confirmed');
  assert.equal(f.stored.entries[0].actualFeeWei,'100001');
  assert.equal(await f.coordinator.exclusive(f.signer,async()=>true),true);
});
test('inactive promotion reports paused status and never broadcasts a reward',async()=>{
  const f=setup();
  f.contract.enabled=async()=>false;
  const worker=createCalendarRewardWorker(f.options);
  const result=await worker.check();
  assert.equal(result.ready,false);
  assert.match(result.reason,/not activated or is paused/);
  assert.equal(worker.status().ready,false);
  assert.equal(f.sent.length,0);
});
test('interruption after journal creation rebroadcasts only the identical transaction on restart',async()=>{
  const f=setup();f.fail(true);
  await assert.rejects(createCalendarRewardWorker(f.options).check(),/interrupted/);
  assert.equal(f.stored.entries.length,1);assert.equal(f.sent.length,0);
  f.fail(false);
  const restarted=createCalendarRewardWorker(f.options);
  await restarted.check();
  assert.equal(f.sent[0],f.stored.entries[0].rawTransaction);
  assert.equal(f.stored.entries.length,1);
});
test('known or consumed nonce responses never create a replacement or release the signing hold',async()=>{
  for(const failure of [{error:{message:'already known'}},{code:'NONCE_EXPIRED'}]){
    const f=setup();f.fail(true);
    await assert.rejects(createCalendarRewardWorker(f.options).check(),/interrupted/);
    f.provider.broadcastTransaction=async()=>{throw Object.assign(new Error('RPC response'),failure);};
    const worker=createCalendarRewardWorker(f.options);
    assert.equal((await worker.check()).pending,f.stored.entries[0].hash);
    assert.equal(f.stored.entries.length,1);
    await assert.rejects(f.coordinator.exclusive(f.signer,async()=>true),/signing paused/);
    f.mined();assert.equal((await worker.check()).confirmed,f.stored.entries[0].hash);
  }
});
test('DJuke reserve, per-send and 0.0007 ETH relay cap preserve the 0.001 total including setup',async()=>{
  const low=setup();low.balance(1_000_000_000_000_000n);
  await assert.rejects(createCalendarRewardWorker(low.options).check(),/minimum gas balance/);
  assert.equal(low.sent.length,0);assert.equal(low.stored,null);
  const high=setup();high.fee(1_000_000_000n);
  await assert.rejects(createCalendarRewardWorker(high.options).check(),/gas cap/);
  assert.equal(high.sent.length,0);
  const full=setup(),entries=[];
  for(let i=0;i<7;i++){
    const rawTransaction=await full.signer.signTransaction({type:2,to:full.options.address,value:0n,chainId:8453,nonce:i,
      gasLimit:100000n,maxFeePerGas:900000000n,maxPriorityFeePerGas:0n,
      data:full.contract.interface.encodeFunctionData('award',[i+1])});
    entries.push({rawTransaction,hash:keccak256(rawTransaction),appointmentId:String(i+1),status:'failed',feeCapWei:'100000000000000'});
  }
  full.next(9n);
  full.storedState({schema:1,address:full.options.address,worker:full.signer.address,cursor:'8',entries});
  await assert.rejects(createCalendarRewardWorker(full.options).check(),/gas cap/);
  assert.equal(full.sent.length,0);
});
test('runtime mismatch and failed checkpoints cannot broadcast; simulation failure is explicit and leaves booking untouched',async()=>{
  const f=setup();
  await assert.rejects(createCalendarRewardWorker({...f.options,runtimeCodeHash:'0x'+'ff'.repeat(32)}).check(),/runtime mismatch/);
  await assert.rejects(createCalendarRewardWorker({...f.options,save:async()=>''}).check(),/checkpoint did not confirm/);
  assert.equal(f.sent.length,0);
  const rejected=setup(),logs=[];
  rejected.contract.award.estimateGas=async()=>{const e=new Error('Receiver rejects token');e.code='CALL_EXCEPTION';e.reason='ERC1155: ERC1155Receiver rejected tokens';e.data='0x08c379a0';throw e;};
  const result=await createCalendarRewardWorker({...rejected.options,log:{info(){},error:(...args)=>logs.push(args)}}).check();
  assert.equal(result.rejected,'1');assert.equal(logs.length,1);assert.equal(rejected.sent.length,0);
  const paused=setup();
  paused.contract.award.estimateGas=async()=>{const e=new Error('NFT temporarily paused');e.code='CALL_EXCEPTION';e.data='0x08c379a0';throw e;};
  await assert.rejects(createCalendarRewardWorker(paused.options).check(),/temporarily paused/);
  assert.equal(paused.stored,null);
});
