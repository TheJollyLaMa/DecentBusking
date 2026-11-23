import fs from 'node:fs';

const lower = value => String(value || '').toLowerCase();

export function readFoundingInvitees(file = new URL('../contributor-accounts.json', import.meta.url)) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set([...(data.contributors || []), ...(data.invitedParticipants || [])]
      .filter(entry => entry.referredBy && entry.walletAddress).map(entry => lower(entry.walletAddress)));
  } catch {
    return new Set();
  }
}

/**
 * DBusker asks a first-time Discord uploader who brought them, once per Discord user per process.
 * Returns a reply payload, or null when the inviter is already known or nothing should be sent.
 */
export function createInviterNudge({ siteUrl, getState, getLinked, foundingInvitees = readFoundingInvitees }) {
  const nudged = new Set();
  return async function inviterNudge(message) {
    const authorId = message?.author?.id;
    if (!siteUrl || !authorId || message.author.bot || nudged.has(authorId)) return null;
    nudged.add(authorId);
    const linked = getLinked(authorId);
    const wallet = lower(linked?.address);
    if (wallet) {
      if (foundingInvitees().has(wallet)) return null;
      const state = await getState();
      if (!state || (state.inviters || []).some(item => item.wallet === wallet)) return null;
    }
    const url = new URL(siteUrl.replace(/\/?$/, '/'));
    url.searchParams.set('inviter', '1');
    return {
      content: '👽 First drop, nice. Who brought you here?',
      components: [{ type: 1, components: [{ type: 2, style: 5, label: '🛸 Tell us', url: url.href }] }],
      allowedMentions: { parse: [] },
    };
  };
}
