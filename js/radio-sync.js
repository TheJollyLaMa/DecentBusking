// js/radio-sync.js?v=20261022-playlist-lane — DecentBusking
// Mirrors the Discord JukeLoop voice channel in the Now Playing banner. New
// Discord uploads briefly take over the site radio for their first play, and
// archive selections mute the radio until the listener returns to it.

import { workerEnsProvider } from './ens-client.mjs?v=20261016-ens-worker';
import { resolveCreatorENS } from './creator-profile-data.mjs?v=20261022-playlist-lane';
import { formatUsdcUnits as _formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';

const POLL_MS = 8_000;
const FADE_IN_MS = 600;
const PREVIEW_MS = 30_000;
const DRIFT_TOLERANCE_S = 8;
const LOAD_TIMEOUT_MS = 20_000;
const GATEWAY_RETRY_TIMEOUT_MS = 5_000;
const RADIO_LOAD_MAX_ATTEMPTS = 3;
const RADIO_LOAD_RETRY_MS = 15_000;
// After a song ends, poll quickly so the next one starts right after the JukeLoop changeover gap.
const HANDOFF_POLL_MS = 750;
const HANDOFF_WINDOW_MS = 30_000;
// Continuous listeners start each new song from 0:00 unless they have fallen this far behind.
const CONTINUOUS_START_MAX_S = 45;
// One upcoming file is buffered in memory; larger files stream normally.
const PRELOAD_MAX_BYTES = 80 * 1024 * 1024;
const PRELOAD_WAIT_MS = 10_000;

let _audio, _labelEl, _sponsorEl, _titleEl, _artistEl, _activityEl, _adCountdownEl, _playBtn, _radioBtn;
let _audioPlayer, _videoPlayer, _videoStage, _videoToggle;
let _videoHidden = false;
const _sponsorEnsCache = new Map();
const _sponsorEnsPending = new Map();

function _notifyRadioSourceMode() {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('radio-source-mode-change', { detail: _mode }));
}

// Mute state for archive listens (previews and purchased plays), separate from the radio mute.
let _archiveMuted = false;

function _notifyArchiveMute() {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('dbusk-archive-mute', { detail: { muted: _archiveMuted } }));
}

export function setArchiveMuted(muted) {
  _archiveMuted = Boolean(muted);
  _applyRadioVolume();
  _notifyArchiveMute();
}

export function archiveMuted() {
  return _archiveMuted;
}

function _shortAddress(address) {
  const value = String(address || '');
  return value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function formatRadioSponsor(sponsor, ensName = '') {
  if (!sponsor) return null;
  const name = ensName || _shortAddress(sponsor.wallet);
  if (sponsor.kind === 'djuke') {
    return {
      text: `💸 DJuke · bumped by ${name} · ${_formatUsdcUnits(sponsor.amountUnits)} USDC`,
      title: `Paid by ${sponsor.wallet}`,
    };
  }
  if (sponsor.kind === 'devert') {
    return {
      text: `📣 DeVert ad · sponsored by ${name}`,
      title: `Sponsored by ${sponsor.wallet}`,
    };
  }
  return null;
}

async function _resolveSponsorName(wallet) {
  const key = String(wallet || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key) || _sponsorEnsCache.has(key) || _sponsorEnsPending.has(key)) return null;
  const provider = workerEnsProvider;
  const task = (async () => {
    try {
      const profile = await resolveCreatorENS(wallet, provider);
      const name = profile?.name || null;
      if (name) _sponsorEnsCache.set(key, name);
      return name;
    } catch {
      return null;
    } finally {
      provider.destroy?.();
    }
  })().finally(() => _sponsorEnsPending.delete(key));
  _sponsorEnsPending.set(key, task);
  return task;
}

function _renderSponsorTag(sponsor) {
  if (!_sponsorEl) return;
  if (!sponsor) {
    _sponsorEl.hidden = true;
    _sponsorEl.removeAttribute('data-creator');
    _sponsorEl.removeAttribute('title');
    _sponsorEl.textContent = '';
    return;
  }
  const key = String(sponsor.wallet || '').toLowerCase();
  const sponsorText = formatRadioSponsor(sponsor, _sponsorEnsCache.get(key) || '');
  if (!sponsorText) return _renderSponsorTag(null);
  _sponsorEl.hidden = false;
  _sponsorEl.classList.remove('hidden');
  _sponsorEl.dataset.creator = sponsor.wallet;
  _sponsorEl.textContent = sponsorText.text;
  _sponsorEl.title = sponsorText.title;
  void _resolveSponsorName(sponsor.wallet).then((name) => {
    if (name && _sponsorEl?.dataset?.creator === sponsor.wallet) _renderSponsorTag(sponsor);
  });
}

function _renderVideo() {
  const videoActive = _videoPlayer && _audio === _videoPlayer;
  if (_videoStage) _videoStage.hidden = !videoActive || _videoHidden;
  if (_videoToggle) {
    _videoToggle.classList.toggle('hidden', !videoActive);
    _videoToggle.setAttribute('aria-pressed', String(videoActive && !_videoHidden));
    _videoToggle.setAttribute('aria-label', _videoHidden ? 'Show video' : 'Hide video');
    _videoToggle.title = _videoHidden ? 'Show video' : 'Hide video';
  }
}

function _onPause(event) {
  if (_suppressPauseStop) {
    _suppressPauseStop = false;
    return;
  }
  if (event?.target && event.target !== _audio && event?.target !== _videoPlayer) return;
  if (!_audio?.paused && !_videoPlayer?.paused) return;
  _broadcastNowPlayingStopped('paused');
}

/** @type {'radio'|'takeover'|'archive'} */
let _mode = 'radio';
let _archiveSession = null;
let _radio = null;
let _activeShowId = null;
let _radioReachable = true;
let _loadedPlayId = null;
let _radioLoadFailure = null;
let _seen = null;
let _seenSince = 0;
const _takeoverQueue = [];
let _takeover = null;
let _burst = false;
let _blocked = false;
let _switchToken = 0;
let _pollTimer = null;
let _listenerId = null;
let _voteButtons = [];
let _voteStatusEl;
let _voteNetEl;
let _voteNet = null;
let _voteNetPlayId = null;
let _voteNetRequest = 0;
let _voteNetRendered = null;
let _voteNetRenderedPlayId = null;
let _votePending = false;
let _votingPlayId = null;
const _votedPlays = new Map();
let _radioVolume = 1;
let _radioMuted = false;
let _devertListenMode = 'radio';
let _fadeLevel = 0;
let _fadeNextRadioSwitch = false;
let _muteBtn, _volumeInput, _volumeDial;
let _nowPlayingBroadcastKey = null;
let _nowPlayingBroadcastDetail = null;
let _suppressPauseStop = false;
let _radioState = null;
let _upNext = null;
/** Set when a radio song played to its end, so the next song starts from its beginning. */
let _radioHandoff = null;
/** The single in-memory preload of the published next radio item. */
let _preload = null;
let _activeBlobUrl = null;
const _transitionLog = [];

function _applyRadioVolume() {
  if (!_audio) return;
  _audio.muted = _mode === 'archive' ? _archiveMuted : _radioMuted;
  _audio.volume = _fadeLevel * (_mode === 'archive' ? 1 : _radioVolume);
}

