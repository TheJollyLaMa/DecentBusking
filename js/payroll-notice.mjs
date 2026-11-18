import { isAdminWallet } from './admin-access.mjs';

export function initPayrollNotice({ document = globalThis.document, window = globalThis.window,
  isAdmin = () => isAdminWallet(), fetchQueue = () => window.fetch(
    'https://raw.githubusercontent.com/TheJollyLaMa/DecentBusking/main/payroll-queue.json',
    { cache: 'no-store', credentials: 'omit' }),
} = {}) {
  let generation = 0, pending = false;
  const publish = detail => document.dispatchEvent(new window.CustomEvent('payroll-queue-status', { detail }));
  async function refresh() {
    if (!isAdmin()) {
      generation++;
      publish({ count: 0 });
      return;
    }
    if (pending || document.hidden) return;
    const attempt = generation;
    pending = true;
    try {
      const response = await fetchQueue();
      if (!response.ok) throw new Error(`Payroll queue unavailable (${response.status})`);
      const queue = await response.json();
      if (!Array.isArray(queue.pending)) throw new Error('Invalid payroll pending queue');
      const count = queue.pending.filter(entry =>
        entry && entry.currency && entry.currency !== 'ETH' && !entry.retainedInFund).length;
      if (attempt === generation && isAdmin()) publish({ count });
    } catch (error) {
      if (attempt === generation && isAdmin()) {
        console.warn('[payroll-notice]', error.message);
        publish({ count: null, error: 'Queue unavailable; open Payroll and retry.' });
      }
    } finally { pending = false; }
  }
  const changed = () => { generation++; void refresh(); };
  document.addEventListener('wallet-connected', changed);
  document.addEventListener('wallet-disconnected', changed);
  document.addEventListener('visibilitychange', refresh);
  const timer = window.setInterval(refresh, 60000);
  void refresh();
  return () => {
    generation++;
    window.clearInterval(timer);
    document.removeEventListener('wallet-connected', changed);
    document.removeEventListener('wallet-disconnected', changed);
    document.removeEventListener('visibilitychange', refresh);
  };
}

if (typeof document !== 'undefined') initPayrollNotice();
