import { Contract, Transaction, getAddress, keccak256, id } from 'ethers';
import { SPONSORED_WORKER_MIN_BALANCE_WEI } from '../js/worker-gas.mjs';

export const CALENDAR_REWARD_ABI = [
  'function VERSION() view returns(string)', 'function LIMIT() view returns(uint256)',
  'function appointments() view returns(address)', 'function nft() view returns(address)', 'function tokenId() view returns(uint256)',
  'function enabled() view returns(bool)', 'function startAppointmentId() view returns(uint256)',
  'function awarded() view returns(uint256)', 'function rewardedAppointment(address) view returns(uint256)',
  'function eligible(uint256) view returns(address)', 'function award(uint256)',
];
const REGISTRY = '0xa61869FD9C4376fF1DA9E7dF48b5Ba746d4bD048';
const NFT = '0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B';
const ZERO = '0x'+'0'.repeat(40);
const TOTAL_CAP = 1_000_000_000_000_000n;
// Setup includes deployment, sale-stock cutover and activation.
const SETUP_RESERVE = 300_000_000_000_000n;
const WORKER_CAP = TOTAL_CAP - SETUP_RESERVE;
const PER_SEND_CAP = 100_000_000_000_000n;
const L1_RESERVE = 10_000_000_000_000n;

