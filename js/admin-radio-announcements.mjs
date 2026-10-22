import { radioCalendarOccurrences } from './radio-calendar.mjs';
import { announcementAuthorization, announcementHash, defaultAnnouncementReason } from './radio-announcement.mjs';

export async function requestRadioAnnouncement({ serviceUrl, signer, address, action, payload, fetchImpl = fetch, origin = window.location.origin, isCurrent = () => true }) {
  const authorization = { address, payload, contentHash: await announcementHash(payload),
    nonce: crypto.randomUUID(), expiresAt: new Date(Date.now() + 240_000).toISOString() };
  authorization.signature = await signer.signMessage(announcementAuthorization({ ...authorization, action, origin,
    occurrenceId: payload.occurrenceId, startUtc: payload.startUtc }));
  if (!isCurrent()) throw new Error('Wallet changed; reopen the admin calendar');
  const response = await fetchImpl(`${serviceUrl.replace(/\/$/, '')}/api/radio/announcements/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(authorization),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Announcement request failed (${response.status})`);
  return result;
}

function node(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text) {
  const el = node('button', text);
  el.type = 'button';
  el.className = 'admin-btn admin-btn-secondary';
  return el;
}
function receipt(container, delivery) {
  if (!delivery) return;
  const link = node('a', 'View Discord announcement');
  link.href = delivery.messageUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  container.append(node('p', `Last announced: ${new Date(delivery.announcedAt).toLocaleString()}`), link);
}

