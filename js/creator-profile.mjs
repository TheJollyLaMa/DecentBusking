import { buildCreatorAuthorizationMessage, creatorImageURL, creatorPresentation, normalizeCreatorProfile, resolveCreatorENS } from './creator-profile-data.mjs';
import { createBrowserIpfsUploader } from './ipfs-upload.js';

export const CREATOR_ALBUM_ABI = [
  'function getAlbum(bytes32) view returns ((address mainOwner,string title,string manifestURI,uint256 revision,uint256 listenPrice,uint256 albumPrice,address[] recipients,uint16[] sharesBps,string[] positions,bytes32[] songIds))',
  'function createAlbum(bytes32,string,string,address[],uint16[],string[],uint256,uint256)',
  'function updateAlbumOwners(bytes32,address[],uint16[],string[],bytes[])',
  'function updateAlbumManifest(bytes32,string)',
  'function updateAlbumFees(bytes32,uint256,uint256)',
  'function syncAlbumSongSplits(bytes32,bytes32[])',
];

export function parseCreatorSplits(text) {
  const entries = text.trim().split('\n').filter(Boolean).map(line => {
    const [address, percent, ...positionParts] = line.split(',').map(value => value.trim());
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || '') || !/^\d{1,3}(?:\.\d{1,2})?$/.test(percent || '')) throw new Error('Enter wallet, percentage, credit title on each line');
    const [whole, fraction = ''] = percent.split('.');
    const shares = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    const position = positionParts.join(', ');
    if (shares < 1 || shares > 10000 || position.length > 80) throw new Error('Invalid percentage or credit title');
    return { address, shares, position };
  });
  if (!entries.length || entries.length > 16 || entries.reduce((sum, entry) => sum + entry.shares, 0) !== 10000 ||
      new Set(entries.map(entry => entry.address.toLowerCase())).size !== entries.length) throw new Error('Use 1-16 distinct wallets with percentages totaling 100');
  return { recipients: entries.map(entry => entry.address), shares: entries.map(entry => entry.shares), positions: entries.map(entry => entry.position) };
}

