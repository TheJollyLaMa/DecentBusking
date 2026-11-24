import { workerEnsProvider } from './ens-client.mjs?v=20261016-ens-worker';
import { resolveCreatorENS, creatorImageURL } from './creator-profile-data.mjs?v=20261119-musician-care';

const lower = value => String(value || '').toLowerCase();
const isWallet = value => /^0x[0-9a-f]{40}$/i.test(String(value || ''));
const short = wallet => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
const SKIP_KEY = wallet => `dbusk-inviter-skip:${lower(wallet)}`;
const ASKED_KEY = 'dbusk-inviter-asked';

let rosterRequest;
let stateRequest;
let stateAt = 0;
const labels = new Map();

export function rosterPeople(data = {}) {
  return [...(data.contributors || []), ...(data.invitedParticipants || [])].map(entry => ({
    wallet: isWallet(entry.walletAddress) ? lower(entry.walletAddress) : '',
    name: entry.displayName || entry.github || '',
    referredBy: isWallet(entry.referredBy) ? lower(entry.referredBy) : '',
    referredByName: entry.referredByName || '',
  }));
}

export function loadRoster(fetchImpl = globalThis.fetch) {
  rosterRequest ||= fetchImpl(new URL('../contributor-accounts.json', import.meta.url), { cache: 'no-store' })
    .then(response => response.ok ? response.json() : {}).then(rosterPeople).catch(() => []);
  return rosterRequest;
}

function service() {
  return String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
}

