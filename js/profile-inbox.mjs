import { promotionLink, campaignAsset, formatAssetUnits, CAMPAIGN_GIFT_ICONS, CAMPAIGN_GIFT_LABELS } from './promotions.mjs?v=20261126-eth-gifts';

const short = wallet => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function sparkle(target, doc = target.ownerDocument) {
  const burst = el(doc, 'span', 'inbox-burst');
  for (let index = 0; index < 8; index += 1) {
    const dot = el(doc, 'i');
    dot.style.setProperty('--a', `${index * 45}deg`);
    burst.append(dot);
  }
  target.append(burst);
  setTimeout(() => burst.remove(), 900);
}

// The live payment slot keeps its own element; other sources replace their card list by key.
export function createProfileInbox({ doc = document, slots = [], isOwnProfile = () => true } = {}) {
  const element = el(doc, 'section', 'profile-inbox');
  element.setAttribute('aria-label', 'For you');
  const header = el(doc, 'header', 'profile-inbox-head');
  const count = el(doc, 'span', 'profile-inbox-count');
  const previous = el(doc, 'button', 'profile-inbox-arrow', '‹');
  const next = el(doc, 'button', 'profile-inbox-arrow', '›');
  for (const [button, label] of [[previous, 'Previous'], [next, 'Next']]) {
    button.type = 'button';
    button.setAttribute('aria-label', label);
  }
  header.append(el(doc, 'span', 'profile-inbox-title', '✨ For you'), count, previous, next);
  const track = el(doc, 'div', 'profile-inbox-track');
  const empty = el(doc, 'p', 'profile-inbox-empty', '🌙 All caught up');
  const lists = new Map();
  element.append(header, track, empty);
  const visible = () => [...track.children].filter(child => !child.hidden);
  const position = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  const refresh = () => {
    const cards = visible();
    const index = Math.min(position(), Math.max(0, cards.length - 1));
    count.textContent = cards.length > 1 ? `${index + 1} / ${cards.length}` : cards.length ? '1' : '';
    count.classList.toggle('has-items', cards.length > 0);
    // Write only changes: re-setting `hidden` queues a mutation and would re-trigger the observer forever.
    const set = (node, key, value) => { if (node[key] !== value) node[key] = value; };
    set(previous, 'hidden', cards.length < 2);
    set(next, 'hidden', cards.length < 2);
    set(previous, 'disabled', index <= 0);
    set(next, 'disabled', index >= cards.length - 1);
    set(empty, 'hidden', cards.length > 0);
    set(track, 'hidden', !cards.length);
    set(element, 'hidden', !cards.length && !isOwnProfile());
  };
  const go = step => track.scrollBy({ left: step * track.clientWidth, behavior: 'smooth' });
  previous.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  track.addEventListener('scroll', () => requestAnimationFrame(refresh), { passive: true });
  for (const slot of slots) {
    slot.classList.add('profile-inbox-card');
    track.append(slot);
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(refresh).observe(track, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }
  const render = () => {
    const fixed = slots;
    track.replaceChildren(...fixed, ...[...lists.values()].flat());
    refresh();
  };
  return {
    element,
    refresh,
    setCards(key, cards = []) {
      cards.forEach(card => card.classList.add('profile-inbox-card'));
      lists.set(key, cards);
      render();
    },
  };
}

export function activeReferralInvites(state, wallet, now = Date.now()) {
  const lower = String(wallet || '').toLowerCase();
  if (!lower) return [];
  return (state?.participantProfiles || []).filter(item => {
    if (item.template === 'pinner') return false;
    const active = ['published', 'paused'].includes(item.status) && now < Date.parse(item.claimDeadline || item.endsAt);
    const owed = item.status !== 'draft' && item.supporterToken?.eligible && item.supporterToken.delivery !== 'delivered';
    return item.wallet?.toLowerCase() === lower && (active || owed);
  });
}

function ring(doc, fraction, label) {
  const wrap = el(doc, 'div', 'inbox-ring');
  wrap.style.setProperty('--p', String(Math.max(0, Math.min(1, fraction))));
  wrap.append(el(doc, 'strong', '', label));
  return wrap;
}

export function renderReferralInviteCard(stats, { wallet, doc = document, now = Date.now(), resolveAvatar = async () => null,
  writeText = text => navigator.clipboard.writeText(text), site = globalThis.location?.href } = {}) {
  const card = el(doc, 'article', 'inbox-referral');
  card.dataset.campaignId = stats.campaignId;
  const earned = ['pendingUnits', 'approvedUnits', 'paidUnits'].reduce((n, key) => n + BigInt(stats[key] || 0), 0n);
  const possible = earned + BigInt(stats.maxEarningsUnits || 0);
  const ended = now >= Date.parse(stats.endsAt);
  const claimsOpen = ['published', 'paused'].includes(stats.status) &&
    now < Date.parse(stats.claimDeadline || stats.endsAt);
  const supporterOwed = stats.supporterToken?.eligible && stats.supporterToken.delivery !== 'delivered';
  const days = Math.max(0, Math.ceil((Date.parse(stats.endsAt) - now) / 86400000));
  const head = el(doc, 'header', 'inbox-referral-head');
  head.append(el(doc, 'span', 'inbox-badge', '🤝'),
    el(doc, 'strong', 'inbox-referral-title', stats.title || 'Referral Campaign'),
    el(doc, 'span', 'inbox-chip', !claimsOpen && supporterOwed ? '🎖 awaiting delivery' : ended ? '⏳ claims open' : `⏳ ${days}d`));
  const body = el(doc, 'div', 'inbox-referral-body');
  const money = units => formatAssetUnits(units || 0, campaignAsset(stats));
  const legs = stats.legAmounts || {};
  const facts = el(doc, 'div', 'inbox-facts');
  facts.append(el(doc, 'span', '', `🤝 ${money(legs.referrer)} each`),
    el(doc, 'span', '', `🎤 ${money(legs.musician)} them`),
    el(doc, 'span', '', `🗳 ${stats.requiredVotes ?? 10} votes`),
    el(doc, 'span', '', `🎯 ${stats.remainingConversions ?? '—'} open`));
  if (stats.supporterToken?.eligible) {
    const delivery = stats.supporterToken.delivery;
    const chip = el(doc, 'span', 'is-glow', delivery === 'delivered' ? '🎖 Supporter ✅' : '🎖 Supporter 🎁');
    chip.title = delivery === 'delivered' ? 'Supporter token delivered to your wallet' : 'Supporter token earned — on its way to your wallet';
    facts.append(chip);
  }
  for (const gift of stats.gifts || []) {
    const mine = (stats.giftAwards || []).filter(award => award.trigger === gift.trigger);
    const amount = mine[0]?.amountUnits ?? gift.amountUnits;
    const complete = mine.every(a => ['paid', 'supporter-only'].includes(a.status)) &&
      (!gift.supporter || stats.supporterToken?.delivery === 'delivered');
    const chip = el(doc, 'span', mine.length ? 'is-glow inbox-gift' : 'inbox-gift',
      `${CAMPAIGN_GIFT_ICONS[gift.trigger]} ${amount !== '0' ? money(amount) : ''}${gift.supporter ? '🎖' : ''}${mine.length ? (complete ? ' ✅' : ' 🎁') : ''}`);
    chip.title = mine.length ? `You won: ${CAMPAIGN_GIFT_LABELS[gift.trigger]}` : `Gift: ${CAMPAIGN_GIFT_LABELS[gift.trigger]}`;
    facts.append(chip);
  }
  body.append(ring(doc, possible > 0n ? Number(earned) / Number(possible) : 0, `${money(earned)}`),
    el(doc, 'div', 'inbox-ring-label', `of ${money(possible)} possible`), facts);
  const aliens = el(doc, 'div', 'inbox-aliens');
  aliens.setAttribute('aria-label', 'Musicians you brought in');
  const referred = (stats.referred || []).filter(item => !item.self && item.referrer?.toLowerCase() === wallet.toLowerCase());
  for (const person of referred) {
    const done = person.trackState === 'minted' && person.voteProgress >= (stats.requiredVotes ?? 10);
    const avatar = el(doc, 'span', `inbox-alien${done ? ' is-done' : ''}`);
    avatar.style.setProperty('--p', String(Math.min(1, person.voteProgress / (stats.requiredVotes || 10))));
    avatar.title = `${short(person.wallet)} · 🗳 ${person.voteProgress}/${stats.requiredVotes ?? 10} · ${person.trackState === 'minted' ? '🎵 minted' : '🎵 not yet'}`;
    const face = el(doc, 'span', 'inbox-alien-face', '👽');
    avatar.append(face);
    void resolveAvatar(person.wallet).then(found => {
      if (!found?.src) return;
      const image = el(doc, 'img');
      image.alt = '';
      image.src = found.src;
      image.onerror = () => image.remove();
      face.replaceChildren(image);
      if (found.name) avatar.title = `${found.name} · ${avatar.title.split(' · ').slice(1).join(' · ')}`;
    }).catch(() => {});
    aliens.append(avatar);
  }
  if (!referred.length) aliens.append(el(doc, 'span', 'inbox-alien is-empty', '👽'), el(doc, 'small', '', 'Invite your first alien'));
  const self = (stats.referred || []).find(item => item.self && item.referrer);
  const journey = self ? el(doc, 'p', 'inbox-journey',
    `Your run: 🎵 ${self.trackState === 'minted' ? '✅' : '…'} · 🗳 ${self.voteProgress}/${stats.requiredVotes ?? 10}`) : null;
  const actions = el(doc, 'footer', 'inbox-actions');
  const copy = el(doc, 'button', 'inbox-action', '🔗 Copy invite');
  copy.type = 'button';
  copy.disabled = ended || !['published', 'paused'].includes(stats.status);
  copy.addEventListener('click', async () => {
    try {
      await writeText(promotionLink(stats.campaignId, wallet, site));
      copy.textContent = '✨ Copied';
      copy.classList.add('is-done');
      sparkle(copy, doc);
      setTimeout(() => { copy.textContent = '🔗 Copy invite'; copy.classList.remove('is-done'); }, 1800);
    } catch {
      copy.textContent = '⚠️ Copy failed';
    }
  });
  actions.append(copy);
  card.append(head, body, aliens, ...(journey ? [journey] : []), actions);
  return card;
}
