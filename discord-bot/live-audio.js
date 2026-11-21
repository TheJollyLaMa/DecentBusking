import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { verifyMessage } from 'ethers';
import { liveAudioPolicy, LIVE_AUDIO_GRACE_MS, LIVE_AUDIO_FRESH_MS } from '../js/live-audio.mjs';
import { LiveAudioError } from './live-audio-errors.js';
import { createLiveDirection, LiveDirectionError } from './live-direction.js';
import { liveBroadcastTiming, liveBroadcastEnd, validateLiveAllocation } from '../js/live-broadcast.mjs';
import { validateLiveAudioState } from './live-audio-store.js';
import { planBroadcastCommand } from './live-broadcast-control.js';
import { catalogRecordingAuthorizationMessage } from '../js/live-recording-edit.mjs';
import { createRepeatLog } from './repeat-log.js';
import { MAX_LIVE_AUDIO_GRACE_MS, MAX_LIVE_RECOVERY_HOLD_MS, liveRecoveryDeadline } from '../js/live-recovery.mjs';
import { planRecoveryCommand } from './live-recovery-control.js';

const clone = value => JSON.parse(JSON.stringify(value));
const address = value => /^0x[0-9a-f]{40}$/i.test(value || '') ? value.toLowerCase() : '';
const opaque = () => randomBytes(32).toString('hex');
const START_EARLY_MS = 70 * 60_000;
const RECOVERY_DELAY_MS = 60 * 60_000;
const BOOKING_UNAVAILABLE_REASON = 'Live performance cancelled: booking is no longer available.';
const INITIAL_ARM_ALLOWANCE_MS = 60_000;

export function createLiveAudioWatchdogTick({ liveAudio, liveFeedback, log = createRepeatLog() }) {
  let ticking = false;
  return async () => {
    if (ticking) return;
    ticking = true;
    try {
      await liveAudio.tick();
      log.recover('room:', '[live-audio] ROOM_STATE_RECOVERED');
    } catch {
      log.warn('room:unavailable', '[live-audio] ROOM_STATE_UNAVAILABLE; inspect hosting and durable storage.');
    } finally {
      ticking = false;
      liveFeedback.sync();
    }
  };
}