export function loadPromotionsState(fetchImpl = globalThis.fetch) {
  if (!service()) return Promise.resolve({});
  if (!stateRequest || Date.now() - stateAt > 60_000) {
    stateAt = Date.now();
    stateRequest = fetchImpl(`${service()}/api/promotions`, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
      .then(response => response.ok ? response.json() : {}).catch(() => ({}));
  }
  return stateRequest;
}

/** Journal records win over the founding roster; returns null when nobody is recorded. */
export function inviterFor(wallet, { inviters = [], roster = [] } = {}) {
  const target = lower(wallet);
  if (!isWallet(target)) return null;
  const record = inviters.find(item => item.wallet === target);
  if (record) return { wallet: record.referrer, name: '', source: 'journal', at: record.at };
  const entry = roster.find(item => item.wallet === target && item.referredBy);
  return entry ? { wallet: entry.referredBy, name: entry.referredByName, source: 'founding' } : null;
}

/** Curated referrers from open referral campaigns first, then the roster; never the viewer. */
export function inviterChoices(wallet, { roster = [], campaigns = [], now = Date.now() } = {}) {
  const self = lower(wallet);
  const choices = new Map();
  for (const campaign of campaigns) {
    if (campaign.template !== 'musician-referral' || campaign.status !== 'published' ||
        Date.parse(campaign.startsAt) > now || now >= Date.parse(campaign.endsAt)) continue;
    for (const curated of campaign.curatedReferrers || []) {
      if (isWallet(curated) && lower(curated) !== self) choices.set(lower(curated), { wallet: lower(curated), name: '' });
    }
  }
  for (const person of roster) {
    if (!person.wallet || person.wallet === self) continue;
    choices.set(person.wallet, { wallet: person.wallet, name: choices.get(person.wallet)?.name || person.name });
  }
  return [...choices.values()];
}

export function referrerLabel(wallet, { name = '', roster = [] } = {}) {
  const target = lower(wallet);
  if (!labels.has(target)) {
    labels.set(target, resolveCreatorENS(target, workerEnsProvider).catch(() => null).then(async ens => {
      let discord = '';
      if (!ens?.name && service()) {
        discord = await fetch(`${service()}/api/creator/profile?${new URLSearchParams({ address: target })}`,
          { signal: AbortSignal.timeout(10000) }).then(response => response.ok ? response.json() : {})
          .then(profile => profile?.discord?.displayName || '').catch(() => '');
      }
      return {
        wallet: target,
        label: ens?.name || discord || name || roster.find(item => item.wallet === target)?.name || short(target),
        avatar: ens?.avatarURI ? creatorImageURL(ens.avatarURI, window.DecentConfig?.ipfsGateway) : '',
      };
    }));
  }
  return labels.get(target);
}

async function resolveInput(value) {
  const input = String(value || '').trim();
  if (isWallet(input)) return lower(input);
  if (!input.includes('.')) throw new Error('Enter an ENS name or 0x wallet');
  const resolved = await workerEnsProvider.resolveName(input).catch(() => '');
  if (!isWallet(resolved)) throw new Error('That name did not resolve');
  return lower(resolved);
}

function avatarNode(doc, person) {
  const node = doc.createElement('span');
  node.className = 'inviter-avatar';
  node.textContent = '👽';
  void person.then?.(found => {
    if (!found?.avatar) return;
    const img = doc.createElement('img');
    img.alt = '';
    img.src = found.avatar;
    img.onerror = () => img.remove();
    node.replaceChildren(img);
  });
  return node;
}

let openDialog = null;

/**
 * Shows the "who brought you here?" card. Resolves with the chosen wallet, or '' when skipped/closed.
 * `record` signs `set-inviter` (default); pass `record: false` when the caller records it another way.
 */
export async function openInviterPrompt({ source = 'profile', record = true, doc = document } = {}) {
  const current = window._wallet;
  if (!isWallet(current?.address)) return '';
  if (openDialog) return openDialog;
  const wallet = lower(current.address);
  const [roster, state] = await Promise.all([loadRoster(), loadPromotionsState()]);
  const choices = inviterChoices(wallet, { roster, campaigns: state.campaigns || [] });
  const dialog = doc.createElement('dialog');
  dialog.className = 'inviter-prompt';
  dialog.innerHTML = `
    <form method="dialog" class="inviter-card">
      <span class="inviter-ufo" aria-hidden="true">🛸</span>
      <h2>Who brought you here?</h2>
      <button type="button" class="inviter-info" aria-label="About invitations" title="Saved once, publicly. Your inviter may earn from open referral campaigns.">i</button>
      <p class="inviter-info-text" hidden>Saved once, publicly. Your inviter may earn from open referral campaigns.</p>
      <div class="inviter-chips" role="radiogroup" aria-label="Inviter"></div>
      <label class="inviter-other"><span aria-hidden="true">🔎</span><input name="other" placeholder="name.eth / 0x…" autocomplete="off" spellcheck="false" aria-label="Inviter ENS or wallet"></label>
      <p class="inviter-status" role="status" aria-live="polite"></p>
      <div class="inviter-actions">
        <button type="button" class="inviter-skip" value="skip">Skip</button>
        <button type="submit" class="inviter-confirm" value="confirm" disabled>👽 That’s them</button>
      </div>
    </form>`;
  const chipBox = dialog.querySelector('.inviter-chips');
  const other = dialog.querySelector('[name="other"]');
  const confirm = dialog.querySelector('.inviter-confirm');
  const status = dialog.querySelector('.inviter-status');
  const infoText = dialog.querySelector('.inviter-info-text');
  let chosen = '';
  const select = value => {
    chosen = value;
    for (const chip of chipBox.children) chip.setAttribute('aria-checked', String(chip.dataset.wallet === value));
    confirm.disabled = !chosen && !other.value.trim();
  };
  for (const choice of choices) {
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'inviter-chip';
    chip.dataset.wallet = choice.wallet;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', 'false');
    const lookup = referrerLabel(choice.wallet, { name: choice.name, roster });
    const label = doc.createElement('span');
    label.className = 'inviter-chip-name';
    label.textContent = choice.name || short(choice.wallet);
    void lookup.then(found => { label.textContent = found.label; chip.title = found.label; });
    chip.append(avatarNode(doc, lookup), label);
    chip.addEventListener('click', () => { other.value = ''; select(chosen === choice.wallet ? '' : choice.wallet); });
    chipBox.append(chip);
  }
  chipBox.hidden = !choices.length;
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref && choices.some(choice => choice.wallet === lower(ref))) select(lower(ref));
  else if (ref) { other.value = ref; select(''); }
  other.addEventListener('input', () => select(''));
  dialog.querySelector('.inviter-info').addEventListener('click', () => { infoText.hidden = !infoText.hidden; });
  doc.body.append(dialog);
  openDialog = new Promise(resolve => {
    const finish = value => {
      dialog.classList.add('is-leaving');
      setTimeout(() => { dialog.close(); dialog.remove(); }, value ? 650 : 180);
      openDialog = null;
      resolve(value);
    };
    dialog.querySelector('.inviter-skip').addEventListener('click', () => {
      try { localStorage.setItem(SKIP_KEY(wallet), new Date().toISOString()); } catch {}
      finish('');
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(''); });
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      confirm.disabled = true;
      status.textContent = '…';
      try {
        const referrer = chosen || await resolveInput(other.value);
        if (referrer === wallet) throw new Error('That’s you 🙂');
        if (record) {
          status.textContent = '✍️';
          const { signedPromotionCommand } = await import('./promotions-ui.mjs?v=20261126-eth-gifts');
          await signedPromotionCommand({ action: 'set-inviter', referrer, source });
          stateRequest = null;
        }
        status.textContent = '';
        dialog.classList.add('is-welcomed');
        doc.dispatchEvent(new CustomEvent('dbusk-inviter-recorded', { detail: { wallet, referrer } }));
        finish(referrer);
      } catch (error) {
        status.textContent = error.message || 'Could not save';
        confirm.disabled = false;
      }
    });
  });
  dialog.showModal();
  return openDialog;
}

