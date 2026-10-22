import { RADIO_LISTEN_URL, RADIO_TIME_ZONE } from './radio-calendar.mjs';

export async function announcementHash(value, cryptoImpl = globalThis.crypto) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function announcementAuthorization({ address, origin, action, occurrenceId = '', startUtc = '', contentHash, nonce, expiresAt }) {
  return ['DecentBusking radio announcement', `Wallet: ${address.toLowerCase()}`, `Origin: ${origin}`,
    `Action: ${action}`, `Occurrence: ${occurrenceId}`, `Start: ${startUtc}`, `Content SHA-256: ${contentHash}`,
    `Nonce: ${nonce}`, `Expires: ${expiresAt}`].join('\n');
}

export function defaultAnnouncementReason(event, show = {}) {
  const type = event.type || show.type;
  if (type === 'weekly_top10') return 'Tune in to the community Top 10, discover your favorites, and get your votes in before the weekly turnover!';
  if (type === 'live_performance') return 'Join the community for a live performance and support our independent artists!';
  if (type === 'playlist_show' && (event.playlistId || show.playlistId) === 'songs-awaiting-your-vote') return 'These songs have never received a single vote. Tune in and give each one a 👍 or 👎 — every honest vote helps shape regular rotation!';
  return 'Discover independent music together — join this radio hour and help choose what plays next!';
}

export function announcementContent({ event, reason, mentions, voiceUrl, listenUrl = RADIO_LISTEN_URL }) {
  const unix = Math.floor(Date.parse(event.startUtc) / 1000);
  const date = new Intl.DateTimeFormat('en-US', { timeZone: RADIO_TIME_ZONE, weekday: 'long', year: 'numeric',
    month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(event.startUtc));
  // Schedule titles and editable copy are plain text, never an alternate source of mentions.
  const plain = value => String(value).replace(/@/g, '@\u200b').replace(/[\\*_~`|<>]/g, '\\$&');
  const targets = [mentions.everyone ? '@everyone' : '', ...mentions.roles.map(id => `<@&${id}>`)].filter(Boolean).join(' ');
  return [targets, `📻 **${plain(event.title)}**`, `${date} (${RADIO_TIME_ZONE})`, `<t:${unix}:F> · <t:${unix}:R>`,
    plain(reason), `Listen on the website: ${listenUrl}`, `Join voice: ${voiceUrl}`].filter(Boolean).join('\n\n');
}
