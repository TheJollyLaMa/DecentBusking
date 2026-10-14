const STORAGE_KEY = 'decentbusking:payment-celebrations:v1';
const MAX_STORED = 180;
const ACTIVE_DURATION_MS = 5400;
const COMPACT_DURATION_MS = 3200;
const REDUCED_MOTION_DURATION_MS = 6200;
const DEFAULT_PAUSE_MS = 180;
const EFFECTS = [
  { id: 'flying-monies', label: 'Flying Monies' },
  { id: 'money-rain', label: 'Money Rain' },
  { id: 'coin-fountain', label: 'Coin Fountain' },
  { id: 'rocket-payday', label: 'Rocket Payday' },
  { id: 'confetti-cash', label: 'Confetti Cash' },
  { id: 'treasure-unlocked', label: 'Treasure Unlocked' },
  { id: 'money-tornado', label: 'Money Tornado' },
  { id: 'rainbow-riches', label: 'Rainbow Riches' },
  { id: 'busker-encore', label: 'Busker Encore' },
  { id: 'payday-fireworks', label: 'Payday Fireworks' },
  { id: 'golden-ripple', label: 'Golden Ripple' },
  { id: 'victory-parade', label: 'Victory Parade' },
];

let controller = null;
let queue = [];
let seen = new Map();
let effectIndex = 0;
let booted = false;

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function styleString(style = {}) {
  return Object.entries(style).filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}:${value}`).join(';');
}

function emoji(tag, text, style = {}) {
  if (tag.includes('pc-particle')) style = { '--drift': `${rand(-18, 18)}vw`, ...style };
  return `<span class="${tag}" aria-hidden="true"${Object.keys(style).length ? ` style="${styleString(style)}"` : ''}>${text}</span>`;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function defaultExplorerUrl(chainId, txHash) {
  if (Number(chainId) === 8453) return `https://basescan.org/tx/${txHash}`;
  if (Number(chainId) === 10) return `https://optimistic.etherscan.io/tx/${txHash}`;
  throw new Error(`No payment explorer configured for chain ${chainId}`);
}

function loadSeen(storage = globalThis.localStorage) {
  if (seen.size) return seen;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const entries = raw ? JSON.parse(raw) : [];
    if (Array.isArray(entries)) {
      for (const [key, timestamp] of entries) {
        if (typeof key === 'string' && Number.isFinite(Number(timestamp))) seen.set(key, Number(timestamp));
      }
    }
  } catch {}
  return seen;
}

