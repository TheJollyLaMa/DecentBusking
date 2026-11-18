import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { Session } from 'node:inspector';

export function summarizeRadioCpuProfile(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
  const root = new URL('.', import.meta.url).href, totals = new Map();
  for (const [index, id] of (profile.samples || []).entries()) {
    let node = nodes.get(id);
    const runtimeName = ['(idle)', '(garbage collector)', '(program)'].includes(node?.callFrame.functionName)
      ? node.callFrame.functionName : '(runtime)';
    while (node && !node.callFrame.url.startsWith(root)) node = nodes.get(parents.get(node.id));
    const frame = node?.callFrame;
    const file = frame ? frame.url.slice(root.length).slice(0, 200) : '(runtime)';
    const line = frame ? frame.lineNumber + 1 : 0;
    const name = frame ? frame.functionName.slice(0, 100) || '(anonymous)' : runtimeName;
    const key = `${file}:${line}:${name}`;
    const entry = totals.get(key) || { file, line, function: name, sampledMs: 0 };
    entry.sampledMs += (profile.timeDeltas?.[index] || 0) / 1000;
    totals.set(key, entry);
  }
  return [...totals.values()].sort((a, b) => b.sampledMs - a.sampledMs).slice(0, 10);
}

function createRadioCpuDiagnostics(log) {
  const session = new Session();
  const post = (method, params = {}) => new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
  let closed = false, windows = 0;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await post('Profiler.disable'); } finally { session.disconnect(); }
  };
  session.connect();
  const ready = post('Profiler.enable').then(() => post('Profiler.setSamplingInterval', { interval: 10000 }))
    .then(() => post('Profiler.start'));
  const failed = async () => {
    log.error('[radio-resources] CPU_PROFILE_FAILED');
    await close().catch(() => log.error('[radio-resources] CPU_PROFILE_STOP_FAILED'));
  };
  void ready.catch(failed);
  return {
    async sample(maxDelayMs) {
      if (closed) return;
      try {
        await ready;
        const { profile } = await post('Profiler.stop');
        if (maxDelayMs > 500) log.info('[radio-cpu-stall]', JSON.stringify({
          eventLoopMaxMs: maxDelayMs, top: summarizeRadioCpuProfile(profile),
        }));
        if (++windows >= 10) await close();
        else await post('Profiler.start');
      } catch { await failed(); }
    },
    stop: () => { void ready.then(close).catch(failed); },
  };
}

export async function readContainerResources({ platform = process.platform, read = readFile } = {}) {
  if (platform !== 'linux') return { available: false, reason: 'Container quotas are not available on this platform' };
  try {
    const [cpu, quota, memory, limit, stat] = await Promise.all([
      ...['cpu.stat', 'cpu.max', 'memory.current', 'memory.max'].map(name => read(`/sys/fs/cgroup/${name}`, 'utf8')),
      read('/sys/fs/cgroup/memory.stat', 'utf8').catch(error => {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) console.warn('[radio-resources] MEMORY_BREAKDOWN_UNREADABLE');
        return null;
      }),
    ]);
    const [allocation, period] = quota.trim().split(/\s+/);
    const usage = cpu.match(/^usage_usec (\d+)$/m);
    if (!usage || !Number.isFinite(Number(memory)) || Number(memory) < 0 ||
        allocation !== 'max' && (!(Number(allocation) > 0) || !(Number(period) > 0)) ||
        limit.trim() !== 'max' && !(Number(limit) > 0)) throw new Error('Invalid container resource counters');
    let memoryBreakdown = { available: false };
    if (stat !== null) {
      const counters = Object.fromEntries([...stat.matchAll(/^([a-z_]+) (\d+)$/gm)].map(([, key, value]) => [key, Number(value)]));
      if (['anon', 'file', 'inactive_file'].every(key => Number.isSafeInteger(counters[key]) && counters[key] >= 0)) {
        memoryBreakdown = { available: true, anonymousBytes: counters.anon, fileBytes: counters.file,
          inactiveFileBytes: counters.inactive_file };
      } else console.warn('[radio-resources] MEMORY_BREAKDOWN_UNREADABLE');
    }
    return { available: true, cpuUsageUs: Number(usage[1]), memoryBreakdown,
      cpuLimitCores: allocation === 'max' ? null : Number(allocation) / Number(period),
      memoryBytes: Number(memory), memoryLimitBytes: limit.trim() === 'max' ? null : Number(limit) };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) console.warn('[radio-resources] CONTAINER_COUNTERS_UNREADABLE');
    return { available: false, reason: 'Container counters unavailable; process values do not establish hosting headroom' };
  }
}

export function createRadioResourceMetrics({ now = Date.now, cpuUsage = process.cpuUsage,
  memoryUsage = process.memoryUsage, histogram = monitorEventLoopDelay({ resolution: 20 }),
  readContainer = readContainerResources, profileCpu = false, log = console } = {}) {
  histogram.enable();
  const diagnostics = profileCpu ? createRadioCpuDiagnostics(log) : null;
  let previousAt = now(), previousCpu = cpuUsage(), last = null, previousContainer = null;
  return {
    async sample() {
      const at = now(), cpu = cpuUsage(), memory = memoryUsage(), elapsedMs = at - previousAt;
      if (elapsedMs <= 0) return last;
      const container = await readContainer();
      if (container.available) {
        container.cpuQuotaPercent = previousContainer?.available && container.cpuLimitCores
          ? (container.cpuUsageUs - previousContainer.cpuUsageUs) / (elapsedMs * 10 * container.cpuLimitCores) : null;
        container.memoryQuotaPercent = container.memoryLimitBytes ? container.memoryBytes / container.memoryLimitBytes * 100 : null;
      }
      last = { at, elapsedMs, cpuCorePercent: (cpu.user + cpu.system - previousCpu.user - previousCpu.system) / (elapsedMs * 10),
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, eventLoopP99Ms: histogram.percentile(99) / 1e6,
        eventLoopMaxMs: histogram.max / 1e6,
        container };
      await diagnostics?.sample(last.eventLoopMaxMs);
      previousContainer = container;
      previousAt = at; previousCpu = cpu; histogram.reset();
      return last;
    },
    snapshot: () => last,
    stop() { histogram.disable(); diagnostics?.stop(); },
  };
}
