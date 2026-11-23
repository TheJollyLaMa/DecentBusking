export const TOP_TEN_MINIMUM_PRIZE_UNITS = 100001n;

function hasPayoutWallet(wallet) {
  return /^0x[0-9a-fA-F]{40}$/.test(wallet || '') && !/^0x0{40}$/i.test(wallet);
}

// A frozen multi-payee DJuke split for a song, or null for a single-wallet song.
export function songPayoutSplits(track) {
  const splits = track?.splits;
  if (!Array.isArray(splits) || splits.length < 2 || splits.length > 16) return null;
  const seen = new Set();
  let total = 0;
  for (const split of splits) {
    if (!hasPayoutWallet(split?.wallet) || !Number.isSafeInteger(split.shareBps) || split.shareBps <= 0) return null;
    const key = split.wallet.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    total += split.shareBps;
  }
  return total === 10000 ? splits.map(split => ({ wallet: split.wallet, shareBps: split.shareBps })) : null;
}

// The last payee receives the integer rounding remainder, matching DJuke playback settlement.
export function splitSongAmount(amountUnits, splits) {
  let remaining = amountUnits;
  return splits.map((split, index) => {
    const part = index === splits.length - 1 ? remaining : amountUnits * BigInt(split.shareBps) / 10000n;
    remaining -= part;
    return { ...split, amountUnits: part };
  });
}

export function rankTopTenSongs(tracks, nowPlayingId = '') {
  return tracks.filter(track => typeof track.trackId === 'string' && track.trackId && Number.isSafeInteger(track.votes) &&
    (track.plays > 0 || track.votes !== 0))
    .slice().sort((first, second) => second.votes - first.votes || second.plays - first.plays ||
      String(first.title).localeCompare(String(second.title)) || first.trackId.localeCompare(second.trackId))
    .slice(0, 10).map((track, index) => ({ ...track, rank: index + 1, nowPlaying: track.trackId === nowPlayingId }));
}

export function previewTopTenSongPayroll({ tracks, budgetUnits, minimumUnits = TOP_TEN_MINIMUM_PRIZE_UNITS, splitSongs = false }) {
  if (typeof budgetUnits !== 'bigint' || budgetUnits < 0n || typeof minimumUnits !== 'bigint' || minimumUnits < 0n) {
    throw new Error('Budgets must be nonnegative token-unit amounts');
  }
  const minimum = minimumUnits > TOP_TEN_MINIMUM_PRIZE_UNITS ? minimumUnits : TOP_TEN_MINIMUM_PRIZE_UNITS;
  const songs = rankTopTenSongs(tracks).filter(song => song.votes > 0);
  if (!songs.length || budgetUnits < minimum) return { entries: [], allocatedUnits: 0n, forfeitedUnits: 0n, remainderUnits: budgetUnits };
  const entries = [];
  let remaining = budgetUnits;
  let allocated = 0n;
  let forfeitedUnits = 0n;
  for (const song of songs) {
    const half = remaining / 2n;
    const last = song === songs.at(-1) || half < minimum;
    const amountUnits = last ? remaining : half;
    const splits = splitSongs ? songPayoutSplits(song) : null;
    const linked = Boolean(splits) || hasPayoutWallet(song.wallet);
    if (splits) {
      for (const part of splitSongAmount(amountUnits, splits)) {
        if (part.amountUnits > 0n) entries.push({ ...song, wallet: part.wallet, splitShareBps: part.shareBps,
          songAmountUnits: amountUnits, amountUnits: part.amountUnits, payable: true });
      }
    } else entries.push({ ...song, amountUnits, payable: linked });
    if (linked) allocated += amountUnits;
    else forfeitedUnits += amountUnits;
    remaining -= amountUnits;
    if (last) break;
  }
  return { entries, allocatedUnits: allocated, forfeitedUnits, remainderUnits: budgetUnits - allocated };
}