function _broadcastNowPlaying(detail) {
  if (typeof document === 'undefined' || !document?.dispatchEvent) return;
  const key = [
   detail?.playId || '',
   detail?.trackId || '',
   detail?.audioUrl || '',
   detail?.title || '',
   detail?.artist || '',
   detail?.ipfsCid || '',
   detail?.source || '',
  ].join('|');
  if (key === _nowPlayingBroadcastKey) return;
  const CustomEventCtor = globalThis.CustomEvent || document.defaultView?.CustomEvent;
  if (!CustomEventCtor) return;
  _nowPlayingBroadcastKey = key;
  _nowPlayingBroadcastDetail = detail ? { ...detail } : null;
  document.dispatchEvent(new CustomEventCtor('dbusk-now-playing', {
   detail,
  }));
  _renderSponsorTag(detail?.source === 'radio' ? detail.sponsor || null : null);
}

function _broadcastNowPlayingStopped(reason = 'stopped') {
  if (typeof document === 'undefined' || !document?.dispatchEvent) return;
  const CustomEventCtor = globalThis.CustomEvent || document.defaultView?.CustomEvent;
  if (!CustomEventCtor) return;
  const detail = _nowPlayingBroadcastDetail ? { ..._nowPlayingBroadcastDetail, reason } : null;
  _nowPlayingBroadcastKey = null;
  _nowPlayingBroadcastDetail = null;
  _renderSponsorTag(null);
  document.dispatchEvent(new CustomEventCtor('dbusk-now-playing-stopped', { detail }));
}

function _cloneRadioState(state) {
  if (!state) return null;
  const countdown = state.mainRadioAdCountdown;
  return {
    ...state,
    mainRadioAdCountdown: countdown ? { ...countdown,
      paidQueue: countdown.paidQueue ? { ...countdown.paidQueue } : countdown.paidQueue,
      activeShow: countdown.activeShow ? { ...countdown.activeShow } : countdown.activeShow } : null,
  };
}

function _broadcastRadioState() {
  if (typeof document === 'undefined' || !document?.dispatchEvent) return;
  const CustomEventCtor = globalThis.CustomEvent || document.defaultView?.CustomEvent;
  if (!CustomEventCtor) return;
  document.dispatchEvent(new CustomEventCtor('dbusk-radio-state', { detail: getRadioStateSnapshot() }));
}

function _setRadioState(state) {
  _radioState = _cloneRadioState(state);
  _broadcastRadioState();
  _renderMainRadioAdCountdown();
}

export function getRadioStateSnapshot() {
  return _cloneRadioState(_radioState);
}

export function formatMainRadioAdCountdown(countdown, { disconnected = false, compact = false } = {}) {
  if (disconnected) return 'Main radio ad: disconnected';
  if (!countdown) return 'Main radio ad: scheduling unavailable';
  const paid = countdown.paidQueue;
  const protectedShow = ['weekly_top10', 'live_performance'].includes(countdown.activeShow?.type);
  if (countdown.status !== 'playing' && paid?.pendingCount > 0) {
    const queued = `${paid.pendingCount} paid ad${paid.pendingCount === 1 ? '' : 's'} queued`;
    if (protectedShow) return `${queued} · deferred during ${countdown.activeShow.label || 'this show'}`;
    if (paid.playbackReady === false) return `${queued} · delayed: ${paid.reason || 'paid playback unavailable'}`;
    if (paid.immediateCount > 0) return `${queued} · next ad after this song`;
    const timing = formatMainRadioAdCountdown({ ...countdown, paidQueue: null }, { compact });
    return `${queued} · ${timing}`;
  }
  if (paid?.unavailable && countdown.status !== 'playing') return `Paid ad queue unavailable · ${paid.reason}`;
  if (countdown.status === 'countdown' && Number.isSafeInteger(countdown.remainingSongs)) {
    const songs = countdown.remainingSongs;
    if (compact) {
      const afterCurrent = Math.max(0, songs - (countdown.includesCurrentSong ? 1 : 0));
      if (afterCurrent === 0) return 'next ad after this song';
      if (afterCurrent === 1) return 'next ad after next song';
      return `next ad after ${afterCurrent} more songs`;
    }
    return `Main radio ad: Next advert after ${songs} more song${songs === 1 ? '' : 's'}${countdown.includesCurrentSong ? ' (current song counted)' : ' (current song not counted)'}`;
  }
  if (countdown.status === 'up_next') return compact ? 'next ad after this song' : 'Main radio ad: Advert up next';
  if (countdown.status === 'playing') return compact ? 'ad playing now' : 'Main radio ad: Advert playing now';
  if (countdown.status === 'paused') return `Main radio ad: Deferred during ${countdown.activeShow?.label || countdown.reason || 'this show'}`;
  if (countdown.status === 'none') return 'Main radio ad: No eligible campaign available';
  if (countdown.status === 'unavailable' && countdown.reason === 'disconnected') return 'Main radio ad: disconnected';
  if (countdown.status === 'unavailable' && /worker gas/i.test(countdown.reason || '')) return 'Ad reporting paused – worker gas low';
  if (countdown.status === 'unavailable') return `Main radio ad: unavailable${countdown.reason ? ` (${countdown.reason})` : ''}`;
  return 'Main radio ad: scheduling unavailable';
}

function _renderMainRadioAdCountdown() {
  if (!_adCountdownEl) return;
  const disconnected = _radioState?.mainRadioAdCountdown?.reason === 'disconnected';
  const text = formatMainRadioAdCountdown(_radioState?.mainRadioAdCountdown, { disconnected, compact: true });
  if (_adCountdownEl.textContent !== text) _adCountdownEl.textContent = text;
}

function _pauseAudio() {
  if (!_audio) return;
  _suppressPauseStop = true;
  _audio.pause();
  setTimeout(() => { if (_suppressPauseStop) _suppressPauseStop = false; }, 0);
}

function _renderAudioControls() {
  if (_muteBtn) {
    const silent = _radioMuted || _radioVolume === 0;
    _muteBtn.setAttribute('aria-pressed', String(silent));
    _muteBtn.setAttribute('aria-label', silent ? 'Unmute DBusk radio' : 'Mute DBusk radio');
    _muteBtn.title = silent ? 'Unmute DBusk radio' : 'Mute DBusk radio';
    _muteBtn.querySelector('[data-volume-on]').hidden = silent;
    _muteBtn.querySelector('[data-volume-off]').hidden = !silent;
  }
  if (_volumeInput) {
    _volumeInput.value = String(Math.round(_radioVolume * 100));
    _volumeInput.setAttribute('aria-valuetext', `${_volumeInput.value}%`);
  }
  if (_volumeDial) {
    _volumeDial.style.setProperty('--volume-angle', `${-135 + _radioVolume * 270}deg`);
    _volumeDial.title = `DBusk radio volume: ${Math.round(_radioVolume * 100)}%`;
  }
}

function _saveAudioPreferences() {
  try {
    localStorage.setItem('decentbusking:radio-audio:v1', JSON.stringify({
      volume: _radioVolume, muted: _radioMuted,
    }));
  } catch {}
  _applyRadioVolume();
  _renderAudioControls();
}

function _setRadioVolume(value) {
  if (!Number.isFinite(value)) return;
  _radioVolume = Math.max(0, Math.min(1, value));
  if (_radioVolume > 0) _radioMuted = false;
  _saveAudioPreferences();
}

