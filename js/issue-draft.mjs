// Adapted from BigNuten_Vanilla/js/issueHelper.js (Apache-2.0).
// Local text only: no wallet, chat, logs, storage, model or posting credentials.
export const ISSUE_DESTINATION = 'https://github.com/TheJollyLaMa/DecentBusking/issues/new';
export const ISSUE_LIMITS = Object.freeze({ field: 1500, title: 120, body: 5000, url: 7500 });
const CREDENTIAL = String.raw`\b[a-z0-9_-]{0,64}(?:authorization|bearer|password|passwd|secret|seed(?:\s+phrase)?|mnemonic|private[\s_-]*key|api[\s_-]*key|client[\s_-]*secret|(?:access|refresh|session)[\s_-]*(?:key|token)|token|credential|jwt)\b`;
const ADDRESS = /0x[a-f0-9]{40}\b|\b(?:bc1|tb1)[a-z0-9]{25,87}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]{1,4}\b|::[a-f0-9]{1,4}\b|\b\d{1,6}\s+(?:[\p{L}\d.'-]+\s+){0,5}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|boulevard|blvd)\b/giu;

export function sanitizeIssueText(value, limit = ISSUE_LIMITS.field) {
  if (typeof value !== 'string') throw new Error('Report fields must be text.');
  if (value.length > limit) throw new Error(`Text is too long (maximum ${limit} characters). Shorten it and review again.`);
  let text = value.normalize('NFKC').replace(/\p{Cf}/gu, '');
  for (let i = 0; i < 4 && /%[a-f0-9]{2}/i.test(text); i++) {
    try { text = decodeURIComponent(text); }
    catch { throw new Error('Malformed URL encoding. Remove it before continuing.'); }
  }
  text = text.normalize('NFKC').replace(/\p{Cf}/gu, '').trim();
  if (/%[a-f0-9]{2}/i.test(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(text)) {
    throw new Error('Unsupported or excessively encoded text. Remove it before continuing.');
  }
  return text
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[^-]*-----[\s\S]*?(?:-----END [^-]+-----|$)/gi, '[redacted]')
    .replace(new RegExp(CREDENTIAL + `[ \\t:="'-]*\\r?\\n[\\s\\S]*`, 'gi'), '[redacted]')
    .replace(new RegExp(CREDENTIAL + '[^\\n]*', 'gi'), '[redacted]')
    .replace(/\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|sk-[a-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[a-z0-9-]+)\b/gi, '[redacted]')
    .replace(/\b[a-z0-9_-]{20,}\.[a-z0-9_-]{6,}\.[a-z0-9_-]{20,}\b/gi, '[redacted]')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, '[removed URL]')
    .replace(/(?:0x)?[a-f0-9]{48,}/gi, '[removed key-like data]')
    .replace(/\b[a-z0-9_+/=-]{32,}\b/gi, '[removed key-like data]')
    .replace(ADDRESS, '[removed address]')
    .replace(/<@(?:!|&)?\d+>|\b\d{16,22}\b/g, '[removed identifier]');
}

export function reviewIssueDraft({ title, body }) {
  const cleanTitle = sanitizeIssueText(title, ISSUE_LIMITS.title).replace(/\s+/g, ' ');
  const cleanBody = sanitizeIssueText(body, ISSUE_LIMITS.body);
  if (!cleanTitle || !cleanBody) throw new Error('A title and report body are required.');
  const url = new URL(ISSUE_DESTINATION);
  url.search = new URLSearchParams({ title: cleanTitle, body: cleanBody, labels: 'bug,bug-catcher-pending' }).toString();
  if (url.href.length > ISSUE_LIMITS.url) throw new Error('The GitHub link is too long. Shorten your report and review again.');
  const search = new URL('https://github.com/TheJollyLaMa/DecentBusking/issues');
  search.searchParams.set('q', `is:issue ${cleanTitle.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim()}`);
  return { title: cleanTitle, body: cleanBody, url: url.href, searchUrl: search.href,
    redacted: cleanTitle !== title.trim() || cleanBody !== body.trim() };
}

export function buildIssueDraft(input) {
  const headings = {
    actual: 'What happened?', expected: 'What did you expect?',
    steps: 'Steps to reproduce', impact: 'Impact',
    environment: 'Browser, device and page or control',
  };
  const parts = Object.entries(headings).map(([field, heading]) => {
    const text = sanitizeIssueText(input[field]);
    if (!text) throw new Error(`Please answer: ${heading}`);
    return `### ${heading}\n${text}`;
  });
  return reviewIssueDraft({ title: input.title, body: `## Bug report\n\n${parts.join('\n\n')}` });
}
