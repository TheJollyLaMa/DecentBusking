export function configuredSettlementFunds(config = {}) {
  return [
    { label: 'Playback Payroll', slug: config.radioFunds?.playback },
    { label: 'Top 10 Prize Payouts', slug: config.radioFunds?.topTen },
    { label: 'Repo Dev Bot Payouts', slug: config.fundSlug },
  ].filter(fund => typeof fund.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fund.slug));
}

export const CUSTOM_FUND_OPTION = '__custom_fund__';

export function validateSettlementFundSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (slug.length < 3 || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('Fund slug must be 3–64 lowercase letters/numbers with single hyphens');
  }
  return slug;
}

export function resolveSettlementFundSlug(selection, customSlug, config = {}, knownCustomFunds = []) {
  if (selection === CUSTOM_FUND_OPTION) {
    const slug = validateSettlementFundSlug(customSlug);
    if (configuredSettlementFunds(config).some(fund => fund.slug === slug)) throw new Error('Select this configured fund from the list');
    return slug;
  }
  const slug = validateSettlementFundSlug(selection);
  if (!configuredSettlementFunds(config).some(fund => fund.slug === slug) && !knownCustomFunds.includes(slug)) {
    throw new Error('Select a configured fund or choose Create a custom fund');
  }
  return slug;
}

export function buildSettlementFundMetadata({ slug, name, description, website = '', routerAddress, owner, fundId, createdAt }) {
  const fundSlug = validateSettlementFundSlug(slug);
  const title = String(name || '').trim();
  const purpose = String(description || '').trim();
  if (!title || title.length > 120) throw new Error('Enter a fund name of 1-120 characters');
  if (!purpose || purpose.length > 2000) throw new Error('Enter a fund purpose of 1-2000 characters');
  if (!/^0x[0-9a-fA-F]{40}$/.test(routerAddress || '') || !/^0x[0-9a-fA-F]{40}$/.test(owner || '')) throw new Error('Valid router and owner addresses are required');
  if (!/^0x[0-9a-fA-F]{64}$/.test(fundId || '') || /^0x0{64}$/.test(fundId)) throw new Error('Invalid fund ID');
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error('Valid metadata creation time is required');
  const link = String(website || '').trim();
  if (link) {
    let url;
    try { url = new URL(link); } catch { throw new Error('Fund website must be an HTTPS URL'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || link.length > 2048) throw new Error('Fund website must be an HTTPS URL');
  }
  return { schema: 'decentbusking/settlement-fund/v1', name: title, description: purpose, fundSlug,
    chainId: 8453, routerAddress, owner, fundId, createdAt: new Date(createdAt).toISOString(),
    ...(link ? { external_url: link } : {}) };
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

export async function recoverSettlementUsdc({ router, token, signer, owner, fundId, amountUnits, onStage = () => {}, onBroadcast = () => {} }) {
  if (!signer?.provider) throw new Error('Connect the owner wallet first');
  if (typeof amountUnits !== 'bigint' || amountUnits <= 0n) throw new Error('Enter a positive USDC recovery amount');
  if (!/^0x[0-9a-fA-F]{64}$/.test(fundId || '') || /^0x0{64}$/.test(fundId)) throw new Error('Invalid fund ID');
  const address = await signer.getAddress();
  if (!owner || address.toLowerCase() !== owner.toLowerCase()) throw new Error('Recover only to the configured owner wallet');
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Fund recovery is Base-only');
  if (token.target.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase() || Number(await token.decimals()) !== 6) throw new Error('Recovery supports native Base USDC only');
  const code = await signer.provider.getCode(router.target);
  if (!code || code === '0x') throw new Error('Settlement router is not deployed');
  if (!await router.hasRole(await router.DEFAULT_ADMIN_ROLE(), address)) throw new Error('DEFAULT_ADMIN_ROLE is required to recover funds');
  const fund = await router.funds(fundId);
  if (!(fund.exists ?? fund[2])) throw new Error('Selected fund does not exist');
  if (await router.fundBalances(fundId, token.target) < amountUnits) throw new Error('Recovery exceeds the selected fund balance');
  if (await token.balanceOf(router.target) < amountUnits) throw new Error('Router has insufficient actual USDC');
  await router.recoverFund.staticCall(fundId, token.target, address, amountUnits);
  onStage();
  const transaction = await router.recoverFund(fundId, token.target, address, amountUnits);
  onBroadcast(transaction.hash);
  const receipt = await transaction.wait();
  if (receipt?.status !== 1) throw new Error('Recovery was not confirmed successfully; check its receipt before retrying');
  verifySettlementRecoveryReceipt({ receipt, router, token, owner: address, fundId, amountUnits });
  return { txHash: transaction.hash, recipient: address };
}

export function verifySettlementRecoveryReceipt({ receipt, router, token, owner, fundId, amountUnits }) {
  if (receipt?.status !== 1) throw new Error('A successful recovery receipt is required');
  let recovered = false;
  let transferred = false;
  for (const log of receipt.logs || []) {
    try {
      if (log.address.toLowerCase() === router.target.toLowerCase()) {
        const event = router.interface.parseLog(log);
        if (event?.name === 'FundRecovered' && event.args.fundId === fundId && event.args.asset.toLowerCase() === token.target.toLowerCase() &&
            event.args.recipient.toLowerCase() === owner.toLowerCase() && event.args.amount === amountUnits) recovered = true;
      }
      if (log.address.toLowerCase() === token.target.toLowerCase()) {
        const event = token.interface.parseLog(log);
        if (event?.name === 'Transfer' && event.args.from.toLowerCase() === router.target.toLowerCase() &&
            event.args.to.toLowerCase() === owner.toLowerCase() && event.args.value === amountUnits) transferred = true;
      }
    } catch {}
  }
  if (!recovered || !transferred) throw new Error('Receipt does not prove the exact selected-fund recovery and USDC transfer; recovery remains locked');
}

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