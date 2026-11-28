export function isPromotionsFund(value) {
  return typeof value === 'string' && value.length <= 64 &&
    (/^dbusk-(?:promotionals|referrals)(?:-[a-z0-9]+)*$/.test(value) || value === 'decentcanopy-promotionals');
}

export async function routerPayout({ w, routerAddress, routerAbi, fund, asset, recipientWallet, amountUnits,
  reference, key, storage, status, prepare, reconcile, isPaid, confirmationTimeout,
  repository = 'TheJollyLaMa/DecentBusking' }) {
  if (storage.getItem(key)) throw new Error('A payment is unresolved. Reconcile its wallet transaction before retrying; do not clear browser storage.');
  const router = new w.ethers.Contract(routerAddress, routerAbi, w.signer);
  const ref = w.ethers.id(reference);
  if (await router.completedWorkReferences(ref)) throw new Error('Reward is already paid on-chain; reconcile its transaction instead');
  if (!await router.hasRole(await router.PAYROLL_ROLE(), w.address) || await router.paused()) throw new Error('Payment requires the unpaused router payroll role');
  if (!await router.approvedAssets(asset.address)) throw new Error(`${asset.symbol} is not enabled on the router`);
  const recipient = await router.contributors(recipientWallet);
  if (!(recipient.approved ?? recipient[1])) throw new Error('Enable this reward recipient on the shared router before paying');
  if (!isPromotionsFund(fund)) throw new Error('Reward has no valid dedicated promotional fund');
  const fundId = w.ethers.id(fund);
  const routerFund = await router.funds(fundId);
  if (!routerFund.exists || !routerFund.active || await router.fundBalances(fundId, asset.address) < BigInt(amountUnits)) {
    throw new Error(`${fund} is missing, inactive or underfunded in ${asset.symbol}`);
  }
  const args = [fundId, asset.address, recipientWallet, BigInt(amountUnits), ref,
    w.ethers.id(repository), w.ethers.id(recipientWallet), '', w.ethers.ZeroHash];
  await router.payout.staticCall(...args);
  await w.check();
  await prepare();
  await w.check();
  storage.setItem(key, JSON.stringify({ status: 'awaiting-wallet', reference: ref }));
  let tx;
  try { tx = await router.payout(...args); } catch (error) {
    if (error.code === 'ACTION_REJECTED' || error.code === 4001) storage.removeItem(key);
    throw error;
  }
  try { storage.setItem(key, JSON.stringify({ hash: tx.hash, reference: ref })); }
  catch (error) { throw new Error(`Payment was sent as ${tx.hash}, but its browser journal failed: ${error.message}. Reconcile this hash; do not send again.`); }
  status.textContent = `Payment pending: ${tx.hash}. Do not send again; reconcile after two confirmations.`;
  await reconcile(tx.hash);
  await tx.wait(2, confirmationTimeout);
  await w.check();
  if (isPaid(await reconcile(tx.hash))) storage.removeItem(key);
}
