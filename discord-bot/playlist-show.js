import { previewRadioPlaylist, radioPlaylistDefinition, playlistTrackReason } from '../js/radio-playlists.mjs';

export function validatePlaylistShowSnapshot(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.occurrences) || value.occurrences.length > 100) throw new Error('Invalid playlist-show checkpoint');
  const ids = new Set();
  for (const state of value.occurrences) {
    radioPlaylistDefinition(state.playlistId);
    if (typeof state.instanceId !== 'string' || !state.instanceId || ids.has(state.instanceId) ||
      !Number.isFinite(Date.parse(state.capturedAt)) || !Number.isFinite(Date.parse(state.startAt)) ||
      !(Date.parse(state.endAt) > Date.parse(state.startAt)) ||
      !Array.isArray(state.tracks) || state.tracks.length > 10000 || state.tracks.some(track => !track?.trackId || typeof track.trackId !== 'string') ||
      new Set(state.tracks.map(track => track.trackId)).size !== state.tracks.length ||
      !Number.isSafeInteger(state.cursor) || state.cursor < 0 || state.cursor > state.tracks.length ||
      !Array.isArray(state.skipped) || state.skipped.some(item => !state.tracks.some(track => track.trackId === item.trackId) || typeof item.reason !== 'string')) {
      throw new Error('Invalid playlist-show occurrence');
    }
    ids.add(state.instanceId);
  }
  return structuredClone(value);
}

export function createPlaylistShow({ store, now = () => Date.now(), random = Math.random } = {}) {
  let snapshot = { schemaVersion: 1, occurrences: [] };
  let initialized = false;
  let pending = null;
  let pendingShuffled = false;
  let error = '';
  let task = Promise.resolve();
  const exclusive = operation => {
    const result = task.then(operation, operation);
    task = result.catch(failure => { error = failure.message; });
    return result;
  };
  const find = id => snapshot.occurrences.find(item => item.instanceId === id);
  async function save(next) {
    if (!store) throw new Error('Durable playlist-show storage unavailable; normal rotation continues');
    const valid = validatePlaylistShowSnapshot(next);
    const uri = await store.save(valid);
    if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Playlist-show checkpoint unconfirmed; normal rotation continues');
    snapshot = valid;
    error = '';
  }
  const api = {
    ensure(show, catalog) {
      return exclusive(async () => {
        if (find(show.instanceId)) {
          if (error) await save(snapshot);
          return;
        }
        if (pending?.instanceId !== show.instanceId) {
          const preview = previewRadioPlaylist(show.playlistId, catalog);
          const tracks = [...preview.tracks];
          pendingShuffled = false;
          pending = { instanceId: show.instanceId, playlistId: show.playlistId, playlistRevision: preview.revision, capturedAt: new Date(now()).toISOString(),
            startAt: show.startAt, endAt: show.endAt, tracks, cursor: 0, skipped: [], unknownCount: preview.unknownCount };
        }
        if (!initialized) {
          const restored = store ? await store.restore() : null;
          if (restored) snapshot = validatePlaylistShowSnapshot(restored);
          initialized = true;
        }
        if (find(show.instanceId)) {
          pending = null;
          if (error) await save(snapshot);
          return;
        }
        if (!pendingShuffled) {
          for (let index = pending.tracks.length - 1; index > 0; index--) {
            const swap = Math.floor(random() * (index + 1));
            [pending.tracks[index], pending.tracks[swap]] = [pending.tracks[swap], pending.tracks[index]];
          }
          pendingShuffled = true;
        }
        await save({ schemaVersion: 1, occurrences: [...snapshot.occurrences.slice(-99), pending] });
        pending = null;
      });
    },
    async next(show, catalog) {
      await api.ensure(show, catalog);
      let state = find(show.instanceId);
      while (state.cursor < state.tracks.length) {
        const entry = state.tracks[state.cursor];
        const track = catalog.find(item => item.trackId === entry.trackId);
        const selection = { ...entry, instanceId: state.instanceId, cursor: state.cursor, totalTracks: state.tracks.length,
          playlistId: state.playlistId, title: show.label, track };
        const reason = playlistTrackReason(track, radioPlaylistDefinition(state.playlistId));
        if (!reason) return selection;
        await api.advance(selection, reason);
        state = find(show.instanceId);
      }
      return null;
    },
    advance(selection, reason = null) {
      return exclusive(async () => {
        const state = find(selection.instanceId);
        if (!state || state.cursor !== selection.cursor) throw new Error('Playlist-show position changed');
        const next = { ...state, cursor: state.cursor + 1,
          ...(reason ? { skipped: [...state.skipped, { trackId: selection.trackId, reason }] }
            : { lastStarted: { trackId: selection.trackId, at: new Date(now()).toISOString() } }) };
        await save({ ...snapshot, occurrences: snapshot.occurrences.map(item => item === state ? next : item) });
      });
    },
    recordSkip(selection, reason) {
      return exclusive(async () => {
        const state = find(selection.instanceId);
        if (!state) throw new Error('Playlist-show occurrence missing');
        await save({ ...snapshot, occurrences: snapshot.occurrences.map(item => item !== state ? item :
          { ...state, skipped: [...state.skipped, { trackId: selection.trackId, reason }] }) });
      });
    },
    publicState(show) {
      if (show.type !== 'playlist_show') return null;
      const state = find(show.instanceId);
      const fallbackReason = error || (!state ? 'Preparing opening snapshot' : !state.tracks.length ? 'Empty eligible pool' :
        state.cursor >= state.tracks.length ? 'Eligible pool exhausted' : null);
      return { ...(state ? structuredClone(state) : { instanceId: show.instanceId, tracks: [] }),
        lateSnapshot: state ? Date.parse(state.capturedAt) - Date.parse(state.startAt) > 15_000 : false,
        status: fallbackReason ? 'normal_rotation' : 'ready', fallbackReason, invitation: radioPlaylistDefinition(show.playlistId).invitation };
    },
  };
  return api;
}
