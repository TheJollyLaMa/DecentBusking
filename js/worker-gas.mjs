export async function readWorkerGasState({ provider, workerAddress }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(workerAddress || '')) throw new Error('Invalid worker wallet');
  if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Worker balance must be checked on Base');
  const balance = await provider.getBalance(workerAddress);
  if (typeof balance !== 'bigint' || balance < 0n) throw new Error('Invalid worker ETH balance');
  return { workerAddress, balanceWei: balance, empty: balance === 0n };
}

export function initWorkerGasNotices() {
  const notices = [...document.querySelectorAll('.worker-gas-notice')];
  if (!notices.length) return;
  const states = notices.map(notice => {
    notice.hidden = true;
    const state = document.createElement('p');
    state.className = 'worker-gas-state';
    state.setAttribute('role', 'status');
    state.hidden = true;
    notice.after(state);
    return state;
  });
  let pending = null;
  let checkedAt = 0;
  async function check() {
    const cfg = window.DecentConfig || {};
    const provider = new ethers.JsonRpcProvider(cfg.rpcUrl || 'https://mainnet.base.org');
    let timeout;
    try {
      const read = async () => {
        if (!cfg.djukeContractAddress) throw new Error('DJuke contract is not configured');
        const contract = new ethers.Contract(cfg.djukeContractAddress, ['function gasWorker() view returns(address)'], provider);
        return readWorkerGasState({ provider, workerAddress: await contract.gasWorker() });
      };
      const result = await Promise.race([read(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Worker balance check timed out')), 15000);
      })]);
      notices.forEach(notice => {
        notice.hidden = !result.empty;
        const address = notice.querySelector('code');
        if (address) address.textContent = result.workerAddress;
      });
      states.forEach(state => { state.hidden = true; state.textContent = ''; });
      checkedAt = Date.now();
    } catch (error) {
      console.warn('[worker-gas]', error.message);
      notices.forEach(notice => { notice.hidden = true; });
      states.forEach(state => {
        state.hidden = false;
        state.textContent = `Worker ETH balance unavailable: ${error.message}. No balance assumption was made.`;
      });
    } finally {
      clearTimeout(timeout);
      provider.destroy();
    }
  }
  const refresh = () => {
    if (!pending && Date.now() - checkedAt >= 60000) pending = check().finally(() => { pending = null; });
    return pending;
  };
  refresh();
  document.addEventListener('open-admin', refresh);
  document.addEventListener('left-drawer-open', refresh);
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initWorkerGasNotices);