function _initAudioControls() {
  try {
    const saved = JSON.parse(localStorage.getItem('decentbusking:radio-audio:v1') || 'null');
    if (saved && Number.isFinite(saved.volume)) _radioVolume = Math.max(0, Math.min(1, saved.volume));
    _radioMuted = saved?.muted === true;
  } catch {}
  _muteBtn = document.getElementById('radio-mute');
  _volumeInput = document.getElementById('radio-volume');
  _volumeDial = document.getElementById('radio-volume-dial');
  _muteBtn?.addEventListener('click', () => {
    if (_radioMuted || _radioVolume === 0) {
      _radioMuted = false;
      if (_radioVolume === 0) _radioVolume = 0.5;
    } else _radioMuted = true;
    _saveAudioPreferences();
  });
  _volumeInput?.addEventListener('input', () => _setRadioVolume(Number(_volumeInput.value) / 100));
  let drag;
  _volumeDial?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { pointerId: event.pointerId, y: event.clientY, volume: _radioVolume };
    _volumeDial.setPointerCapture(event.pointerId);
    _volumeInput.focus();
    event.preventDefault();
  });
  _volumeDial?.addEventListener('pointermove', (event) => {
    if (drag?.pointerId === event.pointerId) _setRadioVolume(drag.volume + (drag.y - event.clientY) / 120);
  });
  _volumeDial?.addEventListener('lostpointercapture', () => { drag = null; });
  _renderAudioControls();
  _applyRadioVolume();
}

export async function sendRadioVote({ radioUrl, playId, voterId, vote, fetchImpl = fetch }) {
  const response = await fetchImpl(`${radioUrl}/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playId, voterId, vote }),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Voting failed (${response.status})`);
  return result;
}

function _anonymousListenerId() {
  if (_listenerId) return _listenerId;
  try {
    const saved = localStorage.getItem('decentbusking:listener:v1');
    if (/^[a-zA-Z0-9_-]{16,128}$/.test(saved || '')) _listenerId = saved;
  } catch {}
  if (!_listenerId) {
    _listenerId = crypto.randomUUID();
    try { localStorage.setItem('decentbusking:listener:v1', _listenerId); } catch {}
  }
  return _listenerId;
}

function _restoreVotes() {
  try {
    const votes = JSON.parse(localStorage.getItem(`decentbusking:votes:v1:${_radioUrl()}`) || '[]');
    if (!Array.isArray(votes)) return;
    for (const entry of votes.slice(-100)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && (entry[1] === 1 || entry[1] === -1)) {
        _votedPlays.set(entry[0], entry[1]);
      }
    }
  } catch {}
}

