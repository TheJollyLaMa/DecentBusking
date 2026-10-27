import { modelContext } from './model.mjs';

export const MODES = ['efficient', 'balanced', 'deep'];
export const TASKS = ['navigation', 'guidance', 'technical', 'sensitive'];
export const TIERS = ['light', 'standard', 'deep'];
export const REVIEWS = ['ready', 'needs_deeper_review', 'insufficient_evidence'];

function keys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

export function validateRouting(policy) {
  if (!keys(policy, ['version', 'models', 'balancedRoutes', 'recommendations']) || policy.version !== 1 ||
      !keys(policy.models, TIERS) || Object.values(policy.models).some(model =>
        typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model)) ||
      !keys(policy.balancedRoutes, TASKS) || Object.values(policy.balancedRoutes).some(tier => !TIERS.includes(tier)) ||
      !keys(policy.recommendations, ['minSamples', 'reviewRate', 'failureRate']) ||
      !Number.isSafeInteger(policy.recommendations.minSamples) || policy.recommendations.minSamples < 20 ||
      policy.recommendations.minSamples > 10000 ||
      ['reviewRate', 'failureRate'].some(key => !Number.isFinite(policy.recommendations[key]) ||
        policy.recommendations[key] <= 0 || policy.recommendations[key] > 1)) {
    throw new Error('Invalid reviewed routing policy');
  }
  return policy;
}

export function classifyTask(message, previousTask) {
  if (/\b(payout|paid|payment|funds?|money|balances?|transactions?|fees?|earn|rewards?|signature|seed phrase|private key|lost|stolen|scam|rights?|copyright|consent|splits?|withdraw|transfer|multisig|multi.sig|safe (?:wallet|contract)|erc.?1271|governance|decentrali[sz](?:e|ed|ation)|admin roles)\b/i.test(message)) return 'sensitive';
  if (/\b(debug|error|bug|fail(?:ed|ing|ure)?|architect(?:ure)?|implement|clone|fork|host|deploy|contract|code|function|tests?|compare)\b/i.test(message)) return 'technical';
  if (message.length <= 160 && /\b(where|link|find|open|tutorial|guide)\b/i.test(message)) return 'navigation';
  if (message.length <= 80 && TASKS.includes(previousTask) &&
      /\b(that|this|it|those|more|why|continue|next|follow.?up)\b/i.test(message)) return previousTask;
  return 'guidance';
}

export function selectRoute(policy, mode, message, previousTask) {
  if (!MODES.includes(mode)) throw new Error('Invalid DBusker mode');
  const task = classifyTask(message, previousTask);
  const tier = mode === 'efficient' ? 'light' : mode === 'deep' ? 'deep' : policy.balancedRoutes[task];
  return { mode, task, tier, model: policy.models[tier] };
}

export function deeperRoute(policy, route, review, attempt) {
  if (route.mode !== 'balanced' || review !== 'needs_deeper_review' || attempt !== 1) return null;
  const tier = TIERS[TIERS.indexOf(route.tier) + 1];
  if (!tier || policy.models[tier] === route.model) return null;
  return { ...route, tier, model: policy.models[tier] };
}

export function fitContext({ instructions, sources, messages, draft }) {
  const boundedDraft = draft && draft.answer.length > 2000
    ? { ...draft, answer: draft.answer.slice(0, 2000), truncated: true } : draft;
  const context = { instructions, sources: [...sources], messages: [...messages], ...(boundedDraft ? { draft: boundedDraft } : {}) };
  const bytes = () => Buffer.byteLength(JSON.stringify(modelContext(context)));
  while (bytes() > 28000 && context.messages.length > 3) context.messages.splice(0, 2);
  while (bytes() > 28000 && context.sources.length > 1) context.sources.pop();
  while (bytes() > 28000 && context.messages.length > 1) context.messages.splice(0, 2);
  if (bytes() > 28000) throw Object.assign(new Error('Conversation context is too large. Sign out and start a shorter conversation.'), { status: 413 });
  return context;
}

export function finalAnswer(candidate) {
  if (candidate.review === 'ready') return candidate;
  if (candidate.review === 'insufficient_evidence') return { ...candidate, abstained: true };
  return {
    ...candidate, abstained: true, sources: [],
    answer: 'I could not complete a reliable answer within this mode and its review limit. Try Balanced or Deep dive if available, or ask a community steward. A stronger model still cannot verify missing evidence or live payouts.',
  };
}
