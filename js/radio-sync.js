// js/radio-sync.js — DecentBusking
// Mirrors the Discord JukeLoop voice channel in the Now Playing banner. New
// Discord uploads briefly take over the site radio for their first play, and
// archive selections mute the radio until the listener returns to it.

const POLL_MS = 8_000;
const FADE_IN_MS = 1_500;
const PREVIEW_MS = 30_000;
const DRIFT_TOLERANCE_S = 8;
const LOAD_TIMEOUT_MS = 20_000;

let _audio, _labelEl, _titleEl, _artistEl, _activityEl, _playBtn, _radioBtn;

/** @type {'radio'|'takeover'|'archive'} */
let _mode = 'radio';
let _radio = null;
let _radioReachable = true;
let _loadedPlayId = null;
let _seen = null;
let _seenSince = 0;
const _takeoverQueue = [];
let _takeover = null;
let _burst = false;
let _blocked = false;
let _switchToken = 0;
let _pollTimer = null;

export function initRadioSync() {
  _audio = document.getElementById('audio-player');
  _labelEl = document.getElementById('now-playing-label');
  _titleEl = document.getElementById('now-playing-title');
  _artistEl = document.getElementById('now-playing-artist');
  _activityEl = document.getElementById('radio-activity');
  _playBtn = document.getElementById('now-playing-play-btn');
  _radioBtn = document.getElementById('now-playing-radio-btn');
  if (!_audio || !_radioUrl()) return;

  _audio.addEventListener('ended', _onEnded);
  _playBtn?.addEventListener('click', _unlock);
  _radioBtn?.addEventListener('click', returnToRadio);

  _setLabel('📻 Live on JukeLoop');
  _setActivity('⏳ Tuning in to the Discord JukeLoop…');
  _poll();
}

/** Play a user-selected archive track; the radio stays muted until returnToRadio(). */
export function playArchiveTrack({ title, artist, audioUrl }) {
  if (!_audio) return;
  if (_takeover) _takeoverQueue.unshift(_takeover.track);
  _clearTakeover();
  _burst = _takeoverQueue.length > 1;
  _mode = 'archive';
  _loadedPlayId = null;
  _setLabel('🎧 From the Archive');
  _radioBtn?.classList.remove('hidden');
  _setActivity('🎧 Playing from the archive — the radio is muted here');
  _switchTo({ title, artist, url: audioUrl });
}

export function returnToRadio() {
  if (_mode !== 'archive') return;
  _radioBtn?.classList.add('hidden');
  _mode = 'radio';
  _loadedPlayId = null;
  if (_takeoverQueue.length) _startNextTakeover();
  else _syncRadio('📻 Back in sync with the Discord JukeLoop');
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
    _radio = state.nowPlaying ? { ...state.nowPlaying, receivedAt: performance.now() } : null;
    _detectNewUploads(Array.isArray(state.recent) ? state.recent : [], state.serverTime);
    if (_mode === 'radio') _syncRadio();
  } catch (err) {
    console.warn('[radio] Could not reach the JukeLoop radio:', err.message);
    if (_radioReachable && _mode === 'radio') {
      _setActivity('📴 Can’t reach the JukeLoop radio right now — retrying…');
    }
    _radioReachable = false;
  }
  _pollTimer = setTimeout(_poll, POLL_MS);
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
  } else if (_mode === 'archive') {
    const count = _takeoverQueue.length;
    _setActivity(`✨ ${count} new song${count === 1 ? '' : 's'} posted in Discord — return to the radio to hear ${count === 1 ? 'it' : 'them'}`);
  } else {
    _startNextTakeover();
  }
}

// ── Radio mirroring ───────────────────────────────────────────────────────

function _radioPositionS() {
  return (_radio.positionMs + (performance.now() - _radio.receivedAt)) / 1000;
}

function _syncRadio(message) {
  _setLabel('📻 Live on JukeLoop');
  if (!_radio) {
    if (_loadedPlayId || !_audio.paused) _stopAudio();
    _loadedPlayId = null;
    _setTrack('—', '');
    _setActivity(message || '🌙 The JukeLoop is between tracks — waiting for the next song');
    return;
  }

  if (_radio.playId === _loadedPlayId) {
    const expected = _radioPositionS();
    if (!_audio.paused && Math.abs(_audio.currentTime - expected) > DRIFT_TOLERANCE_S) _seekTo(expected);
    return;
  }

  _loadedPlayId = _radio.playId;
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
    mime: _mimeType(_radio.filename || ''),
    offset: () => (_radio ? _radioPositionS() : 0),
  });
}

// ── New-upload takeovers ──────────────────────────────────────────────────

