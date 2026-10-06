export function configuredSettlementFunds(config = {}) {
  return [
    { label: 'Playback Payroll', slug: config.radioFunds?.playback },
    { label: 'Top 10 Prize Payouts', slug: config.radioFunds?.topTen },
    { label: 'Repo Dev Bot Payouts', slug: config.fundSlug },
  ].filter(fund => typeof fund.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fund.slug));
}

export async function createConfiguredSettlementFund({ router, signer, owner, fundId, metadataUri }) {
  if (!signer?.provider) throw new Error('Connect the owner wallet first');
  const network = await signer.provider.getNetwork();
  if (Number(network.chainId) !== 8453) throw new Error('Fund creation is Base-only');
  const address = await signer.getAddress();
  if (!owner || address.toLowerCase() !== owner.toLowerCase()) throw new Error('Connect the configured admin wallet');
  if (!/^0x[0-9a-fA-F]{64}$/.test(fundId || '') || /^0x0{64}$/.test(fundId)) throw new Error('Invalid fund ID');
  let uri;
  try { uri = new URL(metadataUri); } catch { throw new Error('Enter a valid HTTPS or IPFS metadata URI'); }
  if (!['https:', 'ipfs:'].includes(uri.protocol) || !uri.hostname) throw new Error('Enter a valid HTTPS or IPFS metadata URI');
  if (metadataUri.length > 2048) throw new Error('Metadata URI is too long');
  const code = await signer.provider.getCode(router.target);
  if (!code || code === '0x') throw new Error('No settlement router is deployed at the configured address');
  const role = await router.DEFAULT_ADMIN_ROLE();
  if (!await router.hasRole(role, address)) throw new Error('This wallet lacks the settlement router DEFAULT_ADMIN_ROLE');
  const fund = await router.funds(fundId);
  if (fund.exists ?? fund[2]) return { fundId, alreadyExists: true };
  await router.createFund.staticCall(fundId, metadataUri);
  const transaction = await router.createFund(fundId, metadataUri);
  const receipt = await transaction.wait();
  if (receipt?.status !== 1) throw new Error('Fund creation was not confirmed successfully');
  const created = await router.funds(fundId);
  if (!(created.exists ?? created[2])) throw new Error('Transaction confirmed but the fund was not found; refresh before retrying');
  return { fundId, alreadyExists: false, txHash: transaction.hash };
}

export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export async function depositSettlementUsdc({ router, token, signer, owner, fundId, amountUnits, onStep = () => {}, onStage = () => {}, onBroadcast = () => {} }) {
  if (typeof amountUnits !== 'bigint' || amountUnits <= 0n) throw new Error('Enter a positive USDC amount');
  if (!/^0x[0-9a-fA-F]{64}$/.test(fundId || '') || /^0x0{64}$/.test(fundId)) throw new Error('Invalid fund ID');
  const address = await signer.getAddress();
  if (!owner || address.toLowerCase() !== owner.toLowerCase()) throw new Error('Connect the configured admin wallet');
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('USDC deposits are Base-only');
  if (token.target.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase() || Number(await token.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  if (await router.paused()) throw new Error('The settlement router is paused');
  if (await signer.provider.getCode(router.target) === '0x') throw new Error('Settlement router is not deployed');
  const fund = await router.funds(fundId);
  if (!(fund.exists ?? fund[2]) || !(fund.active ?? fund[1])) throw new Error('Create and activate the selected fund first');
  if (!await router.approvedAssets(token.target)) throw new Error('USDC is not approved on the settlement router');
  if (await token.balanceOf(address) < amountUnits) throw new Error('Wallet has insufficient USDC');
  if (await token.allowance(address, router.target) < amountUnits) {
    onStep('Approve the exact USDC deposit amount in your wallet');
    onStage('approval');
    const approval = await token.approve(router.target, amountUnits);
    onBroadcast({ stage: 'approval', txHash: approval.hash });
    if ((await approval.wait())?.status !== 1) throw new Error('USDC approval did not confirm');
  }
  await router.fundToken.staticCall(fundId, token.target, amountUnits);
  onStep('Confirm the USDC deposit into the selected fund');
  onStage('deposit');
  const transaction = await router.fundToken(fundId, token.target, amountUnits);
  onBroadcast({ stage: 'deposit', txHash: transaction.hash });
  if ((await transaction.wait())?.status !== 1) throw new Error('USDC deposit did not confirm');
  return { txHash: transaction.hash };
}