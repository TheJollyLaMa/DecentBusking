// Formats the public weekly usage receipt posted to the JukeLoop channel.
export function buildWeeklyPlayReportMessage(report) {
  const marker = `jukeloop-weekly-report:${report.week}`;
  const lines = [
    `## Weekly JukeLoop Play Report · ${report.week}`,
    `**${report.totalPlays} qualifying plays** across ${report.trackCount} songs. Weeks use UTC; plays require at least 30 audible seconds. This is a play count, not a payout statement.`,
  ];
  if (report.artists.length) {
    lines.push('', '**By artist**');
    for (const artist of report.artists.slice(0, 8)) lines.push(`• ${artist.artist}: **${artist.plays}** plays (${artist.tracks} songs)`);
  }
  if (report.tracks.length) {
    lines.push('', '**Top songs**');
    for (const track of report.tracks.slice(0, 8)) lines.push(`• ${track.title} — ${track.artist}: **${track.plays}**`);
  }
  lines.push('', `Receipt ID: \`${marker}\``);
  return lines.join('\n').slice(0, 1900);
}