/** One gentle ask per wallet: skipped, already known, or already asked this session → no prompt. */
export async function maybePromptInviter(options = {}) {
  try {
    const wallet = lower(window._wallet?.address);
    if (!isWallet(wallet)) return '';
    try {
      if (localStorage.getItem(SKIP_KEY(wallet)) || sessionStorage.getItem(`${ASKED_KEY}:${wallet}`)) return '';
      sessionStorage.setItem(`${ASKED_KEY}:${wallet}`, '1');
    } catch {}
    const [roster, state] = await Promise.all([loadRoster(), loadPromotionsState()]);
    if (inviterFor(wallet, { inviters: state.inviters || [], roster })) return '';
    return await openInviterPrompt(options);
  } catch {
    return '';
  }
}

/** Subtle "via …" pill near the profile banner; on your own profile with nobody recorded, a faint ask. */
export async function renderReferredBadge(element, { wallet, own = false, state = null } = {}) {
  if (!element) return;
  const target = lower(wallet);
  const token = String((Number(element.dataset.render) || 0) + 1);
  element.dataset.render = token;
  if (element.dataset.for !== target) { element.hidden = true; element.replaceChildren(); element.dataset.for = target; }
  const current = () => element.dataset.render === token;
  const [roster, promotions] = await Promise.all([loadRoster(), state ? Promise.resolve(state) : loadPromotionsState()]);
  if (!current()) return;
  const inviter = inviterFor(target, { inviters: promotions.inviters || [], roster });
  const doc = element.ownerDocument;
  if (!inviter) {
    if (!own) { element.hidden = true; element.replaceChildren(); return; }
    const ask = doc.createElement('button');
    ask.type = 'button';
    ask.className = 'referred-badge is-ask';
    ask.textContent = '👽 who invited you?';
    ask.addEventListener('click', async () => {
      const chosen = await openInviterPrompt({ source: 'profile' });
      if (chosen) await renderReferredBadge(element, { wallet: target, own });
    });
    element.replaceChildren(ask);
    element.hidden = false;
    return;
  }
  const found = await referrerLabel(inviter.wallet, { name: inviter.name, roster });
  if (!current()) return;
  const link = doc.createElement('button');
  link.type = 'button';
  link.className = 'referred-badge';
  link.title = `Invited by ${found.label}`;
  link.setAttribute('aria-label', `Invited by ${found.label}`);
  const icon = doc.createElement('span');
  icon.className = 'referred-badge-icon';
  icon.setAttribute('aria-hidden', 'true');
  if (found.avatar) {
    const img = doc.createElement('img');
    img.alt = '';
    img.src = found.avatar;
    img.onerror = () => { img.remove(); icon.textContent = '🛸'; };
    icon.append(img);
  } else icon.textContent = '🛸';
  const text = doc.createElement('span');
  text.textContent = `via ${found.label}`;
  link.append(icon, text);
  link.addEventListener('click', () => doc.dispatchEvent(new CustomEvent('open-creator-profile', { detail: { address: inviter.wallet } })));
  element.replaceChildren(link);
  element.hidden = false;
}

/** DBusker's Discord nudge links to `?inviter=1`; ask once the wallet is connected. */
export function watchInviterLink({ doc = document, search = globalThis.location?.search || '' } = {}) {
  if (new URLSearchParams(search).get('inviter') !== '1') return;
  let asked = false;
  const ask = async () => {
    if (asked || !isWallet(window._wallet?.address)) return;
    asked = true;
    const [roster, state] = await Promise.all([loadRoster(), loadPromotionsState()]);
    if (!inviterFor(window._wallet.address, { inviters: state.inviters || [], roster })) {
      await openInviterPrompt({ source: 'discord', doc });
    }
  };
  doc.addEventListener('wallet-connected', () => { void ask(); });
  void ask();
}
if (typeof document !== 'undefined') watchInviterLink();
