export function playlistTakeover(state) {
  const playlist = state?.nowPlaying?.djukePlaylist;
  if (!playlist || typeof playlist.name !== 'string' || !playlist.name.trim() || playlist.name.length > 60 ||
      !Number.isSafeInteger(playlist.songCount) || playlist.songCount < 1 || playlist.songCount > 24 ||
      !Number.isSafeInteger(playlist.remaining) || playlist.remaining < 1 || playlist.remaining > playlist.songCount) return null;
  // Older servers sent only a reservation-time remaining count; position is the live lane's place in the batch.
  const hasPosition = Number.isSafeInteger(playlist.position) && playlist.position >= 1 && playlist.position <= playlist.songCount;
  return { ...playlist, label: hasPosition
    ? `${playlist.name} · Play Live · Song ${playlist.position} of ${playlist.songCount}`
    : `${playlist.name} · Play Live · ${playlist.remaining} of ${playlist.songCount} songs remaining` };
}

export function createRadioPlaylistEffects({ scene, camera, readSpectrum, root = document, three = THREE }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const spectrum = new Uint8Array(128);
  const particles = [];
  const textures = ['♪', '♫', '🎈', '🧞'].map(symbol => {
    const canvas = root.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.font = '80px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#94e6ff';
    ctx.fillText(symbol, 64, 64);
    return new three.CanvasTexture(canvas);
  });
  const badge = root.getElementById('radio-playlist-takeover');
  let active = null;
  let mode = 'radio';
  let lastSpawn = 0;
  let lastEnergy = 0;
  const clear = () => {
    for (const particle of particles) { scene.remove(particle.sprite); particle.sprite.material.dispose(); }
    particles.length = 0;
  };
  const stateChanged = event => {
    active = playlistTakeover(event.detail);
    if (badge) { badge.hidden = !active || mode !== 'radio'; badge.textContent = active?.label || ''; }
    if (!active) clear();
  };
  const modeChanged = event => {
    mode = event.detail;
    if (badge) badge.hidden = !active || mode !== 'radio';
    if (mode !== 'radio') clear();
  };
  root.addEventListener('dbusk-radio-state', stateChanged);
  root.addEventListener('radio-source-mode-change', modeChanged);
  function update(now) {
    if (!active || mode !== 'radio' || root.hidden || reduced.matches) { clear(); return; }
    const live = readSpectrum(spectrum) === true;
    const energy = live ? spectrum.subarray(0, 16).reduce((sum, n) => sum + n, 0) / (16 * 255) : 0;
    const beat = energy > .16 && energy > lastEnergy * 1.08;
    lastEnergy = energy * .2 + lastEnergy * .8;
    if (beat && now - lastSpawn > 1800 && particles.length < 8) {
      const footer = root.querySelector('footer');
      const rect = footer?.getBoundingClientRect();
      if (rect) {
        const origin = new three.Vector3((rect.x + rect.width / 2) / innerWidth * 2 - 1,
          -(rect.y + 12) / innerHeight * 2 + 1, .8).unproject(camera);
        const sprite = new three.Sprite(new three.SpriteMaterial({
          map: textures[Math.floor(Math.random() * textures.length)], transparent: true, opacity: .35, depthWrite: false,
        }));
        sprite.position.copy(origin);
        sprite.scale.setScalar(.045);
        scene.add(sprite);
        particles.push({ sprite, origin, born: now, drift: (Math.random() - .5) * .09 });
        lastSpawn = now;
      }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i], age = (now - particle.born) / 1000;
      if (age > 14) {
        scene.remove(particle.sprite); particle.sprite.material.dispose(); particles.splice(i, 1);
      } else {
        particle.sprite.position.copy(particle.origin);
        particle.sprite.position.y += age * .025;
        particle.sprite.position.x += Math.sin(age * .5) * particle.drift;
        particle.sprite.position.z -= age * .012;
        particle.sprite.material.opacity = Math.min(age, 1) * (1 - age / 14) * .35;
      }
    }
  }
  return { update, dispose() {
    clear();
    textures.forEach(texture => texture.dispose());
    root.removeEventListener('dbusk-radio-state', stateChanged);
    root.removeEventListener('radio-source-mode-change', modeChanged);
  } };
}
