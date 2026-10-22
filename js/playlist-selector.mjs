export function appendPlaylistSong(items, item) {
  if (items.some(song => song.songId.toLowerCase() === item.songId.toLowerCase())) return [...items];
  if (items.length >= 24) throw new Error('Named playlists hold up to 24 songs. Remove a song before adding another.');
  return [...items, item];
}

export function openPlaylistSelector({ anchor, playlists = [], choose, status = () => {} }) {
  document.querySelector('.playlist-selector')?.remove();
  const panel = document.createElement('div');
  panel.className = 'playlist-selector';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Add song to playlist');
  const heading = document.createElement('strong');
  heading.textContent = 'Add to playlist';
  panel.append(heading);
  const add = (label, action) => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { if (await action() !== false) { panel.remove(); anchor?.focus(); } }
      catch (error) { message.textContent = error.message; status(error.message); }
      finally { button.disabled = false; }
    });
    panel.append(button);
    return button;
  };
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  add('Current draft', () => choose(null));
  for (const playlist of playlists) add(`${playlist.name} · ${playlist.songIds.length}/24`, () => choose(playlist));
  const name = document.createElement('input');
  name.maxLength = 60; name.placeholder = 'New playlist name'; name.hidden = true;
  name.setAttribute('aria-label', 'New playlist name');
  add('➕ New playlist…', () => {
    name.hidden = false; create.hidden = false; name.focus();
    return false;
  });
  panel.append(name);
  const create = add('Create playlist', async () => {
    if (!name.value.trim()) throw new Error('Enter a playlist name.');
    await choose(null, name.value.trim());
  });
  create.hidden = true;
  add('Cancel', () => {});
  panel.append(message);
  panel.addEventListener('click', event => event.stopPropagation());
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); panel.remove(); anchor?.focus(); } });
  document.body.append(panel);
  const rect = anchor?.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(rect?.left ?? 24, window.innerWidth - 290))}px`;
  panel.style.top = `${Math.max(8, Math.min(rect?.bottom ?? 100, window.innerHeight - panel.offsetHeight - 12))}px`;
  panel.querySelector('button')?.focus();
  return panel;
}
