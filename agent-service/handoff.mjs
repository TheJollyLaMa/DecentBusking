import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(directory);
const sourcePaths = [
  'README.md', 'WHITEPAPER.md', 'docs/NEWCOMERS.md', 'NOTICE',
  'js/wallet.js', 'js/admin-access.mjs',
];

export function readHandoff(base = directory) {
  const files = ['voice.md', 'boundaries.md', 'evaluation.json', 'sources.json'];
  const contents = files.map(file => readFileSync(path.join(base, 'handoff', file), 'utf8'));
  const digest = createHash('sha256').update(JSON.stringify(contents)).digest('hex');
  const snapshot = JSON.parse(contents[3]);
  if (!snapshot.commit || !Array.isArray(snapshot.sources) || !snapshot.sources.length) {
    throw new Error('Public-source snapshot is missing or invalid; run npm run snapshot -- <public commit>');
  }
  return {
    digest, instructions: `${contents[0]}\n\n${contents[1]}`,
    evaluation: JSON.parse(contents[2]), ...snapshot,
  };
}

export function isApproved(handoff, approvalFile) {
  try {
    const approval = JSON.parse(readFileSync(approvalFile, 'utf8'));
    return approval.digest === handoff.digest && typeof approval.reviewer === 'string' &&
      approval.reviewer.trim().length > 0 && Number.isFinite(Date.parse(approval.approvedAt));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function snapshot(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Supply an explicit 40-character public commit');
  const reachable = execFileSync('git', ['branch', '-r', '--contains', commit], { cwd: root, encoding: 'utf8' });
  if (!reachable.split('\n').some(line => line.trim() === 'origin/main')) {
    throw new Error('Snapshot must come from fetched public origin/main history, never a private worktree');
  }
  const sources = [];
  for (const file of sourcePaths) {
    const text = execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, encoding: 'utf8' });
    const lines = text.split('\n');
    for (let start = 0; start < lines.length; start += 45) {
      sources.push({
        id: `source-${sources.length + 1}`, file, line: start + 1,
        url: `https://github.com/TheJollyLaMa/DecentBusking/blob/${commit}/${file}#L${start + 1}`,
        text: lines.slice(start, start + 45).join('\n'),
      });
    }
  }
  writeFileSync(path.join(directory, 'handoff/sources.json'),
    `${JSON.stringify({ commit, indexedAt: new Date().toISOString(), sources }, null, 2)}\n`);
  console.log(`Captured ${sources.length} excerpts from public commit ${commit}. Approval is now invalidated.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'snapshot') snapshot(process.argv[3]);
  else if (command === 'review') {
    const pack = readHandoff();
    console.log(JSON.stringify({ digest: pack.digest, publicCommit: pack.commit, indexedAt: pack.indexedAt,
      sources: sourcePaths, evaluation: pack.evaluation, approved: isApproved(pack,
        path.resolve(process.env.DBUSKER_APPROVAL_FILE || 'approval.json')) }, null, 2));
  } else if (command === 'approve') {
    const reviewer = process.argv[3]?.trim();
    if (!reviewer) throw new Error('After human review: npm run approve -- "reviewer name"');
    const pack = readHandoff();
    writeFileSync(path.resolve(process.env.DBUSKER_APPROVAL_FILE || 'approval.json'),
      `${JSON.stringify({ digest: pack.digest, reviewer, approvedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 });
    console.log(`Approved ${pack.digest}. Restart the service to load the reviewed pack.`);
  } else throw new Error('Use snapshot <public commit>, review, or approve <reviewer>');
}
