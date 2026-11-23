import { createSplitEditor } from './creator-split-editor.mjs?v=20261025-song-splits';
import { renderCreatorSplitPie } from './creator-split-pie.mjs?v=20261123-split-admin-pies';
import { PENCIL_ICON } from './artwork-edit-badge.mjs';

export function createSplitTutorialSurfaces({ overlay, document: doc = document }) {
  const profile = doc.getElementById('creator-profile');
  const admin = doc.getElementById('admin-modal');
  const restore = [];
  const examples = [];
  let initialized = false;
  const remember = (node, property, value) => {
    const previous = node[property];
    restore.push(() => { node[property] = previous; });
    node[property] = value;
  };
  const note = text => {
    const node = doc.createElement('p');
    node.className = 'creator-dropdown-status split-tutorial-example-label';
    node.textContent = text;
    return node;
  };
  const exampleSong = () => {
    const original = profile.querySelector('[data-song-split-form]');
    if (!original.hidden) return original;
    const form = original.cloneNode(true);
    form.hidden = false;
    form.dataset.tutorialExample = '';
    form.prepend(note('Tutorial example — not your song, not saved. All actions are disabled.'));
    form.querySelector('[data-song-split-title]').textContent = 'Example song — collaborators & payments';
    renderCreatorSplitPie(form.querySelector('[data-song-split-current-chart]'), [
      { wallet: '0x1111111111111111111111111111111111111111', shareBps: 10000 },
    ], { label: 'Tutorial example current split', lookupName: async () => null, document: doc });
    const fieldset = form.querySelector('[data-song-split-editor]');
    fieldset.querySelector('legend').textContent = 'Proposed song split — tutorial example';
    fieldset.querySelectorAll(':scope > button:not([data-split-add])').forEach(node => node.remove());
    const editor = createSplitEditor(fieldset, {
      resolveName: async () => { throw new Error('Tutorial examples do not resolve wallets'); },
    });
    editor.setRows([
      { wallet: '0x1111111111111111111111111111111111111111', shareBps: 5000, position: 'Audio' },
      { wallet: '0x2222222222222222222222222222222222222222', shareBps: 5000, position: 'Video' },
    ]);
    editor.setDisabled(true);
    form.querySelectorAll('input, button').forEach(node => { node.disabled = true; });
    form.addEventListener('submit', event => event.preventDefault());
    original.after(form);
    examples.push(form);
    return form;
  };
  let song;
  let approval;
  const initialize = () => {
    if (initialized) return;
    if (!profile || !admin) throw new Error('The collaborator tutorial requires the full Profile and Admin panels');
    initialized = true;
    const parent = overlay.parentNode;
    restore.push(() => parent.append(overlay));
    const wasOpen = profile.open;
    restore.push(() => {
      if (!wasOpen && profile.open) profile.close();
      else if (wasOpen && !profile.open) profile.showModal();
    });
    const adminHidden = admin.classList.contains('hidden');
    restore.push(() => admin.classList.toggle('hidden', adminHidden));
    const profileScroll = profile.scrollTop;
    const adminScroller = doc.getElementById('admin-modal-inner');
    const adminScroll = adminScroller.scrollTop;
    restore.push(() => { profile.scrollTop = profileScroll; adminScroller.scrollTop = adminScroll; });
    for (const node of profile.querySelectorAll(':scope > :not(dialog)')) remember(node, 'inert', true);
    for (const node of admin.querySelectorAll('#admin-modal-inner > *')) remember(node, 'inert', true);
    const nfts = profile.querySelector('[data-my-nfts-section]');
    remember(nfts, 'hidden', false);
    remember(nfts, 'open', true);
    if (!nfts.querySelector('[data-my-nfts-items]').children.length) {
      const help = note('No songs loaded. In normal use, connect your wallet, search My songs, then choose the pie-chart edit icon. The next card shows a labeled example in the actual editor.');
      nfts.querySelector('.creator-dropdown-body').append(help);
      examples.push(help);
      const item = doc.createElement('li');
      item.className = 'creator-nft-item';
      item.dataset.tutorialExample = '';
      const art = doc.createElement('div');
      art.className = 'creator-nft-art-wrap';
      const image = doc.createElement('img');
      image.src = new URL('../img/Ens_Eth_Breathe.png', import.meta.url).href;
      image.alt = '';
      image.width = 64;
      image.height = 64;
      art.append(image);
      const copy = doc.createElement('div');
      copy.className = 'creator-nft-copy';
      const title = doc.createElement('strong');
      title.textContent = 'Tutorial example song — not your NFT';
      const tools = doc.createElement('div');
      tools.className = 'creator-nft-split-tools';
      const chart = doc.createElement('div');
      chart.className = 'creator-nft-split-mini';
      renderCreatorSplitPie(chart, [
        { wallet: '0x1111111111111111111111111111111111111111', shareBps: 10000 },
      ], { label: 'Tutorial example payout split', size: 'compact', lookupName: async () => null, document: doc });
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'creator-nft-icon creator-nft-split-edit';
      button.disabled = true;
      button.title = 'Edit collaborators and payments';
      button.setAttribute('aria-label', 'Edit collaborators and payments for tutorial example');
      button.innerHTML = PENCIL_ICON;
      tools.append(chart, button);
      copy.append(title, tools);
      item.append(art, copy);
      nfts.querySelector('[data-my-nfts-items]').append(item);
      examples.push(item);
    }
    remember(profile.querySelector('[data-song-section]'), 'open', true);
    song = exampleSong();
    approval = profile.querySelector('[data-profile-status]');
    remember(approval, 'textContent', 'Requested change waiting for admin approval.');
    const mint = doc.getElementById('admin-mint-section');
    const mintHidden = mint.classList.contains('hidden');
    restore.push(() => mint.classList.toggle('hidden', mintHidden));
    mint.classList.remove('hidden');
    remember(mint, 'open', true);
    const queue = doc.getElementById('admin-mint-queue');
    const example = doc.createElement('div');
    example.className = 'split-tutorial-example-label';
    example.append(note('Tutorial only — the actual owner queue requires owner authentication. No request is loaded or applied.'));
    const button = doc.createElement('button');
    button.type = 'button';
    button.disabled = true;
    button.textContent = 'Apply requested song split (admin only)';
    example.append(button);
    queue.prepend(example);
    examples.push(example);
  };
  return {
    show(hop) {
      initialize();
      if (hop === 5) {
        doc.body.append(overlay);
        if (profile.open) profile.close();
        admin.classList.remove('hidden');
        return doc.getElementById('admin-mint-section');
      }
      admin.classList.add('hidden');
      if (!profile.open) profile.showModal();
      profile.append(overlay);
      if (hop === 1) return profile.querySelector('[data-my-nfts-section]');
      if (hop === 2) return song.querySelector('[data-song-split-editor]');
      if (hop === 3) return song.querySelector('[data-song-split-review]');
      if (hop === 4) return approval;
      return song.querySelector('[data-song-split-current-chart]');
    },
    close() {
      if (!initialized) return;
      doc.body.append(overlay);
      examples.forEach(node => node.remove());
      restore.reverse().forEach(undo => undo());
      initialized = false;
    },
  };
}
