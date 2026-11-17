export function renderAfterpartyChecklist(rows, { documentRef = globalThis.document } = {}) {
  if (!documentRef?.createElement || !Array.isArray(rows) || rows.length === 0) return null;
  const section = documentRef.createElement('details');
  section.className = 'live-afterparty-checklist';
  section.open = true;
  const summary = documentRef.createElement('summary');
  summary.textContent = 'Show, fee and recording status';
  const list = documentRef.createElement('ol');
  for (const row of rows) {
    const item = documentRef.createElement('li');
    item.setAttribute('data-state', row.state);
    const title = documentRef.createElement('strong');
    title.textContent = `${row.label}: ${row.text}`;
    item.append(title);
    if (row.detail) {
      const detail = documentRef.createElement('p');
      detail.textContent = row.detail;
      item.append(detail);
    }
    if (row.next) {
      const next = documentRef.createElement('p');
      next.className = 'live-afterparty-next';
      next.textContent = `Next: ${row.next}`;
      item.append(next);
    }
    for (const link of row.links || []) {
      const anchor = documentRef.createElement('a');
      anchor.href = link.href;
      anchor.rel = 'noopener noreferrer';
      anchor.target = '_blank';
      anchor.textContent = link.label;
      item.append(anchor);
    }
    list.append(item);
  }
  section.append(summary, list);
  return section;
}

export function renderCurtainCall(milestone, { documentRef = globalThis.document, celebrate } = {}) {
  if (milestone?.kind !== 'completion' || !milestone.id || !documentRef?.createElement ||
      typeof celebrate !== 'function') return null;
  const section = documentRef.createElement('details');
  section.className = 'live-curtain-call';
  const summary = documentRef.createElement('summary');
  summary.textContent = 'Your curtain call';
  const announcement = documentRef.createElement('output');
  announcement.className = 'live-curtain-announcement';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  const greeting = documentRef.createElement('h3');
  greeting.textContent = milestone.subtitle;
  const detail = documentRef.createElement('p');
  detail.textContent = 'Thank you for the music. Check your Profile for your separate fee and recording status.';
  const flourish = documentRef.createElement('div');
  flourish.className = 'live-curtain-flourish';
  flourish.setAttribute('aria-hidden', 'true');
  const replay = documentRef.createElement('button');
  replay.type = 'button';
  replay.textContent = 'Replay celebration';
  const dismiss = documentRef.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  const play = replayRequested => {
    const result = celebrate(milestone, { replay: replayRequested });
    if (!result.celebrated) return;
    section.open = true;
    announcement.textContent = `Curtain call: ${milestone.subtitle}`;
    const decoration = documentRef.createElement('span');
    decoration.textContent = '✦  ♫  ✧';
    flourish.replaceChildren(decoration);
  };
  replay.onclick = () => play(true);
  dismiss.onclick = () => { section.open = false; summary.focus(); };
  section.append(summary, announcement, flourish, greeting, detail, replay, dismiss);
  return { element: section, activate: () => play(false) };
}

export function renderRecordingReleaseParty(milestone, { documentRef = globalThis.document, celebrate } = {}) {
  if (milestone?.kind !== 'radio-release' || !milestone.id || !milestone.evidence?.trackId ||
      !['airing', 'aired', 'interrupted', 'retrying'].includes(milestone.state) ||
      typeof celebrate !== 'function' || !documentRef?.createElement) return null;
  const section = documentRef.createElement('section');
  section.className = 'live-release-party';
  section.setAttribute('aria-label', 'Your recording release party');
  const heading = documentRef.createElement('h3');
  heading.textContent = milestone.title;
  const name = documentRef.createElement('p');
  name.className = 'live-release-title';
  name.textContent = milestone.subtitle;
  const detail = documentRef.createElement('output');
  detail.setAttribute('role', 'status');
  detail.setAttribute('aria-live', 'polite');
  const states = { airing: 'Verified radio playback started for this exact recording.',
    aired: 'This recording completed its verified radio replay.',
    interrupted: 'Playback started, but completion is unverified.',
    retrying: 'Playback was interrupted; the retry waits for a safe radio slot.' };
  detail.textContent = `${states[milestone.state] || 'This recording reached radio.'}${milestone.partial ? ' This is a partial recording, not a complete set.' : ''} Payment and show completion are separate.`;
  const flourish = documentRef.createElement('div');
  flourish.className = 'live-curtain-flourish';
  flourish.setAttribute('aria-hidden', 'true');
  const links = documentRef.createElement('p');
  const addLink = (href, label) => {
    const link = documentRef.createElement('a');
    link.href = href; link.textContent = label;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    links.append(link);
  };
  addLink('index.html#radio', 'Open DBusk Radio');
  const { contractAddress, tokenId } = milestone.evidence;
  if (/^0x[0-9a-f]{40}$/i.test(contractAddress || '') && /^\d+$/.test(String(tokenId))) {
    addLink(`https://basescan.org/nft/${contractAddress}/${tokenId}`, 'View your recording NFT');
    addLink(`https://basescan.org/token/${contractAddress}`, 'View the collection');
  }
  const replay = documentRef.createElement('button');
  replay.type = 'button'; replay.textContent = 'Replay release celebration';
  const dismiss = documentRef.createElement('button');
  dismiss.type = 'button'; dismiss.textContent = 'Dismiss celebration';
  const play = requested => {
    if (!celebrate(milestone, { replay: requested }).celebrated) return;
    const stars = documentRef.createElement('span');
    stars.textContent = '✦  ♫  ✧  ♫  ✦';
    flourish.replaceChildren(stars);
  };
  replay.onclick = () => play(true);
  dismiss.onclick = () => { flourish.replaceChildren(); replay.focus(); };
  section.append(heading, name, flourish, detail, links, replay, dismiss);
  return { element: section, activate: () => play(false) };
}