async function _refreshVoteNet() {
  if (!_voteNetEl) return;
  const request = ++_voteNetRequest;
  const playId = _radio?.playId;
  if (_voteNetPlayId !== playId) _voteNet = null;
  _voteNetPlayId = playId;
  if (!playId || !_radioReachable) {
    _voteNet = null;
    _renderVoting();
    return;
  }
  if (_radio.isDevert) {
    const tally = _radio.adVotes;
    _voteNet = Number.isSafeInteger(tally?.up) && tally.up >= 0 &&
      Number.isSafeInteger(tally?.down) && tally.down >= 0 && tally.net === tally.up - tally.down ? tally.net : null;
    _renderVoting();
    return;
  }
  const trackId = _radio.trackId;
  _renderVoting();
  try {
    const url = new URL(_radioUrl());
    url.pathname = '/api/radio/history';
    url.search = '?weeks=1&calendar=new-york';
    const response = await fetch(url.href, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const history = await response.json();
    const report = history.weeks?.find(entry => entry.current);
    if (!Array.isArray(report?.tracks) || !trackId) throw new Error('Weekly vote totals unavailable');
    const track = report.tracks.find(entry => entry.trackId === trackId);
    const net = track ? track.votes : 0;
    if (!Number.isSafeInteger(net)) throw new Error('Invalid net vote total');
    if (request === _voteNetRequest && _radio?.playId === playId) _voteNet = net;
  } catch (error) {
    if (request === _voteNetRequest && _radio?.playId === playId) {
      _voteNet = null;
      console.warn('[radio] Could not refresh net votes:', error.message);
    }
  }
  _renderVoting();
}

function _renderVoteNetValue(net, playId) {
  const number = _voteNetEl.querySelector?.('[data-vote-number]') || _voteNetEl;
  const effects = _voteNetEl.querySelector?.('[data-vote-effects]');
  const changed = net !== _voteNetRendered || playId !== _voteNetRenderedPlayId;
  if (!changed) return;
  const previous = _voteNetRendered;
  const samePlay = playId === _voteNetRenderedPlayId;
  number.textContent = net === null ? '—' : net > 0 ? `+${net}` : String(net);
  effects?.replaceChildren();
  const trend = samePlay && net !== null && previous !== null ? Math.sign(net - previous) : 0;
  if (_voteNetEl.dataset) _voteNetEl.dataset.trend = trend > 0 ? 'up' : trend < 0 ? 'down' : '';
  if (trend && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    if (effects) {
      const symbols = trend > 0 ? ['♪', '♫', '🎵', '♪'] : ['🕳️'];
      symbols.forEach((symbol, index) => {
        const particle = effects.ownerDocument.createElement('span');
        particle.textContent = symbol;
        particle.style.setProperty('--note-x', `${(index - 1.5) * 20}px`);
        particle.style.setProperty('--note-delay', `${index * 70}ms`);
        effects.appendChild(particle);
      });
    }
    number.getAnimations?.().forEach(animation => animation.cancel());
    number.animate?.(trend > 0
      ? [{ transform: 'translateY(0)' }, { transform: 'translateY(-10px) scale(1.18)' }, { transform: 'translateY(0)' }]
      : [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(15px) scale(.45)', opacity: 0, offset: .55 },
        { transform: 'translateY(-5px) scale(.8)', opacity: 0, offset: .56 }, { transform: 'translateY(0)', opacity: 1 }],
    { duration: trend > 0 ? 850 : 1100, easing: 'ease-out' });
  }
  _voteNetRendered = net;
  _voteNetRenderedPlayId = playId;
}

function _renderVoting() {
  if (_voteNetEl) {
    const available = _mode === 'radio' && _devertListenMode === 'radio' && _radioReachable &&
      _voteNetPlayId === _radio?.playId && Number.isSafeInteger(_voteNet);
    _renderVoteNetValue(available ? _voteNet : null, _radio?.playId);
    const scope = _radio?.isDevert ? 'this advert play' : 'this week';
    _voteNetEl.setAttribute('aria-label', available ? `${_voteNet} net votes ${scope}` : 'Net votes unavailable');
    _voteNetEl.title = available ? `Net votes ${scope} (upvotes minus downvotes)` : 'Live net votes unavailable';
  }
  if (!_voteButtons.length) return;
  const playId = _radio?.playId || null;
  const active = _mode === 'radio' && _devertListenMode === 'radio' && _radioReachable && playId && _radio?.ipfsCid;
  const choice = _votedPlays.get(playId);
  if (_votingPlayId !== playId) {
    _votingPlayId = playId;
    if (_voteStatusEl) _voteStatusEl.textContent = choice ? 'Vote recorded' : '';
  }
  for (const button of _voteButtons) {
    button.disabled = !active || _votePending || choice !== undefined;
    button.setAttribute('aria-pressed', String(choice === Number(button.dataset.radioVote)));
  }
}

async function _castRadioVote(vote) {
  const playId = _radio?.playId;
  if (_mode !== 'radio' || !playId || _votePending || _votedPlays.has(playId)) return;
  _votePending = true;
  _renderVoting();
  try {
    const result = await sendRadioVote({ radioUrl: _radioUrl(), playId, voterId: _anonymousListenerId(), vote });
    if (result.playId !== playId || (result.vote !== 1 && result.vote !== -1)) throw new Error('Invalid vote response');
    _votedPlays.set(playId, result.vote);
    while (_votedPlays.size > 100) _votedPlays.delete(_votedPlays.keys().next().value);
    try { localStorage.setItem(`decentbusking:votes:v1:${_radioUrl()}`, JSON.stringify([..._votedPlays])); } catch {}
    if (_radio?.playId === playId && _voteStatusEl) _voteStatusEl.textContent = 'Vote recorded';
    document.dispatchEvent(new CustomEvent('dbusk-radio-vote-recorded', { detail: { playId, vote: result.vote } }));
    if (_radio?.playId === playId) {
      if (_radio.isDevert) {
        // Advert totals arrive with the radio snapshot, not the weekly music chart.
        await _poll();
      } else {
        await _refreshVoteNet();
      }
    }
  } catch (error) {
    if (_radio?.playId === playId && _voteStatusEl) _voteStatusEl.textContent = error.message;
  } finally {
    _votePending = false;
    _renderVoting();
  }
}

/** Active archive listen session id, or null while the radio or a takeover is playing. */
export function archiveSessionId() {
  return _mode === 'archive' ? _archiveSession?.id ?? null : null;
}

export function archiveMedia() {
  return _mode === 'archive' ? _audio : null;
}

export function initRadioSync() {
  _audio = document.getElementById('audio-player');
  _audioPlayer = _audio;
  _videoPlayer = document.getElementById('radio-video-player');
  _videoStage = document.getElementById('radio-video-stage');
  _videoToggle = document.getElementById('radio-video-toggle');
  _labelEl = document.getElementById('now-playing-label');
  _sponsorEl = document.getElementById('now-playing-sponsor');
  _titleEl = document.getElementById('now-playing-title');
  _artistEl = document.getElementById('now-playing-artist');
  _adCountdownEl = document.getElementById('radio-ad-countdown');
  _activityEl = document.getElementById('radio-activity');
  _playBtn = document.getElementById('now-playing-play-btn');
  _radioBtn = document.getElementById('now-playing-radio-btn');
  if (!_audio || !_radioUrl()) return;
  _initAudioControls();
  _voteButtons = [...document.querySelectorAll('[data-radio-vote]')];
  _voteStatusEl = document.getElementById('radio-vote-status');
  _voteNetEl = document.getElementById('radio-vote-net');
  _restoreVotes();
  _voteButtons.forEach((button) => button.addEventListener('click', () => _castRadioVote(Number(button.dataset.radioVote))));
  _renderVoting();

  _audio.addEventListener('ended', _onEnded);
  _audio.addEventListener('pause', _onPause);
  _videoPlayer?.addEventListener('pause', _onPause);
  _videoPlayer?.addEventListener('ended', _onEnded);
  _videoToggle?.addEventListener('click', () => { _videoHidden = !_videoHidden; _renderVideo(); });
  _playBtn?.addEventListener('click', _unlock);
  _radioBtn?.addEventListener('click', returnToRadio);
  _renderSponsorTag(null);

  _setLabel('📻 Live on JukeLoop');
  _setActivity('⏳ Tuning in to the Discord JukeLoop…');
  _renderMainRadioAdCountdown();
  _poll();
}

function _mediaTypeForTrack(track = {}) {
  return (track.videoUrl || track.mediaType === 'video/mp4')
    ? 'video/mp4'
    : track.mediaType || _mimeType(track.filename || '') || '';
}

export function canSetDevertListenMode() {
  return _mode === 'radio';
}

export function setDevertListenMode(mode) {
  if (!['radio', 'ads-only'].includes(mode)) return false;
  if (mode === 'ads-only' && _mode !== 'radio') return false;
  if (_devertListenMode === mode) return true;
  const returningToRadio = mode === 'radio' && _devertListenMode === 'ads-only';
  _devertListenMode = mode;
  _radioHandoff = null;
  _maybePreload();
  if (_mode !== 'radio') return mode === 'radio';
  _loadedPlayId = null;
  if (mode === 'ads-only') {
    _setLabel('🎟️ DVert Ads Only');
    _fadeMainRadioOut();
    _setTrack('Ads Only', '');
    _setActivity('Listening to VertLoop');
  } else if (_takeoverQueue.length) {
    _fadeNextRadioSwitch = returningToRadio;
    _startNextTakeover();
  } else {
    _fadeNextRadioSwitch = returningToRadio;
    _syncRadio('📻 Back in sync with the Discord JukeLoop');
  }
  _renderVoting();
  return true;
}

/** Play a user-selected archive track; the radio stays muted until returnToRadio(). */
export function playArchiveTrack({ title, artist, audioUrl, mediaType, nft = null, sessionId = null, onEnded = null }) {
  if (!_audio) return;
  _archiveSession = { id: sessionId, onEnded };
  _radioHandoff = null;
  if (_takeover) _takeoverQueue.unshift(_takeover.track);
  _clearTakeover();
  _burst = _takeoverQueue.length > 1;
  _mode = 'archive';
  _maybePreload();
  if (_archiveMuted) setArchiveMuted(false);
  _notifyRadioSourceMode();
  _renderVoting();
  _loadedPlayId = null;
  _setLabel('🎧 From the Archive');
  _radioBtn?.classList.remove('hidden');
  _setActivity('🎧 Playing from the archive — the radio is muted here');
  _switchTo({
    title,
    artist,
    url: audioUrl,
    mime: mediaType || _mimeType(audioUrl),
    nowPlaying: {
      source: 'archive',
      nft,
      title,
      artist,
      audioUrl,
      mediaType: mediaType || _mimeType(audioUrl),
      videoUrl: nft?.videoUrl || (mediaType === 'video/mp4' ? audioUrl : ''),
    },
  });
}

export function returnToRadio() {
  if (_mode !== 'archive') return;
  _archiveSession = null;
  _radioBtn?.classList.add('hidden');
  _mode = 'radio';
  _notifyRadioSourceMode();
  _loadedPlayId = null;
  if (_takeoverQueue.length) _startNextTakeover();
  else _syncRadio('📻 Back in sync with the Discord JukeLoop');
  _renderVoting();
}

// ── Polling ───────────────────────────────────────────────────────────────

function _radioUrl() {
  const cfg = window.DecentConfig || {};
  const base = (cfg.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  return base ? `${base}/api/radio` : '';
}

async function _poll() {
  clearTimeout(_pollTimer);
  try {
    const response = await fetch(_radioUrl(), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = await response.json();
    _radioReachable = true;
    _setRadioState(state);
    _activeShowId = state.activeShow?.id || null;
    _radio = state.nowPlaying ? { ...state.nowPlaying, receivedAt: performance.now() } : null;
    _upNext = state.upNext && typeof state.upNext === 'object' ? state.upNext : null;
    _detectNewUploads(Array.isArray(state.recent) ? state.recent : [], state.serverTime);
    if (_mode === 'radio') _syncRadio();
    _maybePreload();
  } catch (err) {
    console.warn('[radio] Could not reach the JukeLoop radio:', err.message);
    _setRadioState({
      mainRadioAdCountdown: { status: 'unavailable', reason: 'disconnected' },
    });
    if (_radioReachable && _mode === 'radio') {
      _setActivity('📴 Can’t reach the JukeLoop radio right now — retrying…');
    }
    _radioReachable = false;
  }
  _renderVoting();
  _pollTimer = setTimeout(_poll, _handoffActive() ? HANDOFF_POLL_MS : POLL_MS);
  void _refreshVoteNet();
  _pollTimer?.unref?.();
}

function _handoffActive() {
  if (_radioHandoff && (_mode !== 'radio' || performance.now() - _radioHandoff.endedAt > HANDOFF_WINDOW_MS)) {
    _radioHandoff = null;
  }
  return !!_radioHandoff;
}

// Discord snowflake IDs encode their creation time.
function _postedAt(track) {
  if (/^\d{15,}$/.test(track.trackId || '')) return Number((BigInt(track.trackId) >> 22n) + 1420070400000n);
  return Date.parse(track.addedAt) || 0;
}

function _detectNewUploads(recent, serverTime) {
  if (!_seen) {
    _seen = new Set(recent.map((track) => track.trackId));
    _seenSince = serverTime || Date.now();
    return;
  }
  // A bot restart can re-list old tracks; only posts made after this page loaded count as new.
  const fresh = recent
    .filter((track) => track.ipfsCid && !_seen.has(track.trackId) && _postedAt(track) > _seenSince)
    .reverse();
  recent.forEach((track) => { if (track.ipfsCid) _seen.add(track.trackId); });
  if (!fresh.length) return;
  fresh.forEach((track) => _takeoverQueue.push(track));

  if (_mode === 'takeover') {
    _capTakeoverToPreview();
  } else if (_mode === 'archive' || _devertListenMode === 'ads-only') {
    if (_mode === 'archive') {
      const count = _takeoverQueue.length;
      _setActivity(`✨ ${count} new song${count === 1 ? '' : 's'} posted in Discord — return to the radio to hear ${count === 1 ? 'it' : 'them'}`);
    }
  } else {
    _startNextTakeover();
  }
}

// ── Radio mirroring ───────────────────────────────────────────────────────

function _radioPositionS() {
  return (_radio.positionMs + (performance.now() - _radio.receivedAt)) / 1000;
}

function _liveLabel() {
  if (_radioState?.activeShow?.type === 'playlist_show') {
    const fallback = _radio?.playlistShow?.fallback ? _radioState.playlistShow?.fallbackReason : null;
    return `📻 ${_radioState.activeShow.label} · ${fallback ? `Normal rotation (${fallback}) · ` : ''}Vote up OR down!`;
  }
  if (_activeShowId !== 'friday-top10-hype') return '📻 Live on JukeLoop';
  const hype = _radio?.hype;
  const place = hype?.encore ? ' · Encore' : Number.isInteger(hype?.openingRank) ? ` · #${hype.openingRank}` : '';
  return `🎉 Listening to Top 10 Friday Night Hype${place}`;
}

function _syncRadio(message) {
  _setLabel(_liveLabel());
  _renderVoting();
  if (_devertListenMode === 'ads-only') {
    _renderSponsorTag(null);
    return;
  }
  if (!_radio) {
    if (!_audio.paused) return;
    _loadedPlayId = null;
    _broadcastNowPlayingStopped('radio-empty');
    _renderSponsorTag(null);
    const playback = _radioState?.playback;
    if (playback?.status === 'empty') {
      _setTrack('📻 No playable recordings are available — waiting for radio uploads', '');
      _setActivity('');
      return;
    }
    if (playback && ['offline', 'recovering', 'paused'].includes(playback.status)) {
      _setTrack(playback.status === 'paused'
        ? `📻 Radio paused · ${playback.reason || 'scheduled live performance'}`
        : '📻 Radio is reconnecting — playback is temporarily unavailable', '');
      _setActivity(playback.reason || '');
      return;
    }
    if (playback?.status === 'preparing' && playback.idleMs >= 30_000) {
      _setTrack('📻 Preparing the next recording — radio recovery will retry automatically', '');
      _setActivity('The radio is taking longer than expected to load the next track.');
      return;
    }
    _setTrack(message || (_radioHandoff && _upNext?.title
      ? `📻 Up next: ${_upNext.title}`
      : '🌙 The JukeLoop is between tracks — waiting for the next song'), '');
    _setActivity('');
    return;
  }

  if (_radioLoadFailure?.playId !== _radio.playId) _radioLoadFailure = null;
  if (_radioLoadFailure && performance.now() < _radioLoadFailure.retryAt) return;

  if (_radio.playId === _loadedPlayId) {
    return;
  }

  if (_loadedPlayId && !_audio.paused) {
    _setActivity(message || '📻 Waiting for the current song to finish before switching tracks');
    return;
  }

  _loadedPlayId = _radio.playId;
  // A listener whose last song played to its end hears the next one from 0:00; joins and returns sync live.
  const continuing = !!_radioHandoff && _radio.playId !== _radioHandoff.previousPlayId &&
    _radioPositionS() <= CONTINUOUS_START_MAX_S;
  _radioHandoff = null;
  if (!_radio.ipfsCid) {
    _stopAudio();
    _setTrack(_radio.title, _radio.uploader);
    _setActivity('🎧 Playing in Discord — this track isn’t on IPFS yet, so it can’t stream here');
    return;
  }
  _setActivity(message || '📻 In sync with the Discord JukeLoop voice channel');
  _switchTo({
    title: _radio.title,
    artist: _radio.uploader,
    url: _gatewayUrl(_radio.ipfsCid),
    fallbackUrls: _gatewayUrls(_radio.ipfsCid).slice(1),
    mime: _mediaTypeForTrack(_radio),
    offset: continuing ? () => 0 : _radioPositionS,
    preloadCid: _radio.ipfsCid,
    nowPlaying: {
      source: 'radio',
      playId: _radio.playId || null,
      trackId: _radio.trackId || null,
      title: _radio.title || '',
      artist: _radio.uploader || '',
      audioUrl: _radio.ipfsCid ? _gatewayUrl(_radio.ipfsCid) : '',
      mediaType: _mediaTypeForTrack(_radio),
      videoUrl: _radio.videoUrl || (_mediaTypeForTrack(_radio) === 'video/mp4' ? _gatewayUrl(_radio.ipfsCid) : ''),
      ipfsCid: _radio.ipfsCid || null,
      nft: null,
    },
  });
}

// ── New-upload takeovers ──────────────────────────────────────────────────

function _startNextTakeover() {
  _clearTakeover();
  const track = _takeoverQueue.shift();
  if (!track) {
    _burst = false;
    _mode = 'radio';
    _notifyRadioSourceMode();
    _loadedPlayId = null;
    _broadcastNowPlayingStopped('takeover-finished');
    _syncRadio('📻 Back to mirroring the Discord JukeLoop');
    return;
  }

  _mode = 'takeover';
  _radioHandoff = null;
  _maybePreload();
  _notifyRadioSourceMode();
  _renderVoting();
  if (_takeoverQueue.length > 0) _burst = true;
  const preview = _burst;
  const queued = _takeoverQueue.length;
  _takeover = { track, preview, startedAt: performance.now(), timer: null };
  _setLabel('✨ New Song');
  _setActivity(preview
    ? `✨ New song NFTs are pouring in — 30-second preview (${queued ? `${queued} more queued` : 'last one, then back to the JukeLoop'})`
    : '✨ New song posted in Discord — its first play is here, then back to the JukeLoop');
  if (preview) {
    _takeover.timer = setTimeout(_startNextTakeover, PREVIEW_MS);
    _takeover.timer?.unref?.();
  }
  _switchTo({
    title: track.title,
    artist: track.uploader,
    url: _gatewayUrl(track.ipfsCid),
    fallbackUrls: _gatewayUrls(track.ipfsCid).slice(1),
    mime: _mediaTypeForTrack(track),
    nowPlaying: {
      source: 'takeover',
      playId: track.playId || null,
      trackId: track.trackId || null,
      title: track.title || '',
      artist: track.uploader || '',
      audioUrl: track.ipfsCid ? _gatewayUrl(track.ipfsCid) : '',
      mediaType: _mediaTypeForTrack(track),
      videoUrl: track.videoUrl || (_mediaTypeForTrack(track) === 'video/mp4' ? _gatewayUrl(track.ipfsCid) : ''),
      ipfsCid: track.ipfsCid || null,
      nft: track.nft || null,
    },
  });
}

function _capTakeoverToPreview() {
  if (!_takeover) return;
  const queued = _takeoverQueue.length;
  _setActivity(`✨ More new songs arriving — 30-second previews (${queued} queued)`);
  _burst = true;
  if (_takeover.preview) return;
  _takeover.preview = true;
  const remaining = PREVIEW_MS - (performance.now() - _takeover.startedAt);
  _takeover.timer = setTimeout(_startNextTakeover, Math.max(0, remaining));
  _takeover.timer?.unref?.();
}

function _clearTakeover() {
  if (_takeover?.timer) clearTimeout(_takeover.timer);
  _takeover = null;
}

function _onEnded(event) {
  if (event?.target && event.target !== _audio) return;
  _broadcastNowPlayingStopped('ended');
  if (_mode === 'takeover') {
    _startNextTakeover();
  } else if (_mode === 'archive') {
    const continuation = _archiveSession?.onEnded;
    _archiveSession = null;
    if (continuation?.()) return;
    _radioBtn?.classList.add('hidden');
    _mode = 'radio';
    _notifyRadioSourceMode();
    _loadedPlayId = null;
    if (_takeoverQueue.length) _startNextTakeover();
    else _syncRadio('🎧 Archive track finished — back to the JukeLoop');
  } else {
    _radioHandoff = { endedAt: performance.now(), previousPlayId: _loadedPlayId };
    _setActivity(_upNext?.title ? `📻 Up next: ${_upNext.title}` : '📻 Waiting for the JukeLoop’s next track…');
    clearTimeout(_pollTimer);
    _pollTimer = setTimeout(_poll, HANDOFF_POLL_MS);
    _pollTimer?.unref?.();
  }
}

// ── Audio element control ─────────────────────────────────────────────────

function _buildIpfsGatewayUrl(gateway, cid) {
  const [rawBase, ...queryParts] = String(gateway).split('?');
  const base = rawBase.replace(/\/+$/, '');
  const ipfsBase = /\/ipfs$/i.test(base) ? base : `${base}/ipfs`;
  return `${ipfsBase}/${cid}${queryParts.length ? `?${queryParts.join('?')}` : ''}`;
}

function _gatewayUrls(cid) {
  const cfg = window.DecentConfig || {};
  const worker = (cfg.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  return [...new Set([
    ...(worker ? [`${worker}/api/radio/media?cid=${encodeURIComponent(cid)}`] : []),
    _buildIpfsGatewayUrl(cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/', cid),
  ])];
}

function _gatewayUrl(cid) {
  return _gatewayUrls(cid)[0];
}

async function _switchTo({ title, artist, url, fallbackUrls = [], mime = _mimeType(url), offset = () => 0, nowPlaying = null, preloadCid = null }) {
  const token = ++_switchToken;
  const switchStartedAt = performance.now();
  _setTrack(title, artist);
  const preloaded = preloadCid && _preload?.cid === preloadCid ? await _takePreload(preloadCid) : null;
  if (token !== _switchToken) {
    if (preloaded?.blobUrl) URL.revokeObjectURL(preloaded.blobUrl);
    return;
  }
  const mediaUrl = preloaded?.blobUrl || url;
  let canSeekImmediately = false;

  _broadcastNowPlayingStopped('switching');
  _pauseAudio();
  _fadeLevel = 0;
  const previous = _audio;
  _audioPlayer ||= previous;
  _audio = mime === 'video/mp4' && _videoPlayer ? _videoPlayer : _audioPlayer;
  if (previous !== _audio) {
    previous.removeAttribute('src');
    previous.querySelectorAll('source').forEach(source => source.remove());
    previous.load();
  }
  _pauseAudio();
  _renderVideo();
  _applyRadioVolume();
  if (_audio) _audio.crossOrigin = 'anonymous';
  _audio.preload = 'auto';
  _releaseActiveBlob(preloaded?.blobUrl || null);

  const candidates = [...new Set([mediaUrl, ...(preloaded ? [url] : []), ...fallbackUrls].filter(Boolean))];
  let activeUrl = mediaUrl;
  let loaded = false;
  for (const candidate of candidates) {
    if (token !== _switchToken) return;
    activeUrl = candidate;
    _audio.removeAttribute('src');
    _audio.querySelectorAll('source').forEach((source) => source.remove());
    // A direct src exposes MediaError on the player; child <source> errors can hide decoder failures.
    _audio.src = candidate;
    const metadataReady = _waitForMetadata(candidate === url ? LOAD_TIMEOUT_MS : GATEWAY_RETRY_TIMEOUT_MS);
    _audio.load();
    const result = await metadataReady;
    loaded = result.loaded;
    if (!loaded && token === _switchToken) {
      console.warn('[radio] Media load failed:', { url: candidate, mime, ...result });
      if (result.reason === 'unsupported') {
        _reportLoadFailure('unsupported', nowPlaying);
        return;
      }
    }
    if (loaded) break;
  }
  if (token !== _switchToken) return;
  if (!loaded) {
    _reportLoadFailure('network', nowPlaying);
    return;
  }
  const at = offset();
  const broadcastUrl = activeUrl === mediaUrl ? (nowPlaying?.audioUrl || activeUrl) : activeUrl;
  if (at > 0) canSeekImmediately = _seekTo(at);
  _broadcastNowPlaying(nowPlaying ? {
    ...nowPlaying,
    audioUrl: broadcastUrl,
    videoUrl: mime === 'video/mp4' && activeUrl !== mediaUrl ? activeUrl : (nowPlaying.videoUrl || ''),
  } : {
    source: _mode,
    title,
    artist,
    audioUrl: broadcastUrl,
    mediaType: mime || _mimeType(url),
    videoUrl: mime === 'video/mp4' ? broadcastUrl : '',
    nft: nowPlaying?.nft ?? null,
  });

  try {
    try {
      await _audio.play();
    } catch (error) {
      // Browsers may block audible autoplay; start archive previews muted so the
      // listener can unmute from the NFT card instead of losing the preview.
      if (_mode !== 'archive' || _archiveMuted || error?.name !== 'NotAllowedError' || token !== _switchToken) throw error;
      setArchiveMuted(true);
      await _audio.play();
    }
    _blocked = false;
    _playBtn?.classList.add('hidden');
  } catch (error) {
    if (token !== _switchToken) return;
    if (error?.name !== 'NotAllowedError') {
      console.warn('[radio] Playback failed:', error);
      _reportLoadFailure(error?.name === 'NotSupportedError' ? 'unsupported' : 'network', nowPlaying);
      return;
    }
    _blocked = true;
    _playBtn?.classList.remove('hidden');
    _maybePreload();
    return;
  }
  if (token !== _switchToken) return;
  if (_mode === 'radio' && _radio?.playId === nowPlaying?.playId) _radioLoadFailure = null;
  _recordTransition({
    source: nowPlaying?.source || _mode,
    title,
    media: preloaded ? 'preload' : 'network',
    startupMs: Math.round(performance.now() - switchStartedAt),
    startedAtS: Math.round(at * 10) / 10,
    liveBehindS: _mode === 'radio' && _radio ? Math.round((_radioPositionS() - at) * 10) / 10 : null,
  });
  if (at > 0) {
    const seek = _prepareRadioSeek(offset, token);
    if (canSeekImmediately) {
      if (!await seek && token === _switchToken) {
        _setActivity('📻 Playing while the audio gateway catches up with this track');
      }
    } else {
      seek.then((synced) => {
        if (!synced && token === _switchToken) {
          _setActivity('📻 Playing while the audio gateway catches up with this track');
        }
      }).catch(() => {});
    }
  }
  if (_fadeNextRadioSwitch) {
    _fadeNextRadioSwitch = false;
    await _fadeIn(token);
  } else {
    _fadeLevel = 1;
    _applyRadioVolume();
  }
}

async function _prepareRadioSeek(offset, token) {
  const deadline = performance.now() + LOAD_TIMEOUT_MS;
  while (token === _switchToken && performance.now() < deadline) {
    const target = offset();
    if (Number.isFinite(_audio.duration) && target >= _audio.duration - 1) return false;
    if (!_audio.seeking && _audio.readyState >= 3 && Math.abs(_audio.currentTime - target) <= 0.75) return true;
    if (_seekTo(target)) {
      while ((_audio.seeking || _audio.readyState < 3) && token === _switchToken && performance.now() < deadline) {
        await new Promise((resolve) => { const timer = setTimeout(resolve, 40); timer.unref?.(); });
      }
      if (token !== _switchToken) return false;
      if (performance.now() >= deadline) break;
    }
    await new Promise((resolve) => { const timer = setTimeout(resolve, 40); timer.unref?.(); });
  }
  if (token === _switchToken) {
    _loadedPlayId = null;
    _setActivity('Waiting for the audio gateway to sync this track…');
  }
  return false;
}

// Gateways without HTTP range support restart from 0 on seek, so only seek inside seekable ranges.
function _seekTo(seconds) {
  if (!Number.isFinite(_audio.duration) || seconds >= _audio.duration - 1) return false;
  const ranges = _audio.seekable;
  for (let i = 0; i < ranges.length; i += 1) {
    if (seconds >= ranges.start(i) && seconds <= ranges.end(i)) {
      _audio.currentTime = seconds;
      return true;
    }
  }
  return false;
}

function _reportLoadFailure(reason, nowPlaying) {
  _blocked = false;
  _playBtn?.classList.add('hidden');
  _broadcastNowPlayingStopped('load-failed');
  const isLive = _mode === 'radio' && _radio?.playId && _radio.playId === nowPlaying?.playId;
  if (reason === 'unsupported') {
    if (isLive) {
      _loadedPlayId = null;
      _radioLoadFailure = { playId: _radio.playId, retryAt: Infinity, attempts: 1 };
      _discardPreload();
    }
    console.warn('[radio] This browser cannot decode the recording.', { playId: nowPlaying?.playId });
    _setActivity('');
    return;
  }
  if (isLive) {
    _loadedPlayId = null;
    const attempts = (_radioLoadFailure?.playId === _radio.playId ? _radioLoadFailure.attempts : 0) + 1;
    const retrying = attempts < RADIO_LOAD_MAX_ATTEMPTS;
    _radioLoadFailure = {
      playId: _radio.playId, attempts,
      retryAt: retrying ? performance.now() + RADIO_LOAD_RETRY_MS * attempts : Infinity,
    };
    _discardPreload();
    _setActivity(retrying
      ? '⚠️ Audio could not be loaded from the media gateways — retrying shortly.'
      : '⚠️ Audio is still unavailable after several attempts — waiting for the next song.');
    return;
  }
  _setActivity('⚠️ Audio could not be loaded from the media gateways — try this recording again shortly.');
}

function _waitForMetadata(timeoutMs = LOAD_TIMEOUT_MS) {
  const player = _audio;
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      player.removeEventListener('loadedmetadata', onLoaded);
      player.removeEventListener('error', onError, true);
      resolve(result);
    };
    const onLoaded = () => finish({ loaded: true });
    const onError = () => {
      const error = player.error;
      // Code 4 can also mean an HTTP error; only call it unsupported with explicit decoder evidence.
      const unsupported = error?.code === 3 ||
        /DEMUXER_ERROR_NO_SUPPORTED_STREAMS|DECODER_ERROR_NOT_SUPPORTED|unsupported codec/i.test(error?.message || '');
      finish({ loaded: false, reason: unsupported ? 'unsupported' : 'network', code: error?.code, message: error?.message });
    };
    const timer = setTimeout(() => finish({ loaded: false, reason: 'timeout' }), timeoutMs);
    timer.unref?.();
    player.addEventListener('loadedmetadata', onLoaded);
    player.addEventListener('error', onError, true);
  });
}

// ── Next-track preloading ───────────────────────────────────────────────────
// The gateway can take several seconds to send its first byte, so the published next
// item is downloaded during the current song and played from memory at the changeover.

function _preloadAllowed() {
  const connection = globalThis.navigator?.connection;
  return _mode === 'radio' && _devertListenMode === 'radio' && !_blocked &&
    typeof fetch === 'function' && typeof globalThis.URL?.createObjectURL === 'function' && typeof Blob === 'function' &&
    connection?.saveData !== true && !/(^|-)2g$/.test(connection?.effectiveType || '');
}

function _maybePreload() {
  if (!_preloadAllowed()) {
    _discardPreload();
    return;
  }
  // A live item this browser has not started yet (still finishing the previous song) is needed first.
  const pendingLive = _radio?.ipfsCid && _radio.playId !== _loadedPlayId &&
    _radioLoadFailure?.playId !== _radio.playId ? _radio : null;
  const target = pendingLive || _upNext;
  const cid = target?.ipfsCid || null;
  if (_preload && _preload.cid !== cid) _discardPreload();
  if (!cid || _preload) return;
  _startPreload(target);
}

function _startPreload(track) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const entry = {
    cid: track.ipfsCid,
    title: track.title || '',
    mime: _mediaTypeForTrack(track),
    status: 'loading',
    blobUrl: null,
    bytes: 0,
    startedAt: performance.now(),
    controller,
    done: null,
  };
  _preload = entry;
  entry.done = (async () => {
    try {
      const response = await fetch(_gatewayUrl(entry.cid), { signal: controller?.signal, mode: 'cors' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers?.get?.('content-length'));
      if (declared > PRELOAD_MAX_BYTES) throw new Error(`file is ${_megabytes(declared)} MB, over the preload limit`);
      const chunks = [];
      const reader = response.body?.getReader?.();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          entry.bytes += value.byteLength;
          if (entry.bytes > PRELOAD_MAX_BYTES) {
            reader.cancel().catch(() => {});
            throw new Error('file is over the preload limit');
          }
          chunks.push(value);
        }
      } else {
        const buffer = await response.arrayBuffer();
        entry.bytes = buffer.byteLength;
        if (entry.bytes > PRELOAD_MAX_BYTES) throw new Error('file is over the preload limit');
        chunks.push(buffer);
      }
      if (entry.discarded) return;
      const type = entry.mime || response.headers?.get?.('content-type') || '';
      entry.blobUrl = URL.createObjectURL(new Blob(chunks, type ? { type } : {}));
      entry.status = 'ready';
      console.info(`[radio] Preloaded next track "${entry.title}" (${_megabytes(entry.bytes)} MB in ${((performance.now() - entry.startedAt) / 1000).toFixed(1)}s)`);
    } catch (error) {
      if (entry.discarded) return;
      entry.status = 'failed';
      entry.error = error?.message || String(error);
      console.warn(`[radio] Could not preload "${entry.title}"; it will stream when it starts:`, entry.error);
    }
  })();
}