// Mounted only by the owner-only admin panel, never by the public calendar.
export function renderAdminRadioAnnouncements({ anchor, schedule, request, isCurrent }) {
  let root = anchor.parentElement.querySelector('[data-radio-announcements]');
  if (root) root.remove();
  root = node('section');
  root.dataset.radioAnnouncements = '';
  anchor.after(root);
  root.append(node('h4', 'Promote a radio-hour occurrence'), node('p', 'Select one dated occurrence, preview, then explicitly confirm. Checking a box never sends.'));
  if (schedule.ready !== true) { root.append(node('p', 'Promotion is unavailable until the shared calendar is ready.')); return; }
  const list = node('div');
  list.style.maxHeight = '18rem';
  list.style.overflowY = 'auto';
  const editor = node('div');
  root.append(list, editor);
  let selected;
  let options;
  let busy = false;
  let generation = 0;
  const occurrences = radioCalendarOccurrences(schedule, { days: 60, pastDays: 0 })
    .filter(event => event.status !== 'cancelled' && Date.parse(event.endUtc) > Date.now());
  for (const event of occurrences) {
    const label = node('label');
    label.style.display = 'block';
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.occurrenceId = event.id;
    const date = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' }).format(new Date(event.startUtc));
    label.append(checkbox, document.createTextNode(` ${event.title} — ${date} (America/New_York)`));
    list.append(label);
    checkbox.addEventListener('change', () => {
      if (busy) { checkbox.checked = selected?.id === event.id; return; }
      generation++;
      selected = checkbox.checked ? event : null;
      for (const input of list.querySelectorAll('input')) input.checked = input === checkbox && checkbox.checked;
      editor.replaceChildren();
      if (selected) edit(selected, generation);
    });
  }
  async function edit(event, version) {
    const status = node('p', 'Loading authorized Discord destination and mentionable roles…');
    status.setAttribute('role', 'status');
    editor.append(status);
    try {
      options ||= await request('options', {});
      if (!isCurrent() || generation !== version) return;
      editor.replaceChildren();
      editor.append(node('p', `Destination: #${options.channelName} (${options.channelId})`));
      const reasonLabel = node('label', 'Reason to tune in ');
      const reason = node('textarea');
      reason.maxLength = 600;
      reason.style.width = '100%';
      reason.value = defaultAnnouncementReason(event, schedule.schedule?.find(show => show.id === event.showId));
      reasonLabel.append(reason);
      const targets = node('fieldset');
      targets.append(node('legend', 'Mention targets (uncheck all for none)'));
      const controls = [];
      for (const role of [{ id: 'everyone', name: 'everyone' }, ...options.roles]) {
        const label = node('label');
        label.style.display = 'block';
        const input = node('input');
        input.type = 'checkbox';
        input.checked = role.id === 'everyone' ? options.defaultMentions.everyone : options.defaultMentions.roles.includes(role.id);
        controls.push({ id: role.id, input });
        label.append(input, document.createTextNode(` @${role.name}`));
        targets.append(label);
      }
      const repeatLabel = node('label', ' Intentionally re-announce this occurrence (may notify everyone again)');
      const repeat = node('input');
      repeat.type = 'checkbox';
      repeatLabel.prepend(repeat);
      const previewButton = button('Preview announcement');
      const previewArea = node('div');
      const history = node('div');
      receipt(history, options.deliveries[event.id]);
      editor.append(reasonLabel, targets, repeatLabel, history, previewButton, previewArea, status);
      status.textContent = 'Review the reason and mention targets, then preview.';
      const invalidate = () => previewArea.replaceChildren();
      reason.addEventListener('input', invalidate);
      targets.addEventListener('change', invalidate);
      repeat.addEventListener('change', invalidate);
      previewButton.addEventListener('click', async () => {
        busy = true;
        previewButton.disabled = true;
        for (const input of list.querySelectorAll('input')) input.disabled = true;
        reason.disabled = repeat.disabled = targets.disabled = true;
        previewArea.replaceChildren();
        status.textContent = 'Preparing current-schedule preview; authorize with your owner wallet…';
        try {
          const preview = await request('preview', { occurrenceId: event.id, startUtc: event.startUtc, reason: reason.value,
            mentions: { everyone: controls.find(role => role.id === 'everyone').input.checked,
              roles: controls.filter(role => role.id !== 'everyone' && role.input.checked).map(role => role.id) }, reannounce: repeat.checked });
          if (!isCurrent() || generation !== version) return;
          history.replaceChildren();
          receipt(history, preview.lastAnnouncement);
          const copy = node('pre', preview.content);
          copy.style.whiteSpace = 'pre-wrap';
          previewArea.append(node('p', `Will send to #${preview.channelName} (${preview.draft.channelId}). Mentions shown below WILL notify the selected targets.`), copy);
          const confirm = button('Confirm — send to Discord');
          previewArea.append(confirm);
          status.textContent = 'Preview ready. Nothing has been sent.';
          confirm.addEventListener('click', async () => {
            if (busy || !isCurrent()) return;
            busy = true;
            confirm.disabled = previewButton.disabled = true;
            reason.disabled = repeat.disabled = targets.disabled = true;
            for (const input of list.querySelectorAll('input')) input.disabled = true;
            status.textContent = 'Sending… authorize this exact preview with your owner wallet.';
            try {
              const result = await request('send', preview.draft);
              if (!isCurrent()) return;
              options.deliveries[event.id] = result.delivery;
              history.replaceChildren();
              receipt(history, result.delivery);
              status.textContent = result.duplicate ? 'Already announced — no duplicate sent.' : 'Announcement sent successfully.';
              previewArea.replaceChildren();
            } catch (error) {
              status.textContent = `${error.message} Refresh the calendar if the preview is stale; otherwise retry this confirmed preview safely.`;
            } finally {
              busy = false;
              confirm.disabled = previewButton.disabled = false;
              reason.disabled = repeat.disabled = targets.disabled = false;
              for (const input of list.querySelectorAll('input')) input.disabled = false;
            }
          });
        } catch (error) { status.textContent = `Could not preview: ${error.message}. Refresh the calendar or adjust the selection and try again.`; }
        finally {
          busy = false;
          previewButton.disabled = false;
          reason.disabled = repeat.disabled = targets.disabled = false;
          for (const input of list.querySelectorAll('input')) input.disabled = false;
        }
      });
    } catch (error) { status.textContent = `Cannot load announcement options: ${error.message}. Uncheck/reselect to retry.`; }
  }
}
