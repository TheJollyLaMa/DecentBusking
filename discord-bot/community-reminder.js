import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';
import { utcToNewYorkInput, newYorkInputToUtc } from '../js/radio-calendar.mjs';

export const COMMUNITY_CHANNEL_ID = '943117480883265539';
const guildId = '943117480883265536';
const poster = fileURLToPath(new URL('../img/community-monday.png', import.meta.url));
const windowMs = 60 * 60_000;
const markerFor = date => `decent-community-monday:${date}`;

export function communityReminderTime(now = Date.now()) {
  const local = utcToNewYorkInput(new Date(now).toISOString());
  const monday = new Date(`${local.slice(0, 10)}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const date = monday.toISOString().slice(0, 10);
  const start = Date.parse(newYorkInputToUtc(`${date}T09:00`));
  monday.setUTCDate(monday.getUTCDate() + 7);
  return {
    date, start, end: start + windowMs, due: now >= start && now < start + windowMs,
    nextRunAt: new Date(now < start ? start :
      Date.parse(newYorkInputToUtc(`${monday.toISOString().slice(0, 10)}T09:00`))).toISOString(),
  };
}

export function deserializeCommunityReminders(value) {
  if (value?.schemaVersion !== 1 || value.channelId !== COMMUNITY_CHANNEL_ID ||
      !Array.isArray(value.deliveries) || value.deliveries.length > 104) {
    throw new Error('Invalid community reminder checkpoint');
  }
  const dates = new Set();
  for (const entry of value.deliveries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || dates.has(entry.date) ||
        !['pending', 'sent'].includes(entry.status) || !Number.isFinite(entry.createdAt) ||
        !/^[a-f0-9]{24}$/.test(entry.nonce) ||
        entry.status === 'sent' && !/^\d{17,20}$/.test(entry.messageId)) {
      throw new Error('Invalid community reminder receipt');
    }
    dates.add(entry.date);
  }
  return value;
}

export function buildCommunityReminder(date, siteUrl) {
  const site = new URL(siteUrl);
  if (site.protocol !== 'https:') throw new Error('Community reminder needs an HTTPS site URL');
  site.search = '';
  site.hash = '';
  const calendar = new URL(site);
  calendar.searchParams.set('schedule', '1');
  const adverts = new URL(site);
  adverts.hash = 'devert-tab';
  return {
    content: '@everyone The world is your village, Busk from home!',
    allowedMentions: { parse: ['everyone'], roles: [], users: [], repliedUser: false },
    files: [{ attachment: poster, name: 'community-monday.png',
      description: 'The world is your village, Busk from home! Check the Public Schedule and sync it to your calendar. Buy DVert ads for your projects, events and public announcements to fuel the funds. Send jams to the radio and invite friends to do the same. Listen and vote on songs.' }],
    embeds: [{
      color: 0xff8a32,
      image: { url: 'attachment://community-monday.png' },
      description: `[Community calendar & sync](${calendar.href}) · [Run a DVert ad](${adverts.href}) · [Send jams, listen & vote](${site.href})`,
      footer: { text: markerFor(date) },
    }],
  };
}

export function createCommunityReminder({ store, getClient, canAnnounce, siteUrl, now = () => Date.now(), log = console }) {
  let state;
  let initialized = false;
  let error = null;
  let retryAt = 0;
  let task;
  let dirty = false;
  const ready = (async () => {
    try {
      if (!store) throw new Error('Durable community reminder storage is unavailable');
      state = deserializeCommunityReminders(await store.restore() ||
        { schemaVersion: 1, channelId: COMMUNITY_CHANNEL_ID, deliveries: [] });
      initialized = true;
    } catch (failure) {
      error = failure.message;
      log.error('[community-reminder] Sending disabled:', error);
    }
  })();
  const save = async () => {
    dirty = true;
    const uri = await store.save(structuredClone(state));
    if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Community reminder checkpoint did not confirm an IPFS receipt');
    dirty = false;
  };
  function available() {
    return canAnnounce() && getClient()?.isReady() === true;
  }
  async function destination() {
    if (!available()) throw new Error('Discord unavailable or in cooldown');
    const client = getClient();
    const channel = await client.channels.fetch(COMMUNITY_CHANNEL_ID);
    if (channel?.guild?.id !== guildId || !channel.isTextBased() || typeof channel.send !== 'function') {
      throw new Error('Community reminder destination is not the verified DecentAgency message channel');
    }
    const permissions = channel.permissionsFor(client.user);
    for (const name of ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'MentionEveryone']) {
      if (!permissions?.has(PermissionFlagsBits[name])) throw new Error(`Community reminder requires ${name}`);
    }
    return channel;
  }
  async function reconcile(entry, channel) {
    let before;
    for (let page = 0; page < 20; page++) {
      if (!available()) throw new Error('Discord cooldown began during reminder reconciliation');
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const found = [...messages.values()].find(message => message.author.id === getClient().user.id &&
        message.embeds.some(embed => embed.footer?.text === markerFor(entry.date)));
      if (found) {
        entry.status = 'sent';
        entry.messageId = found.id;
        await save();
        return;
      }
      if (!messages.size || [...messages.values()].some(message => message.createdTimestamp < entry.createdAt - 5000)) break;
      before = messages.last().id;
    }
    throw new Error('Community reminder delivery uncertain; no duplicate sent. Check the pending receipt and channel before operator recovery.');
  }
  return {
    ready,
    getStatus: () => ({ ready: initialized, channelId: COMMUNITY_CHANNEL_ID,
      timeZone: 'America/New_York', schedule: 'Monday 09:00', nextRunAt: communityReminderTime(now()).nextRunAt,
      error, retryAt: retryAt || null, lastDelivery: state?.deliveries.findLast(entry => entry.status === 'sent') || null }),
    tick() {
      if (task) return task;
      task = (async () => {
        await ready;
        if (!initialized || now() < retryAt || !available()) return;
        // Recover uncertain sends even after the Monday delivery window, never blindly resend.
        const pending = state.deliveries.find(entry => entry.status === 'pending');
        if (pending) { await reconcile(pending, await destination()); return true; }
        if (dirty) await save();
        const occurrence = communityReminderTime(now());
        if (!occurrence.due) return;
        if (state.deliveries.some(entry => entry.date === occurrence.date)) {
          if (dirty) await save();
          return true;
        }
        let channel = await destination();
        const entry = { date: occurrence.date, status: 'pending', nonce: randomBytes(12).toString('hex'), createdAt: now() };
        state.deliveries.push(entry);
        state.deliveries = state.deliveries.slice(-104);
        try { await save(); } catch (failure) {
          state.deliveries = state.deliveries.filter(item => item !== entry);
          throw failure;
        }
        if (!available() || now() >= occurrence.end) {
          state.deliveries = state.deliveries.filter(item => item !== entry);
          await save();
          throw new Error('Community reminder window or Discord availability changed before delivery');
        }
        try {
          channel = await destination();
          if (!available() || now() >= occurrence.end) throw new Error('Community reminder delivery window closed');
        } catch (failure) {
          state.deliveries = state.deliveries.filter(item => item !== entry);
          await save();
          throw failure;
        }
        let message;
        try {
          message = await channel.send({ ...buildCommunityReminder(entry.date, siteUrl),
            nonce: entry.nonce, enforceNonce: true });
        } catch (failure) {
          if (failure.status >= 400 && failure.status < 500 && failure.status !== 408) {
            state.deliveries = state.deliveries.filter(item => item !== entry);
            try { await save(); } catch (checkpointFailure) {
              state.deliveries.push(entry);
              log.error('[community-reminder] Rejection checkpoint failed:', checkpointFailure.message);
            }
          }
          throw failure;
        }
        entry.status = 'sent';
        entry.messageId = message.id;
        await save();
        log.log(`[community-reminder] Posted ${entry.date} in #${channel.name}.`);
        return true;
      })().then(completed => {
        if (completed) { error = null; retryAt = 0; }
      }).catch(failure => {
        if (error !== failure.message) log.error('[community-reminder]', failure.message);
        error = failure.message;
        retryAt = now() + 60_000;
      }).finally(() => { task = null; });
      return task;
    },
  };
}
