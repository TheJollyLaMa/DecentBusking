import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';

export function createPromotionAnnouncements({ getClient, channelId, canAnnounce = () => true }) {
  async function destination() {
    if (!canAnnounce()) throw new Error('Discord cooldown active; wait before announcing');
    const client = getClient?.();
    if (!client?.isReady()) throw new Error('Discord bot is unavailable');
    const channel = await client.channels.fetch(channelId);
    if (!channel?.guild || !channel.isTextBased() || typeof channel.send !== 'function') throw new Error('Discord announcement channel is unavailable');
    const permissions = channel.permissionsFor(client.user);
    for (const name of ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory']) {
      if (!permissions?.has(PermissionFlagsBits[name])) throw new Error(`Discord announcement channel requires ${name}`);
    }
    return { client, channel };
  }
  return {
    check: destination,
    async send(draft, pending) {
      const { channel } = await destination();
      if (!canAnnounce()) throw new Error('Discord cooldown began before delivery');
      const message = await channel.send({
        content: `${draft.sentence}\n${draft.link}`,
        embeds: [{ image: { url: draft.posterUrl }, footer: { text: pending.marker } }],
        allowedMentions: { parse: [], roles: [], users: [], repliedUser: false },
        nonce: randomBytes(12).toString('hex'), enforceNonce: true,
      });
      return { messageId: message.id, messageUrl: message.url, announcedAt: new Date(message.createdTimestamp).toISOString() };
    },
    async reconcile(pending) {
      const { client, channel } = await destination();
      let before;
      for (let page = 0; page < 20; page++) {
        const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        for (const message of messages.values()) {
          if (message.author.id === client.user.id && message.embeds.some(embed => embed.footer?.text === pending.marker)) {
            return { messageId: message.id, messageUrl: message.url, announcedAt: new Date(message.createdTimestamp).toISOString() };
          }
        }
        if (!messages.size || [...messages.values()].some(message => message.createdTimestamp < Date.parse(pending.createdAt) - 5000)) break;
        before = messages.last().id;
      }
      throw new Error('Discord delivery is uncertain; no duplicate was sent. Inspect the channel and retry reconciliation.');
    },
  };
}
