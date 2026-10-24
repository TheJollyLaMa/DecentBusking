export function audibleDjukeRequest(state) {
  const sponsor = state?.nowPlaying?.sponsor;
  return state?.playback?.status === 'playing' && sponsor?.kind === 'djuke' &&
    typeof sponsor.requestId === 'string' ? sponsor.requestId : null;
}

export function centerQueueRow(container, row, behavior = 'smooth') {
  const viewport = container.getBoundingClientRect();
  const bounds = row.getBoundingClientRect();
  const top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight,
    container.scrollTop + bounds.top + bounds.height / 2 - viewport.top - container.clientHeight / 2));
  container.scrollTo({ top, behavior });
}

export function mountDjukeQueueFocus({ queue, isOpen, root = document, initialState = null }) {
  let radio = initialState;
  let centered = null;
  const sync = ({ force = false } = {}) => {
    const requestId = audibleDjukeRequest(radio);
    let current = null;
    for (const row of queue.querySelectorAll('[data-djuke-request]')) {
      const active = row.dataset.djukeRequest === requestId;
      row.classList.toggle('is-now-playing', active);
      if (active) { row.setAttribute('aria-current', 'true'); current = row; }
      else row.removeAttribute('aria-current');
      const label = row.querySelector('[data-queue-song-status]');
      if (label) label.textContent = active ? '♫ On air' : row.dataset.state;
    }
    if (!requestId) centered = null;
    if (!current || !isOpen() || (!force && centered === requestId)) return;
    const behavior = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    const songs = current.closest('.djuke-playlist-songs');
    if (songs) centerQueueRow(songs, current, behavior);
    const visibleRow = songs?.closest('.djuke-playlist-queue') || current;
    const bounds = visibleRow.getBoundingClientRect(), viewport = queue.getBoundingClientRect();
    if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) centerQueueRow(queue, visibleRow, behavior);
    centered = requestId;
  };
  root.addEventListener('dbusk-radio-state', event => { radio = event.detail; sync(); });
  return { sync };
}
