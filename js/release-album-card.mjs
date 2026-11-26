import { buildNftShareUrl, fetchNftCatalogPage } from './nft-loader.js';
import { memberships } from './release-albums.mjs';

export async function openReleaseAlbum({ album, wallet }) {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet) || typeof album !== 'string' || !album.trim()) throw Error('Invalid release album');
  const dialog = document.createElement('dialog'), title = document.createElement('h2'), status = document.createElement('p');
  const close = document.createElement('button'), list = document.createElement('ol'), controller = new AbortController();
  title.textContent = album; dialog.setAttribute('aria-label', `${album} album card`); close.textContent = 'Close album';
  close.onclick = () => dialog.close(); dialog.onclose = () => { controller.abort(); dialog.remove(); };
  status.setAttribute('role', 'status'); status.textContent = 'Loading published recordings…';
  dialog.append(title, status, list, close); document.body.append(dialog); dialog.showModal();
  try {
    let offset = 0, tracks = [];
    do {
      const page = await fetchNftCatalogPage({ config: window.DecentConfig, artist: wallet, query: album, offset, signal: controller.signal });
      for (const nft of page.nfts) {
        const m = memberships(nft).find(m => m.wallet === wallet.toLowerCase() && m.album.toLowerCase() === album.toLowerCase());
        if (m) tracks.push({ nft, position: m.position });
      }
      offset = page.nextOffset;
    } while (offset !== null);
    for (const { nft, position } of tracks.sort((a, b) => a.position - b.position)) {
      const item = document.createElement('li'), song = document.createElement('a');
      song.href = buildNftShareUrl(nft); song.textContent = nft.name || nft.title || `Track ${position}`;
      item.value = position; item.append(song); list.append(item);
    }
    status.textContent = `${tracks.length} published recording(s) · ${wallet}`;
  } catch (error) { if (!controller.signal.aborted) status.textContent = `Could not load album: ${error.message}`; }
}

export function albumButton(m) {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = m.album;
  button.addEventListener('click', () => openReleaseAlbum(m));
  return button;
}