function _discardPreload(entry = _preload) {
  if (!entry) return;
  if (_preload === entry) _preload = null;
  entry.discarded = true;
  try { entry.controller?.abort(); } catch {}
  if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
}

/** Hand the preloaded file for this CID to the player, waiting briefly if it is still downloading. */
async function _takePreload(cid) {
  const entry = _preload;
  if (!entry || entry.cid !== cid) return null;
  // Detach first so a poll that publishes the following item cannot discard this one mid-handoff.
  _preload = null;
  if (entry.status === 'loading') {
    let timer;
    await Promise.race([entry.done, new Promise((resolve) => { timer = setTimeout(resolve, PRELOAD_WAIT_MS); })]);
    clearTimeout(timer);
  }
  if (entry.status !== 'ready') {
    if (entry.status === 'loading') console.warn(`[radio] Preload of "${entry.title}" was not ready in time; streaming it instead`);
    _discardPreload(entry);
    return null;
  }
  return entry;
}

function _releaseActiveBlob(nextBlobUrl) {
  if (_activeBlobUrl && _activeBlobUrl !== nextBlobUrl) URL.revokeObjectURL(_activeBlobUrl);
  _activeBlobUrl = nextBlobUrl;
}

function _megabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function _recordTransition(entry) {
  const record = { at: new Date().toISOString(), ...entry };
  _transitionLog.push(record);
  if (_transitionLog.length > 20) _transitionLog.shift();
  console.info('[radio] Track started', record);
}

