import { parseReleaseSheet, prepareRelease, releaseAuthorization, MAX_RELEASE_TRACKS } from './release-batch.mjs';
import { createBrowserIpfsUploader } from './ipfs-upload.js?v=20261015-mime-sniff';
import { SUBMISSION_MEDIA_TYPES as formats } from './submission-media.mjs';

async function droppedFiles(transfer) {
  const entries = Array.from(transfer.items, item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(transfer.files, file => ({ file, path: file.name }));
  const files = [];
  let scanned = 0;
  async function walk(entry) {
    if (++scanned > 500) throw Error('Drop at most 500 files and folders at a time');
    if (entry.isFile) {
      if (!Object.hasOwn(formats, entry.name.split('.').pop().toLowerCase())) return;
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push({ file, path: entry.fullPath });
      if (files.length > MAX_RELEASE_TRACKS) throw Error('Select fewer recordings');
    } else {
      const reader = entry.createReader();
      while (true) {
        const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        for (const child of children) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return files;
}

export function mountReleaseBriefcase(root, { inspectMedia, fileCid, lock }) {
  if (!root) return;
  const field = name => root.querySelector(`[data-release-${name}]`);
  const rows = field('rows'), status = field('status'), files = new Map(), cache = new Map();
  let serial = 0, working = false;
  function add(items) {
    if (working) return;
    const lines = [], next = [];
    for (const { file, path } of items) {
      const format = file.name.split('.').pop().toLowerCase();
      if (!Object.hasOwn(formats, format)) continue;
      if (file.size > 50 * 1024 * 1024 || !file.size) throw Error(`${file.name}: use a file CID for media over 50 MB; empty files are not accepted`);
      const album = path.split('/').filter(Boolean).at(-2) || field('album').value.trim();
      const title = file.name.slice(0, -(format.length + 1));
      if (/[|\r\n]/.test(album + title)) throw Error('Rename files/folders containing a pipe or newline before adding');
      const ref = `file:${++serial}`;
      lines.push([album, title, format, ref].join(' | ')); next.push([ref, file]);
    }
    if (!lines.length) throw Error('No supported audio or video files found');
    const value = [rows.value.trim(), ...lines].filter(Boolean).join('\n');
    prepareRelease(parseReleaseSheet(value), id => id.startsWith('file:') ? id : fileCid(id), formats);
    for (const [ref, file] of next) files.set(ref, file);
    rows.value = value; status.textContent = 'Review album names, titles and track order above.';
  }
  for (const name of ['files', 'folder']) field(name).addEventListener('change', event => {
    try { add(Array.from(event.target.files, file => ({ file, path: file.webkitRelativePath || file.name }))); }
    catch (error) { status.textContent = error.message; }
    event.target.value = '';
  });
  field('drop').addEventListener('dragover', e => e.preventDefault());
  field('drop').addEventListener('drop', async e => {
    e.preventDefault();
    try { add(await droppedFiles(e.dataTransfer)); } catch (error) { status.textContent = error.message; }
  });
  field('submit').addEventListener('click', async () => {
    if (working || !lock(true)) return;
    working = true;
    root.querySelector('fieldset').disabled = true;
    try {
      const { signer, address } = window._wallet || {}, cfg = window.DecentConfig;
      if (!signer || !address) throw Error('Connect your artist wallet first');
      const artist = field('artist').value.trim() || address;
      const artworkCid = field('cover').value.trim() ? fileCid(field('cover').value) : '';
      const items = parseReleaseSheet(rows.value);
      const tracks = prepareRelease(items, id => files.has(id) ? id : fileCid(id), formats);
      const serviceUrl = cfg.ipfsUploadServiceUrl, origin = window.location.origin;
      const upload = createBrowserIpfsUploader({ provider: cfg.ipfsUploadProvider || 'pinata', serviceUrl,
        ipfsApiUrl: cfg.ipfsApiUrl, signer, address, origin, purpose: 'submission' });
      for (const track of tracks) {
        const file = files.get(track.cid);
        status.textContent = `Checking ${track.title}…`;
        const detected = await inspectMedia({ file, cid: file ? '' : track.cid, serviceUrl });
        if (detected.mediaType !== formats[track.format]) throw Error(`${track.title}: media does not match ${track.format}`);
        if (file && !cache.has(track.cid)) {
          status.textContent = `Uploading ${track.title}…`;
          cache.set(track.cid, fileCid(await upload(new File([file], detected.filename, { type: detected.mediaType }))));
          rows.value = items.map(r => [r.album, r.title, r.format, cache.get(r.cid) || r.cid].join(' | ')).join('\n');
        }
      }
      const resolved = items.map(row => ({ ...row, cid: cache.get(row.cid) || fileCid(row.cid) }));
      rows.value = resolved.map(r => [r.album, r.title, r.format, r.cid].join(' | ')).join('\n');
      const payload = { address, artist, artworkCid, rows: resolved, origin, issuedAt: new Date().toISOString() };
      status.textContent = `Review and sign the ${tracks.length}-recording submission. No mint transaction.`;
      const signature = await signer.signMessage(releaseAuthorization(payload));
      const res = await fetch(`${serviceUrl.replace(/\/$/, '')}/api/media/submit-batch`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, signature }), signal: AbortSignal.timeout(90000) });
      const reply = await res.json();
      if (!res.ok || !Array.isArray(reply.results)) throw Error(reply.error || `Batch unavailable (${res.status})`);
      status.textContent = reply.results.map(t => `${t.already ? 'Already ' : ''}${t.status}: ${t.title} · ${t.trackId}`).join('\n');
    } catch (error) { status.textContent = `Batch: ${error.message}`; }
    finally { root.querySelector('fieldset').disabled = false; working = false; lock(false); }
  });
}
