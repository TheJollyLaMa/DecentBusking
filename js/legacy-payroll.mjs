export function legacyEntryKey(entry) {
  return JSON.stringify([entry.issueRef, String(entry.contributor || '').toLowerCase(),
    String(entry.contributorGithub || '').toLowerCase(), entry.role || 'contributor', String(entry.amount), entry.queuedAt || '']);
}

export function createLegacyReceiptStore(storage) {
  const key = 'decentbusking:optimism-payroll-receipts:v1';
  function read() {
    const result = JSON.parse(storage.getItem(key) || '{}');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Legacy payment records are invalid; review transaction history before paying');
    return result;
  }
  return {
    get: entry => read()[legacyEntryKey(entry)],
    all: read,
    set(entry, receipt) {
      const records = read();
      if (receipt.txHash && Object.entries(records).some(([identity, value]) => identity !== legacyEntryKey(entry) && value.txHash?.toLowerCase() === receipt.txHash.toLowerCase())) {
        throw new Error('That transaction is already assigned to another payroll entry');
      }
      records[legacyEntryKey(entry)] = receipt;
      storage.setItem(key, JSON.stringify(records));
    },
    remove(entry) {
      const records = read();
      delete records[legacyEntryKey(entry)];
      storage.setItem(key, JSON.stringify(records));
    },
  };
}

export async function verifyLegacyPayment({ provider, txHash, owner, recipient, amountWei }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) throw new Error('Enter a valid transaction hash');
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 10) throw new Error('Payment verification must use Optimism');
  const [transaction, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
  if (!transaction) throw new Error('Transaction not found on Optimism; do not repay while it is unresolved');
  if (transaction.from?.toLowerCase() !== owner.toLowerCase() || transaction.to?.toLowerCase() !== recipient.toLowerCase() ||
      BigInt(transaction.value) !== BigInt(amountWei) || Number(transaction.chainId) !== 10) {
    throw new Error('Transaction sender, recipient, amount, or chain does not match this payout');
  }
  if (!receipt) return { status: 'pending', txHash };
  if (receipt.status !== 1) throw new Error('Transaction failed; review it before retrying');
  return { status: 'confirmed', txHash };
}