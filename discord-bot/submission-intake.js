export const SUBMISSION_TIMEOUT_MS = 10 * 60 * 1000;
const DISCORD_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const EPHEMERAL = 64;

function mediaTypeFor(filename = '', declaredType = '') {
  const extension = String(filename || '').split('.').pop().toLowerCase();
  return { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
    flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'video/mp4' }[extension] ||
    (['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac', 'video/mp4', 'audio/webm'].includes(declaredType) ? declaredType : '');
}

export function submissionKey(messageId, attachmentId) {
  return `${messageId}__${attachmentId}`;
}

export function submissionMediaKind(attachment) {
  return mediaTypeFor(attachment?.name || '', attachment?.contentType || '') === 'video/mp4' ? 'video' : 'audio';
}

export function buildSubmissionPrompt({ filename, mediaKind }) {
  return `🎧 Got **${filename}** (${mediaKind}). What is it?`;
}

export function buildSubmissionButtons(key, defaultKind) {
  const primary = defaultKind === 'advert' ? 'advert' : 'song';
  return [{
    type: 1,
    components: [
      {
        type: 2,
        custom_id: `submission:choice:${key}:song`,
        label: 'Song',
        style: primary === 'song' ? 1 : 2,
      },
      {
        type: 2,
        custom_id: `submission:choice:${key}:advert`,
        label: 'Advert',
        style: primary === 'advert' ? 1 : 2,
      },
    ],
  }];
}

export function buildWalletButtons({ linkUrl, key }) {
  const components = [];
  if (linkUrl) {
    components.push({ type: 2, label: 'Link wallet', style: 5, url: linkUrl });
  }
  if (key) {
    components.push({ type: 2, custom_id: `submission:continue:${key}`, label: 'Continue', style: 1 });
  }
  return components.length ? [{ type: 1, components }] : [];
}

export function buildChangeButtons(key) {
  return [{ type: 1, components: [{ type: 2, custom_id: `submission:change:${key}`, label: 'Change', style: 2 }] }];
}

export function createSubmissionIntake({
  siteUrl = '',
  timeoutMs = SUBMISSION_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  isAdmin = () => false,
  onChoose = async () => ({ handled: true }),
} = {}) {
  const pending = new Map();

  const finish = async (record, choice, interaction, extra = {}) => {
    const key = record.key;
    if (!extra.keepPending) {
      pending.delete(key);
      clearTimer(record.timer);
    }
    const result = await onChoose({ choice, record, interaction, ...extra });
    if ((result && result.keepPending) || extra.keepPending) pending.set(key, record);
    return result;
  };

  const prompt = async (message, attachment, defaultKind) => {
    const key = submissionKey(message.id, attachment.id);
    const record = {
      key,
      message,
      messageId: message.id,
      channelId: message.channelId,
      attachmentId: attachment.id,
      attachment,
      defaultKind,
      authorId: message.author.id,
      defaultUrl: siteUrl,
    };
    pending.set(key, record);
    record.timer = setTimer(() => {
      const current = pending.get(key);
      if (!current) return;
      finish(current, current.defaultKind, null, { timedOut: true }).catch(() => {});
    }, timeoutMs);
    record.timer?.unref?.();
    await message.reply({
      content: buildSubmissionPrompt({ filename: attachment.name || 'file', mediaKind: submissionMediaKind(attachment) }),
      components: buildSubmissionButtons(key, defaultKind),
      allowedMentions: { parse: [] },
    });
    return record;
  };

  return {
    pending,
    async prompt(message, attachment, defaultKind) {
      if (!attachment || !message) return null;
      if (attachment.size > DISCORD_UPLOAD_MAX_BYTES) {
        const components = siteUrl ? [{
          type: 1,
          components: [{ type: 2, label: 'Open DVert panel', style: 5, url: siteUrl }],
        }] : [];
        await message.reply({
          content: 'This file is too big for Discord. Upload it here:',
          components,
          allowedMentions: { parse: [] },
        }).catch(() => {});
        return null;
      }
      return prompt(message, attachment, defaultKind);
    },
    async handleInteraction(interaction) {
      if (!interaction.isButton?.() || !interaction.customId?.startsWith('submission:')) return false;
      const [, action, key, choice] = interaction.customId.split(':');
      const record = pending.get(key);
      if (!record) {
        await interaction.reply({ content: 'This upload is no longer pending.', flags: EPHEMERAL }).catch(() => {});
        return true;
      }
      const allowed = interaction.user.id === record.authorId || isAdmin(interaction);
      if (!allowed) {
        await interaction.reply({ content: 'Only the uploader can choose.', flags: EPHEMERAL }).catch(() => {});
        return true;
      }
      if (action === 'change') {
        pending.delete(key);
        clearTimer(record.timer);
        return onChoose({ choice: 'change', record, interaction });
      }
      if (action === 'continue') {
        return finish(record, record.defaultKind, interaction, { resume: true });
      }
      if (action === 'choice' && (choice === 'song' || choice === 'advert')) {
        return finish(record, choice, interaction);
      }
      return false;
    },
    complete(key) {
      const record = pending.get(key);
      if (!record) return null;
      pending.delete(key);
      clearTimer(record.timer);
      return record;
    },
  };
}
