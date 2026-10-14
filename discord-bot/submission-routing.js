export function shouldHandleDevertLoopSubmission(message, { jukeboxChannelId, vertLoopChannelId, adIntakeEnabled = false } = {}) {
  if (!message || !message.channelId) return false;
  if (message.channelId === vertLoopChannelId) return true;
  if (!adIntakeEnabled && message.channelId === jukeboxChannelId && /^!devert-ad\b/i.test(message.content || '')) return true;
  return false;
}
