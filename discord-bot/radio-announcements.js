import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { PermissionFlagsBits } from 'discord.js';
import { radioCalendarOccurrences } from '../js/radio-calendar.mjs';
import { announcementHash as sharedHash, announcementAuthorization, announcementContent, defaultAnnouncementReason } from '../js/radio-announcement.mjs';

const announcementHash = value => sharedHash(value, webcrypto);

export function deserializeAnnouncements(snapshot) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (snapshot?.schemaVersion !== 1 || !object(snapshot.deliveries) || !object(snapshot.requests) ||
      Object.values(snapshot.requests).some(item => !object(item) || !['pending', 'sent'].includes(item.status) ||
        typeof item.occurrenceId !== 'string' || typeof item.nonce !== 'string' || typeof item.hash !== 'string' ||
        typeof item.marker !== 'string' || !Number.isFinite(item.createdAt)) ||
      Object.values(snapshot.deliveries).some(item => !object(item) || item.status !== 'sent' ||
        typeof item.messageId !== 'string' || !/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(item.messageUrl) ||
        !Number.isFinite(Date.parse(item.announcedAt)))) throw new Error('Invalid announcement checkpoint; sending disabled');
  return snapshot;
}

export function announcementMentions(selection, guild) {
  if (!selection || typeof selection.everyone !== 'boolean' || !Array.isArray(selection.roles) || selection.roles.length > 50) {
    throw new Error('Choose @everyone, mentionable roles, or no mentions');
  }
  const roles = [...new Set(selection.roles)].sort();
  for (const id of roles) {
    const role = typeof id === 'string' && /^\d{17,20}$/.test(id) && guild.roles.cache.get(id);
    if (!role || role.id === guild.id || !role.mentionable || role.managed) throw new Error('Selected role is no longer mentionable in this guild; refresh the preview');
  }
  return { mentions: { everyone: selection.everyone, roles },
    allowedMentions: { parse: selection.everyone ? ['everyone'] : [], roles, users: [], repliedUser: false } };
}

