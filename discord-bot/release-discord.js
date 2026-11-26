import { parseReleaseSheet, MAX_RELEASE_ROWS } from '../js/release-batch.mjs';

export async function discordReleaseRows(interaction, { playlist, isAudioAttachment }) {
  const sheet = interaction.options.getAttachment('sheet'), text = interaction.options.getString('rows'),
    post = interaction.options.getString('post'), album = interaction.options.getString('album');
  if ([sheet, text, post].filter(Boolean).length !== 1 || (album && !post)) throw Error('Choose one: rows, sheet, or a post with optional album');
  let rows;
  if (sheet) {
    const url = new URL(sheet.url);
    if (!sheet.size || sheet.size > 16000 || !['https://cdn.discordapp.com', 'https://media.discordapp.net'].includes(url.origin)) throw Error('Use a Discord text attachment no larger than 16 KB');
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw Error(`Cannot read release sheet (${response.status})`);
    rows = parseReleaseSheet(await response.text());
  } else rows = post ? [{ album: album || '', format: 'post', cid: post }] : parseReleaseSheet(text);
  if (rows.length > MAX_RELEASE_ROWS) throw Error('Too many release rows');
  const expanded = [];
  for (const row of rows) {
    if (row.format !== 'post') expanded.push(row);
    else {
      if (!/^\d{16,20}$/.test(row.cid)) throw Error('Enter the message ID of your upload in this channel');
      const msg = await interaction.channel.messages.fetch(row.cid);
      if (msg.author.id !== interaction.user.id || msg.channelId !== interaction.channelId) throw Error('Only your own upload posts are allowed');
      const attachments = [...msg.attachments.values()].filter(isAudioAttachment);
      if (!attachments.length) throw Error('This post contains no supported recordings');
      for (const file of attachments) {
        const entry = playlist.find(t => t.attachmentId === file.id && t.uploaderId === interaction.user.id && t.pinStatus === 'pinned');
        if (!entry?.ipfsCid) throw Error(`${file.name}: choose Song on the upload and wait for its IPFS pin`);
        expanded.push({ album: row.album, title: entry.title, format: file.name.split('.').pop().toLowerCase(), cid: entry.ipfsCid });
      }
    }
    if (expanded.length > MAX_RELEASE_ROWS) throw Error('Too many tracks or album references');
  }
  return expanded;
}

export function releaseReceipt(results) {
  return results.map(t => `${t.already ? 'Already ' : ''}${t.status} | ${t.title} | ${t.trackId}`).join('\n');
}