/** Recent track-start timings (startup delay, preload use, start position) for diagnosing playback. */
export function getRadioTransitionDiagnostics() {
  return {
    transitions: _transitionLog.map(entry => ({ ...entry })),
    preload: _preload ? { cid: _preload.cid, title: _preload.title, status: _preload.status, bytes: _preload.bytes, error: _preload.error || null } : null,
  };
}

// Silence-to-music fade on every start; time-based steps keep it finishing in throttled background tabs.
function _fadeIn(token = _switchToken, ms = FADE_IN_MS) {
  _fadeLevel = 0;
  _applyRadioVolume();
  const start = performance.now();
  return new Promise((resolve) => {
    const step = () => {
      if (token !== _switchToken) return resolve();
      const t = Math.min(1, (performance.now() - start) / ms);
      // Squared ramp sounds even to the ear; a linear ramp jumps in loudness early.
      _fadeLevel = t * t;
      _applyRadioVolume();
      if (t < 1) {
        const timer = setTimeout(step, 40);
        timer.unref?.();
      }
      else resolve();
    };
    step();
  });
}

function _fadeMainRadioOut(ms = FADE_IN_MS) {
  const token = ++_switchToken;
  const initial = _fadeLevel;
  const startedAt = performance.now();
  const step = () => {
    if (token !== _switchToken || _devertListenMode !== 'ads-only') return;
    const progress = Math.min(1, (performance.now() - startedAt) / ms);
    _fadeLevel = initial * (1 - progress) ** 2;
    _applyRadioVolume();
    if (progress < 1) {
      const timer = setTimeout(step, 30);
      timer.unref?.();
    }
    else _pauseAudio();
  };
  step();
}

