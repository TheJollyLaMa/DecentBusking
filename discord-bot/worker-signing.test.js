import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerSigningCoordinator } from './worker-signing.js';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
test('promotion-off wallets preserve original sending behavior',async()=>{
  const signer={address:'0xabc',sendTransaction:async value=>value};
  const send=signer.sendTransaction;
  const coordinator=createWorkerSigningCoordinator({makeWallet:()=>signer});
  assert.equal(coordinator.wallet('private',{}).sendTransaction,send);
});
test('shared account sends serialize through mining across separate DJuke and DVert signers',async()=>{
  const mined=deferred(),order=[];
  let nonce=0;
  const provider={send:async()=>`0x${nonce.toString(16)}`};
  const coordinator=createWorkerSigningCoordinator({enabled:true,makeWallet:()=>({
    address:'0xabc',sendTransaction:async tx=>{
      order.push(tx.nonce);nonce++;
      return {hash:`0x${tx.nonce}`,wait:()=>tx.nonce===0?mined.promise:Promise.resolve({status:1})};
    },
  })});
  const first=coordinator.wallet('private',provider),second=coordinator.wallet('private',provider);
  const a=first.sendTransaction({}),b=second.sendTransaction({});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,[0]);
  mined.resolve({status:1});await Promise.all([a,b]);
  assert.deepEqual(order,[0,1]);
});
test('ambiguous transactions block reuse until explicitly reconciled; known mined reverts do not',async()=>{
  const provider={send:async()=> '0x0'};
  const coordinator=createWorkerSigningCoordinator({enabled:true,makeWallet:()=>({
    address:'0xabc',sendTransaction:async()=>{throw new Error('network interrupted');},
  })});
  const signer=coordinator.wallet('private',provider);
  await assert.rejects(signer.sendTransaction({}),/interrupted/);
  await assert.rejects(signer.sendTransaction({}),/signing paused/);
  coordinator.unblock(signer,'different hash');
  await assert.rejects(coordinator.exclusive(signer,async()=>true),/signing paused/);
  const safe=createWorkerSigningCoordinator({enabled:true,makeWallet:()=>({
    address:'0xdef',sendTransaction:async()=>{
      const error=new Error('mined revert');error.receipt={status:0};throw error;
    },
  })});
  const other=safe.wallet('private',provider);
  await assert.rejects(other.sendTransaction({}),/mined revert/);
  assert.equal(await safe.exclusive(other,async()=>true),true);
});
