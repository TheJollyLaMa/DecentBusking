import { ensureBaseNetwork, approvalNotice } from './base-chain.mjs?v=20261018-shared-provider';
import { BASE_USDC_ADDRESS, depositSettlementUsdc } from './settlement-funds.mjs?v=20261019-fund-tour';

export const RADIO_FUND_SLUGS = ['dbusk-playback', 'dbusk-top10'];
export const SETTLEMENT_ROUTER_ADDRESS = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
const ROUTER_ABI = [
  'function paused() view returns(bool)',
  'function funds(bytes32) view returns(string metadataUri,bool active,bool exists)',
  'function approvedAssets(address) view returns(bool)',
  'function fundToken(bytes32,address,uint256)',
  'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
];
const TOKEN_ABI = [
  'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
];
const same = (first, second) => typeof first === 'string' && typeof second === 'string' &&
  first.toLowerCase() === second.toLowerCase();

export function contributionUnits(value) {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(String(value))) {
    throw new Error('Enter a positive USDC amount with at most six decimal places');
  }
  const [whole, fraction = ''] = String(value).split('.');
  const units = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (units <= 0n) throw new Error('Enter a positive USDC amount');
  return units;
}

export function contributionJournalKey(address, slug) {
  if (!/^0x[0-9a-f]{40}$/i.test(address || '') || !RADIO_FUND_SLUGS.includes(slug)) throw new Error('Invalid contribution wallet or fund');
  return `decentbusking:fund-contribution:8453:${SETTLEMENT_ROUTER_ADDRESS.toLowerCase()}:${address.toLowerCase()}:${slug}`;
}

export function verifyContributionReceipt({ receipt, operation, ethers }) {
  if (!receipt || receipt.status !== 1) throw new Error('Contribution is not confirmed successfully');
  const iface = new ethers.Interface([...ROUTER_ABI, ...TOKEN_ABI]);
  const amount = BigInt(operation.amountUnits);
  let funded = false;
  let transferred = false;
  let approved = false;
  for (const log of receipt.logs) {
    if (!same(log.address, SETTLEMENT_ROUTER_ADDRESS) && !same(log.address, BASE_USDC_ADDRESS)) continue;
    let event;
    try { event = iface.parseLog(log); } catch { continue; }
    if (same(log.address, SETTLEMENT_ROUTER_ADDRESS) && event?.name === 'FundFunded' &&
        event.args.fundId === ethers.id(operation.slug) && same(event.args.asset, BASE_USDC_ADDRESS) &&
        same(event.args.funder, operation.address) && event.args.amount === amount) funded = true;
    if (same(log.address, BASE_USDC_ADDRESS) && event?.name === 'Transfer' &&
        same(event.args.from, operation.address) && same(event.args.to, SETTLEMENT_ROUTER_ADDRESS) &&
        event.args.value === amount) transferred = true;
    if (same(log.address, BASE_USDC_ADDRESS) && event?.name === 'Approval' &&
        same(event.args.owner, operation.address) && same(event.args.spender, SETTLEMENT_ROUTER_ADDRESS) &&
        event.args.value === amount) approved = true;
  }
  if (operation.stage === 'deposit' && funded && transferred) return 'deposit';
  if (operation.stage === 'approval' && approved) return 'approval';
  throw new Error('Receipt does not prove the recorded contribution stage, fund, sender and exact amount');
}

export function createContributionController({ storage, ethers, deposit = depositSettlementUsdc }) {
  let busy = false;
  async function contribute({ signer, router, token, slug, amount, onStep = () => {} }) {
    if (busy) throw new Error('A contribution is already in progress');
    busy = true;
    try {
      const address = await signer.getAddress();
      const key = contributionJournalKey(address, slug);
      if (storage.getItem(key)) throw new Error('An earlier contribution is unresolved. Check its receipt before sending again');
      const amountUnits = contributionUnits(amount);
      let operation;
      const result = await deposit({ signer, router, token, owner: address, fundId: ethers.id(slug), amountUnits, onStep,
        onStage: stage => {
          operation = { address, slug, amountUnits: amountUnits.toString(), stage, txHash: null };
          storage.setItem(key, JSON.stringify(operation));
        },
        onBroadcast: record => {
          operation = { ...operation, ...record };
          storage.setItem(key, JSON.stringify(operation));
        },
      }).catch(error => {
        if (operation && !operation.txHash && (error.code === 4001 || error.code === 'ACTION_REJECTED')) storage.removeItem(key);
        throw error;
      });
      const receipt = await signer.provider.getTransactionReceipt(result.txHash);
      verifyContributionReceipt({ receipt, operation, ethers });
      storage.removeItem(key);
      return result;
    } finally { busy = false; }
  }
  async function check({ signer, slug }) {
    if (busy) throw new Error('A contribution is already in progress');
    busy = true;
    try {
      if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
      const key = contributionJournalKey(await signer.getAddress(), slug);
      const operation = JSON.parse(storage.getItem(key) || 'null');
      if (!operation) throw new Error('No unresolved contribution for this wallet and fund');
      if (!/^0x[0-9a-f]{64}$/i.test(operation.txHash || '')) {
        throw new Error('Broadcast status is unknown. Review wallet history before retrying; this contribution remains locked');
      }
      const receipt = await signer.provider.getTransactionReceipt(operation.txHash);
      if (!receipt) throw new Error('Transaction is still pending; do not send again');
      if (receipt.status === 0) {
        storage.removeItem(key);
        return { stage: 'reverted', txHash: operation.txHash };
      }
      const stage = verifyContributionReceipt({ receipt, operation, ethers });
      storage.removeItem(key);
      return { stage, txHash: operation.txHash };
    } finally { busy = false; }
  }
  return { contribute, check };
}