export function initCreatorProfile() {
  const dialog = document.getElementById('creator-profile');
  if (!dialog) return;
  const status = dialog.querySelector('[data-profile-status]');
  const form = dialog.querySelector('[data-profile-form]');
  const albumForm = dialog.querySelector('[data-album-form]');
  const value = name => form.elements.namedItem(name).value;
  const albumValue = name => albumForm.elements.namedItem(name).value;
  let address = '';
  let profile = {};
  let ens = null;
  let revision = 0;
  let album = null;
  let busy = false;
  const config = () => window.DecentConfig || {};
  const service = () => String(config().ipfsUploadServiceUrl || '').replace(/\/$/, '');
  const editable = () => address && window._wallet?.address?.toLowerCase() === address.toLowerCase();
  const message = text => { status.textContent = text; };
  const signer = () => {
    if (!editable() || !window._wallet?.signer) throw new Error('Connect the profile wallet in the page header');
    return window._wallet.signer;
  };
  const albumContract = () => {
    if (config().djukeContractVersion !== '0.2') throw new Error('Album management requires the tested DJuke v0.2 deployment');
    return new ethers.Contract(config().djukeContractAddress, CREATOR_ALBUM_ABI, signer());
  };
  const requireBase = async () => {
    if (Number((await signer().provider.getNetwork()).chainId) !== 8453) throw new Error('Switch to Base');
  };
  const setControls = () => {
    form.querySelectorAll('input, textarea, button').forEach(element => { element.disabled = busy || !editable(); });
    dialog.querySelector('[data-discord-link]').disabled = busy || !editable();
    albumForm.querySelectorAll('input, textarea, button').forEach(element => {
      element.disabled = busy || !editable() || config().djukeContractVersion !== '0.2';
    });
  };
  const display = () => {
    const presentation = creatorPresentation(profile, ens);
    dialog.querySelector('[data-profile-name]').textContent = presentation.name;
    dialog.querySelector('[data-profile-ens]').textContent = ens?.name || '';
    dialog.querySelector('[data-profile-discord]').textContent = profile.discord ? `Discord verified: ${profile.discord.displayName}` : 'Discord not linked';
    for (const kind of ['avatar', 'banner']) {
      const image = dialog.querySelector(`[data-profile-${kind}]`);
      const uri = creatorImageURL(presentation[`${kind}URI`], config().ipfsGateway);
      image.hidden = !uri;
      if (uri) image.src = uri; else image.removeAttribute('src');
    }
    for (const field of ['displayName', 'bio']) form.elements.namedItem(field).value = profile[field] || '';
    setControls();
  };
  const run = async operation => {
    if (busy) return;
    busy = true;
    setControls();
    try { await operation(); } catch (error) { message(error.shortMessage || error.reason || error.message); }
    finally { busy = false; setControls(); }
  };
  const request = async (action, nextProfile = {}) => {
    const captured = address;
    const activeSigner = signer();
    const body = { address: captured, origin: window.location.origin, action, profile: normalizeCreatorProfile(nextProfile),
      nonce: crypto.randomUUID(), issuedAt: new Date().toISOString() };
    const signature = await activeSigner.signMessage(buildCreatorAuthorizationMessage(body));
    if (!editable() || captured !== address || activeSigner !== window._wallet?.signer) throw new Error('Wallet changed; sign again');
    const endpoint = action === 'save' ? 'profile' : 'link-discord';
    const response = await fetch(`${service()}/api/creator/${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, signature }), signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Creator request failed');
    return result;
  };
  const open = async detail => {
    const target = detail?.address || window._wallet?.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(target || '')) { message('Connect your wallet in the page header'); if (!dialog.open) dialog.showModal(); return; }
    address = target;
    profile = {};
    ens = null;
    album = null;
    const check = ++revision;
    if (!dialog.open) dialog.showModal();
    display();
    message('Loading profile');
    const response = await fetch(`${service()}/api/creator/profile?${new URLSearchParams({ address })}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (check !== revision) return;
    if (response?.ok) profile = await response.json();
    display();
    message(response?.ok ? '' : 'Profile service unavailable; ENS and read-only profile remain available');
    let resolvedENS = null;
    try {
      const provider = new ethers.JsonRpcProvider(config().ensRpcUrl || 'https://ethereum-rpc.publicnode.com', 1);
      try { resolvedENS = await resolveCreatorENS(target, provider); } finally { provider.destroy(); }
    } catch { resolvedENS = null; }
    if (check !== revision) return;
    ens = resolvedENS;
    display();
    if (detail?.albumId) albumForm.elements.namedItem('albumId').value = detail.albumId;
  };
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const captured = address;
      const next = { ...normalizeCreatorProfile(profile), displayName: value('displayName'), bio: value('bio') };
      const upload = createBrowserIpfsUploader({ provider: 'pinata', serviceUrl: service(), signer: signer(),
        address, origin: window.location.origin, purpose: 'submission' });
      for (const kind of ['avatar', 'banner']) {
        const file = form.elements.namedItem(kind).files[0];
        if (file) {
          if (file.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Use PNG, JPEG, WebP or GIF up to 10 MB');
          message(`Pinning ${kind} to IPFS`);
          next[`${kind}URI`] = await upload(file);
        }
        if (address !== captured || !editable()) throw new Error('Wallet changed during upload');
      }
      const result = await request('save', next);
      profile = result.profile;
      form.elements.namedItem('avatar').value = '';
      form.elements.namedItem('banner').value = '';
      display();
      message('Profile saved');
    });
  });
  dialog.querySelector('[data-discord-link]').addEventListener('click', () => run(async () => {
    const result = await request('link-discord');
    const code = dialog.querySelector('[data-discord-code]');
    code.textContent = `/creator-link code:${result.code}`;
    code.hidden = false;
    message('Confirm this private code with the Discord bot within five minutes, then refresh');
  }));
  dialog.querySelector('[data-profile-refresh]').addEventListener('click', () => run(() => open({ address })));
  dialog.querySelector('[data-profile-close]').addEventListener('click', () => { revision++; dialog.close(); });
  dialog.querySelectorAll('img').forEach(image => image.addEventListener('error', () => { image.hidden = true; }));
  const getAlbumId = () => /^0x[0-9a-fA-F]{64}$/.test(albumValue('albumId')) ? albumValue('albumId') : ethers.id(albumValue('albumId').trim());
  const loadAlbum = async () => {
    const contract = albumContract();
    if (Number((await signer().provider.getNetwork()).chainId) !== 8453) throw new Error('Switch to Base');
    album = await contract.getAlbum(getAlbumId());
    if (album.mainOwner === ethers.ZeroAddress) throw new Error('Album not found');
    albumForm.elements.namedItem('title').value = album.title;
    albumForm.elements.namedItem('manifest').value = album.manifestURI;
    albumForm.elements.namedItem('listenPrice').value = ethers.formatUnits(album.listenPrice, 6);
    albumForm.elements.namedItem('albumPrice').value = ethers.formatUnits(album.albumPrice, 6);
    albumForm.elements.namedItem('splits').value = album.recipients.map((recipient, index) => `${recipient}, ${Number(album.sharesBps[index]) / 100}, ${album.positions[index]}`).join('\n');
    message(`Album revision ${album.revision}. ${album.mainOwner.toLowerCase() === address.toLowerCase() ? 'Manager access verified' : 'Collaborator signature access only'}`);
  };
  dialog.querySelector('[data-album-load]').addEventListener('click', () => run(loadAlbum));
  albumForm.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      const contract = albumContract();
      if (Number((await signer().provider.getNetwork()).chainId) !== 8453) throw new Error('Switch to Base');
      const split = parseCreatorSplits(albumValue('splits'));
      const transaction = await contract.createAlbum(getAlbumId(), albumValue('title'), albumValue('manifest'),
        split.recipients, split.shares, split.positions, ethers.parseUnits(albumValue('listenPrice'), 6), ethers.parseUnits(albumValue('albumPrice'), 6));
      if ((await transaction.wait())?.status !== 1) throw new Error('Album creation did not confirm');
      await loadAlbum();
    });
  });
  const proposal = async () => {
    await requireBase();
    const contract = albumContract();
    const albumId = getAlbumId();
    const current = await contract.getAlbum(albumId);
    const split = parseCreatorSplits(albumValue('splits'));
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const domain = { name: 'DecentJukeBox', version: '0.2', chainId: 8453, verifyingContract: contract.target };
    const types = { AlbumSplit: [{ name: 'albumId', type: 'bytes32' }, { name: 'revision', type: 'uint256' },
      { name: 'recipientsHash', type: 'bytes32' }, { name: 'sharesHash', type: 'bytes32' }, { name: 'positionsHash', type: 'bytes32' }] };
    const data = { albumId, revision: current.revision, recipientsHash: ethers.keccak256(coder.encode(['address[]'], [split.recipients])),
      sharesHash: ethers.keccak256(coder.encode(['uint16[]'], [split.shares])), positionsHash: ethers.keccak256(coder.encode(['string[]'], [split.positions])) };
    return { contract, current, split, domain, types, data, albumId };
  };
  dialog.querySelector('[data-album-sign]').addEventListener('click', () => run(async () => {
    const proposed = await proposal();
    if (!proposed.current.recipients.some(recipient => recipient.toLowerCase() === address.toLowerCase())) throw new Error('Only current recipients can approve a split');
    const signature = await signer().signTypedData(proposed.domain, proposed.types, proposed.data);
    dialog.querySelector('[data-album-signature]').textContent = JSON.stringify({ address, albumId: proposed.albumId, revision: String(proposed.current.revision), signature });
    message('Approval signed. Share the proposal fields and this approval with the album manager');
  }));
  dialog.querySelector('[data-album-update]').addEventListener('click', () => run(async () => {
    const proposed = await proposal();
    if (proposed.current.mainOwner.toLowerCase() !== address.toLowerCase()) throw new Error('Only the album manager can apply changes');
    const supplied = JSON.parse(albumValue('approvals') || '[]');
    if (!Array.isArray(supplied)) throw new Error('Approvals must be a JSON array');
    const approvals = proposed.current.recipients.map(recipient => {
      const approval = supplied.find(entry => entry.address?.toLowerCase() === recipient.toLowerCase());
      if (!approval || approval.albumId !== proposed.albumId || String(approval.revision) !== String(proposed.current.revision)) throw new Error('Missing current-revision approval');
      return approval.signature;
    });
    const transaction = await proposed.contract.updateAlbumOwners(proposed.albumId, proposed.split.recipients, proposed.split.shares, proposed.split.positions, approvals);
    if ((await transaction.wait())?.status !== 1) throw new Error('Split change did not confirm');
    message('Split revision confirmed; syncing songs');
    if (proposed.current.songIds.length) {
      const sync = await proposed.contract.syncAlbumSongSplits(proposed.albumId, [...proposed.current.songIds]);
      if ((await sync.wait())?.status !== 1) throw new Error('Split saved; song sync is pending. Do not resubmit approvals');
    }
    await loadAlbum();
  }));
  dialog.querySelector('[data-album-metadata]').addEventListener('click', () => run(async () => {
    await requireBase();
    const contract = albumContract();
    const current = await contract.getAlbum(getAlbumId());
    if (current.mainOwner.toLowerCase() !== address.toLowerCase()) throw new Error('Only the album manager can apply changes');
    const manifest = await contract.updateAlbumManifest(getAlbumId(), albumValue('manifest'));
    if ((await manifest.wait())?.status !== 1) throw new Error('Manifest update did not confirm');
    const fees = await contract.updateAlbumFees(getAlbumId(), ethers.parseUnits(albumValue('listenPrice'), 6), ethers.parseUnits(albumValue('albumPrice'), 6));
    if ((await fees.wait())?.status !== 1) throw new Error('Manifest saved; fee update did not confirm');
    await loadAlbum();
  }));
  dialog.querySelector('[data-album-sync]').addEventListener('click', () => run(async () => {
    await requireBase();
    const contract = albumContract();
    const current = await contract.getAlbum(getAlbumId());
    if (current.mainOwner.toLowerCase() !== address.toLowerCase()) throw new Error('Only the album manager can sync splits');
    if (!current.songIds.length) throw new Error('No album songs to sync');
    const transaction = await contract.syncAlbumSongSplits(getAlbumId(), [...current.songIds]);
    if ((await transaction.wait())?.status !== 1) throw new Error('Song split sync did not confirm');
    await loadAlbum();
  }));
  document.addEventListener('open-creator-profile', event => { run(() => open(event.detail)); });
  document.addEventListener('click', event => {
    const button = event.target.closest?.('.nft-creator-profile');
    if (button) run(() => open({ address: button.dataset.creator, albumId: button.dataset.album }));
  });
  document.getElementById('djuke-profile')?.addEventListener('click', () => { run(() => open({})); });
  document.addEventListener('wallet-disconnected', () => { revision++; setControls(); });
  document.addEventListener('wallet-connected', () => { revision++; setControls(); });
  import('https://cdn.jsdelivr.net/npm/lucide@0.468.0/+esm').then(icons => {
    for (const element of dialog.querySelectorAll('[data-profile-icon]')) {
      const icon = icons[element.dataset.profileIcon];
      if (icon) element.replaceChildren(icons.createElement(icon, { 'aria-hidden': 'true' }));
    }
  }).catch(() => {});
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCreatorProfile); else initCreatorProfile();
}