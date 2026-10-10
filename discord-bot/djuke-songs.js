// Builds the DJuke song registration manifest from the newest playlist checkpoint.
//   node djuke-songs.js ../docs/reports/djuke-songs.json
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { djukeCatalog } from './djuke.js';
import { createPinataStateStore } from './ipfs-state.js';

export function buildDjukeSongManifest(playlist) {
  const songs = djukeCatalog(playlist).map(({ songId, track }) => ({
    songId, trackId: track.trackId, title: track.title, audioURI: `ipfs://${track.ipfsCid}`,
    recipients: [track.mintRecipient], sharesBps: [10000],
  }));
  if (new Set(songs.map(song => song.songId)).size !== songs.length) throw new Error('Duplicate DJuke song IDs');
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), songs };
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: node djuke-songs.js <output.json>');
  const playlist = await createPinataStateStore({ pinataJwt: process.env.PINATA_JWT,
    filesApiUrl: process.env.PINATA_FILES_API_URL || undefined, gateway: 'https://gateway.pinata.cloud' }).restore();
  if (!Array.isArray(playlist) || !playlist.length) throw new Error('Could not restore the live playlist checkpoint');
  const manifest = buildDjukeSongManifest(playlist);
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${manifest.songs.length} DJuke songs from ${playlist.length} playlist tracks to ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