export function createLiveAudioFileStore(path) {
  if (!path) return null;
  return {
    async restore() {
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return { version: 1, rooms: [] }; throw error; }
    },
    async save(value) {
      await writeFile(`${path}.next`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${path}.next`, path);
    },
  };
}

export function createLiveAudioService({ getBookings, ownerWallet, transport, store, recorder, onPolicy = () => {},
  onCancel, now = () => Date.now(), verify = verifyMessage, checkpointTimeoutMs = 45_000, programs = {},
  withBroadcastHandoff, feedback, listenerTelemetry, resolveCatalogRecording, graceMs = LIVE_AUDIO_GRACE_MS,
  recoveryEnabled = false, onPublicFrame, publicBroadcastState = () => null } = {}) {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > MAX_LIVE_AUDIO_GRACE_MS) {
    throw new Error('LIVE_AUDIO_GRACE_MS must be an integer from 1 to 60000 (default 15000)');
  }
  const owner = address(ownerWallet);
  const challenges = new Map(), sessions = new Map(), frames = new Map(), reservations = new Map();
  const direction = createLiveDirection({ now });
  const monitoring = new Set(), closed = new Set(), restoredAt = new Map(), closing = new Set(), notifying = new Set();
  const publicSuspensions = new Set();
  let state = null, failed = false, tail = Promise.resolve(), bookings = [], checkedAt = -Infinity;
  let bookingRefresh, bookingsLoaded = false, bookingVerificationFailed = false, stopped = false;
  let checkpointWrite = null, failedBroadcast = null;
  const configured = !!owner && !!store && transport?.ready === true;
  async function getCatalogRecording(nftId) {
    if (typeof resolveCatalogRecording !== 'function') throw new LiveAudioError('Catalog recording lookup is unavailable');
    let source;
    try { source = await resolveCatalogRecording(nftId); }
    catch { throw new LiveAudioError('Verified NFT catalog source is unavailable; retry after catalog refresh'); }
    if (!source || source.nftId?.toLowerCase() !== String(nftId || '').toLowerCase() ||
        source.chainId !== 8453 || !/^8453:0x[0-9a-f]{40}:\d{1,20}$/i.test(source.nftId || '') ||
        !/^0x[0-9a-f]{40}$/i.test(source.contractAddress || '') ||
        !Number.isSafeInteger(source.tokenId) || source.tokenId < 0 ||
        source.nftId.toLowerCase() !== `8453:${source.contractAddress.toLowerCase()}:${source.tokenId}` ||
        !/^0x[0-9a-f]{40}$/i.test(source.artistWallet || '') ||
        !/^[a-zA-Z0-9]{20,120}$/.test(source.sourceCid || '') ||
        typeof source.title !== 'string' || !source.title.trim() ||
        typeof source.mediaType !== 'string' || !source.mediaType.startsWith('audio/')) {
      throw new LiveAudioError('Verified catalog item is not a supported DecentBusking audio source');
    }
    return { ...source, nftId: source.nftId.toLowerCase(), contractAddress: source.contractAddress.toLowerCase(),
      artistWallet: source.artistWallet.toLowerCase() };
  }
  const sameCatalogSource = (first, second) => first?.nftId === second?.nftId &&
    first?.sourceCid === second?.sourceCid && first?.artistWallet === second?.artistWallet &&
    first?.chainId === second?.chainId && first?.contractAddress === second?.contractAddress &&
    first?.tokenId === second?.tokenId && first?.title === second?.title &&
    first?.artistName === second?.artistName && first?.mediaType === second?.mediaType &&
    first?.artworkCid === second?.artworkCid;
  const outroSeconds = b => programs[b.id]?.outroSeconds ?? 300;
  const policyFor = (record, b) => {
    const p = liveAudioPolicy(record, b, now(), Object.hasOwn(programs, b.id) ? programs[b.id] : null);
    if (p && record?.allocation) {
      p.controlled = true;
      p.controlledEventIds = [b.id, record.allocation.previousBookingId, record.allocation.nextBookingId]
        .filter(Boolean).map(id => bookings.find(item => item.id === id)?.eventId).filter(Boolean);
    }
    return p;
  };
  const canonicalPolicy = () => {
    const policies = bookings.map(b => policyFor(recordFor(b.id), b)).filter(Boolean);
    return policies.findLast(p => p.mode === 'live' && recordFor(p.bookingId)?.allocation) ||
      policies.findLast(p => p.mode === 'live') ||
      policies.findLast(p => p.mode === 'fault') ||
      policies.findLast(p => p.mode === 'adverts' && p.breakKind !== 'waiting') ||
      policies.findLast(p => p.mode === 'adverts') || policies[0] || null;
  };
  const mediaBooking = b => {
    const broadcast = liveBroadcastTiming(b, recordFor(b.id));
    return broadcast ? { ...b, broadcast: { ...broadcast,
      outroEndsAt: (broadcast.actualEndedAt ?? broadcast.authorizedEndAt) + (broadcast.actualStartedAt ? outroSeconds(b) * 1000 : 0) } } : b;
  };
  const run = fn => {
    const task = tail.then(fn);
    tail = task.catch(() => {});
    return task;
  };
  async function initialize() {
    if (!configured || failed) throw new LiveAudioError('Live audio unavailable: hosting and durable room state must be configured');
    if (state) return;
    const restored = validateLiveAudioState(await store.restore());
    if (restored.rooms.some(r => r.recovery && r.lossSince > now())) {
      throw new LiveAudioError('Recovery journal is ahead of authoritative server time; controls stay closed');
    }
    for (const record of restored.rooms.filter(r => r.recovery?.filler && !r.cancelledAt && !r.allocation?.endedAt)) {
      const b = (await readBookings()).find(item => item.id === record.bookingId);
      if (!b || typeof transport.suspendListeners !== 'function') throw new LiveAudioError('Recovering public listeners cannot be safely suspended');
      await transport.suspendListeners(b);
    }
    state = restored;
    for (const record of state.rooms) restoredAt.set(record.bookingId, now());
  }
  async function save(next) {
    let timer;
    try {
      const write = Promise.resolve().then(() => store.save(next));
      checkpointWrite = write;
      const settled = () => { if (checkpointWrite === write) checkpointWrite = null; };
      write.then(settled, settled);
      await Promise.race([
        write,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Live audio checkpoint deadline exceeded')), checkpointTimeoutMs);
        }),
      ]);
      state = next;
    }
    catch {
      const policy = canonicalPolicy();
      const liveBooking = policy?.mode === 'live' && bookings.find(b => b.id === policy.bookingId);
      if (liveBooking) failedBroadcast = { booking: liveBooking, cancelledAt: now() };
      failed = true; sessions.clear(); frames.clear(); direction.clear();
      for (const b of bookings.filter(item => recordFor(item.id))) void cleanup(b);
      if (failedBroadcast) onPolicy(liveAudioPolicy({ armed: false, checks: {},
        cancelledAt: failedBroadcast.cancelledAt, reason: 'Live audio unavailable: durable checkpoint could not be verified. Performer fee is unchanged.' },
      failedBroadcast.booking, now()));
      throw new LiveAudioError('Live audio checkpoint failed; room controls are closed');
    }
    finally { clearTimeout(timer); }
  }
  async function readBookings(force = false) {
    if (!bookingRefresh && (force || now() - checkedAt > 10_000)) {
      try {
        bookingRefresh = Promise.resolve(getBookings()).then(result => {
          const verified = Array.isArray(result) ? result : result?.bookings;
          if (!Array.isArray(verified) || result.ready === false || result.unavailable === true ||
              verified.some(b => !b || typeof b !== 'object' || typeof b.id !== 'string')) {
            bookingVerificationFailed = true; return;
          }
          bookings = verified;
          checkedAt = now(); bookingsLoaded = true;
          bookingVerificationFailed = false;
          direction.prune(bookings.map(mediaBooking));
        }, () => { bookingVerificationFailed = true; }).finally(() => { bookingRefresh = null; });
      } catch { bookingVerificationFailed = true; }
    }
    // RPC/indexing must never hold the serialized media watchdog behind an external request.
    await Promise.resolve();
    if (!bookingsLoaded || (force && now() - checkedAt > 30_000)) {
      throw new LiveAudioError('Live booking verification unavailable; retry when the booking service has refreshed');
    }
    return bookings;
  }
  async function findBooking(id, force = false) {
    const b = (await readBookings(force)).find(item => item.id === id);
    if (!b || !address(b.wallet) || !Number.isFinite(Date.parse(b.startUtc)) ||
        !Number.isFinite(Date.parse(b.endUtc))) throw new LiveAudioError('Live booking unavailable');
    return b;
  }
  function funded(b) {
    const validStatus = recordFor(b.id)?.allocation ? ['funded', 'approved', 'paid'].includes(b.status) : b.status === 'funded';
    if (!validStatus || b.cancelled || b.acknowledged !== true || !['pilot-guaranteed-v1', 'asset-guaranteed-v1'].includes(b.payoutPolicy)) {
      throw new LiveAudioError('Live audio requires this acknowledged, funded, uncancelled guaranteed-pilot booking');
    }
  }
  function recordingReleaseEligible(b) {
    return !!(b && !b.cancelled && b.acknowledged === true && ['pilot-guaranteed-v1', 'asset-guaranteed-v1'].includes(b.payoutPolicy) &&
      ['funded', 'approved', 'paid'].includes(b.status) && now() >= liveBroadcastEnd(mediaBooking(b)));
  }
  function windowOpen(b) {
    funded(b);
    const broadcast = liveBroadcastTiming(b, recordFor(b.id));
    if (now() < Date.parse(b.startUtc) - START_EARLY_MS || now() >= (broadcast?.actualEndedAt ?? broadcast?.accessUntil ?? Date.parse(b.endUtc))) {
      throw new LiveAudioError('Room opens at T−70 minutes and closes at its authorized live-session end');
    }
  }
  function recordFor(id) { return state?.rooms.find(r => r.bookingId === id); }
  function preShowAvailabilityClosure(b, record) {
    return b.payoutPolicy === 'asset-guaranteed-v1' && !record?.allocation && record?.cancelledAt > 0 &&
      record.cancelledAt < Date.parse(b.startUtc) && record.reason === BOOKING_UNAVAILABLE_REASON;
  }
  function recoverablePreShowClosure(b, record) {
    return preShowAvailabilityClosure(b, record) && b.status === 'funded' && bookingVerification(b).fresh &&
      now() < Date.parse(b.endUtc);
  }
  function recoverableDeclinedPreflight(b, record) {
    const a = record?.allocation;
    return b.status === 'funded' && bookingVerification(b).fresh && !record?.cancelledAt &&
      !!a?.endedAt && a.endReason === 'declined' && !a.startedAt && !a.previousBookingId && !a.nextBookingId &&
      now() < liveBroadcastTiming(b, record).accessUntil && (record.broadcastCommands?.length || 0) < 128;
  }
  function checkPreflightConflict(b, plannedStartAt) {
    const end = plannedStartAt + Date.parse(b.endUtc) - Date.parse(b.startUtc);
    if (bookings.some(other => {
      if (other.id === b.id || other.cancelled || !['funded', 'approved', 'paid'].includes(other.status)) return false;
      const timing = liveBroadcastTiming(other, recordFor(other.id));
      const start = timing?.actualStartedAt ?? timing?.plannedStartAt ?? Date.parse(other.startUtc);
      return start < end && liveBroadcastEnd(mediaBooking(other)) > plannedStartAt;
    })) throw new LiveAudioError('The replacement preflight conflicts with another funded performance');
  }
  // After the original T−60 window has passed, recovery holds the full contracted length at a later
  // effective start so both soundchecks can happen again. Contract times, fee and escrow are unchanged.
  function recoveryDelayedStart(b) {
    if (now() <= Date.parse(b.startUtc) - 40 * 60_000) return null;
    return Math.ceil((now() + RECOVERY_DELAY_MS) / 300_000) * 300_000;
  }
  function bookingVerification(b) {
    const eligible = !b || !!address(b.wallet) && (recordFor(b.id)?.allocation ? ['funded', 'approved', 'paid'].includes(b.status) : b.status === 'funded') && !b.cancelled &&
      b.acknowledged === true && ['pilot-guaranteed-v1', 'asset-guaranteed-v1'].includes(b.payoutPolicy) &&
      Number.isFinite(Date.parse(b.startUtc)) && Date.parse(b.endUtc) > Date.parse(b.startUtc);
    return { fresh: !!eligible && bookingsLoaded && !bookingVerificationFailed && now() >= checkedAt && now() - checkedAt <= 30_000,
      verifiedAt: bookingsLoaded ? checkedAt : null };
  }
  function publicState(b, record, privateView = false) {
    const policy = policyFor(record, b);
    const broadcast = liveBroadcastTiming(b, record);
    const currentFrame = frames.get(b.id) || 0;
    const phase = record?.cancelledAt ? 'cancelled'
      : record?.recovery?.filler && !record.allocation?.endedAt && now() < liveBroadcastEnd(mediaBooking(b)) ? 'recovering'
      : broadcast ? broadcast.actualEndedAt || now() >= liveBroadcastEnd(mediaBooking(b)) ? 'ended'
        : broadcast.actualStartedAt && record?.armed ? 'live' : 'preflight'
        : now() >= Date.parse(b.endUtc) ? 'ended'
          : now() >= Date.parse(b.startUtc) && record?.armed ? 'live' : 'preflight';
    const fresh = currentFrame > 0 && now() - currentFrame <= LIVE_AUDIO_FRESH_MS;
    return { configured: configured && !failed, serverTime: now(), bookingId: b.id, title: b.title,
      performer: { wallet: address(b.wallet), artist: b.displayName || b.title || 'Live performer', title: b.title || 'Live performance' },
      bookingVerification: bookingVerification(b),
      preflightRecoveryAvailable: recoverableDeclinedPreflight(b, record),
      broadcast,
      startUtc: b.startUtc, endUtc: b.endUtc, phase, armed: !!record?.armed,
      status: phase === 'live' ? fresh ? 'ON-AIR' : 'RECONNECTING' : 'OFF-AIR',
      verifiedAudioAt: phase === 'live' && currentFrame ? new Date(currentFrame).toISOString() : null,
      reason: record?.reason || '', policy, ingressEnabled: transport.ingressEnabled,
      listenerLimit: transport.listenerLimit || 10, recordingAvailable: recorder?.available === true,
      discordParity: 'Website audio only; Discord live relay is not enabled',
      ...(privateView && recorder ? { recording: recorder.status(mediaBooking(b)), recordingRelease: b.recordingRelease } : {}),
      ...(privateView ? { broadcastControl: record?.allocation ? {
        choice: record.allocation.choice, previousBookingId: record.allocation.previousBookingId,
        nextBookingId: record.allocation.nextBookingId, delayNotifiedAt: record.allocation.delayNotifiedAt,
        finishedId: record.allocation.finishedId, finishedAt: record.allocation.finishedAt,
        priorityFollowup: record.allocation.priorityFollowup,
      } : null } : {}),
      ...(privateView ? { lateFirstCheckAllowed: !!broadcast && !broadcast.actualStartedAt && !broadcast.actualEndedAt &&
        !record?.cancelledAt && !record?.armed && broadcast.plannedStartAt > now() &&
        broadcast.plannedStartAt - now() <= 25 * 60_000, recovery: {
        enabled: recoveryEnabled, revision: record?.recovery?.revision || 0,
        usedMs: record?.recovery?.usedMs || 0, remainingMs: MAX_LIVE_RECOVERY_HOLD_MS - (record?.recovery?.usedMs || 0),
        deadline: record?.lossSince ? Math.min(liveRecoveryDeadline(record, graceMs), liveBroadcastEnd(mediaBooking(b))) : null,
        filler: record?.recovery?.filler || null,
        graceMs: record?.recovery?.deadline ? record.recovery.graceMs : graceMs,
      }, checks: record?.checks || {}, privateAudioFresh: fresh,
        targets: { t60: new Date((broadcast?.plannedStartAt ?? Date.parse(b.startUtc)) - 60 * 60_000).toISOString(),
          t15: new Date((broadcast?.plannedStartAt ?? Date.parse(b.startUtc)) - 15 * 60_000).toISOString() } } : {}) };
  }
  function auth(token, origin) {
    const session = sessions.get(token);
    if (!session || session.origin !== origin || session.expiresAt <= now()) throw new LiveAudioError('Room authorization expired; reconnect your wallet');
    return session;
  }
  function feedbackCommand(token, input, origin) {
    if (!configured || failed || stopped || !feedback) {
      throw new LiveDirectionError('FEEDBACK_UNAVAILABLE', 'Listener feedback is unavailable', 503);
    }
    let session;
    try { session = auth(token, origin); }
    catch { throw new LiveDirectionError('FEEDBACK_AUTH_EXPIRED', 'Room authorization expired; reconnect your wallet', 401); }
    if (input.action !== 'feedback-snapshot' || Object.keys(input).some(key => key !== 'action')) {
      throw new LiveDirectionError('FEEDBACK_INVALID', 'Invalid listener feedback request', 400);
    }
    try { return feedback.snapshot(session.bookingId); }
    catch (error) {
      console.warn('[live-feedback] Private feedback snapshot unavailable:', error?.name || 'Error');
      throw new LiveDirectionError('FEEDBACK_UNAVAILABLE', 'Listener feedback is unavailable; retry shortly', 503);
    }
  }
  function telemetryCommand(token, input, origin) {
    if (!configured || failed || stopped || !listenerTelemetry) {
      throw new LiveDirectionError('TELEMETRY_UNAVAILABLE', 'Listener telemetry is unavailable', 503);
    }
    let session;
    try { session = auth(token, origin); }
    catch { throw new LiveDirectionError('TELEMETRY_AUTH_EXPIRED', 'Room authorization expired; reconnect your wallet', 401); }
    if (session.role !== 'owner' || session.wallet !== owner) {
      throw new LiveDirectionError('TELEMETRY_DENIED', 'Owner authorization required', 403);
    }
    if (input.action !== 'telemetry-snapshot' || Object.keys(input).some(key => key !== 'action')) {
      throw new LiveDirectionError('TELEMETRY_INVALID', 'Invalid listener telemetry request', 400);
    }
    try { return listenerTelemetry.snapshot(session.bookingId); }
    catch (error) {
      if (!error?.status) listenerTelemetry.reportFailure?.();
      throw new LiveDirectionError('TELEMETRY_UNAVAILABLE', 'Listener telemetry is unavailable for this public show', 503);
    }
  }
  async function directionCommand(token, input, origin) {
    if (!configured || failed || stopped) throw new LiveDirectionError('DIRECTION_UNAVAILABLE', 'Private direction is unavailable', 503);
    let session;
    try { session = auth(token, origin); }
    catch { throw new LiveDirectionError('DIRECTION_AUTH_EXPIRED', 'Room authorization expired; reconnect your wallet', 401); }
    let b;
    try { b = await findBooking(session.bookingId); }
    catch { throw new LiveDirectionError('DIRECTION_UNAVAILABLE', 'Booking verification is unavailable; retry shortly', 503); }
    if (!bookingVerification().fresh) throw new LiveDirectionError('DIRECTION_UNAVAILABLE', 'Booking verification is unavailable; retry shortly', 503);
    try {
      auth(token, origin);
      windowOpen(b);
      if (!recordFor(b.id) || recordFor(b.id).cancelledAt) throw new Error('closed');
    } catch {
      direction.forget(b.id);
      throw new LiveDirectionError('DIRECTION_CLOSED', 'This private room is closed or authorization expired', 403);
    }
    const result = direction.command({ booking: mediaBooking(b), session, input });
    const attach = target => {
      target.broadcast = liveBroadcastTiming(b, recordFor(b.id));
      target.broadcastCapabilities = broadcastCapabilities(b, session);
    };
    attach(result.state || result);
    return result;
  }
  function broadcastCapabilities(b, session) {
    const a = recordFor(b.id)?.allocation, t = liveBroadcastTiming(b, recordFor(b.id));
    const ownerRole = session.wallet === owner, performer = session.wallet === address(b.wallet);
    const open = !a?.endedAt && !recordFor(b.id)?.cancelledAt && bookingVerification(b).fresh;
    const record = recordFor(b.id), deadline = liveRecoveryDeadline(record, graceMs);
    const recovering = recoveryEnabled && open && !!record?.armed && !!record.lossSince &&
      now() < deadline && now() < liveBroadcastEnd(mediaBooking(b)) && (!a || !!a.startedAt && !a.finishedAt);
    return {
      enable: ownerRole && open && !a, reserveNext: ownerRole && open && !a?.previousBookingId,
      grantEncore: ownerRole && open && !!a?.startedAt && t.remainingEncoreMs > 0 && now() < t.authorizedEndAt,
      chooseSet: performer && open && !!a && !a.startedAt,
      declareFinished: performer && open && !!a?.startedAt,
      endBroadcast: ownerRole && open && !!a?.startedAt,
      takeLive: ownerRole && open && !!a && !a.startedAt && ['contracted', 'full', 'short'].includes(a.choice),
      recoveryHold: ownerRole && recovering && deadline < liveBroadcastEnd(mediaBooking(b)) &&
        (record.recovery?.usedMs || 0) < MAX_LIVE_RECOVERY_HOLD_MS,
      recoveryFiller: ownerRole && recovering,
      recoveryReturn: ownerRole && recovering,
      advanceNext: ownerRole && recovering && !!a?.nextBookingId,
    };
  }
  function performerReady(b, session) {
    const view = direction.command({ booking: mediaBooking(b),
      session: { ...session, bookingId: b.id, wallet: address(b.wallet), role: 'publisher' },
      input: { action: 'direction-state' } });
    return view.readiness.ready === true && view.performerPresence.expiresAt > now();
  }
  async function recoveryCommand(session, b, input) {
    if (!recoveryEnabled) throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'Recovery controls are not enabled; reader-first deployment is required', 503);
    // Observe the outage on the same serialized watchdog as normal cancellation. Late commands cannot revive a set.
    await tickInternal();
    const plan = () => {
      auth([...sessions].find(([, s]) => s === session)?.[0], session.origin);
      funded(b);
      if (!bookingVerification(b).fresh) throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'Current booking verification is required', 503);
      return planRecoveryCommand({ state, booking: b, command: input, wallet: session.wallet, owner,
        now: now(), graceMs, endAt: liveBroadcastEnd(mediaBooking(b)),
        audioFresh: !!frames.get(b.id) && now() - frames.get(b.id) <= LIVE_AUDIO_FRESH_MS,
        ready: performerReady(b, session) });
    };
    const response = applied => ({ commandId: input.commandId, applied,
      state: { ...publicState(b, recordFor(b.id), true), broadcastCapabilities: broadcastCapabilities(b, session) } });
    if (plan().duplicate) return response(false);
    const apply = async () => {
      const planned = plan();
      if (planned.duplicate) return response(false);
      if (input.action === 'broadcast-recovery-filler') {
        if (typeof transport.suspendListeners !== 'function') throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'Verified public-listener suspension is unavailable', 503);
        publicSuspensions.add(b.id);
        try {
          await transport.suspendListeners(mediaBooking(b));
          // Suspension is external I/O: recheck expiry, authorization and readiness before committing.
          const checked = plan();
          await save(checked.next);
        } catch (error) {
          if (!failed && !recordFor(b.id)?.recovery?.filler) transport.resumeListeners?.(mediaBooking(b));
          throw error;
        } finally { publicSuspensions.delete(b.id); }
        recorder?.stopCapture?.(mediaBooking(b), { interrupted: true });
      } else {
        await save(planned.next);
      }
      onPolicy(canonicalPolicy());
      if (input.action === 'broadcast-recovery-return') transport.resumeListeners?.(mediaBooking(b));
      return response(true);
    };
    if (input.action !== 'broadcast-recovery-hold') {
      if (!withBroadcastHandoff) throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'A verified radio handoff is required', 503);
      try { return await withBroadcastHandoff(apply, { protectAd: true }); }
      catch (error) {
        if (error instanceof LiveAudioError) throw error;
        throw new LiveDirectionError('BROADCAST_BUSY', 'Recovery handoff waits for the active paid item or pending selection', 409);
      }
    }
    return apply();
  }
  async function advanceNextCommand(session, b, input) {
    if (!recoveryEnabled) throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'Recovery controls are not enabled', 503);
    if (session.wallet !== owner) throw new LiveDirectionError('BROADCAST_FORBIDDEN', 'Only the configured producer may advance the next act', 403);
    if (Object.keys(input).some(k => !['action', 'commandId', 'expectedRevision', 'expectedNextRevision', 'nextToken', 'confirmed'].includes(k)) ||
        input.confirmed !== true || !/^[a-zA-Z0-9:_-]{8,90}$/.test(input.commandId || '') ||
        !Number.isSafeInteger(input.expectedNextRevision)) {
      throw new LiveDirectionError('BROADCAST_CONFLICT', 'Confirm advancing the exact paired next act', 409);
    }
    await tickInternal();
    const nextId = recordFor(b.id)?.allocation?.nextBookingId;
    if (!nextId) throw new LiveDirectionError('BROADCAST_CONFLICT', 'No paired next act is available', 409);
    const partner = await findBooking(nextId, true);
    const plan = () => {
      auth([...sessions].find(([, s]) => s === session)?.[0], session.origin);
      const nextSession = auth(input.nextToken, session.origin);
      if (nextSession.wallet !== owner || nextSession.bookingId !== nextId) throw new LiveDirectionError('BROADCAST_FORBIDDEN', 'Authorize the exact paired next booking with its own owner pass', 403);
      funded(b); funded(partner);
      if (!bookingVerification(b).fresh || !bookingVerification(partner).fresh) throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'Both bookings require fresh verification', 503);
      const endCommand = { action: 'broadcast-end', commandId: `${input.commandId}:end`,
        expectedRevision: input.expectedRevision, mode: 'operator-cut', confirmed: true };
      const ended = planBroadcastCommand({ state, booking: b, bookings, command: endCommand,
        wallet: owner, owner, now: now(), outroSeconds });
      if (ended.duplicate) {
        const taken = planBroadcastCommand({ state, booking: partner, bookings,
          command: { action: 'broadcast-take', commandId: `${input.commandId}:take`, expectedRevision: input.expectedNextRevision + 1, confirmed: true },
          wallet: owner, owner, now: now(), audioFresh: true, ready: true, earlyTake: true, outroSeconds });
        if (!taken.duplicate) throw new LiveDirectionError('BROADCAST_CONFLICT', 'Advance receipt is incomplete', 409);
        return { duplicate: true, next: state };
      }
      const record = recordFor(b.id), deadline = liveRecoveryDeadline(record, graceMs);
      if (!record.armed || !record.lossSince || record.allocation?.finishedAt || !deadline || now() >= deadline) {
        throw new LiveDirectionError('BROADCAST_CONFLICT', 'Only an explicitly interrupted, still-recoverable set may be advanced', 409);
      }
      const actualNextRevision = recordFor(nextId)?.allocation?.revision;
      if (input.expectedNextRevision !== actualNextRevision) throw new LiveDirectionError('BROADCAST_CONFLICT', 'Next act changed; refresh its owner pass', 409);
      // The end command updates its paired timing revision; only this atomic producer advance may start early.
      const nextRoom = ended.next.rooms.find(r => r.bookingId === nextId);
      const taken = planBroadcastCommand({ state: ended.next, booking: partner, bookings,
        command: { action: 'broadcast-take', commandId: `${input.commandId}:take`,
          expectedRevision: nextRoom.allocation.revision, confirmed: true },
        wallet: owner, owner, now: now(), outroSeconds, earlyTake: true,
        audioFresh: !!frames.get(nextId) && now() - frames.get(nextId) <= LIVE_AUDIO_FRESH_MS,
        ready: performerReady(partner, nextSession) });
      return taken;
    };
    const response = applied => ({ commandId: input.commandId, applied,
      state: { ...publicState(b, recordFor(b.id), true), broadcastCapabilities: broadcastCapabilities(b, session) } });
    if (plan().duplicate) return response(false);
    if (!withBroadcastHandoff || typeof transport.suspendListeners !== 'function') throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'A verified listener and radio handoff is required', 503);
    try {
      return await withBroadcastHandoff(async () => {
        plan();
        publicSuspensions.add(b.id);
        try {
          await transport.suspendListeners(mediaBooking(b));
          const planned = plan();
          await save(planned.next);
        } catch (error) {
          if (!failed && !recordFor(b.id)?.recovery?.filler) transport.resumeListeners?.(mediaBooking(b));
          throw error;
        } finally { publicSuspensions.delete(b.id); }
        direction.forget(b.id); recorder?.stopCapture?.(mediaBooking(b)); void cleanup(mediaBooking(b));
        direction.prune(bookings.map(mediaBooking));
        onPolicy(canonicalPolicy());
        return response(true);
      }, { protectAd: true });
    } catch (error) {
      if (error instanceof LiveAudioError) throw error;
      throw new LiveDirectionError('BROADCAST_BUSY', 'Advance waits for a verified safe paid-program boundary', 409);
    }
  }
  async function broadcastCommand(session, b, input) {
    if (input.action.startsWith('broadcast-recovery-')) return recoveryCommand(session, b, input);
    if (input.action === 'broadcast-advance-next') return advanceNextCommand(session, b, input);
    if (!bookingVerification(b).fresh) throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'Current booking verification is required', 503);
    let partner;
    const partnerId = input.action === 'broadcast-reserve-next' ? input.nextBookingId
      : input.action === 'broadcast-encore' ? recordFor(b.id)?.allocation?.nextBookingId : null;
    if (partnerId) {
      const nextSession = auth(input.nextToken, session.origin);
      if (nextSession.wallet !== owner || nextSession.bookingId !== partnerId) throw new LiveDirectionError('BROADCAST_FORBIDDEN', 'Authorize the exact next booking with its own owner pass', 403);
      partner = await findBooking(partnerId, true);
      funded(partner);
    }
    const plan = () => {
      auth([...sessions].find(([, s]) => s === session)?.[0], session.origin);
      funded(b);
      if (!bookingVerification(b).fresh) throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'Current booking verification is required', 503);
      if (partnerId) {
        const nextSession = auth(input.nextToken, session.origin);
        if (nextSession.wallet !== owner || nextSession.bookingId !== partnerId) {
          throw new LiveDirectionError('BROADCAST_FORBIDDEN', 'Authorize the exact next booking with its own owner pass', 403);
        }
        funded(partner);
        if (!bookingVerification(partner).fresh) throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'Next booking verification is required', 503);
      }
      let ready = false;
      if (input.action === 'broadcast-take') {
        const performerSession = { ...session, wallet: address(b.wallet), role: 'publisher' };
        ready = direction.command({ booking: mediaBooking(b), session: performerSession, input: { action: 'direction-state' } }).readiness.ready === true;
      }
      return planBroadcastCommand({ state, booking: b, partner, bookings, command: input,
        wallet: session.wallet, owner, now: now(),
        audioFresh: !!frames.get(b.id) && now() - frames.get(b.id) <= LIVE_AUDIO_FRESH_MS,
        ready, outroSeconds });
    };
    const response = applied => {
      const result = publicState(b, recordFor(b.id), true);
      result.broadcastCapabilities = broadcastCapabilities(b, session);
      return { commandId: input.commandId, applied, state: result };
    };
    // Reject invalid decisions and return durable retries before holding any paid admission.
    if (plan().duplicate) return response(false);
    const apply = async () => {
      const planned = plan();
      if (!planned.duplicate) {
        await save(planned.next);
        direction.prune(bookings.map(mediaBooking));
        if (recordFor(b.id).allocation?.endedAt) {
          direction.forget(b.id);
          recorder?.stopCapture?.(mediaBooking(b));
          void cleanup(mediaBooking(b));
        }
        onPolicy(canonicalPolicy());
      }
      return response(!planned.duplicate);
    };
    if (['broadcast-take', 'broadcast-end'].includes(input.action)) {
      if (session.wallet !== owner) throw new LiveDirectionError('BROADCAST_FORBIDDEN', 'Only the configured owner may request a radio handoff', 403);
      if (!withBroadcastHandoff) throw new LiveDirectionError('BROADCAST_UNAVAILABLE', 'A verified radio handoff is required', 503);
      try { return await withBroadcastHandoff(apply); }
      catch (error) {
        if (error instanceof LiveAudioError) throw error;
        throw new LiveDirectionError('BROADCAST_BUSY', 'Radio handoff unavailable; retry after the active paid item or pending selection finishes', 409);
      }
    }
    return apply();
  }
  function startMonitor(b) {
    if (stopped || monitoring.has(b.id) || closed.has(b.id)) return;
    monitoring.add(b.id);
    void transport.monitor(mediaBooking(b), frame => {
      if (!closed.has(b.id) && !recordFor(b.id)?.cancelledAt && frame.samples > 0) frames.set(b.id, now());
    }, frame => {
      if (recordFor(b.id)?.armed && !recordFor(b.id)?.cancelledAt && !recordFor(b.id)?.allocation?.endedAt &&
          !recordFor(b.id)?.recovery?.filler && !publicSuspensions.has(b.id) &&
          frames.get(b.id) && now() - frames.get(b.id) <= LIVE_AUDIO_FRESH_MS) {
        recorder?.capture(mediaBooking(b), frame);
        if (policyFor(recordFor(b.id), b)?.mode === 'live') onPublicFrame?.(mediaBooking(b), frame);
      }
    }).catch(() => {}).finally(() => monitoring.delete(b.id));
  }
  function endAllocation(next, b, endedAt, endReason) {
    const a = next.rooms.find(r => r.bookingId === b.id)?.allocation;
    if (!a || a.endedAt) return;
    a.endedAt = endedAt; a.endReason = endReason; a.revision++;
    a.priorityFollowup = !!a.previousBookingId && a.startedAt > Date.parse(b.startUtc) && a.choice === 'short' &&
      a.endedAt - a.startedAt < Date.parse(b.endUtc) - Date.parse(b.startUtc);
    const partner = bookings.find(item => item.id === a.nextBookingId);
    const n = next.rooms.find(r => r.bookingId === a.nextBookingId)?.allocation;
    if (partner && n && !n.startedAt && !n.endedAt) {
      n.plannedStartAt = Math.max(Date.parse(partner.startUtc), endedAt + outroSeconds(b) * 1000);
      n.delayNotifiedAt = now(); n.revision++;
    }
  }
  async function cancel(b, reason, endReason = 'audio-loss') {
    const record = recordFor(b.id);
    if (record.cancelledAt) return;
    const next = clone(state), r = next.rooms.find(item => item.bookingId === b.id);
    r.cancelledAt = now(); r.reason = reason; r.armed = false; r.cancelNoticePending = true;
    endAllocation(next, b, now(), endReason);
    await save(next);
    recorder?.stopCapture?.(mediaBooking(b));
    frames.delete(b.id);
    direction.forget(b.id);
    for (const [token, session] of sessions) if (session.bookingId === b.id) sessions.delete(token);
    onPolicy(policyFor(r, b));
  }
  async function cleanup(b) {
    if (closed.has(b.id) || closing.has(b.id)) return;
    closing.add(b.id);
    try { await transport.close(b); closed.add(b.id); }
    catch { /* Retry cleanup; listener grants are already closed and the public player is off-air. */ }
    finally { closing.delete(b.id); }
  }
  function notifyCancellation(b, reason) {
    if (!onCancel || notifying.has(b.id)) return;
    notifying.add(b.id);
    void Promise.resolve().then(() => onCancel(mediaBooking(b), reason)).then(() => run(async () => {
      const next = clone(state);
      next.rooms.find(r => r.bookingId === b.id).cancelNoticePending = false;
      await save(next);
    })).catch(() => {}).finally(() => notifying.delete(b.id));
  }
  async function tickInternal() {
    if (failed) {
      const fallback = failedBroadcast && liveAudioPolicy({ armed: false, checks: {},
        cancelledAt: failedBroadcast.cancelledAt, reason: 'Live audio unavailable: durable checkpoint could not be verified. Performer fee is unchanged.' },
      failedBroadcast.booking, now());
      if (failedBroadcast) onPolicy(fallback);
      // Never race a late checkpoint write or reconnect while its old receiver is closing.
      if (checkpointWrite || closing.size) return fallback || null;
      try {
        const restored = validateLiveAudioState(await store.restore());
        state = restored;
        for (const r of state.rooms) {
          restoredAt.set(r.bookingId, now());
          if (!r.cancelledAt && !r.allocation?.endedAt) closed.delete(r.bookingId);
        }
        failed = false; failedBroadcast = null;
      } catch { return fallback || null; }
    }
    await initialize();
    await readBookings();
    direction.prune(bookings.map(mediaBooking));
    const newRooms = bookings.filter(b => ['pilot-guaranteed-v1', 'asset-guaranteed-v1'].includes(b.payoutPolicy) && b.status === 'funded' &&
      b.acknowledged === true && !b.cancelled && !recordFor(b.id) &&
      now() >= Date.parse(b.startUtc) - START_EARLY_MS && now() < Date.parse(b.endUtc));
    if (newRooms.length) {
      const next = clone(state);
      next.rooms.push(...newRooms.map(b => ({ bookingId: b.id, armed: false, checks: {}, lastVerifiedAt: 0 })));
      await save(next);
    }
    for (const record of [...state.rooms]) {
      const b = bookings.find(item => item.id === record.bookingId);
      if (!b) continue;
      let allocation = record.allocation;
      const timing = liveBroadcastTiming(b, record);
      const start = timing?.actualStartedAt ?? timing?.plannedStartAt ?? Date.parse(b.startUtc);
      const end = liveBroadcastEnd(mediaBooking(b));
      if (allocation && !allocation.endedAt && !record.cancelledAt && now() >= end) {
        const next = clone(state);
        endAllocation(next, b, end, allocation.startedAt ? 'authorization-expired' : 'not-ready');
        await save(next);
        allocation = recordFor(b.id).allocation;
        direction.forget(b.id); recorder?.stopCapture?.(mediaBooking(b));
      }
      if (!record.cancelledAt && now() < end && now() >= start - START_EARLY_MS) {
        // The asset index can temporarily mask a funded booking. Keep pre-show audio private
        // and require fresh verification for grants rather than permanently closing the room.
        if (!b.cancelled && b.payoutPolicy === 'asset-guaranteed-v1' && b.status === 'unavailable' &&
            !allocation?.startedAt && now() < start) continue;
        if (b.cancelled || !(allocation ? ['funded', 'approved', 'paid'].includes(b.status) : b.status === 'funded')) {
          await cancel(b, BOOKING_UNAVAILABLE_REASON, 'operator-cut');
        }
        else {
          const last = frames.get(b.id) || 0;
          const fresh = last > 0 && now() - last <= LIVE_AUDIO_FRESH_MS;
          let lossSince = record.lossSince || 0;
          const deadline = liveRecoveryDeadline(record, graceMs);
          const expired = deadline !== null && now() >= deadline &&
            (record.recovery?.filler || !fresh || last >= deadline);
          if (record.armed && fresh && !record.recovery?.filler && !expired) {
            if (lossSince) {
              const next = clone(state);
              const recovered = next.rooms.find(r => r.bookingId === b.id);
              Object.assign(recovered, { lastVerifiedAt: last, lossSince: 0 });
              if (recovered.recovery) {
                recovered.recovery.deadline = null; recovered.recovery.filler = null; recovered.recovery.revision++;
              }
              await save(next);
            } else {
              // Healthy packet times are memory-only; durable writes are lifecycle transitions.
              record.lastVerifiedAt = last;
            }
            lossSince = 0;
            restoredAt.delete(b.id);
          } else if (record.armed && !fresh && !lossSince && now() >= start && (!allocation || allocation.startedAt)) {
            // A healthy checkpoint is not evidence that packets stopped at that old timestamp.
            lossSince = Math.max(start, last || restoredAt.get(b.id) || start);
            const next = clone(state);
            next.rooms.find(r => r.bookingId === b.id).lossSince = lossSince;
            await save(next);
          }
          const baseline = record.armed ? lossSince || now() : start;
          const rejoinProbe = record.armed && restoredAt.has(b.id) && now() - restoredAt.get(b.id) < LIVE_AUDIO_FRESH_MS;
          const quiet = record.armed && (expired || now() >= start && !fresh && !rejoinProbe && now() >=
            (record.recovery?.deadline ?? baseline + graceMs));
          if (record.armed && allocation?.startedAt && allocation.finishedAt && quiet) {
            // The performer declared the set finished and then went quiet: a normal ending, not an audio fault.
            const next = clone(state);
            endAllocation(next, b, Math.max(lossSince, allocation.finishedAt), 'producer-finished');
            await save(next);
            direction.forget(b.id); recorder?.stopCapture?.(mediaBooking(b));
          } else if ((!allocation || allocation.startedAt) && (quiet || (!record.armed && now() - start >= INITIAL_ARM_ALLOWANCE_MS))) {
            await cancel(b, record.armed
              ? `Live performance cancelled: authorized audio recovery deadline expired (${graceMs / 1000} seconds plus any explicit producer hold). Performer fee is unchanged.`
              : `Live performance cancelled: the slot was not armed within ${INITIAL_ARM_ALLOWANCE_MS / 1000} seconds. Performer fee is unchanged.`);
          } else startMonitor(b);
        }
      }
      const updated = recordFor(b.id);
      if (updated.cancelledAt || updated.allocation?.endedAt || now() >= end) {
        void cleanup(b);
        // A pre-show availability closure is recoverable and the booking itself is still funded:
        // repeatedly cancelling it would hold cleanup open and block the owner's recovery.
        if (updated.cancelNoticePending && (b.cancelled || !preShowAvailabilityClosure(b, updated))) notifyCancellation(b, updated.reason);
      }
    }
    void recorder?.tick(bookings.map(mediaBooking));
    const activePolicy = canonicalPolicy();
    onPolicy(activePolicy);
    return activePolicy;
  }
  return {
    get configured() { return configured && !failed; },
    async previewRecording(input) {
      if (Object.keys(input).some(key => !['bookingId', 'nftId', 'wallet'].includes(key)) ||
          Boolean(input.bookingId) === Boolean(input.nftId)) throw new LiveAudioError('Choose one recording to preview.');
      const who = address(input.wallet);
      if (!who) throw new LiveAudioError('Connect the artist wallet in the page header.');
      await run(initialize);
      if (input.nftId) {
        const source = await getCatalogRecording(input.nftId);
        if (who !== source.artistWallet) throw new LiveAudioError('Only the credited artist can open this recording in the studio.');
        return recorder.previewCatalogEdit(source);
      }
      const booking = await findBooking(input.bookingId, true);
      if (who !== address(booking.wallet) || !recordingReleaseEligible(booking)) {
        throw new LiveAudioError('Only the booked performer can open this recording in the studio.');
      }
      return recorder.previewEdit(mediaBooking(booking));
    },
    async publishRecording(input, origin) {
      if (Object.keys(input).some(key => !['bookingId', 'nftId', 'wallet', 'sourceCid', 'sourceSamples',
        'choice', 'draft', 'issuedAt', 'signature'].includes(key)) ||
          Boolean(input.bookingId) === Boolean(input.nftId)) throw new LiveAudioError('Invalid recording confirmation.');
      const who = address(input.wallet);
      if (!who) throw new LiveAudioError('Connect the artist wallet before confirming.');
      await run(initialize);
      if (input.nftId) {
        const source = await getCatalogRecording(input.nftId);
        if (who !== source.artistWallet) throw new LiveAudioError('Only the credited artist can confirm this recording.');
        return recorder.publishCatalogEdit(source, input, who, origin);
      }
      const booking = await findBooking(input.bookingId, true);
      if (who !== address(booking.wallet) || !recordingReleaseEligible(booking)) {
        throw new LiveAudioError('Only the booked performer can confirm this recording.');
      }
      return recorder.publishEdit(mediaBooking(booking), input, who, origin);
    },
    async challenge({ bookingId, nftId, wallet, scope = 'room' }, origin) {
      if (scope === 'catalog-recording-edit') {
        await run(initialize);
        const who = address(wallet);
        if (!who) throw new LiveAudioError('Connect the artist wallet for this recording');
        for (const [key, challenge] of challenges) if (challenge.expiresAt <= now()) challenges.delete(key);
        if (challenges.size >= 128) throw new LiveAudioError('Too many room challenges; retry shortly');
        const source = await getCatalogRecording(nftId);
        if (who !== source.artistWallet) throw new LiveAudioError('Only the artist wallet recorded in this NFT may edit its audio');
        if (!recorder?.available) throw new LiveAudioError('Catalog recording editing is not configured');
        const nonce = opaque(), expiresAt = now() + 120_000;
        const message = catalogRecordingAuthorizationMessage({
          nftId: source.nftId, wallet: who, origin, nonce, expiresAt, sourceCid: source.sourceCid,
        });
        for (const [key, challenge] of challenges) if (challenge.expiresAt <= now()) challenges.delete(key);
        if (challenges.size >= 128) throw new LiveAudioError('Too many room challenges; retry shortly');
        challenges.set(nonce, { nftId: source.nftId, source, who, origin, nonce, message, expiresAt, scope });
        return { challengeId: nonce, message };
      }
      return run(async () => {
        await initialize();
        const b = await findBooking(bookingId, true);
        const who = address(wallet);
        if (!who || (who !== owner && who !== address(b.wallet))) {
          throw new LiveAudioError('Only this booking performer or configured owner may enter backstage');
        }
        for (const [key, challenge] of challenges) if (challenge.expiresAt <= now()) challenges.delete(key);
        if (challenges.size >= 128) throw new LiveAudioError('Too many room challenges; retry shortly');
        if (scope === 'recording-edit') {
          if (who !== address(b.wallet) || !recordingReleaseEligible(b)) {
            throw new LiveAudioError('Only the booked performer on an active, acknowledged recording booking may edit or approve releases');
          }
          const edit = await recorder?.editState(mediaBooking(b));
          if (!edit?.available) throw new LiveAudioError('This booking has no finalized recording ready for performer review');
          const id = opaque(), expiresAt = now() + 120_000;
          const message = ['DecentBusking live recording edit authorization', `Booking: ${b.id}`, `Wallet: ${who}`,
            `Origin: ${origin}`, `Nonce: ${id}`, `Expires: ${new Date(expiresAt).toISOString()}`,
            `Source CID: ${edit.sourceCid}`, `Source samples: ${edit.sourceSamples}`,
            'This pass allows only this booked performer to edit and approve distinct recording releases.',
            'No owner mint signature, token mutation, payment, collaborator royalty, or transaction is authorized.'].join('\n');
          challenges.set(id, { bookingId, who, origin, message, expiresAt, scope });
          return { challengeId: id, message };
        }
        if (scope !== 'room') throw new LiveAudioError('Unknown live audio authorization scope');
        const preflightRecord = recordFor(b.id);
        const reopenPreflight = who === owner && recoverableDeclinedPreflight(b, preflightRecord);
        if (!reopenPreflight) windowOpen(b);
        const id = opaque(), expiresAt = now() + 120_000;
        const broadcast = liveBroadcastTiming(b, recordFor(b.id));
        const record = recordFor(b.id);
        const recoverCancelledAt = who === owner && recoverablePreShowClosure(b, record) ? record.cancelledAt : null;
        const delayedStart = recoverCancelledAt ? recoveryDelayedStart(b) : null;
        const preflightStart = reopenPreflight ? Math.ceil((now() + 15 * 60_000) / 60_000) * 60_000 : null;
        if (preflightStart) checkPreflightConflict(b, preflightStart);
        const accessUntil = preflightStart
          ? liveBroadcastTiming(b, { allocation: { plannedStartAt: preflightStart, startedAt: null,
            durationMs: Date.parse(b.endUtc) - Date.parse(b.startUtc), encoreMs: 0 } }).accessUntil
          : broadcast?.accessUntil ?? (delayedStart
          ? liveBroadcastTiming(b, { allocation: { id: 'pending', revision: 1, plannedStartAt: delayedStart + 300_000, startedAt: null,
            durationMs: Date.parse(b.endUtc) - Date.parse(b.startUtc), encoreMs: 0 } }).accessUntil
          : Date.parse(b.endUtc));
        const message = ['DecentBusking live audio room authorization', `Booking: ${b.id}`, `Wallet: ${who}`,
          `Origin: ${origin}`, `Nonce: ${id}`, `Expires: ${new Date(expiresAt).toISOString()}`,
          `Broadcast allocation: ${broadcast?.allocationId || 'original booked slot'}`,
          `Room authorization until: ${new Date(accessUntil).toISOString()}`,
          ...(recoverCancelledAt ? ['Reopen this verified booking for PRIVATE soundchecks only. Both checks must be completed again.',
            ...(delayedStart ? [`Delayed start: the full contracted set moves to about ${new Date(delayedStart).toISOString()}. The performer may decline or shorten; the guaranteed fee is unchanged.`] : [])] : []),
          ...(preflightStart ? [`Replace the declined, never-aired allocation with PRIVATE preflight at ${new Date(preflightStart).toISOString()}.`,
            'Both real listening checks must be repeated. The performer must choose participation again before Take live.',
            'This does not reopen a completed performance or authorize a no-show, recording, payout, or forfeiture.'] : []),
          'Owner broadcast direction affects airtime only. Pair changes require the next booking owner pass. Original contract times and fees are unchanged.',
          'Audio room access only. No transaction, recording, payout or financial authorization.'].join('\n');
        challenges.set(id, { bookingId, who, origin, message, expiresAt, accessUntil, allocationId: broadcast?.allocationId || null,
          recoverCancelledAt, preflightStart, preflightRevision: reopenPreflight ? preflightRecord.allocation.revision : null });
        return { challengeId: id, message };
      });
    },
    async authorize({ challengeId, signature }, origin) {
      if (challenges.get(challengeId)?.scope === 'catalog-recording-edit') {
        const c = await run(async () => {
          await initialize();
          const challenge = challenges.get(challengeId);
          if (!challenge || challenge.origin !== origin || challenge.expiresAt <= now()) {
            throw new LiveAudioError('Room challenge expired or already used');
          }
          if (address(verify(challenge.message, signature)) !== challenge.who) {
            throw new LiveAudioError('Room signature does not match the catalog artist wallet');
          }
          challenges.delete(challengeId);
          return challenge;
        });
        const source = await getCatalogRecording(c.nftId);
        if (!sameCatalogSource(c.source, source) || c.who !== source.artistWallet) {
          throw new LiveAudioError('The verified NFT source changed; reopen the recording editor and sign again');
        }
        const state = await recorder?.prepareCatalogEdit(source, {
          origin: c.origin, nonce: c.nonce, expiresAt: c.expiresAt, signature,
        });
        if (!state?.available) throw new LiveAudioError('This catalog recording could not be prepared for editing');
        const token = opaque(), sessionExpiresAt = now() + 15 * 60_000;
        for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
        if (sessions.size >= 32) throw new LiveAudioError('Room session limit reached');
        sessions.set(token, { nftId: source.nftId, source, wallet: c.who,
          role: 'performer', scope: 'catalog-recording-edit', origin, expiresAt: sessionExpiresAt });
        return { token, role: 'performer', expiresAt: sessionExpiresAt, state };
      }
      return run(async () => {
        await initialize();
        const c = challenges.get(challengeId);
        if (!c || c.origin !== origin || c.expiresAt <= now()) throw new LiveAudioError('Room challenge expired or already used');
        if (address(verify(c.message, signature)) !== c.who) throw new LiveAudioError('Room signature does not match the booking wallet');
        challenges.delete(challengeId);
        const b = await findBooking(c.bookingId, true);
        if (c.scope === 'recording-edit') {
          if (c.who !== address(b.wallet) || !recordingReleaseEligible(b)) {
            throw new LiveAudioError('Only the booked performer on an active, acknowledged recording booking may edit or approve releases');
          }
          const state = await recorder?.editState(mediaBooking(b));
          if (!state?.available) throw new LiveAudioError('This recording is no longer available for editing');
          const token = opaque(), expiresAt = now() + 15 * 60_000;
          for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
          if (sessions.size >= 32) throw new LiveAudioError('Room session limit reached');
          sessions.set(token, { bookingId: b.id, wallet: c.who, role: 'performer', scope: 'recording-edit', origin, expiresAt });
          return { token, role: 'performer', expiresAt, state };
        }
        if (!c.preflightStart) windowOpen(b);
        const currentAllocation = liveBroadcastTiming(b, recordFor(b.id));
        if ((currentAllocation?.allocationId || null) !== c.allocationId) throw new LiveAudioError('Allocation changed; sign its current room scope');
        const record = recordFor(b.id);
        if (c.preflightStart) {
          if (c.who !== owner || !recoverableDeclinedPreflight(b, record) ||
              record.allocation.revision !== c.preflightRevision || now() >= c.preflightStart) {
            throw new LiveAudioError('Private preflight recovery changed or expired; the owner must sign again');
          }
          if (closing.has(b.id) || notifying.has(b.id)) throw new LiveAudioError('Room cleanup is still in progress; retry authorization');
          checkPreflightConflict(b, c.preflightStart);
          const next = clone(state), r = next.rooms.find(item => item.bookingId === b.id);
          r.allocation = validateLiveAllocation({ ...r.allocation,
            id: `allocation:${createHash('sha256').update(`preflight:${c.allocationId}:${challengeId}`).digest('hex')}`,
            revision: 1, plannedStartAt: c.preflightStart, endedAt: null, endReason: null,
            durationMs: Date.parse(b.endUtc) - Date.parse(b.startUtc), choice: 'pending', choiceAt: null,
            delayNotifiedAt: now(), finishedId: null, finishedAt: null, priorityFollowup: false,
          });
          Object.assign(r, { armed: false, checks: {}, lastVerifiedAt: 0, lossSince: 0 });
          r.broadcastCommands ||= [];
          r.broadcastCommands.push({ id: `preflight-reopen:${challengeId}`,
            hash: createHash('sha256').update(c.message).digest('hex') });
          await save(next);
          for (const [token, session] of sessions) if (session.bookingId === b.id) sessions.delete(token);
          direction.forget(b.id);
          closed.delete(b.id); frames.delete(b.id); restoredAt.delete(b.id);
        }
        if (record?.cancelledAt) {
          if (c.who !== owner || c.recoverCancelledAt !== record.cancelledAt || !recoverablePreShowClosure(b, record)) {
            throw new LiveAudioError('This live room is cancelled; only the owner may recover an eligible pre-show booking');
          }
          if (closing.has(b.id) || notifying.has(b.id)) throw new LiveAudioError('Room cleanup is still in progress; retry authorization');
          const next = clone(state), start = Date.parse(b.startUtc), plannedStartAt = recoveryDelayedStart(b);
          next.rooms[next.rooms.findIndex(item => item.bookingId === b.id)] = {
            bookingId: b.id, armed: false, checks: {}, lastVerifiedAt: 0,
            ...(plannedStartAt ? { allocation: validateLiveAllocation({
              id: `allocation:${createHash('sha256').update(`recovery:${b.id}:${record.cancelledAt}`).digest('hex')}`,
              revision: 1, plannedStartAt, startedAt: null, endedAt: null, endReason: null,
              durationMs: Date.parse(b.endUtc) - start, encoreMs: 0, choice: 'contracted', choiceAt: null,
              previousBookingId: null, nextBookingId: null, delayNotifiedAt: now(), finishedId: null,
              finishedAt: null, priorityFollowup: false }) } : {}),
          };
          await save(next);
          closed.delete(b.id);
          frames.delete(b.id);
          restoredAt.delete(b.id);
        }
        if (!recordFor(b.id)) {
          const next = clone(state);
          next.rooms.push({ bookingId: b.id, armed: false, checks: {}, lastVerifiedAt: 0 });
          await save(next);
        }
        const token = opaque(), role = c.who === owner ? 'owner' : 'publisher';
        for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
        if (sessions.size >= 32) throw new LiveAudioError('Room session limit reached');
        const expiresAt = Math.min(c.accessUntil, liveBroadcastTiming(b, recordFor(b.id))?.accessUntil ?? Date.parse(b.endUtc));
        sessions.set(token, { bookingId: b.id, wallet: c.who, role, origin, expiresAt });
        startMonitor(b);
        return { token, role, canPublish: c.who === address(b.wallet), expiresAt,
          state: { ...publicState(b, recordFor(b.id), true), broadcastCapabilities: broadcastCapabilities(b, sessions.get(token)) } };
      });
    },
    async command(token, command, origin) {
      // Private coordination never queues a checkpoint or waits behind the media watchdog.
      if (typeof command?.action === 'string' && command.action.startsWith('direction-')) {
        return directionCommand(token, command, origin);
      }
      if (typeof command?.action === 'string' && command.action.startsWith('feedback-')) {
        return feedbackCommand(token, command, origin);
      }
      if (typeof command?.action === 'string' && command.action.startsWith('telemetry-')) {
        return telemetryCommand(token, command, origin);
      }
      if (sessions.get(token)?.scope === 'catalog-recording-edit') {
        await run(initialize);
        let session = auth(token, origin);
        if (!['catalog-recording-edit-state', 'catalog-recording-edit-save', 'catalog-recording-edit-approve'].includes(command.action)) {
          throw new LiveAudioError('This pass permits only edits to its verified catalog recording');
        }
        if (recorder?.deploymentPaused?.()) throw new LiveAudioError('Recording editing is paused for a verified deployment handoff');
        const source = await getCatalogRecording(session.nftId);
        session = auth(token, origin);
        if (!sameCatalogSource(session.source, source) || session.wallet !== source.artistWallet) {
          throw new LiveAudioError('Catalog source attribution changed; reopen and reauthorize the recording');
        }
        if (recorder?.deploymentPaused?.()) throw new LiveAudioError('Recording editing is paused for a verified deployment handoff');
        if (command.action === 'catalog-recording-edit-state') {
          if (Object.keys(command).some(key => key !== 'action')) throw new LiveAudioError('Invalid catalog recording edit request');
          return recorder.catalogEditState(source);
        }
        if (command.action === 'catalog-recording-edit-save') {
          if (Object.keys(command).some(key => !['action', 'draft'].includes(key))) throw new LiveAudioError('Invalid catalog recording edit request');
          return recorder.saveCatalogEdit(source, command.draft, session.wallet);
        }
        if (Object.keys(command).some(key => !['action', 'choice', 'issuedAt', 'signature'].includes(key))) {
          throw new LiveAudioError('Invalid catalog recording approval request');
        }
        return recorder.approveCatalogEdit(source, command, session.wallet, origin);
      }
      return run(async () => {
        await initialize();
        const session = auth(token, origin);
        const b = await findBooking(session.bookingId, !['state', 'cancel'].includes(command.action));
        if (session.scope === 'recording-edit') {
          if (session.wallet !== address(b.wallet) || !recordingReleaseEligible(b) ||
              !['recording-edit-state', 'recording-edit-save', 'recording-edit-approve'].includes(command.action)) {
            throw new LiveAudioError('This pass permits only the booked performer’s recording edit actions');
          }
          if (recorder?.deploymentPaused?.()) throw new LiveAudioError('Recording editing is paused for a verified deployment handoff');
          if (command.action === 'recording-edit-state') {
            if (Object.keys(command).some(key => key !== 'action')) throw new LiveAudioError('Invalid recording edit request');
            return recorder.editState(mediaBooking(b));
          }
          if (command.action === 'recording-edit-save') {
            if (Object.keys(command).some(key => !['action', 'draft'].includes(key))) throw new LiveAudioError('Invalid recording edit request');
            return recorder.saveEdit(mediaBooking(b), command.draft, session.wallet);
          }
          if (Object.keys(command).some(key => !['action', 'choice', 'issuedAt', 'signature'].includes(key))) {
            throw new LiveAudioError('Invalid recording approval request');
          }
          return recorder.approveEdit(mediaBooking(b), command, session.wallet, origin);
        }
        if (typeof command.action === 'string' && command.action.startsWith('recording-edit-')) {
          throw new LiveAudioError('A performer recording edit authorization is required');
        }
        const record = recordFor(b.id);
        if (command.action === 'state') return { ...publicState(b, record, true), broadcastCapabilities: broadcastCapabilities(b, session) };
        if (recorder?.deploymentPaused?.()) throw new LiveAudioError('Live controls paused for a verified deployment handoff; try again after maintenance');
        if (typeof command.action === 'string' && command.action.startsWith('broadcast-')) {
          return broadcastCommand(session, b, command);
        }
        windowOpen(b);
        if (record.cancelledAt) throw new LiveAudioError('This room is cancelled');
        if (command.action === 'recording-consent') {
          if (!recorder) throw new LiveAudioError('Recording is not configured');
          await recorder.consent(mediaBooking(b), command, session.wallet, origin);
          return publicState(b, recordFor(b.id), true);
        }
        if (command.action === 'connect') {
          if (command.publish === true && session.wallet !== address(b.wallet)) {
            throw new LiveAudioError('Only the booked performer may publish audio');
          }
          return transport.connect(mediaBooking(b), command.publish === true ? 'publisher' : 'owner');
        }
        if (command.action === 'obs') {
          if (session.wallet !== address(b.wallet)) throw new LiveAudioError('Only the booked performer may obtain OBS credentials');
          return transport.obs(mediaBooking(b));
        }
        if (session.role !== 'owner') throw new LiveAudioError('Only the configured owner controls the public room');
        if (command.action === 'cancel') {
          if (command.confirmed !== true) throw new LiveAudioError('Confirm cancellation explicitly');
          await cancel(b, 'Live performance cancelled by the operator. Performer fee is unchanged.', 'operator-cut');
          void cleanup(b);
          return publicState(b, recordFor(b.id), true);
        }
        if (command.action === 'check') {
          const beforeStart = (liveBroadcastTiming(b, record)?.plannedStartAt ?? Date.parse(b.startUtc)) - now();
          const lateFirst = command.check === 't60' && command.lateConfirmed === true &&
            record.allocation && !record.allocation.startedAt && !record.allocation.endedAt && !record.armed &&
            beforeStart > 0 && beforeStart <= 25 * 60_000;
          const valid = command.check === 't60' ? beforeStart >= 40 * 60_000 && beforeStart <= 70 * 60_000
            : command.check === 't15' && beforeStart > 0 && beforeStart <= 25 * 60_000;
          if ((!valid && !lateFirst) || command.confirmed !== true) throw new LiveAudioError('Confirm the matching T−60/T−15 private listening check in its window');
          if (!frames.get(b.id) || now() - frames.get(b.id) > LIVE_AUDIO_FRESH_MS) throw new LiveAudioError('No fresh audio has reached the independent worker receiver');
          if (command.check === 't15' && record.checks.t60 &&
              Date.parse(record.checks.t60) > (liveBroadcastTiming(b, record)?.plannedStartAt ?? Date.parse(b.startUtc)) - 40 * 60_000 &&
              frames.get(b.id) <= Date.parse(record.checks.t60)) {
            throw new LiveAudioError('Wait for newly delivered audio after the late first check, then listen and confirm the final check');
          }
          const next = clone(state);
          next.rooms.find(r => r.bookingId === b.id).checks[command.check] = new Date(now()).toISOString();
          await save(next);
        } else if (command.action === 'arm') {
          if (!record.checks.t60 || !record.checks.t15 || now() >= (liveBroadcastTiming(b, record)?.plannedStartAt ?? Date.parse(b.startUtc))) {
            throw new LiveAudioError('Both private soundchecks must pass before arming the scheduled slot');
          }
          const next = clone(state); next.rooms.find(r => r.bookingId === b.id).armed = true;
          await save(next);
        } else throw new LiveAudioError('Unknown room action');
        return publicState(b, recordFor(b.id), true);
      });
    },
    async state(bookingId) {
      if (!configured || failed) return { configured: false, status: 'OFF-AIR', phase: 'unavailable',
        performer: null, bookingVerification: { fresh: false, verifiedAt: bookingsLoaded ? checkedAt : null },
        reason: 'Live audio hosting and durable room state are not configured' };
      return run(async () => { await initialize(); const b = await findBooking(bookingId); return publicState(b, recordFor(b.id)); });
    },
    async current() {
      if (!configured || failed) return null;
      return run(async () => {
        await initialize(); await readBookings();
        const policy = canonicalPolicy();
        const live = policy?.mode !== 'radio' && bookings.find(item => item.id === policy?.bookingId);
        const b = live || bookings.find(item => {
          const p = policyFor(recordFor(item.id), item);
          return p && p.mode !== 'radio' || recordFor(item.id) && !recordFor(item.id).cancelledAt &&
            now() >= Date.parse(item.startUtc) - 15_000 && now() < Date.parse(item.startUtc);
        });
        return b ? publicState(b, recordFor(b.id)) : null;
      });
    },
    feedbackState() {
      if (!configured || failed || stopped || !state || !bookingVerification().fresh) {
        throw new LiveAudioError('Live booking verification is unavailable');
      }
      const policy = canonicalPolicy();
      if (policy?.mode !== 'live') return null;
      const b = bookings.find(item => item.id === policy.bookingId);
      if (!b || !bookingVerification(b).fresh) throw new LiveAudioError('Live booking verification is unavailable');
      return publicState(b, recordFor(b.id));
    },
    async listener(bookingId, telemetryPageId, mode = 'direct') {
      return run(async () => {
        if (!['direct', 'hls'].includes(mode)) throw new LiveAudioError('Invalid public listener transport');
        await initialize();
        const b = await findBooking(bookingId, true), record = recordFor(b.id);
        funded(b);
        if (!record?.armed || record.cancelledAt || canonicalPolicy()?.bookingId !== b.id || policyFor(record, b)?.mode !== 'live' ||
            now() < (liveBroadcastTiming(b, record)?.actualStartedAt ?? Date.parse(b.startUtc)) || now() >= liveBroadcastEnd(mediaBooking(b))) {
          throw new LiveAudioError('Public listening is unavailable; soundchecks are private');
        }
        let result;
        if (mode === 'hls') {
          const broadcast = publicBroadcastState();
          if (broadcast?.selected !== true || broadcast.status !== 'ready') {
            throw new LiveAudioError('Public broadcast admission is unavailable');
          }
          result = { transport: 'hls' };
        } else {
          for (const [id, at] of reservations) if (at <= now()) reservations.delete(id);
          if (reservations.size >= (transport.listenerLimit || 10)) throw new LiveAudioError('Live listener admission busy; retry in 30 seconds');
          result = await transport.listener(mediaBooking(b));
          reservations.set(opaque(), now() + 30_000);
        }
        let telemetryToken, telemetryRenewal;
        try {
          telemetryToken = listenerTelemetry?.issue(bookingId, telemetryPageId);
          if (telemetryToken) telemetryRenewal = listenerTelemetry?.renewal(bookingId, telemetryPageId);
        } catch { listenerTelemetry?.reportFailure?.(); }
        return telemetryToken ? { ...result, telemetryToken, ...(telemetryRenewal ? { telemetryRenewal } : {}) } : result;
      });
    },
    prepareDeployment: lease => run(async () => {
      if (lease.action === 'cancel') {
        recorder?.cancelDeployment(lease.id);
        return { ready: false };
      }
      if (!configured || failed) throw new LiveAudioError('Live audio state unavailable for deployment handoff');
      await initialize();
      let timer, result;
      try {
        result = await Promise.race([
          Promise.resolve().then(getBookings),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new LiveAudioError('Booking handoff verification timed out')), checkpointTimeoutMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
      const currentBookings = Array.isArray(result) ? result : result?.bookings;
      if (!Array.isArray(currentBookings)) throw new LiveAudioError('Current bookings unavailable for deployment handoff');
      if (state.rooms.some(r => {
        const b = currentBookings.find(b => b.id === r.bookingId);
        return !r.cancelledAt && (r.allocation ? !r.allocation.endedAt :
          r.armed && (!b || !Number.isFinite(Date.parse(b.endUtc)) || Date.parse(b.endUtc) > now()));
      })) return { ready: false };
      if (!recorder?.prepareDeployment) throw new LiveAudioError('Durable recording handoff is unavailable');
      return recorder.prepareDeployment({ ...lease, bookings: currentBookings.map(mediaBooking) });
    }),
    completionState(bookingId) {
      if (!state || failed) return { known: false, pending: true, actualEndedAt: null };
      const a = recordFor(bookingId)?.allocation;
      return a ? { known: true, pending: !a.endedAt, actualEndedAt: a.endedAt, endReason: a.endReason,
        actualStartedAt: a.startedAt, plannedStartAt: a.plannedStartAt, choice: a.choice,
        priorityFollowup: a.priorityFollowup } : { known: true, pending: false, actualEndedAt: null };
    },
    broadcastDeploymentState() {
      return { known: !!state && !failed, pending: !state || failed ||
        state.rooms.some(r => r.allocation && !r.allocation.endedAt && !r.cancelledAt) };
    },
    tick: () => stopped ? Promise.resolve(null) : run(tickInternal),
    stop: async () => { stopped = true; direction.clear(); await transport?.stop?.(); },
  };
}