function _stopAudio() {
  ++_switchToken;
  _broadcastNowPlayingStopped('stopped');
  _pauseAudio();
  if (_videoStage) _videoStage.hidden = true;
  _videoToggle?.classList.add('hidden');
}

async function _unlock() {
  _fadeLevel = 1;
  _applyRadioVolume();
  try {
    await _audio.play();
  } catch (err) {
    console.warn('[radio] Manual play failed:', err.message);
    return;
  }
  _blocked = false;
  _playBtn?.classList.add('hidden');
  if (_mode === 'radio' && _radio) {
    const target = _radioPositionS();
    if (target > 0) {
      const canSeekImmediately = _seekTo(target);
      const seek = _prepareRadioSeek(_radioPositionS, _switchToken);
      if (canSeekImmediately) {
        if (!await seek) {
          _setActivity('📻 Playing while the audio gateway catches up with this track');
        }
      } else {
        seek.then((synced) => {
          if (!synced) _setActivity('📻 Playing while the audio gateway catches up with this track');
        }).catch(() => {});
      }
    }
  }
}

// ── Banner text ───────────────────────────────────────────────────────────

function _setLabel(text) {
  if (_labelEl) _labelEl.textContent = text;
}

function _setTrack(title, artist) {
  if (_titleEl) _titleEl.textContent = title || '—';
  if (_artistEl) _artistEl.textContent = artist || '';
}

function _setActivity(text) {
  if (/in sync with|mirroring the Discord JukeLoop/i.test(text)) text = '';
  if (!_activityEl) return;
  const message = _blocked ? `${text} · tap ▶ Tune in to listen` : text;
  _activityEl.hidden = !message;
  if (_activityEl.textContent === message) return;
  _activityEl.textContent = message;
  _activityEl.title = message;
  _activityEl.classList.remove('radio-activity-flash');
  void _activityEl.offsetWidth;
  _activityEl.classList.add('radio-activity-flash');
}

function _mimeType(name) {
  const ext = name.split('?')[0].split('/').pop().split('.').slice(1).pop()?.toLowerCase() || '';
  return { mp3: 'audio/mpeg', mp4: 'video/mp4', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm' }[ext] || '';
}