// One service/worker owns this journal. Every send is serialized and checkpointed before Discord sees it.
export function createRadioAnnouncements({ store, getSchedule, getClient, ownerWallet, channelId = '943117480883265539',
  defaultMention = 'everyone', voiceChannelId, listenUrl, now = () => Date.now(),
  canAnnounce = () => true, log = console }) {
  let state;
  let restoreError;
  let queue = Promise.resolve();
  const seen = new Map();
  let reminderTask = null;
  let reminderRetryAt = 0;
  let reminderError = null;
  let lastReminder = null;
  const ready = (async () => {
    try {
      if (!store) throw new Error('Durable announcement storage is unavailable');
      state = deserializeAnnouncements(await store.restore() || { schemaVersion: 1, deliveries: {}, requests: {} });
    } catch (error) { restoreError = error; }
  })();
  const save = async () => {
    const uri = await store.save(structuredClone(state));
    if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) throw new Error('Durable checkpoint did not confirm an IPFS receipt');
  };
  const lastDelivery = id => Object.hasOwn(state.deliveries, id) ? state.deliveries[id] : null;
  const reminderId = (id, startUtc) => `reminder:${id}:${startUtc}`;

  async function destination() {
    if (!canAnnounce()) throw new Error('Discord cooldown active; wait before announcing');
    const client = getClient();
    if (!client?.isReady()) throw new Error('Discord bot is reconnecting; retry shortly');
    const channel = await client.channels.fetch(channelId);
    if (!channel?.guild || !channel.isTextBased() || typeof channel.send !== 'function') throw new Error('Announcement channel is unavailable');
    const permissions = channel.permissionsFor(client.user);
    for (const permission of ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory']) {
      if (!permissions?.has(PermissionFlagsBits[permission])) throw new Error(`Bot needs ${permission} permission in #${channel.name}`);
    }
    const voiceId = voiceChannelId;
    const voice = voiceId && channel.guild.channels.cache.get(voiceId);
    if (!voice?.isVoiceBased()) throw new Error('Configure JUKE_LOOP_VOICE_CHANNEL_ID to a voice channel in the announcement guild');
    return { channel, permissions, voiceUrl: `https://discord.com/channels/${channel.guild.id}/${voiceId}` };
  }

  async function draftFor(payload, dest, automatic = false) {
    const schedule = await getSchedule();
    if (schedule.ready !== true) throw new Error('Shared calendar is restoring; refresh before announcing');
    const event = radioCalendarOccurrences(schedule, { now: now(), days: 90, pastDays: 0 }).find(item => item.id === payload.occurrenceId);
    if (!event || event.startUtc !== payload.startUtc) throw new Error('Occurrence changed or removed; refresh the calendar and preview again');
    if (event.status === 'cancelled' || Date.parse(event.endUtc) <= now()) throw new Error('Cannot announce a canceled or ended occurrence');
    if (automatic && (event.announce === false || Date.parse(event.startUtc) <= now() ||
      Date.parse(event.startUtc) - now() > 5 * 60_000)) throw new Error('Reminder is disabled or outside its five-minute window');
    const show = schedule.schedule?.find(item => item.id === event.showId);
    const revision = await announcementHash({ event, show: show || null });
    if (payload.revision && payload.revision !== revision) throw new Error('Stale preview: occurrence changed; refresh and reconfirm');
    const reason = payload.reason === undefined ? defaultAnnouncementReason(event, show) : payload.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 600) throw new Error('Reason must be 1–600 characters');
    const { mentions, allowedMentions } = announcementMentions(payload.mentions, dest.channel.guild);
    if (mentions.everyone && !dest.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      throw new Error('Bot lacks Mention Everyone permission in this channel; grant it or choose roles/none and preview again');
    }
    if (payload.requestId !== undefined && !/^[a-f\d-]{36}$/i.test(payload.requestId)) throw new Error('Invalid confirmation ID');
    const draft = { requestId: payload.requestId || randomUUID(), occurrenceId: event.id, startUtc: event.startUtc, revision, reason: reason.trim(), mentions,
      reannounce: payload.reannounce === true, channelId, voiceUrl: dest.voiceUrl, listenUrl };
    const content = announcementContent({ event, ...draft });
    if (content.length > 2000) throw new Error('Announcement exceeds Discord’s 2000-character limit; shorten the reason or reduce roles');
    return { draft, content, allowedMentions };
  }

  async function reconcile(request, channel) {
    if (request.messageId) return request;
    let before;
    for (let page = 0; page < 20; page++) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      for (const message of messages.values()) {
        if (message.author.id === getClient().user.id && message.embeds.some(embed => embed.footer?.text === request.marker)) {
          return { ...request, messageId: message.id, messageUrl: message.url, announcedAt: new Date(message.createdTimestamp).toISOString() };
        }
      }
      if (!messages.size || [...messages.values()].some(message => message.createdTimestamp < request.createdAt - 5000)) break;
      before = messages.last().id;
    }
    throw new Error('Delivery uncertain: no duplicate was sent. Check Discord and retry reconciliation; an operator must resolve the pending checkpoint if no post exists.');
  }

  async function send(body, dest) {
    dest = await destination();
    const id = body.automatic ? reminderId(body.payload.occurrenceId, body.payload.startUtc) : body.payload.occurrenceId;
    const previousRequest = state.requests[body.nonce];
    if (previousRequest && previousRequest.hash !== body.contentHash) throw new Error('Nonce already used for different content');
    let pending = previousRequest || Object.values(state.requests).find(item => item.occurrenceId === id && item.status === 'pending');
    if (pending) {
      if (pending.status !== 'sent') {
        if (pending.channelId !== channelId) throw new Error('Pending announcement belongs to a previous destination; reconcile that channel before sending again');
        pending = { ...await reconcile(pending, dest.channel), status: 'sent' };
        state.requests[pending.nonce] = pending;
        state.deliveries = { ...state.deliveries, [id]: pending };
      }
      await save();
      return { delivery: pending, duplicate: true };
    }
    if (Date.parse(body.expiresAt) <= now()) throw new Error('Announcement authorization expired; confirm again');
    const built = await draftFor(body.payload, dest, body.automatic);
    if (await announcementHash(built.draft) !== body.contentHash) throw new Error('Stale preview or destination changed; refresh and reconfirm');
    if (lastDelivery(id) && !built.draft.reannounce) return { delivery: lastDelivery(id), duplicate: true };
    const request = { occurrenceId: id, nonce: body.nonce, hash: body.contentHash, status: 'pending',
      marker: `Radio announcement ${randomBytes(16).toString('hex')}`, channelId, createdAt: now() };
    state.requests[body.nonce] = request;
    try { await save(); } catch (error) { delete state.requests[body.nonce]; throw new Error(`Checkpoint failed; nothing sent. ${error.message}`); }
    // The checkpoint upload can take time. Revalidate immediately before the Discord call too.
    try {
      if (Date.parse(body.expiresAt) <= now()) throw new Error('Announcement authorization expired during checkpoint; confirm again');
      dest = await destination();
      const current = await draftFor(body.payload, dest, body.automatic);
      if (await announcementHash(current.draft) !== body.contentHash) throw new Error('Stale preview; refresh and reconfirm');
      if (!canAnnounce()) throw new Error('Discord cooldown began before delivery; wait before announcing');
    } catch (error) {
      delete state.requests[body.nonce];
      await save();
      throw error;
    }
    let message;
    try {
      message = await dest.channel.send({ content: built.content, allowedMentions: built.allowedMentions,
        embeds: [{ footer: { text: request.marker } }], nonce: randomBytes(12).toString('hex'), enforceNonce: true });
    } catch (error) {
      // Definite Discord rejections are safe to retry; timeouts/5xx retain the durable pending marker.
      if (error.status >= 400 && error.status < 500 && error.status !== 408) {
        delete state.requests[body.nonce];
        try { await save(); } catch { state.requests[body.nonce] = request; }
      }
      throw new Error(`Discord delivery failed: ${error.message}. Retry safely; uncertain delivery will be reconciled, not resent.`);
    }
    const delivery = { ...request, status: 'sent', messageId: message.id, messageUrl: message.url,
      announcedAt: new Date(now()).toISOString() };
    // Retain the receipt in memory even if the final checkpoint fails. Restart recovery uses the footer marker.
    state.requests[body.nonce] = delivery;
    state.deliveries = { ...state.deliveries, [id]: delivery };
    try { await save(); } catch (error) { throw new Error(`Message delivered but receipt checkpoint failed; retry safely to recover: ${error.message}`); }
    return { delivery, duplicate: false };
  }

  return { ready,
    reminderStatus: () => ({ retryAt: reminderRetryAt || null, error: reminderError, lastDelivery: lastReminder }),
    tick() {
      if (reminderTask) return reminderTask;
      reminderTask = (async () => {
        await ready;
        if (restoreError) throw new Error(`Announcements disabled: ${restoreError.message}`);
        if (now() < reminderRetryAt || !canAnnounce() || !getClient()?.isReady()) return;
        const schedule = await getSchedule();
        if (schedule.ready !== true) return;
        const due = radioCalendarOccurrences(schedule, { now: now(), days: 1, pastDays: 0 }).filter(event =>
          event.status !== 'cancelled' && event.announce !== false &&
          Date.parse(event.startUtc) > now() && Date.parse(event.startUtc) <= now() + 5 * 60_000 &&
          !lastDelivery(reminderId(event.id, event.startUtc)));
        for (const event of due) {
          const operation = queue.then(async () => {
            if (lastDelivery(reminderId(event.id, event.startUtc))) return;
            const dest = await destination();
            const built = await draftFor({ occurrenceId: event.id, startUtc: event.startUtc,
              mentions: { everyone: true, roles: [] }, reason: `Starting soon! ${defaultAnnouncementReason(event)}` }, dest, true);
            const result = await send({ automatic: true, payload: built.draft, nonce: built.draft.requestId,
              contentHash: await announcementHash(built.draft), expiresAt: event.startUtc }, dest);
            lastReminder = result.delivery;
            reminderError = null;
            reminderRetryAt = 0;
          });
          queue = operation.catch(() => {});
          await operation;
        }
      })().catch(error => {
        if (now() >= reminderRetryAt) log.error(`[radio-reminder] ${error.message}`);
        reminderError = error.message;
        reminderRetryAt = Math.max(reminderRetryAt, now() + 60_000);
      }).finally(() => { reminderTask = null; });
      return reminderTask;
    },
    async handle(action, body, origin) {
    await ready;
    const expires = Date.parse(body.expiresAt);
    if (!['options', 'preview', 'send'].includes(action) || !/^0x[\da-f]{40}$/i.test(body.address || '') ||
        !/^[\da-f-]{16,100}$/i.test(body.nonce || '') || !Number.isFinite(expires) || expires <= now() || expires > now() + 300_000 ||
        body.contentHash !== await announcementHash(body.payload)) throw new Error('Invalid or expired announcement authorization');
    const message = announcementAuthorization({ ...body, action, origin, occurrenceId: body.payload.occurrenceId, startUtc: body.payload.startUtc });
    const recovered = verifyMessage(message, body.signature).toLowerCase();
    if (recovered !== body.address.toLowerCase() || recovered !== ownerWallet.toLowerCase()) throw new Error('Announcement authorization is not from the radio owner');
    if (restoreError) throw new Error(`Announcements disabled: ${restoreError.message}`);
    for (const [nonce, entry] of seen) if (entry.expires < now()) seen.delete(nonce);
    const binding = `${action}:${body.contentHash}`;
    if (seen.has(body.nonce) && seen.get(body.nonce).binding !== binding) throw new Error('Nonce already used');
    seen.set(body.nonce, { binding, expires });
    const dest = await destination();
    if (action === 'options') {
      const roles = [...dest.channel.guild.roles.cache.values()].filter(role => role.id !== dest.channel.guild.id && role.mentionable && !role.managed)
        .map(role => ({ id: role.id, name: role.name }));
      const defaults = { everyone: defaultMention === 'everyone', roles: defaultMention === 'everyone' || defaultMention === 'none' ? [] : defaultMention.split(',').map(id => id.trim()) };
      announcementMentions(defaults, dest.channel.guild);
      return { channelId, channelName: dest.channel.name, roles, defaultMentions: defaults, deliveries: state.deliveries };
    }
    if (action === 'preview') {
      const built = await draftFor(body.payload, dest);
      return { ...built, contentHash: await announcementHash(built.draft), channelName: dest.channel.name,
        lastAnnouncement: lastDelivery(built.draft.occurrenceId) };
    }
    if (!body.payload.requestId) throw new Error('Preview and explicitly confirm before sending');
    const result = queue.then(() => send({ ...body, automatic: false, nonce: body.payload.requestId }, dest));
    queue = result.catch(() => {});
    return result;
  } };
}
