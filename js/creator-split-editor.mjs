import { MAX_CREATOR_RECIPIENTS, validateCreatorSplitRows } from './creator-splits.mjs?v=20261025-song-splits';
import { evenCreatorSplits } from './submission-media.mjs';

export function splitPercentToBps(value) {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(String(value))) throw new Error('Use percentages with at most two decimal places');
  const [whole, fraction = ''] = String(value).split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (result < 1 || result > 10000) throw new Error('Each share must be between 0.01% and 100%');
  return result;
}

export async function resolveSplitEditorRows(rows, resolveName) {
  return validateCreatorSplitRows(await Promise.all(rows.map(async row => {
    const input = row.wallet.trim();
    if (!input) throw new Error('Enter a wallet or ENS name for every collaborator');
    const wallet = /^0x[0-9a-fA-F]{40}$/.test(input) ? input : await resolveName(input);
    if (!wallet) throw new Error(`Could not resolve "${input}" to a wallet`);
    return { wallet, shareBps: splitPercentToBps(row.percent), position: row.position.trim() };
  })));
}

export function createSplitEditor(root, { resolveName, onChange = () => {} }) {
  const list = root.querySelector('[data-split-rows]');
  const total = root.querySelector('[data-split-total]');
  const add = root.querySelector('[data-split-add]');
  const even = document.createElement('button');
  even.type = 'button';
  even.textContent = 'Split evenly';
  add.after(even);
  let disabled = false;
  let generation = 0;
  const rows = () => [...list.children].map(element => ({
    wallet: element.querySelector('[data-split-wallet]').value,
    percent: element.querySelector('[data-split-percent]').value,
    position: element.querySelector('[data-split-position]').value,
  }));
  const update = () => {
    generation++;
    let sum = 0;
    let valid = true;
    for (const row of rows()) {
      try { sum += splitPercentToBps(row.percent); } catch { valid = false; }
      if (!row.wallet.trim()) valid = false;
    }
    total.textContent = `Total: ${(sum / 100).toFixed(2)}% / 100%${valid && sum === 10000 ? ' - ready to review' : ' - adjust shares to total 100%'}`;
    total.dataset.valid = String(valid && sum === 10000);
    add.disabled = disabled || list.children.length >= MAX_CREATOR_RECIPIENTS;
    onChange();
  };
  const append = ({ wallet = '', shareBps, position = '' } = {}) => {
    const row = document.createElement('div');
    row.className = 'creator-split-row';
    for (const [key, text, type, value] of [
      ['wallet', 'Wallet or ENS', 'text', wallet],
      ['position', 'Role / credit', 'text', position],
      ['percent', 'Share (%)', 'number', shareBps === undefined ? '' : String(shareBps / 100)],
    ]) {
      const label = document.createElement('label');
      label.append(document.createTextNode(text));
      const input = document.createElement('input');
      input.type = type;
      input.dataset[`split${key[0].toUpperCase()}${key.slice(1)}`] = '';
      input.value = value;
      input.required = key !== 'position';
      input.disabled = disabled;
      if (key === 'percent') { input.min = '0.01'; input.max = '100'; input.step = '0.01'; }
      if (key === 'position') input.maxLength = 80;
      if (key === 'wallet') { input.placeholder = '0x... or name.eth'; input.spellcheck = false; }
      input.addEventListener('input', () => {
        row.querySelector('[data-split-resolution]').textContent = '';
        update();
      });
      label.append(input);
      row.append(label);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.disabled = disabled;
    remove.setAttribute('aria-label', 'Remove collaborator');
    remove.addEventListener('click', () => { row.remove(); update(); });
    const resolution = document.createElement('small');
    resolution.dataset.splitResolution = '';
    row.append(remove, resolution);
    list.append(row);
  };
  add.addEventListener('click', () => {
    if (list.children.length >= MAX_CREATOR_RECIPIENTS) return;
    append();
    update();
    list.lastElementChild.querySelector('input').focus();
  });
  even.addEventListener('click', () => {
    const values = rows();
    const shares = evenCreatorSplits(values.map(row => row.wallet));
    values.forEach((row, index) => {
      list.children[index].querySelector('[data-split-percent]').value = String(shares[index].shareBps / 100);
    });
    update();
  });
  return {
    setRows(values) { list.replaceChildren(); values.forEach(append); update(); },
    setDisabled(value) {
      disabled = value;
      even.disabled = value;
      list.querySelectorAll('input, button').forEach(element => { element.disabled = value; });
      add.disabled = value || list.children.length >= MAX_CREATOR_RECIPIENTS;
    },
    async resolve() {
      const current = generation;
      const resolved = await resolveSplitEditorRows(rows(), resolveName);
      if (current !== generation) throw new Error('Collaborators changed during validation; review again');
      resolved.forEach((entry, index) => {
        list.children[index].querySelector('[data-split-resolution]').textContent = `Pays ${entry.wallet}`;
      });
      return resolved;
    },
  };
}
