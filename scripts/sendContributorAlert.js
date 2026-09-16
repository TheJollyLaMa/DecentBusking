const fs = require('fs');

const { postIssueComment, repositoryCoordinates } = require('./githubApi');

function parseIssueForm(body) {
  const fields = {};
  const pattern = /(?:^|\r?\n)### ([^\r\n]+)\r?\n+([\s\S]*?)(?=\r?\n### |$)/g;
  for (const match of String(body || '').matchAll(pattern)) fields[match[1].trim()] = match[2].trim();
  return fields;
}

async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const issue = event.issue;
  if (!issue) throw new Error('GitHub issue event payload is required');
  const { owner, repo } = repositoryCoordinates();
  const fields = parseIssueForm(issue.body);
  const github = fields['GitHub username'] || issue.user.login;
  const body = [
    `@${owner}, a contributor request from @${github} is ready for wallet and technical fit review.`,
    '',
    'This GitHub mention is the administrative notification; no email or external notification service is used.',
  ].join('\n');
  await postIssueComment(owner, repo, issue.number, body);

  const summary = [
    '## Contributor request received',
    '',
    `- Issue: #${issue.number}`,
    `- GitHub: @${github}`,
    `- Wallet: ${fields['Wallet address'] || 'not provided'}`,
    `- Area: ${fields['What you want to help with'] || 'not provided'}`,
    `- URL: ${issue.html_url}`,
    '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(`GitHub-native contributor request alert posted for issue #${issue.number}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseIssueForm };