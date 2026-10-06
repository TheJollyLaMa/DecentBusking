const WALLET = /^0x[0-9a-fA-F]{40}$/;

function eligibleArtists(tracks) {
  const artists = new Map();
  for (const track of tracks) {
    if (!WALLET.test(track.wallet || '') || /^0x0{40}$/i.test(track.wallet) || !Number.isSafeInteger(track.plays) || track.plays <= 0) continue;
    const key = track.wallet.toLowerCase();
    const artist = artists.get(key) || { wallet: track.wallet, artist: track.artist, plays: 0, tracks: 0 };
    artist.plays += track.plays;
    if (!Number.isSafeInteger(artist.plays)) throw new Error('Playback total exceeds safe accounting precision');
    artist.tracks++;
    artists.set(key, artist);
  }
  return [...artists.values()].sort((first, second) => second.plays - first.plays || first.wallet.localeCompare(second.wallet));
}

function checkBudget(budgetUnits, minimumUnits) {
  if (typeof budgetUnits !== 'bigint' || budgetUnits < 0n || typeof minimumUnits !== 'bigint' || minimumUnits < 0n) {
    throw new Error('Budgets must be nonnegative token-unit amounts');
  }
}

export function previewPlaybackPayroll({ tracks, budgetUnits, minimumUnits = 0n }) {
  checkBudget(budgetUnits, minimumUnits);
  const artists = eligibleArtists(tracks);
  const totalPlays = artists.reduce((total, artist) => total + BigInt(artist.plays), 0n);
  let allocated = 0n;
  const entries = artists.map(artist => {
    const amountUnits = totalPlays ? budgetUnits * BigInt(artist.plays) / totalPlays : 0n;
    const payable = amountUnits > 0n && amountUnits >= minimumUnits;
    if (payable) allocated += amountUnits;
    return { ...artist, amountUnits, payable };
  });
  return { entries, totalPlays, allocatedUnits: allocated, remainderUnits: budgetUnits - allocated };
}

export function previewTopTenPayroll({ tracks, budgetUnits, minimumUnits = 0n }) {
  checkBudget(budgetUnits, minimumUnits);
  const artists = eligibleArtists(tracks).slice(0, 10);
  const amountUnits = artists.length ? budgetUnits / BigInt(artists.length) : 0n;
  const entries = artists.map((artist, index) => ({ ...artist, rank: index + 1, amountUnits,
    payable: amountUnits > 0n && amountUnits >= minimumUnits }));
  const allocated = entries.reduce((total, entry) => total + (entry.payable ? entry.amountUnits : 0n), 0n);
  return { entries, allocatedUnits: allocated, remainderUnits: budgetUnits - allocated };
}