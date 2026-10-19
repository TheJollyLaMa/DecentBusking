import { id } from 'ethers';
import { radioAllocationMatchesReport, validateRadioReceipt } from '../js/radio-payroll.mjs';
import { rankTopTenSongs } from '../js/top-ten-prizes.mjs';
import { formatUsdcUnits } from '../js/usdc-format.mjs';

const same = (first, second) => typeof first === 'string' && typeof second === 'string' &&
  first.toLowerCase() === second.toLowerCase();
const snowflake = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const markerFor = week => `decentbusking-payroll-paid:${week}`;
function label(value, maximum = 32) {
  const text = String(value || 'Unknown').replace(/[\r\n\t]/g, ' ').replace(/[\\`*_~|<>\[\]()@#]/g, '');
  return text.length > maximum ? `${text.slice(0, maximum - 3)}...` : text;
}
const dollars = units => `$${formatUsdcUnits(units)}`;

export function payrollTutorialUrl(siteUrl, week) {
  if (!/^NY-\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error('Invalid payroll tutorial week');
  const url = new URL(siteUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Payroll tutorial requires an HTTP site URL');
  url.search = '';
  url.hash = '';
  url.searchParams.set('tutorial', 'payroll');
  url.searchParams.set('week', week);
  return url.href;
}

export function buildWeeklyPayrollReport({ playback, top10, report, siteUrl }) {
  const artists = new Map();
  for (const entry of playback.allocation.entries) {
    const key = entry.wallet.toLowerCase();
    const artist = artists.get(key) || { wallet: key, artist: entry.artist, amountUnits: 0n };
    artist.amountUnits += BigInt(entry.amountUnits);
    artists.set(key, artist);
  }
  const ranked = [...artists.values()].sort((first, second) => first.amountUnits === second.amountUnits
    ? first.wallet.localeCompare(second.wallet) : first.amountUnits > second.amountUnits ? -1 : 1);
  const chart = rankTopTenSongs(report.tracks).filter(song => song.votes > 0);
  const prizes = new Map(top10.allocation.entries.map(entry => [entry.trackId, entry]));
  const chartLines = chart.map(song => {
    const prize = prizes.get(song.trackId);
    return `${song.rank}. ${label(song.title)} - ${label(song.artist, 22)}: **${prize ? dollars(prize.amountUnits) : '$0.00 (not payable)'}**`;
  });
  const artistLines = ranked.slice(0, 10).map((artist, index) =>
    `${index + 1}. ${label(artist.artist)} (\`${artist.wallet.slice(0, 6)}...${artist.wallet.slice(-4)}\`): **${dollars(artist.amountUnits)}**`);
  if (ranked.length > 10) {
    const remaining = ranked.slice(10).reduce((sum, artist) => sum + artist.amountUnits, 0n);
    artistLines.push(`Plus ${ranked.length - 10} other artists: **${dollars(remaining)}** total.`);
  }
  const playbackTotal = BigInt(playback.allocation.allocatedUnits);
  const prizeTotal = BigInt(top10.allocation.allocatedUnits);
  const embed = {
    title: `Weekly Radio Payroll Paid - ${report.week}`,
    description: [
      'All payable entries in both reviewed allocations are verified on Base (2+ confirmations).',
      `**${dollars(playbackTotal + prizeTotal)} USDC paid**: Playback ${dollars(playbackTotal)}; Top 10 prizes ${dollars(prizeTotal)}.`,
      'Week closed Monday 00:00 America/New_York. Amounts displayed rounded to cents.',
      `[Payment proofs & fund walkthrough](${payrollTutorialUrl(siteUrl, report.week)})`,
    ].join('\n'),
    fields: [
      { name: 'Top 10 chart - song prizes (USDC)', value: chartLines.join('\n') || 'No positive-vote songs.' },
      { name: 'Top Playback payees - artist totals (USDC)', value: artistLines.join('\n') },
    ],
    footer: { text: markerFor(report.week) },
  };
  if (embed.fields.some(field => field.value.length > 1024) ||
      JSON.stringify(embed).length > 5500) throw new Error('Payroll report exceeds Discord embed limits');
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

export function createWeeklyPayrollReporter({ config, channelId, siteUrl, getWeeklyPayflow,
  getPaymentLedger, getReports, getChannel, restore, save, now = () => Date.now() }) {
  const records = new Map();
  let initialized = false;
  let dirty = false;
  let pending = null;
  let lastError = '';
  let lastCheckedAt = null;
  let waitingReason = '';

  async function persist() {
    if (!dirty) return;
    const uri = await save({ schemaVersion: 1, chainId: 8453, routerAddress: config.routerAddress,
      channelId, reports: [...records.values()] });
    if (!/^ipfs:\/\//.test(uri)) throw new Error('Payroll announcement checkpoint did not return an IPFS URI');
    dirty = false;
  }

  async function initialize() {
    if (!restore || !save) throw new Error('Payroll announcements require durable checkpoint storage');
    const saved = await restore();
    if (saved) {
      if (saved.schemaVersion !== 1 || saved.chainId !== 8453 ||
          !same(saved.routerAddress, config.routerAddress) || saved.channelId !== channelId ||
          !Array.isArray(saved.reports)) throw new Error('Invalid payroll announcement checkpoint');
      for (const record of saved.reports) {
        if (!/^NY-\d{4}-\d{2}-\d{2}$/.test(record.week) || records.has(record.week) ||
            !snowflake(record.afterMessageId) || (record.messageId && !snowflake(record.messageId)) ||
            !/^0x[0-9a-f]{64}$/.test(record.allocationHash || '') ||
            record.payload?.embeds?.[0]?.footer?.text !== markerFor(record.week)) {
          throw new Error('Invalid payroll announcement record');
        }
        records.set(record.week, record);
      }
    }
    initialized = true;
  }

  function paymentsComplete(allocations, ledger, report) {
    const proofs = new Map(ledger.entries.map(entry => [entry.workReference, entry]));
    let complete = true;
    for (const record of allocations) {
      const allocation = record.allocation;
      validateRadioReceipt(allocation, { routerAddress: config.routerAddress,
        assetAddress: config.assets.USDC.address, funds: config.radioFunds, report });
      if (record.metadataHash !== id(JSON.stringify(allocation)) || !/^ipfs:\/\/[^/\s]+$/.test(record.metadataUri)) {
        throw new Error('Invalid payroll allocation proof');
      }
      for (const entry of allocation.entries) {
        const proof = proofs.get(id(entry.workReferenceText));
        if (!proof || proof.verification !== 'verified') { complete = false; continue; }
        if (proof.chainId !== 8453 || !same(proof.routerAddress, config.routerAddress) ||
            !same(proof.fundId, id(allocation.fundSlug)) || !same(proof.asset, allocation.assetAddress) ||
            !same(proof.recipient, entry.wallet) || proof.amountUnits !== entry.amountUnits ||
            proof.repositoryIdHash !== id('TheJollyLaMa/DecentBusking') ||
            proof.contributorIdHash !== id(`radio-artist:${entry.wallet.toLowerCase()}`) ||
            proof.metadataUri !== record.metadataUri || proof.metadataHash !== record.metadataHash) {
          throw new Error(`Payroll payment proof does not match ${entry.workReferenceText}`);
        }
      }
    }
    return complete;
  }

  async function findPosted(channel, record) {
    let before;
    for (;;) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!messages.size) return null;
      let oldest;
      for (const message of messages.values()) {
        if (message.author?.id === channel.client.user.id &&
            message.embeds?.some(embed => embed.footer?.text === markerFor(record.week))) return message;
        if (!oldest || BigInt(message.id) < BigInt(oldest)) oldest = message.id;
      }
      if (BigInt(oldest) <= BigInt(record.afterMessageId)) return null;
      if (before && BigInt(oldest) >= BigInt(before)) throw new Error('Discord announcement history did not advance');
      before = oldest;
    }
  }

  async function update() {
    if (!initialized) await initialize();
    await persist();
    lastCheckedAt = new Date(now()).toISOString();
    const weekly = await getWeeklyPayflow();
    const ledger = await getPaymentLedger();
    if (!weekly.ready || weekly.lastError || weekly.backupPending ||
        !ledger.ready || ledger.lastError || ledger.backupPending) {
      waitingReason = 'Waiting for healthy, backed-up weekly allocations and verified payment ledger';
      return;
    }
    if (ledger.chainId !== 8453 || !same(ledger.routerAddress, config.routerAddress)) {
      throw new Error('Payroll announcement ledger does not match Base router');
    }
    const weeks = [...new Set(weekly.allocations.map(record => record.allocation.week))]
      .filter(week => /^NY-\d{4}-\d{2}-\d{2}$/.test(week)).sort();
    waitingReason = 'Waiting for both published allocations and all their verified payments';
    for (const week of weeks) {
      if (records.get(week)?.messageId) continue;
      const allocations = weekly.allocations.filter(record => record.allocation.week === week);
      const playback = allocations.find(record => record.allocation.category === 'playback');
      const top10 = allocations.find(record => record.allocation.category === 'top10');
      if (!playback || !top10) continue;
      if (allocations.length !== 2) throw new Error('Duplicate weekly payroll allocations');
      if (top10.allocation.schemaVersion < 5) continue;
      if (Date.parse(playback.allocation.endAt) > now() || Date.parse(top10.allocation.endAt) > now()) continue;
      const report = (await getReports()).find(value => value.week === week);
      if (!allocations.every(record => radioAllocationMatchesReport(report, record.allocation))) {
        throw new Error(`Payroll report no longer matches frozen allocations for ${week}`);
      }
      if (!paymentsComplete(allocations, ledger, report)) continue;
      const channel = await getChannel();
      if (channel.id !== channelId || !channel.messages?.fetch || !channel.send || !channel.client?.user?.id) {
        throw new Error('Payroll announcement channel is unavailable or not a message channel');
      }
      const allocationHash = id(JSON.stringify([playback.metadataHash, top10.metadataHash]));
      let record = records.get(week);
      if (!record) {
        const latest = await channel.messages.fetch({ limit: 1 });
        record = { week, allocationHash, afterMessageId: latest.first()?.id || '0',
          payload: buildWeeklyPayrollReport({ playback, top10, report, siteUrl }) };
        records.set(week, record);
        dirty = true;
        await persist();
      }
      if (record.allocationHash !== allocationHash) throw new Error('Payroll allocations changed after announcement preparation');
      // Recover a successful send whose response or checkpoint was lost before trying another POST.
      const message = await findPosted(channel, record) || await channel.send({ ...record.payload,
        nonce: id(markerFor(week)).slice(2, 26), enforceNonce: true });
      if (!snowflake(message.id)) throw new Error('Discord did not return a payroll announcement message ID');
      record.messageId = message.id;
      record.sentAt = new Date(now()).toISOString();
      dirty = true;
      await persist();
      waitingReason = '';
    }
  }

  function tick() {
    if (!pending) pending = update().then(() => { lastError = ''; return getState(); })
      .catch(error => { lastError = error.message; throw error; }).finally(() => { pending = null; });
    return pending;
  }
  function getState() {
    return { ready: initialized, channelId, lastCheckedAt, lastError, backupPending: dirty, waitingReason,
      reports: [...records.values()].map(({ week, messageId, sentAt }) => ({ week,
        status: messageId ? 'sent' : 'prepared', messageId, sentAt })) };
  }
  return { tick, getState };
}
