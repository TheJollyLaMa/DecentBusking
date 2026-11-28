// Shares the tip modal's Coinbase spot quote and its session cache (js/stage.js).
const QUOTE_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot';
const CACHE_KEY = 'decentbusking:tip-eth-usdc:v1';
const CACHE_MS = 5 * 60 * 1000;
let request = null;

export function cachedEthUsd(storage = globalThis.sessionStorage, now = Date.now()) {
  try {
    const value = JSON.parse(storage?.getItem(CACHE_KEY) || 'null');
    return Number.isFinite(value?.rate) && value.rate > 0 && now - value.savedAt < CACHE_MS ? value.rate : null;
  } catch { return null; }
}

export function loadEthUsd({ fetchImpl = globalThis.fetch, storage = globalThis.sessionStorage, force = false } = {}) {
  const cached = cachedEthUsd(storage);
  if (cached && !force) return Promise.resolve(cached);
  request ||= fetchImpl(QUOTE_URL, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    .then(async response => {
      const rate = Number((await response.json())?.data?.amount);
      if (!response.ok || !Number.isFinite(rate) || rate <= 0) throw new Error('ETH quote unavailable');
      try { storage?.setItem(CACHE_KEY, JSON.stringify({ rate, savedAt: Date.now() })); } catch {}
      return rate;
    })
    .catch(() => null)
    .finally(() => { request = null; });
  return request;
}

// "≈ $12.34" for an amount in wei, or '' when no quote is available.
export function weiToUsdText(wei, rate) {
  if (!rate) return '';
  const usd = Number(BigInt(wei || 0)) / 1e18 * rate;
  return `≈ $${usd.toLocaleString('en-US', { minimumFractionDigits: usd < 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

// "0.002 ETH ($6.70)": the ETH amount is the promise; the parenthetical is a live estimate.
export function ethWithUsd(wei, rate = cachedEthUsd()) {
  const units = BigInt(wei || 0);
  const fraction = (units % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  const eth = `${units / 10n ** 18n}${fraction ? `.${fraction}` : ''} ETH`;
  const usd = weiToUsdText(units, rate).replace(/^≈ /, '');
  return usd ? `${eth} (${usd})` : eth;
}