function _startNextTakeover() {
  _clearTakeover();
  const track = _takeoverQueue.shift();
  if (!track) {
    _burst = false;
    _mode = 'radio';
    _loadedPlayId = null;
    _syncRadio('📻 Back to mirroring the Discord JukeLoop');
    return;
  }

  _mode = 'takeover';
  if (_takeoverQueue.length > 0) _burst = true;
  const preview = _burst;
  const queued = _takeoverQueue.length;
  _takeover = { track, preview, startedAt: performance.now(), timer: null };
  _setLabel('✨ New Song');
  _setActivity(preview
    ? `✨ New song NFTs are pouring in — 30-second preview (${queued ? `${queued} more queued` : 'last one, then back to the JukeLoop'})`
    : '✨ New song posted in Discord — its first play is here, then back to the JukeLoop');
  if (preview) _takeover.timer = setTimeout(_startNextTakeover, PREVIEW_MS);
  _switchTo({
    title: track.title,
    artist: track.uploader,
    url: _gatewayUrl(track.ipfsCid),
    mime: _mimeType(track.filename || ''),
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
}

function _clearTakeover() {
  if (_takeover?.timer) clearTimeout(_takeover.timer);
  _takeover = null;
}

function _onEnded() {
  if (_mode === 'takeover') {
    _startNextTakeover();
  } else if (_mode === 'archive') {
    _radioBtn?.classList.add('hidden');
    _mode = 'radio';
    _loadedPlayId = null;
    if (_takeoverQueue.length) _startNextTakeover();
    else _syncRadio('🎧 Archive track finished — back to the JukeLoop');
  } else {
    _setActivity('📻 Waiting for the JukeLoop’s next track…');
    clearTimeout(_pollTimer);
    _pollTimer = setTimeout(_poll, 1_500);
  }
}

// ── Audio element control ─────────────────────────────────────────────────

function _gatewayUrl(cid) {
  const cfg = window.DecentConfig || {};
  const gateway = (cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/').replace(/\/?$/, '/');
  return `${gateway}${cid}`;
}

async function _switchTo({ title, artist, url, mime = _mimeType(url), offset = () => 0 }) {
  const token = ++_switchToken;
  _setTrack(title, artist);

  _audio.pause();
  _audio.volume = 0;
  _audio.removeAttribute('src');
  _audio.querySelectorAll('source').forEach((source) => source.remove());
  const source = document.createElement('source');
  source.src = url;
  if (mime) source.type = mime;
  _audio.appendChild(source);
  _audio.preload = 'auto';
  const metadataReady = _waitForMetadata();
  _audio.load();

  const loaded = await metadataReady;
  if (token !== _switchToken) return;
  if (!loaded) {
    _setActivity('⚠️ Couldn’t load this track from IPFS — waiting for the next one');
    return;
  }

  const at = offset();
  if (at > 0 && !await _prepareRadioSeek(offset, token)) return;

  try {
    await _audio.play();
    _blocked = false;
    _playBtn?.classList.add('hidden');
  } catch {
    _blocked = true;
    _playBtn?.classList.remove('hidden');
    return;
  }
  await _fadeIn(token);
}

async function _prepareRadioSeek(offset, token) {
  const deadline = performance.now() + LOAD_TIMEOUT_MS;
  while (token === _switchToken && performance.now() < deadline) {
    const target = offset();
    if (Number.isFinite(_audio.duration) && target >= _audio.duration - 1) return false;
    if (_seekTo(target)) {
      while (_audio.seeking && token === _switchToken && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      if (token === _switchToken && !_audio.seeking) return true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
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

function _waitForMetadata() {
  return new Promise((resolve) => {
    const finish = (ok) => {
      clearTimeout(timer);
      _audio.removeEventListener('loadedmetadata', onLoaded);
      _audio.removeEventListener('error', onError, true);
      resolve(ok);
    };
    const onLoaded = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);
    _audio.addEventListener('loadedmetadata', onLoaded);
    _audio.addEventListener('error', onError, true);
  });
}

// Silence-to-music fade on every start; time-based steps keep it finishing in throttled background tabs.
function _fadeIn(token = _switchToken, ms = FADE_IN_MS) {
  _audio.volume = 0;
  const start = performance.now();
  return new Promise((resolve) => {
    const step = () => {
      if (token !== _switchToken) return resolve();
      const t = Math.min(1, (performance.now() - start) / ms);
      // Squared ramp sounds even to the ear; a linear ramp jumps in loudness early.
      _audio.volume = t * t;
      if (t < 1) setTimeout(step, 40);
      else resolve();
    };
    step();
  });
}

function _stopAudio() {
  ++_switchToken;
  _audio.pause();
}

async function _unlock() {
  _audio.volume = 0;
  if (_mode === 'radio' && _radio && !await _prepareRadioSeek(_radioPositionS, _switchToken)) return;
  try {
    await _audio.play();
  } catch (err) {
    console.warn('[radio] Manual play failed:', err.message);
    return;
  }
  _blocked = false;
  _playBtn?.classList.add('hidden');
  await _fadeIn();
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
  if (!_activityEl) return;
  const message = _blocked ? `${text} · tap ▶ Tune in to listen` : text;
  if (_activityEl.textContent === message) return;
  _activityEl.textContent = message;
  _activityEl.classList.remove('radio-activity-flash');
  void _activityEl.offsetWidth;
  _activityEl.classList.add('radio-activity-flash');
}

function _mimeType(name) {
  const ext = name.split('?')[0].split('/').pop().split('.').slice(1).pop()?.toLowerCase() || '';
  return { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm' }[ext] || '';
}