export function initFundContributions() {
  const form = document.getElementById('fund-contribution-form');
  if (!form || form.dataset.ready) return;
  form.dataset.ready = '1';
  const status = document.getElementById('fund-contribution-status');
  const setStatus = text => { status.textContent = text; };
  const slugInput = document.getElementById('fund-contribution-slug');
  const amountInput = document.getElementById('fund-contribution-amount');
  let controller;
  let working = false;
  const controls = [...form.querySelectorAll('input, select, button')];
  const wallet = async () => {
    if (!window.ethereum) throw new Error('Install or open an Ethereum wallet such as MetaMask to contribute');
    if (!window._wallet?.signer) await window._wallet?.connect?.();
    if (!window._wallet?.signer) throw new Error('Connect your wallet before contributing');
    const provider = new window.ethers.BrowserProvider(window.ethereum, 'any');
    await ensureBaseNetwork(provider);
    return provider.getSigner();
  };
  const run = async action => {
    if (working) return;
    working = true;
    controls.forEach(control => { control.disabled = true; });
    try {
      if (!window.ethers) throw new Error('Wallet library is not ready. Refresh and try again');
      controller ||= createContributionController({ storage: window.localStorage, ethers: window.ethers });
      await action();
    } catch (error) {
      console.warn('[fund-contribution]', error);
      setStatus(`${error.shortMessage || error.message}. Check any unresolved receipt before retrying.`);
    } finally {
      working = false;
      controls.forEach(control => { control.disabled = false; });
    }
  };
  for (const button of form.querySelectorAll('[data-contribution-amount]')) button.addEventListener('click', () => {
    amountInput.value = button.dataset.contributionAmount;
    amountInput.focus();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const slug = slugInput.value;
    const amount = amountInput.value;
    run(async () => {
      contributionUnits(amount);
      if (!RADIO_FUND_SLUGS.includes(slug)) throw new Error('Select a radio payout fund');
      if (!window.confirm(`Add ${amount} USDC to ${slug} on Base? This is a fund contribution, not an ad purchase or a refundable deposit. MetaMask may request an exact USDC approval and then the contribution. Base ETH is needed for gas.`)) return;
      setStatus('Connect your wallet and confirm Base. No payment has been sent.');
      const signer = await wallet();
      const router = new window.ethers.Contract(SETTLEMENT_ROUTER_ADDRESS, ROUTER_ABI, signer);
      const token = new window.ethers.Contract(BASE_USDC_ADDRESS, TOKEN_ABI, signer);
      setStatus(approvalNotice(amount));
      const result = await controller.contribute({ signer, router, token, slug, amount, onStep: setStatus });
      setStatus('Contribution confirmed. Thank you for supporting the artists! ');
      const link = document.createElement('a');
      link.href = `https://basescan.org/tx/${result.txHash}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'View transaction proof';
      status.append(link);
      document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
    });
  });
  document.getElementById('fund-contribution-check').addEventListener('click', () => run(async () => {
    setStatus('Checking the recorded transaction on Base...');
    const result = await controller.check({ signer: await wallet(), slug: slugInput.value });
    setStatus(result.stage === 'deposit' ? 'Contribution confirmed on Base. Thank you!'
      : result.stage === 'approval' ? 'USDC approval confirmed; no contribution was sent. You can now submit the contribution.'
      : 'Recorded transaction reverted. No contribution was confirmed by that transaction. Review before retrying.');
    if (result.stage === 'deposit') document.dispatchEvent(new CustomEvent('fund-contribution-confirmed'));
  }));
}
