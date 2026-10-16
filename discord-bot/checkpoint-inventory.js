import 'dotenv/config';
import { pathToFileURL } from 'node:url';

const CHECKPOINT_NAMES = new Set([
  'decentbusking-jukeloop-state.json', 'decentbusking-main-radio-ad-state.json',
  'decentbusking-devert-main-radio.json', 'decentbusking-devert-removals.json',
  'decentbusking-creator-profiles.json', 'decentbusking-artwork-updates.json',
  'decentbusking-rpc-usage.json', 'decentbusking-payment-ledger.json',
  'decentbusking-weekly-payflow.json', 'decentbusking-fund-ledger.json',
  'decentbusking-earnings-index.json', 'decentbusking-djuke-journal.json',
  'decentbusking-live-schedule.json',
]);

export async function inventoryCheckpoints({ pinataJwt, fetchImpl = fetch,
  filesApiUrl = 'https://api.pinata.cloud/v3/files/public' }) {
  if (!pinataJwt) throw new Error('PINATA_JWT is required for a read-only checkpoint inventory');
  const files = [];
  const seen = new Set();
  let token;
  do {
    const url = new URL(filesApiUrl);
    url.searchParams.set('name', 'decentbusking-');
    url.searchParams.set('order', 'DESC');
    url.searchParams.set('limit', '100');
    if (token) url.searchParams.set('pageToken', token);
    const response = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${pinataJwt}` },
      signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Pinata inventory listing failed (${response.status}); no files changed`);
    const result = await response.json();
    if (!Array.isArray(result.data?.files)) throw new Error('Invalid Pinata inventory listing');
    files.push(...result.data.files);
    token = result.data.next_page_token;
    if (token && seen.has(token)) throw new Error('Pinata inventory repeated a page token');
    if (token) seen.add(token);
  } while (token);
  const checkpoints = files.filter(file => CHECKPOINT_NAMES.has(file.name) &&
    file.mime_type === 'application/json' && file.keyvalues?.app === 'decentbusking');
  const byName = checkpoints.reduce((groups, file) => {
    if (!groups.has(file.name)) groups.set(file.name, []);
    groups.get(file.name).push(file);
    return groups;
  }, new Map());
  return { dryRun: true, generatedAt: new Date().toISOString(), listedFiles: files.length,
    checkpointFiles: checkpoints.length, untouchedFiles: files.length - checkpoints.length,
    groups: [...byName].map(([name, entries]) => {
      entries.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const describe = file => ({ id: file.id, cid: file.cid, createdAt: file.created_at,
        size: file.size, groupId: file.group_id || null });
      return { name, count: entries.length, keep: entries.slice(0, 5).map(describe),
        reviewBeforeRemoval: entries.slice(5).map(describe) };
    }),
    warning: 'No files changed. Before deletion, verify cumulative state, referenced proof CIDs and recovery baselines; archive legacy history separately. This inventory is not deletion approval.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inventoryCheckpoints({ pinataJwt: process.env.PINATA_JWT })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
