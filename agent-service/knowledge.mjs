import { createHash } from 'node:crypto';
import path from 'node:path';

const textExtensions = new Set([
  '.md', '.txt', '.cff', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.yml', '.yaml', '.html', '.css', '.sh', '.py', '.sol', '.toml',
]);
const stopWords = new Set(('a an the and or to of in on for with from is it its this that these those ' +
  'i me my we our you your how what which where when why can could would should do does did have ' +
  'has be been are as at by about want know please tell some more there they them their not').split(' '));

export function sourceDisposition(file, mode = '100644') {
  if (!['100644', '100755'].includes(mode)) return 'non-regular Git entry';
  if (/(^|\/)(node_modules|vendor|dist|build)\//.test(file)) return 'third-party or build output';
  if (/(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(file) ||
      /(^|\/)(access|approval)\.json$/.test(file)) return 'credentials or private operator configuration';
  if (['contributor-accounts.json', 'payroll-queue.json'].includes(file) ||
      file.startsWith('docs/reports/')) return 'individual accounting or generated operational report';
  if (file === 'agent-service/handoff/sources.json') return 'generated knowledge snapshot (avoid recursive ingestion)';
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(file)) return 'dependency lockfile';
  if (file.startsWith('img/')) return 'creative or binary asset; no asset-content ingestion';
  if (!textExtensions.has(path.extname(file).toLowerCase()) &&
      !['LICENSE', 'NOTICE', '.gitignore'].includes(path.basename(file))) return 'unsupported or binary format';
  return null;
}

export function chunkSource(file, text, commit) {
  const chunks = [];
  let parts = [], bytes = 0, start = 1, end = 1;
  const flush = () => {
    if (!parts.length) return;
    const value = parts.join('\n');
    const id = `source-${createHash('sha256').update(`${file}\0${start}\0${chunks.length}\0${value}`).digest('hex').slice(0, 20)}`;
    chunks.push({
      id, file, line: start, endLine: end,
      url: `https://github.com/TheJollyLaMa/DecentBusking/blob/${commit}/${file}#L${start}`,
      text: value,
    });
    parts = []; bytes = 0;
  };
  text.split('\n').forEach((line, index) => {
    // Bound even minified/generated single lines without splitting UTF-8 characters.
    let segment = '', segmentBytes = 0;
    const segments = [];
    for (const character of line) {
      const length = Buffer.byteLength(character);
      if (segmentBytes + length > 1800) { segments.push(segment); segment = ''; segmentBytes = 0; }
      segment += character; segmentBytes += length;
    }
    segments.push(segment);
    for (const [part, value] of segments.entries()) {
      if (part > 0) flush();
      const length = Buffer.byteLength(value);
      if (parts.length && (bytes + length + 1 > 1800 || parts.length >= 56)) flush();
      if (!parts.length) start = index + 1;
      end = index + 1;
      parts.push(value); bytes += length + 1;
      if (part < segments.length - 1) flush();
    }
  });
  flush();
  return chunks;
}

export function words(text) {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function createRetriever(sources, topics = []) {
  const frequency = new Map(), documents = [];
  for (const source of sources) {
    const tokens = words(`${source.file} ${source.text}`);
    const counts = new Map();
    for (const word of tokens) counts.set(word, (counts.get(word) || 0) + 1);
    for (const word of counts.keys()) frequency.set(word, (frequency.get(word) || 0) + 1);
    documents.push({ source, counts, length: tokens.length });
  }
  const average = documents.reduce((sum, item) => sum + item.length, 0) / (documents.length || 1);
  return (message, history = []) => {
    const terms = new Map();
    const addTerms = (text, weight) => {
      for (const term of new Set(words(text).filter(word => !stopWords.has(word) && word.length > 1))) {
        terms.set(term, Math.max(terms.get(term) || 0, weight));
      }
    };
    addTerms(message, 1);
    const previous = history.filter(item => item.role === 'user').at(-1)?.content || '';
    const followup = words(message).length < 9 || /^(and |what about |how about |why |that |those )/i.test(message);
    if (followup) addTerms(previous, 0.3);
    const normalized = ` ${words(message).join(' ')} `;
    const previousNormalized = ` ${words(previous).join(' ')} `;
    const matches = topics.map(topic => {
      const current = topic.aliases.some(alias => normalized.includes(` ${words(alias).join(' ')} `));
      const prior = followup && topic.aliases.some(alias => previousNormalized.includes(` ${words(alias).join(' ')} `));
      return { topic, weight: current ? 1 : prior ? 0.3 : 0 };
    }).filter(match => match.weight);
    for (const { topic, weight } of matches) addTerms(topic.terms.join(' '), 0.45 * weight);
    const ranked = documents.map(({ source, counts, length }, order) => {
      let score = 0;
      for (const [term, weight] of terms) {
        const count = counts.get(term) || 0;
        if (!count) continue;
        const idf = Math.log(1 + (sources.length - frequency.get(term) + 0.5) / (frequency.get(term) + 0.5));
        score += weight * idf * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * length / average));
      }
      for (const { topic, weight } of matches) {
        if (topic.files.includes(source.file) && score > 0) score += 8 * weight;
      }
      if (message.toLowerCase().includes(source.file.toLowerCase())) score += 35;
      return { source, score, order };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
    const selected = [], perFile = new Map(), selectedIds = new Set();
    const select = source => {
      if (!source || selectedIds.has(source.id) || selected.length >= 8 ||
          (perFile.get(source.file) || 0) >= 3) return;
      selected.push(source);
      selectedIds.add(source.id);
      perFile.set(source.file, (perFile.get(source.file) || 0) + 1);
    };
    // Keep reviewed entry points visible instead of drowning short forms in code matches.
    for (let index = 0; index < 2; index++) {
      for (const { topic } of matches) {
        const file = topic.entryFiles?.[index];
        const evidence = topic.entryEvidence?.[file];
        if (file) select(ranked.find(item => item.source.file === file &&
          (!evidence || item.source.text.includes(evidence)))?.source);
      }
    }
    for (const item of ranked) {
      if ((perFile.get(item.source.file) || 0) >= 3) continue;
      select(item.source);
      if (selected.length >= 8) break;
    }
    return selected;
  };
}
