import { buildMusicianCareAuthorizationMessage, musicianCareDay, musicianCareTotals,
  normalizeMusicianCareEntry, normalizeMusicianCareState } from './creator-profile-data.mjs?v=20261119-musician-care';
import { PRACTICES, practicePhase, createPracticeTimer } from './bignuten-practice.mjs?v=20261119-guided-care';

export function initBigNutenPanel({ document = globalThis.document, window = globalThis.window,
  fetchImpl = globalThis.fetch, now = () => new Date(),
  timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  monotonicNow = () => performance.now(), schedule = setInterval, clear = clearInterval } = {}) {
  const byId = id => document.getElementById(`bignuten-${id}`);
  const total = byId('water-total');
  if (!total) return;
  const status = byId('water-status');
  const service = String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  const wallet = () => String(window._wallet?.address || '').toLowerCase();
  let address = '', signer, revision = 0, busy = false, available = false, state = null, pending = null, selected = '';
  const say = message => { status.textContent = message; };
  const today = () => musicianCareDay(now(), timeZone());
  const lastWater = () => state?.entries.filter(entry => !entry.removedAt && entry.activity === 'water' && entry.date === today()).at(-1);
  const current = check => check === revision && address === wallet() && signer === window._wallet?.signer;
  let method = 'even', practice = null;
  const duration = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const practiceSay = message => { byId('practice-status').textContent = message; };
  const timer = createPracticeTimer({
    now: monotonicNow, schedule, clear,
    tick(seconds, precise) {
      if (practice) { practice.seconds = seconds; practice.precise = precise; }
      renderPractice();
    },
    complete() { if (practice) { practice.status = 'complete'; renderPractice(); } },
  });

  function renderPractice() {
    const preset = PRACTICES[method], voice = preset.family === 'throat';
    const seconds = practice?.seconds || 0, precise = practice?.precise || 0;
    const phase = practicePhase(method, precise);
    const running = practice?.status === 'running', complete = practice?.status === 'complete';
    byId('practice-controls').classList.toggle('is-voice', voice);
    byId('practice-controls').dataset.running = String(running);
    byId('practice-title').textContent = preset.title;
    byId('practice-hint').textContent = preset.hint;
    byId('breath-methods').hidden = byId('breath-today').hidden = voice;
    if (voice) byId('breath-icon').setAttribute('hidden', '');
    else byId('breath-icon').removeAttribute('hidden');
    byId('voice-methods').hidden = byId('voice-icon').hidden = byId('voice-today').hidden = !voice;
    byId('practice-symbol').textContent = preset.symbol;
    for (const id of Object.keys(PRACTICES)) {
      byId(`method-${id}`).setAttribute('aria-pressed', String(id === method));
      byId(`method-${id}`).disabled = !!practice;
    }
    const label = complete ? seconds >= 60 ? 'Minute complete' : 'Ready to log'
      : running ? phase.label : practice ? 'Paused' : 'One gentle minute';
    if (byId('practice-phase').textContent !== label) byId('practice-phase').textContent = label;
    byId('practice-elapsed').textContent = duration(seconds);
    byId('practice-countdown').textContent = running ? `${phase.remaining}s` : '';
    byId('practice-ring').setAttribute('aria-valuenow', String(seconds));
    byId('practice-progress').setAttribute('stroke-dashoffset', String(100 * (1 - precise / 60)));
    const scale = !practice || complete ? .8 : phase.key === 'inhale' ? .74 + .26 * phase.progress
      : phase.key === 'exhale' || phase.key === 'sound' ? 1 - .26 * phase.progress : .74;
    byId('practice-orb').style.transform = `scale(${scale})`;
    byId('voice-wave').style.transform = `scaleY(${practice && !complete && phase.key === 'sound' ? .4 + .6 * Math.abs(Math.sin(phase.progress * Math.PI * 4)) : .18})`;
    byId('practice-start').disabled = !!practice || !!pending || !!document.hidden;
    byId('practice-pause').disabled = !practice || complete;
    byId('practice-pause').textContent = practice?.status === 'paused' ? 'Resume' : 'Pause';
    byId('practice-save').disabled = !practice || seconds < 1 || busy || !!pending;
    byId('practice-spark').hidden = !!practice;
    byId('practice-discard').hidden = !practice;
    byId('practice-discard').disabled = !!pending;
  }

  function pausePractice() {
    if (practice?.status !== 'running') return;
    timer.pause();
    practice.status = 'paused';
    renderPractice();
  }

  function resetPractice() {
    practice = null;
    timer.cancel();
  }

  function confirmPractice(id) {
    if (practice?.entry?.id !== id) return;
    const elapsed = duration(practice.seconds);
    resetPractice();
    practiceSay(`Logged ${elapsed}.`);
  }

  function render() {
    const totals = state && musicianCareTotals(state, today());
    total.textContent = totals ? String(totals.water) : address ? '--' : '0';
    byId('water-fill').setAttribute('stroke-dashoffset', String(100 * (1 - Math.min((totals?.water || 0) / 8, 1))));
    for (const activity of ['breathwork', 'chanting', 'vocal']) {
      byId(`${activity}-total`).textContent = totals ? String(Math.round(totals[activity] / 60 * 10) / 10) : '--';
    }
    const disabled = busy || !available || !signer || !!pending;
    byId('water-add').disabled = disabled;
    byId('water-remove').disabled = disabled || !lastWater();
    byId('retry').hidden = !pending && (available || !address || busy);
    byId('retry').disabled = busy || (!!pending && !signer);
    byId('water-add').title = address ? 'Add one glass' : 'Connect your wallet using the header';
    renderPractice();
  }

  function select(kind) {
    pausePractice();
    let next = selected === kind ? '' : kind;
    if (next && practice && next !== PRACTICES[method].family) {
      next = PRACTICES[method].family;
      practiceSay('Finish or discard this session before changing practice.');
    }
    selected = next;
    if (selected && !practice && selected !== PRACTICES[method].family) {
      method = selected === 'heart' ? 'even' : 'hum';
      practiceSay('');
    }
    for (const name of ['heart', 'throat']) byId(`${name}-select`).setAttribute('aria-pressed', String(selected === name));
    byId('home').hidden = byId('project').hidden = !!selected;
    byId('practice-controls').hidden = !selected;
    byId('practice-controls').dataset.kind = selected;
    renderPractice();
    if (selected) byId('practice-back').focus();
  }

  function accept(profile) {
    if (profile?.address?.toLowerCase() !== address) throw new Error('The profile response belongs to a different wallet.');
    const next = normalizeMusicianCareState(profile.musicianCare);
    musicianCareTotals(next);
    state = next;
    available = true;
    document.dispatchEvent(new window.CustomEvent('musician-care-updated', { detail: { address, musicianCare: state } }));
  }

  async function refresh() {
    if (address !== wallet() || signer !== window._wallet?.signer) return walletChanged();
    render();
    if (busy || !address) return;
    const check = ++revision;
    busy = true;
    say('');
    render();
    try {
      const response = await fetchImpl(`${service}/api/creator/profile?${new URLSearchParams({ address })}`,
        { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!current(check)) return;
      if (!response.ok) throw new Error(`Profile service returned HTTP ${response.status}.`);
      const profile = await response.json();
      if (!current(check)) return;
      accept(profile);
      if (pending) {
        const entry = state.entries.find(item => item.id === pending.entry.id);
        if (entry && (pending.action === 'add-musician-care' || entry.removedAt)) {
          confirmPractice(entry.id);
          pending = null;
        }
      }
      say(pending ? 'Save not confirmed. Retry this entry.' : '');
    } catch (error) {
      if (!current(check)) return;
      available = false;
      say(`Activity unavailable: ${error.message}${state ? ' Showing saved totals.' : ''}`);
    } finally {
      if (current(check)) { busy = false; render(); }
    }
  }

  async function save(change) {
    if (address !== wallet() || signer !== window._wallet?.signer) { void walletChanged(); return; }
    if (busy) return;
    if (!address || !signer || (!available && !pending)) {
      say(address ? 'Profile tracking is unavailable. Retry loading it.' : 'Connect your wallet using the header.');
      return;
    }
    const check = ++revision;
    pending = pending || change;
    busy = true;
    let submitted = false;
    render();
    try {
      const body = { ...pending, address, origin: window.location.origin, visibility: 'public',
        nonce: window.crypto.randomUUID(), issuedAt: now().toISOString() };
      say('Confirm in your wallet...');
      const signature = await signer.signMessage(buildMusicianCareAuthorizationMessage(body));
      if (!current(check)) return;
      submitted = true;
      say('Saving...');
      const response = await fetchImpl(`${service}/api/creator/musician-care`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, signature }),
        signal: AbortSignal.timeout(30000) });
      if (!current(check)) return;
      if (!response.ok) throw new Error(`Profile save returned HTTP ${response.status}.`);
      const result = await response.json();
      if (!current(check)) return;
      if (result.ok !== true) throw new Error('Profile save did not confirm.');
      accept(result.profile);
      const recorded = state.entries.find(entry => entry.id === pending.entry.id);
      if (!recorded || (pending.action === 'remove-musician-care' && !recorded.removedAt)) throw new Error('Entry is not confirmed in the saved profile.');
      confirmPractice(recorded.id);
      pending = null;
      say('');
    } catch (error) {
      if (!current(check)) return;
      if (!submitted) pending = null;
      say(submitted ? `Save not confirmed: ${error.message} Retry this entry.`
        : `Not saved: ${error.shortMessage || error.message}`);
    } finally {
      if (current(check)) { busy = false; render(); }
    }
  }

  function add(activity, amount) {
    try {
      const entry = normalizeMusicianCareEntry({ id: window.crypto.randomUUID(), activity, amount,
        unit: activity === 'water' ? 'glasses' : 'seconds', timestamp: now().toISOString(), timeZone: timeZone() });
      return save({ action: 'add-musician-care', entry });
    } catch (error) { say(`Not saved: ${error.message}`); }
  }

  async function walletChanged() {
    const nextAddress = /^0x[0-9a-f]{40}$/.test(wallet()) ? wallet() : '';
    const nextSigner = window._wallet?.signer;
    const identityChanged = address !== nextAddress;
    if (!identityChanged && signer === nextSigner) return;
    revision++;
    address = nextAddress;
    signer = nextSigner;
    busy = false;
    if (identityChanged) {
      state = null; pending = null; available = false;
      if (practice) { resetPractice(); practiceSay('Wallet changed; unfinished practice cleared.'); }
      say('');
    }
    render();
    if (address && !available) await refresh();
  }

  for (const kind of ['heart', 'throat']) byId(`${kind}-select`).addEventListener('click', () => select(kind));
  byId('practice-back').addEventListener('click', () => {
    const kind = selected;
    select('');
    byId(`${kind}-select`).focus();
  });
  for (const id of Object.keys(PRACTICES)) byId(`method-${id}`).addEventListener('click', () => {
    if (practice) return;
    method = id;
    practiceSay('');
    renderPractice();
  });
  byId('practice-start').addEventListener('click', () => {
    if (practice || pending || !selected || document.hidden) return;
    if (address !== wallet() || signer !== window._wallet?.signer) { void walletChanged(); return; }
    practice = { status: 'running', seconds: 0, precise: 0, entry: null };
    practiceSay('');
    timer.start(60);
  });
  byId('practice-pause').addEventListener('click', () => {
    if (practice?.status === 'running') pausePractice();
    else if (practice?.status === 'paused' && selected && !document.hidden) {
      practice.status = 'running';
      timer.resume();
    }
  });
  byId('practice-discard').addEventListener('click', () => {
    if (pending) return;
    resetPractice();
    practiceSay('Discarded. Nothing logged.');
    byId('practice-start').focus();
  });
  byId('water-add').addEventListener('click', () => add('water', 1));
  byId('water-remove').addEventListener('click', () => {
    const entry = lastWater();
    if (!entry) { say('No water entries to undo today.'); render(); return; }
    return save({ action: 'remove-musician-care', entry });
  });
  byId('practice-save').addEventListener('click', () => {
    if (!practice || practice.seconds < 1 || busy || pending) return;
    if (address !== wallet() || signer !== window._wallet?.signer) { void walletChanged(); return; }
    practice.seconds = timer.end();
    practice.precise = practice.seconds;
    practice.status = 'complete';
    renderPractice();
    try {
      practice.entry ||= normalizeMusicianCareEntry({ id: window.crypto.randomUUID(), activity: PRACTICES[method].activity,
        amount: practice.seconds, unit: 'seconds', timestamp: now().toISOString(), timeZone: timeZone() });
      return save({ action: 'add-musician-care', entry: practice.entry });
    } catch (error) {
      say(`Not saved: ${error.message}`);
    }
  });
  byId('retry').addEventListener('click', () => pending ? save(pending) : refresh());
  document.addEventListener('wallet-connected', walletChanged);
  document.addEventListener('wallet-disconnected', walletChanged);
  window.addEventListener('focus', refresh);
  window.addEventListener('pagehide', pausePractice);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pausePractice(); else void refresh(); });
  select('');
  void walletChanged();
  return { refresh, pause: pausePractice };
}
