import { monitorEventLoopDelay } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';

export async function readContainerResources() {
  if (process.platform !== 'linux') return { available: false, reason: 'Container quotas are not available on this platform' };
  try {
    const [cpu, quota, memory, limit] = await Promise.all(['cpu.stat', 'cpu.max', 'memory.current', 'memory.max']
      .map(name => readFile(`/sys/fs/cgroup/${name}`, 'utf8')));
    const [allocation, period] = quota.trim().split(/\s+/);
    const usage = cpu.match(/^usage_usec (\d+)$/m);
    if (!usage || !Number.isFinite(Number(memory)) || Number(memory) < 0 ||
        allocation !== 'max' && (!(Number(allocation) > 0) || !(Number(period) > 0)) ||
        limit.trim() !== 'max' && !(Number(limit) > 0)) throw new Error('Invalid container resource counters');
    return { available: true, cpuUsageUs: Number(usage[1]),
      cpuLimitCores: allocation === 'max' ? null : Number(allocation) / Number(period),
      memoryBytes: Number(memory), memoryLimitBytes: limit.trim() === 'max' ? null : Number(limit) };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) console.warn('[radio-resources] CONTAINER_COUNTERS_UNREADABLE');
    return { available: false, reason: 'Container counters unavailable; process values do not establish hosting headroom' };
  }
}

export function createRadioResourceMetrics({ now = Date.now, cpuUsage = process.cpuUsage,
  memoryUsage = process.memoryUsage, histogram = monitorEventLoopDelay({ resolution: 20 }),
  readContainer = readContainerResources } = {}) {
  histogram.enable();
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
        container };
      previousContainer = container;
      previousAt = at; previousCpu = cpu; histogram.reset();
      return last;
    },
    snapshot: () => last,
    stop: () => histogram.disable(),
  };
}