export function createCalendarRewardWorker({ provider, signer, coordinator, address, runtimeCodeHash, restore, save,
  minimumReserveWei = SPONSORED_WORKER_MIN_BALANCE_WEI,
  contract = new Contract(address, CALENDAR_REWARD_ABI, provider),
  registry = new Contract(REGISTRY, ['function nextAppointmentId() view returns(uint256)'], provider),
  log = console, now = () => Date.now() }) {
  address = getAddress(address);
  if (!/^0x[0-9a-fA-F]{64}$/.test(runtimeCodeHash || '') || !signer || !coordinator ||
      typeof restore !== 'function' || typeof save !== 'function') throw new Error('Pinned rewards, existing DJuke signer and durable journal are required.');
  if (typeof minimumReserveWei !== 'bigint' || minimumReserveWei < SPONSORED_WORKER_MIN_BALANCE_WEI) throw new Error('Retain at least the sponsored DJuke worker gas minimum.');
  let state, running, verifiedAt = 0, lastChecked = 0, lastError = 'Promotion worker has not reconciled';
  const commit = async value => {
    const uri = await save(value);
    if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Reward checkpoint did not confirm; nothing newly broadcast.');
    state = value;
  };
  const validateEntry = entry => {
    const tx = Transaction.from(entry.rawTransaction);
    const decoded = contract.interface.parseTransaction({data:tx.data});
    if (!['pending','confirmed','failed'].includes(entry.status) || tx.chainId !== 8453n ||
        tx.from?.toLowerCase() !== signer.address.toLowerCase() || tx.to !== address || tx.value !== 0n ||
        decoded?.name !== 'award' || String(decoded.args[0]) !== entry.appointmentId ||
        entry.hash !== tx.hash || !/^[1-9]\d*$/.test(entry.appointmentId) ||
        BigInt(entry.feeCapWei) !== tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice) + L1_RESERVE ||
        BigInt(entry.feeCapWei) > PER_SEND_CAP) throw new Error('Invalid reward journal transaction; manual reconciliation required.');
  };
  async function verify() {
    if (state && now()-verifiedAt < 300000) return;
    if (BigInt(await provider.send('eth_chainId', [])) !== 8453n ||
        keccak256(await provider.getCode(address)) !== runtimeCodeHash) throw new Error('Reward network/runtime mismatch.');
    const [version,limit,registryAddress,nft,token] = await Promise.all([
      contract.VERSION(),contract.LIMIT(),contract.appointments(),contract.nft(),contract.tokenId(),
    ]);
    if (version !== 'dcal-first-booking-rewards-1' || limit !== 10n ||
        getAddress(registryAddress) !== REGISTRY || getAddress(nft) !== NFT || token !== 77n) throw new Error('Reward policy differs from approved ten-copy promotion.');
    if (!state) {
      const loaded = await restore();
      const initial = loaded ?? {schema:1,address,worker:signer.address,cursor:'0',entries:[]};
      if (initial.schema !== 1 || initial.address !== address || initial.worker !== signer.address ||
          !/^\d+$/.test(initial.cursor) || !Array.isArray(initial.entries) ||
          initial.entries.filter(entry=>entry.status==='pending').length > 1) throw new Error('Invalid reward checkpoint.');
      initial.entries.forEach(validateEntry);
      if (new Set(initial.entries.map(entry=>entry.hash)).size !== initial.entries.length ||
          initial.entries.reduce((sum,entry)=>sum+BigInt(entry.feeCapWei),0n) > WORKER_CAP) throw new Error('Reward journal exceeds gas cap or repeats transactions.');
      state = initial;
      const pending = state.entries.find(entry=>entry.status==='pending');
      if (pending) coordinator.block(signer,pending.hash);
    }
    verifiedAt = now();
  }
  async function reconcile(entry) {
    const receipt = await provider.getTransactionReceipt(entry.hash);
    if (receipt) {
      if (await receipt.confirmations() < 2) return {pending:entry.hash};
      const rawReceipt = await provider.send('eth_getTransactionReceipt',[entry.hash]);
      if (rawReceipt?.l1Fee == null) throw new Error('Base L1 receipt fee unavailable; keep reward nonce held for reconciliation.');
      const actualFeeWei = receipt.gasUsed*receipt.gasPrice+BigInt(rawReceipt.l1Fee);
      await commit({...state,entries:state.entries.map(item=>item.hash===entry.hash
        ? {...item,status:receipt.status===1?'confirmed':'failed',actualFeeWei:String(actualFeeWei)} : item)});
      coordinator.unblock(signer,entry.hash);
      if (receipt.status !== 1) throw new Error(`Calendar reward reverted: ${entry.hash}; booking remains confirmed.`);
      return {confirmed:entry.hash};
    }
    // Only rebroadcast the identical, journaled transaction; never invent a replacement nonce.
    if (!await provider.getTransaction(entry.hash)) {
      try {
        const tx = await provider.broadcastTransaction(entry.rawTransaction);
        if (tx.hash !== entry.hash) throw new Error('Reward rebroadcast hash mismatch.');
      } catch (error) {
        if (error.error?.message !== 'already known' && error.code !== 'NONCE_EXPIRED') throw error;
        log.error('[calendar-rewards] RPC reports known/used nonce; exact reward receipt remains unconfirmed:',entry.hash);
      }
    }
    return {pending:entry.hash};
  }
  async function tick() {
    await verify();
    const pending = state.entries.find(entry=>entry.status==='pending');
    if (pending) return reconcile(pending);
    if (!await contract.enabled()) return {ready:false,reason:'Promotion is not activated or is paused'};
    if (await contract.awarded() >= 10n) return {ready:false,reason:'All ten gifts have been awarded'};
    const start = await contract.startAppointmentId();
    let cursor = BigInt(state.cursor) > start ? BigInt(state.cursor) : start;
    if (cursor === 0n) throw new Error('Activated promotion has no starting appointment ID.');
    const through = await registry.nextAppointmentId();
    for (let checked=0;cursor < through && checked<100;checked++,cursor++) {
      const recipient = await contract.eligible(cursor);
      if (recipient === ZERO) continue;
      return coordinator.exclusive(signer,async () => {
        if (await contract.eligible(cursor) === ZERO) { await commit({...state,cursor:String(cursor+1n)}); return {skipped:String(cursor)}; }
        let gas;
        try { gas = await contract.award.estimateGas(cursor,{from:signer.address}); }
        catch (error) {
          const receiverRejected = error.reason === 'ERC1155: transfer to non-ERC1155Receiver implementer' ||
            error.reason === 'ERC1155: ERC1155Receiver rejected tokens' ||
            typeof error.data === 'string' && error.data.startsWith(id('ERC1155InvalidReceiver(address)').slice(0,10));
          // Unknown reverts may be a paused NFT or transient stock issue; preserve this booking for retry.
          if (error.code !== 'CALL_EXCEPTION' || !receiverRejected) throw error;
          log.error('[calendar-rewards] Booking reward simulation rejected; booking is unchanged:',String(cursor),error.shortMessage || error.message);
          await commit({...state,cursor:String(cursor+1n)});
          return {rejected:String(cursor)};
        }
        const fees = await provider.getFeeData();
        const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
        if (!maxFeePerGas || maxFeePerGas <= 0n) throw new Error('Reward fee quote unavailable.');
        const gasLimit = (gas*120n+99n)/100n;
        const feeCap = gasLimit*maxFeePerGas+L1_RESERVE;
        const used = state.entries.reduce((sum,entry)=>sum+(BigInt(entry.actualFeeWei || '0') > BigInt(entry.feeCapWei)
          ? BigInt(entry.actualFeeWei) : BigInt(entry.feeCapWei)),0n);
        if (feeCap > PER_SEND_CAP || used+feeCap > WORKER_CAP) throw new Error('Calendar promotion gas cap reached; no new transfer signed.');
        if (await provider.getBalance(signer.address) < minimumReserveWei+feeCap) throw new Error('Calendar rewards paused to retain DJuke minimum gas balance.');
        const nonce = Number(BigInt(await provider.send('eth_getTransactionCount',[signer.address,'pending'])));
        const transaction = await signer.populateTransaction({to:address,data:contract.interface.encodeFunctionData('award',[cursor]),
          value:0n,chainId:8453,nonce,gasLimit,maxFeePerGas,maxPriorityFeePerGas:fees.maxPriorityFeePerGas ?? 0n});
        const rawTransaction = await signer.signTransaction(transaction);
        const entry = {appointmentId:String(cursor),rawTransaction,hash:keccak256(rawTransaction),feeCapWei:String(feeCap),status:'pending'};
        validateEntry(entry);
        await commit({...state,cursor:String(cursor+1n),entries:[...state.entries,entry]});
        coordinator.block(signer,entry.hash);
        const tx = await provider.broadcastTransaction(rawTransaction);
        if (tx.hash !== entry.hash) throw new Error('Reward broadcast hash mismatch; reconcile journal.');
        log.info('[calendar-rewards] Transfer submitted',entry.hash,'recipient',recipient);
        // Reconciliation releases the signing lane only after two confirmations.
        return {pending:entry.hash};
      });
    }
    if (state.cursor!==String(cursor)) await commit({...state,cursor:String(cursor)});
    return {ready:true,cursor:String(cursor)};
  }
  return {
    initialize:verify,
    check() {
      if (!running) running = tick().then(result=>{
        lastChecked=now(); lastError=result.reason || ''; return result;
      }).catch(error=>{lastError=error.shortMessage || error.message; throw error;}).finally(()=>{running=null;});
      return running;
    },
    status:()=>({ready:!lastError && now()-lastChecked<120000,reason:lastError || (now()-lastChecked>=120000?'Promotion worker status is stale':''),
      pendingHash:state?.entries.find(entry=>entry.status==='pending')?.hash || null}),
  };
}