function saveSeen(storage = globalThis.localStorage) {
  if (!storage) return;
  try {
    const entries = [...seen.entries()].sort((first, second) => first[1] - second[1]).slice(-MAX_STORED);
    storage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {}
}

function normalize(detail = {}) {
  const chainId = Number(detail.chainId);
  const txHash = String(detail.txHash || detail.hash || '').trim();
  if (!Number.isInteger(chainId) || chainId <= 0 || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  const key = `${chainId}:${txHash.toLowerCase()}`;
  return {
    key,
    chainId,
    txHash,
    amountText: String(detail.amountText || detail.amount || '').trim(),
    assetText: String(detail.assetText || detail.asset || '').trim(),
    summary: String(detail.summary || '').trim(),
    title: String(detail.title || 'Payment confirmed on chain').trim() || 'Payment confirmed on chain',
    explorerUrl: String(detail.explorerUrl || '').trim() || defaultExplorerUrl(chainId, txHash),
    txLabel: String(detail.txLabel || '').trim(),
    source: String(detail.source || '').trim(),
  };
}

function nextEffect() {
  const effect = EFFECTS[effectIndex % EFFECTS.length];
  effectIndex = (effectIndex + 1) % EFFECTS.length;
  return effect;
}

function paymentLine(detail) {
  const amount = [detail.amountText, detail.assetText].filter(Boolean).join(' ');
  if (detail.summary && amount) return `${detail.summary} · ${amount}`;
  if (detail.summary) return detail.summary;
  if (amount) return amount;
  return 'Confirmed transfer';
}

function renderFlyingMonies(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-coin', '💸')}${emoji('pc-static-coin', '💸')}${emoji('pc-static-coin', '💸')}</div>`;
  return `<div class="pc-scene pc-flying">
    ${Array.from({ length: 8 }, (_, index) => emoji('pc-particle pc-fly', '💸', {
      '--x': `${6 + index * 12}%`,
      '--y': `${72 + (index % 3) * 6}%`,
      '--dx': `${rand(-50, 48)}vw`,
      '--dy': `${rand(-62, -24)}vh`,
      '--rot': `${rand(-620, 620)}deg`,
      '--delay': `${index * 0.08}s`,
      '--duration': `${3.1 + (index % 3) * 0.18}s`,
    })).join('')}
  </div>`;
}

function renderMoneyRain(detail, reduced) {
  const bills = ['💵', '💶', '💷', '💵', '💶', '💷', '💵'];
  if (reduced) return `<div class="pc-static-row">${bills.slice(0, 4).map(emoji.bind(null, 'pc-static-bill')).join('')}</div>`;
  return `<div class="pc-scene pc-rain">
    ${Array.from({ length: 18 }, (_, index) => emoji('pc-particle pc-rain-drop', bills[index % bills.length], {
      '--x': `${rand(0, 100)}%`,
      '--delay': `${rand(0, 1.1).toFixed(2)}s`,
      '--duration': `${2.8 + rand(0, 1.1)}s`,
      '--rot': `${rand(-130, 130)}deg`,
      '--sway': `${rand(-7, 7)}vw`,
    })).join('')}
  </div>`;
}

function renderCoinFountain(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-coin', '🪙')}${emoji('pc-static-coin', '🪙')}${emoji('pc-static-coin', '🪙')}</div>`;
  return `<div class="pc-scene pc-fountain">
    ${Array.from({ length: 10 }, (_, index) => emoji('pc-particle pc-coin', '🪙', {
      '--x': `${46 + (index % 5) * 2}%`,
      '--y': `${72 + (index % 2) * 3}%`,
      '--dx': `${rand(-26, 26)}vw`,
      '--dy': `${rand(-48, -16)}vh`,
      '--rot': `${rand(-360, 360)}deg`,
      '--delay': `${index * 0.06}s`,
      '--duration': `${2.9 + (index % 4) * 0.12}s`,
    })).join('')}
  </div>`;
}

function renderRocketPayday(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-rocket', '🚀')}${emoji('pc-static-spark', '✨')}${emoji('pc-static-coin', '💸')}</div>`;
  return `<div class="pc-scene pc-rocket-scene">
    <span class="pc-rocket" aria-hidden="true">🚀</span>
    <span class="pc-rocket-trail" aria-hidden="true">${emoji('pc-trail', '💸')}${emoji('pc-trail', '✨')}${emoji('pc-trail', '💸')}</span>
    ${Array.from({ length: 8 }, (_, index) => emoji('pc-particle pc-burst', index % 2 ? '✨' : '💸', {
      '--x': `${48 + rand(-4, 4)}%`,
      '--y': `${48 + rand(-4, 4)}%`,
      '--delay': `${index * 0.04}s`,
      '--duration': `${2.8 + rand(0, 0.7)}s`,
      '--rot': `${rand(-180, 180)}deg`,
    })).join('')}
  </div>`;
}

function renderConfettiCash(detail, reduced) {
  const confetti = ['🎉', '🎊', '💸', '💵', '✨'];
  if (reduced) return `<div class="pc-static-row">${confetti.slice(0, 4).map(emoji.bind(null, 'pc-static-confetti')).join('')}</div>`;
  return `<div class="pc-scene pc-confetti">
    ${Array.from({ length: 18 }, (_, index) => emoji('pc-particle pc-confetti-piece', confetti[index % confetti.length], {
      '--x': `${rand(10, 90)}%`,
      '--y': `${rand(20, 60)}%`,
      '--delay': `${rand(0, 0.9).toFixed(2)}s`,
      '--duration': `${2.6 + rand(0, 0.9)}s`,
      '--rot': `${rand(-540, 540)}deg`,
    })).join('')}
  </div>`;
}

function renderTreasureUnlocked(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-chest', '💰')}${emoji('pc-static-burst', '🎁')}${emoji('pc-static-coin', '🪙')}</div>`;
  return `<div class="pc-scene pc-treasure">
    <div class="pc-treasure-box" aria-hidden="true">
      <span class="pc-chest-lid">🎁</span>
      <span class="pc-chest-body">💰</span>
    </div>
    ${Array.from({ length: 9 }, (_, index) => emoji('pc-particle pc-treasure-spark', index % 3 === 0 ? '🪙' : '✨', {
      '--x': `${50 + rand(-3, 3)}%`,
      '--y': `${52 + rand(-3, 3)}%`,
      '--delay': `${index * 0.05}s`,
      '--duration': `${3.0 + rand(0, 0.6)}s`,
      '--rot': `${rand(-300, 300)}deg`,
    })).join('')}
  </div>`;
}

function renderMoneyTornado(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-coin', '💸')}${emoji('pc-static-coin', '🪙')}${emoji('pc-static-coin', '💸')}</div>`;
  return `<div class="pc-scene pc-tornado">
    <div class="pc-tornado-core" aria-hidden="true"></div>
    ${Array.from({ length: 14 }, (_, index) => emoji('pc-particle pc-tornado-piece', index % 3 === 0 ? '💸' : '🪙', {
      '--delay': `${index * 0.05}s`,
      '--duration': `${3.2 + (index % 4) * 0.18}s`,
      '--radius': `${12 + index * 2}px`,
      '--turns': `${2 + (index % 3) * 0.35}`,
      '--start': `${index * 25}deg`,
    })).join('')}
  </div>`;
}

function renderRainbowRiches(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-rainbow', '🌈')}${emoji('pc-static-coin', '💰')}${emoji('pc-static-spark', '✨')}</div>`;
  return `<div class="pc-scene pc-rainbow">
    <div class="pc-rainbow-arc" aria-hidden="true">🌈</div>
    ${Array.from({ length: 8 }, (_, index) => emoji('pc-particle pc-rainbow-spark', index % 2 ? '✨' : '💰', {
      '--x': `${12 + index * 11}%`,
      '--y': `${42 + Math.sin(index) * 4}%`,
      '--delay': `${index * 0.08}s`,
      '--duration': `${3.1 + rand(0, 0.7)}s`,
      '--rot': `${rand(-180, 180)}deg`,
    })).join('')}
  </div>`;
}

function renderBuskerEncore(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-guitar', '🎸')}${emoji('pc-static-note', '🎵')}${emoji('pc-static-note', '🎶')}</div>`;
  return `<div class="pc-scene pc-encore">
    <span class="pc-hat" aria-hidden="true">🎩</span>
    <span class="pc-guitar" aria-hidden="true">🎸</span>
    ${Array.from({ length: 6 }, (_, index) => emoji('pc-particle pc-note', index % 3 === 0 ? '🎵' : index % 3 === 1 ? '🎶' : '💸', {
      '--x': `${20 + index * 12}%`,
      '--y': `${34 + (index % 2) * 18}%`,
      '--delay': `${index * 0.08}s`,
      '--duration': `${1.8 + rand(0, 0.6)}s`,
      '--rot': `${rand(-220, 220)}deg`,
    })).join('')}
  </div>`;
}

function renderPaydayFireworks(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-firework', '🎆')}${emoji('pc-static-firework', '🎇')}${emoji('pc-static-coin', '🪙')}</div>`;
  const bursts = [20, 46, 72];
  return `<div class="pc-scene pc-fireworks">
    ${bursts.map((left, index) => `<span class="pc-firework" style="left:${left}%;top:${30 + index * 6}%">🎆</span>`).join('')}
    ${Array.from({ length: 15 }, (_, index) => emoji('pc-particle pc-firework-spark', index % 4 === 0 ? '🪙' : '✨', {
      '--x': `${rand(18, 82)}%`,
      '--y': `${rand(18, 64)}%`,
      '--delay': `${rand(0, 0.8).toFixed(2)}s`,
      '--duration': `${1.7 + rand(0, 0.5)}s`,
      '--rot': `${rand(-420, 420)}deg`,
    })).join('')}
  </div>`;
}

function renderGoldenRipple(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-ripple', '🪙')}${emoji('pc-static-ripple', '✨')}${emoji('pc-static-coin', '💸')}</div>`;
  return `<div class="pc-scene pc-ripple">
    ${Array.from({ length: 3 }, (_, index) => `<span class="pc-ripple-ring" style="--delay:${index * 0.22}s"></span>`).join('')}
    ${Array.from({ length: 6 }, (_, index) => emoji('pc-particle pc-ripple-coin', index % 2 ? '💸' : '🪙', {
      '--x': `${32 + index * 7}%`,
      '--y': `${48 + (index % 2) * 3}%`,
      '--delay': `${index * 0.06}s`,
      '--duration': `${3.0 + rand(0, 0.6)}s`,
      '--rot': `${rand(-180, 180)}deg`,
    })).join('')}
  </div>`;
}

function renderVictoryParade(detail, reduced) {
  if (reduced) return `<div class="pc-static-row">${emoji('pc-static-parade', '🥳')}${emoji('pc-static-parade', '🙌')}${emoji('pc-static-parade', '💃')}</div>`;
  return `<div class="pc-scene pc-parade">
    ${Array.from({ length: 4 }, (_, index) => `<span class="pc-parader" style="--delay:${index * 0.12}s;left:${8 + index * 22}%">${['🥳', '🙌', '💃', '🕺'][index % 4]}</span>`).join('')}
    ${Array.from({ length: 5 }, (_, index) => emoji('pc-particle pc-parade-float', index % 2 ? '🎉' : '💸', {
      '--x': `${8 + index * 18}%`,
      '--y': `${18 + (index % 2) * 8}%`,
      '--delay': `${index * 0.12}s`,
      '--duration': `${3.1 + rand(0, 0.6)}s`,
      '--rot': `${rand(-120, 120)}deg`,
    })).join('')}
  </div>`;
}

const RENDERERS = {
  'flying-monies': renderFlyingMonies,
  'money-rain': renderMoneyRain,
  'coin-fountain': renderCoinFountain,
  'rocket-payday': renderRocketPayday,
  'confetti-cash': renderConfettiCash,
  'treasure-unlocked': renderTreasureUnlocked,
  'money-tornado': renderMoneyTornado,
  'rainbow-riches': renderRainbowRiches,
  'busker-encore': renderBuskerEncore,
  'payday-fireworks': renderPaydayFireworks,
  'golden-ripple': renderGoldenRipple,
  'victory-parade': renderVictoryParade,
};

function ensureStyles(documentRef) {
  if (!documentRef || documentRef.getElementById('payment-celebration-styles')) return;
  const style = documentRef.createElement('style');
  style.id = 'payment-celebration-styles';
  style.textContent = `
#payment-celebration-root {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
  display: grid;
  place-items: start center;
  padding: 14px 16px 18px;
  box-sizing: border-box;
}
#payment-celebration-root[hidden] { display: none !important; }
#payment-celebration-root[data-phase="compact"] .payment-celebration-shell {
  width: min(440px, calc(100vw - 24px));
  min-height: auto;
}
#payment-celebration-root[data-phase="compact"] .payment-celebration-stage { display: none; }
#payment-celebration-root[data-phase="reduced"] .payment-celebration-stage {
  display: grid;
  place-items: center;
  padding-top: 3vh;
}
.payment-celebration-shell {
  position: relative;
  width: min(680px, calc(100vw - 24px));
  min-height: 250px;
  margin-top: 10px;
  pointer-events: none;
}
.payment-celebration-card {
  position: relative;
  pointer-events: auto;
  margin: 0 auto;
  padding: 16px 18px 14px;
  border-radius: 18px;
  border: 1px solid rgba(255, 226, 126, .42);
  background: linear-gradient(180deg, rgba(22, 27, 44, .95), rgba(11, 13, 22, .98));
  box-shadow: 0 20px 42px rgba(0, 0, 0, .45), 0 0 0 1px rgba(255, 255, 255, .08) inset;
  backdrop-filter: blur(16px) saturate(1.08);
  overflow: hidden;
}
.payment-celebration-card h2 {
  margin: 0 40px 6px 0;
  color: #fff7d2;
  font: 800 clamp(1.08rem, 2.3vw, 1.38rem)/1.12 system-ui, sans-serif;
}
.payment-celebration-summary,
.payment-celebration-subtitle {
  margin: 0;
  color: #f3f4ff;
  font: 650 clamp(.96rem, 2vw, 1.04rem)/1.42 system-ui, sans-serif;
}
.payment-celebration-subtitle { color: #d7daf4; margin-top: 6px; font-weight: 500; }
.payment-celebration-link {
  display: inline-flex;
  align-items: center;
  gap: .35rem;
  margin-top: 10px;
  padding: .34rem .62rem;
  border-radius: 999px;
  background: rgba(142, 230, 255, .12);
  border: 1px solid rgba(142, 230, 255, .22);
  color: #8ee6ff;
  font: 700 .92rem/1.2 system-ui, sans-serif;
  text-decoration: none;
}
.payment-celebration-link:hover { text-decoration: underline; }
.payment-celebration-dismiss {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: rgba(255,255,255,.09);
  color: #fff;
  cursor: pointer;
  pointer-events: auto;
}
.payment-celebration-stage {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  isolation: isolate;
  display: grid;
  place-items: center;
  padding-top: 4vh;
  background:
    radial-gradient(circle at 50% 16%, rgba(255, 221, 116, .13), transparent 32%),
    radial-gradient(circle at 50% 80%, rgba(142, 230, 255, .08), transparent 34%);
}
.payment-celebration-stage[data-paused="true"] * { animation-play-state: paused !important; }
.pc-scene, .pc-static-row { position: absolute; inset: 0; }
.pc-static-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: .4rem;
  font-size: clamp(2rem, 4.8vw, 3.1rem);
  filter: drop-shadow(0 6px 16px rgba(0,0,0,.45));
}
.pc-particle, .pc-rocket, .pc-hat, .pc-guitar, .pc-rainbow-arc, .pc-firework, .pc-ripple-ring, .pc-parader {
  position: absolute;
  display: inline-block;
  transform-origin: center;
  will-change: transform, opacity;
}
.pc-particle { font-size: clamp(1.35rem, 2.8vw, 2.5rem); text-shadow: 0 3px 10px rgba(0,0,0,.38); }
.pc-fly { left: var(--x); top: var(--y); animation: pc-fly var(--duration) cubic-bezier(.15,.7,.2,1) var(--delay) both; }
.pc-rain-drop { left: var(--x); top: -12%; animation: pc-rain var(--duration) linear var(--delay) both; }
.pc-coin { left: var(--x); top: var(--y); animation: pc-fountain var(--duration) cubic-bezier(.12,.75,.2,1) var(--delay) both; }
.pc-rocket { left: 18%; bottom: 12%; font-size: clamp(2.4rem, 4.8vw, 3.8rem); animation: pc-rocket var(--duration, 3.3s) cubic-bezier(.2,.8,.2,1) .1s both; }
.pc-rocket-trail { position: absolute; left: 25%; bottom: 20%; font-size: clamp(1.1rem, 2.2vw, 1.7rem); animation: pc-trail 3.0s ease-in-out .15s both; }
.pc-trail { position: relative; margin: 0 .08rem; --drift: 0px; animation: pc-trail-spark 2.1s ease-out var(--delay, 0s) both; }
.pc-burst { left: var(--x); top: var(--y); animation: pc-trail-spark var(--duration) ease-out var(--delay) both; }
.pc-confetti-piece { left: var(--x); top: var(--y); animation: pc-confetti var(--duration) cubic-bezier(.2,.7,.15,1) var(--delay) both; }
.pc-treasure-box { position: absolute; left: 50%; top: 44%; transform: translate(-50%, -50%); font-size: clamp(3rem, 5.5vw, 4.6rem); animation: pc-treasure 2.9s cubic-bezier(.2,.8,.2,1) .1s both; }
.pc-chest-lid, .pc-chest-body { display: block; line-height: 1; text-align: center; }
.pc-chest-lid { transform-origin: 50% 100%; }
.pc-chest-body { margin-top: -4px; }
.pc-treasure-spark { left: var(--x); top: var(--y); animation: pc-treasure-spark var(--duration) ease-out var(--delay) both; }
.pc-tornado-core {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255,234,148,.96), rgba(255,234,148,0) 70%);
  box-shadow: 0 0 24px rgba(255, 220, 110, .8);
}
.pc-tornado-piece { left: 50%; top: 50%; animation: pc-tornado 3.4s linear var(--delay) both; transform: translate(-50%, -50%); }
.pc-rainbow-arc { left: 14%; right: 14%; top: 18%; font-size: clamp(3.4rem, 8vw, 6.6rem); animation: pc-rainbow-arc 3.4s ease-in-out .05s both; transform-origin: 50% 90%; }
.pc-rainbow-spark { left: var(--x); top: var(--y); animation: pc-rainbow-spark var(--duration) ease-out var(--delay) both; }
.pc-hat { left: 56%; top: 58%; font-size: clamp(2.4rem, 4.7vw, 3.6rem); animation: pc-hat 2.9s ease-out .1s both; }
.pc-guitar { left: 18%; top: 36%; font-size: clamp(2.4rem, 4.7vw, 3.6rem); animation: pc-guitar 2.8s ease-in-out .08s both; }
.pc-note { left: var(--x); top: var(--y); animation: pc-note var(--duration) ease-in-out var(--delay) both; }
.pc-firework { position: absolute; font-size: clamp(2.4rem, 4.7vw, 3.6rem); animation: pc-firework 3.0s ease-out both; }
.pc-firework-spark { left: var(--x); top: var(--y); animation: pc-firework-spark var(--duration) ease-out var(--delay) both; }
.pc-ripple-ring {
  left: 50%;
  top: 50%;
  width: 20px;
  height: 20px;
  margin: -10px 0 0 -10px;
  border-radius: 50%;
  border: 2px solid rgba(255, 221, 116, .85);
  box-shadow: 0 0 14px rgba(255, 221, 116, .45), inset 0 0 10px rgba(255, 221, 116, .2);
  animation: pc-ripple 3.2s ease-out var(--delay) both;
}
.pc-ripple-coin { left: var(--x); top: var(--y); animation: pc-ripple-coin var(--duration) ease-out var(--delay) both; }
.pc-parader { bottom: 12%; font-size: clamp(2rem, 4vw, 3rem); animation: pc-parade 3.3s ease-in-out var(--delay) both; }
.pc-parade-float { left: var(--x); top: var(--y); animation: pc-parade-float var(--duration) ease-out var(--delay) both; }
.payment-celebration-root[data-effect="flying-monies"] .payment-celebration-card { border-color: rgba(255, 200, 96, .42); }
.payment-celebration-root[data-effect="money-rain"] .payment-celebration-card { border-color: rgba(144, 213, 255, .42); }
.payment-celebration-root[data-effect="coin-fountain"] .payment-celebration-card { border-color: rgba(255, 226, 118, .46); }
.payment-celebration-root[data-effect="rocket-payday"] .payment-celebration-card { border-color: rgba(155, 197, 255, .46); }
.payment-celebration-root[data-effect="confetti-cash"] .payment-celebration-card { border-color: rgba(255, 138, 170, .46); }
.payment-celebration-root[data-effect="treasure-unlocked"] .payment-celebration-card { border-color: rgba(246, 214, 113, .5); }
.payment-celebration-root[data-effect="money-tornado"] .payment-celebration-card { border-color: rgba(220, 198, 134, .46); }
.payment-celebration-root[data-effect="rainbow-riches"] .payment-celebration-card { border-color: rgba(143, 227, 255, .46); }
.payment-celebration-root[data-effect="busker-encore"] .payment-celebration-card { border-color: rgba(209, 178, 255, .46); }
.payment-celebration-root[data-effect="payday-fireworks"] .payment-celebration-card { border-color: rgba(255, 164, 120, .46); }
.payment-celebration-root[data-effect="golden-ripple"] .payment-celebration-card { border-color: rgba(255, 221, 116, .46); }
.payment-celebration-root[data-effect="victory-parade"] .payment-celebration-card { border-color: rgba(255, 171, 207, .46); }
.payment-celebration-root[data-paused="true"] .payment-celebration-card { backdrop-filter: blur(6px); }
@media (max-width: 520px) {
  .payment-celebration-shell { width: min(100%, calc(100vw - 18px)); }
  .payment-celebration-card { padding: 14px 14px 12px; border-radius: 16px; }
  .payment-celebration-card h2 { margin-right: 34px; }
  .payment-celebration-link { width: 100%; justify-content: center; box-sizing: border-box; }
}
@keyframes pc-fly {
  0% { transform: translate3d(0, 0, 0) rotate(-18deg) scale(.8); opacity: 0; }
  12% { opacity: 1; }
  100% { transform: translate3d(var(--dx), var(--dy), 0) rotate(var(--rot)) scale(1.14); opacity: 0; }
}
@keyframes pc-rain {
  0% { transform: translate3d(0, -10vh, 0) rotate(0deg); opacity: 0; }
  10% { opacity: 1; }
  100% { transform: translate3d(var(--sway), 122vh, 0) rotate(var(--rot)); opacity: 0; }
}
@keyframes pc-fountain {
  0% { transform: translate3d(0, 0, 0) scale(.7); opacity: 0; }
  10% { opacity: 1; }
  50% { transform: translate3d(var(--dx), var(--dy), 0) scale(1.15); }
  100% { transform: translate3d(calc(var(--dx) * .92), 34vh, 0) scale(.9); opacity: 0; }
}
@keyframes pc-rocket {
  0% { transform: translate3d(-6vw, 18vh, 0) rotate(-16deg) scale(.9); opacity: 0; }
  12% { opacity: 1; }
  70% { transform: translate3d(46vw, -34vh, 0) rotate(12deg) scale(1.05); }
  100% { transform: translate3d(58vw, -46vh, 0) rotate(18deg) scale(.96); opacity: 0; }
}
@keyframes pc-trail {
  0% { opacity: 0; transform: translate3d(0, 0, 0) scale(.7); }
  18% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(12vw, -16vh, 0) scale(1.1); }
}
@keyframes pc-trail-spark {
  0% { opacity: 0; transform: translate3d(0, 0, 0) scale(.6); }
  30% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--drift), -16vh, 0) scale(1.2); }
}
@keyframes pc-confetti {
  0% { opacity: 0; transform: translate3d(0, -2vh, 0) rotate(0deg) scale(.5); }
  15% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--drift), 28vh, 0) rotate(var(--rot)) scale(1); }
}
@keyframes pc-treasure {
  0% { transform: translate(-50%, -50%) scale(.84); }
  40% { transform: translate(-50%, -50%) scale(1.08) rotate(-2deg); }
  100% { transform: translate(-50%, -50%) scale(1); }
}
@keyframes pc-treasure-spark {
  0% { opacity: 0; transform: translate3d(0, 0, 0) scale(.5); }
  20% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--drift), -20vh, 0) scale(1.15); }
}
@keyframes pc-tornado {
  0% { transform: translate(-50%, -50%) rotate(var(--start)) translateX(var(--radius)) rotate(calc(var(--start) * -1)); opacity: 0; }
  10% { opacity: 1; }
  100% { transform: translate(-50%, -50%) rotate(calc(var(--start) + 720deg * var(--turns))) translateX(calc(var(--radius) * 7)) rotate(calc((var(--start) + 720deg * var(--turns)) * -1)); opacity: 0; }
}
@keyframes pc-rainbow-arc {
  0% { transform: translateY(8vh) scale(.8); opacity: 0; }
  20% { opacity: 1; }
  80% { transform: translateY(-1vh) scale(1.02); }
  100% { transform: translateY(-4vh) scale(1); opacity: .98; }
}
@keyframes pc-rainbow-spark {
  0% { opacity: 0; transform: translate3d(0, 0, 0) scale(.5); }
  20% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--drift), -24vh, 0) scale(1.1); }
}
@keyframes pc-hat {
  0% { transform: translate3d(0, 0, 0) rotate(0deg) scale(.8); opacity: 0; }
  20% { opacity: 1; }
  60% { transform: translate3d(4vw, -8vh, 0) rotate(10deg) scale(1.05); }
  100% { transform: translate3d(12vw, -16vh, 0) rotate(18deg) scale(.95); opacity: 0; }
}
@keyframes pc-guitar {
  0% { transform: translate3d(-14vw, 4vh, 0) rotate(-16deg) scale(.9); opacity: 0; }
  15% { opacity: 1; }
  55% { transform: translate3d(0, 0, 0) rotate(8deg) scale(1.05); }
  100% { transform: translate3d(12vw, -8vh, 0) rotate(20deg) scale(.92); opacity: 0; }
}
@keyframes pc-note {
  0% { opacity: 0; transform: translate3d(0, 0, 0) scale(.65); }
  22% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--drift), -20vh, 0) scale(1.08); }
}
@keyframes pc-firework {
  0% { opacity: 0; transform: scale(.5); }
  10% { opacity: 1; }
  30% { transform: scale(1.2); }
  100% { opacity: 0; transform: scale(.86); }
}
@keyframes pc-firework-spark {
  0% { opacity: 0; transform: translate3d(0, 0, 0) scale(.55); }
  20% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--drift), -20vh, 0) scale(1.15); }
}
@keyframes pc-ripple {
  0% { transform: scale(.3); opacity: 0; }
  20% { opacity: 1; }
  100% { transform: scale(13); opacity: 0; }
}
@keyframes pc-ripple-coin {
  0% { opacity: 0; transform: translate3d(0, 0, 0) scale(.6); }
  20% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--drift), -16vh, 0) scale(1.15); }
}
@keyframes pc-parade {
  0% { transform: translate3d(-22vw, 0, 0) rotate(-4deg); opacity: 0; }
  15% { opacity: 1; }
  50% { transform: translate3d(24vw, -1vh, 0) rotate(4deg); }
  100% { transform: translate3d(64vw, 0, 0) rotate(-2deg); opacity: 0; }
}
@keyframes pc-parade-float {
  0% { opacity: 0; transform: translate3d(0, 6vh, 0) scale(.7); }
  15% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--drift), -20vh, 0) scale(1.08); }
}
@media (prefers-reduced-motion: reduce) {
  #payment-celebration-root * {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
}
  `;
  documentRef.head.appendChild(style);
}

function ensureController(documentRef = globalThis.document, windowRef = globalThis.window, storageRef = globalThis.localStorage) {
  if (controller) return controller;
  if (!documentRef || !windowRef) {
    controller = {
      show() {},
      hide() {},
      enqueue() {},
      destroy() {},
    };
    return controller;
  }

  ensureStyles(documentRef);
  const root = documentRef.createElement('section');
  root.id = 'payment-celebration-root';
  root.className = 'payment-celebration-root';
  root.hidden = true;
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-atomic', 'true');
  root.innerHTML = `
    <div class="payment-celebration-shell">
      <article class="payment-celebration-card" role="status">
        <button type="button" class="payment-celebration-dismiss" aria-label="Dismiss payment celebration">×</button>
        <h2 class="payment-celebration-title">Payment confirmed on chain</h2>
        <p class="payment-celebration-summary"></p>
        <p class="payment-celebration-subtitle"></p>
        <a class="payment-celebration-link" href="#" target="_blank" rel="noopener noreferrer">Open transaction ↗</a>
      </article>
    </div>
    <div class="payment-celebration-stage" aria-hidden="true"></div>
  `;
  documentRef.body.appendChild(root);
  const title = root.querySelector('.payment-celebration-title');
  const summary = root.querySelector('.payment-celebration-summary');
  const subtitle = root.querySelector('.payment-celebration-subtitle');
  const link = root.querySelector('.payment-celebration-link');
  const dismiss = root.querySelector('.payment-celebration-dismiss');
  const stage = root.querySelector('.payment-celebration-stage');
  const reducedMotion = !!windowRef.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const state = { timer: null, paused: false, reducedMotion };

  const hide = () => {
    clearTimeout(state.timer);
    state.timer = null;
    root.hidden = true;
    root.dataset.effect = '';
    root.dataset.phase = '';
    stage.hidden = false;
    stage.replaceChildren();
  };

  const showNext = () => {
    if (state.timer || !queue.length) return;
    const detail = queue.shift();
    root.dataset.effect = detail.effectId;
    root.dataset.phase = reducedMotion ? 'reduced' : 'celebrating';
    root.hidden = false;
    stage.dataset.paused = documentRef.hidden ? 'true' : 'false';
    stage.hidden = false;
    title.textContent = detail.title;
    summary.textContent = paymentLine(detail);
    subtitle.textContent = detail.txLabel || detail.source || `Tx ${detail.txHash.slice(0, 10)}…`;
    link.href = detail.explorerUrl;
    link.textContent = `Open ${detail.txHash.slice(0, 10)}…`;
    try {
      stage.innerHTML = RENDERERS[detail.effectId](detail, reducedMotion);
    } catch (error) {
      stage.replaceChildren();
      console.error('[payment-celebration] Animation failed; payment remains confirmed:', error);
    }
    if (reducedMotion) {
      state.timer = windowRef.setTimeout(() => {
        hide();
        state.timer = null;
        showNext();
      }, REDUCED_MOTION_DURATION_MS);
      return;
    }
    state.timer = windowRef.setTimeout(() => {
      root.dataset.phase = 'compact';
      stage.hidden = true;
      stage.replaceChildren();
      state.timer = windowRef.setTimeout(() => {
        hide();
        state.timer = null;
        showNext();
      }, COMPACT_DURATION_MS);
    }, ACTIVE_DURATION_MS);
  };

  const show = detail => {
    queue.push(detail);
    showNext();
  };

  const pause = () => {
    stage.dataset.paused = documentRef.hidden ? 'true' : 'false';
  };

  dismiss.addEventListener('click', () => {
    hide();
    windowRef.setTimeout(() => showNext(), DEFAULT_PAUSE_MS);
  });
  documentRef.addEventListener('visibilitychange', pause);

  const destroy = () => {
    hide();
    documentRef.removeEventListener?.('visibilitychange', pause);
    root.remove?.();
    controller = null;
    booted = false;
    queue = [];
  };

  controller = { show, hide, destroy };
  if (queue.length) showNext();
  return controller;
}

export function resetPaymentCelebrationState() {
  queue = [];
  seen.clear();
  effectIndex = 0;
}

export function nextPaymentCelebrationEffect() {
  return nextEffect();
}

export function announcePaymentCelebration(detail = {}) {
  const normalized = normalize(detail);
  if (!normalized) return { accepted: false, reason: 'invalid' };
  loadSeen();
  if (seen.has(normalized.key)) return { accepted: false, reason: 'duplicate', key: normalized.key };
  const effect = nextEffect();
  normalized.effectId = effect.id;
  normalized.effectLabel = effect.label;
  seen.set(normalized.key, Date.now());
  saveSeen();
  if (controller) controller.show(normalized);
  else queue.push(normalized);
  return { accepted: true, key: normalized.key, effectId: effect.id, effectLabel: effect.label };
}

export function initPaymentCelebrations(options = {}) {
  const { document: documentRef = globalThis.document, window: windowRef = globalThis.window, storage = globalThis.localStorage } = options;
  if (!documentRef || !windowRef) return null;
  const existing = ensureController(documentRef, windowRef, storage);
  if (booted) return existing;
  booted = true;
  loadSeen(storage);
  if (queue.length) existing.show(queue.shift());
  return existing;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const boot = () => initPaymentCelebrations({ document, window, storage: globalThis.localStorage });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else queueMicrotask(boot);
}
