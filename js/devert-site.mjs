import * as radio from './radio-sync.js?v=20261030-ad-cutoff';
import { initDevertTab } from './devert-tab.mjs?v=20261024-devert-sponsored';
import { initDevertPaidQueue } from './devert-paid-queue.mjs?v=20261024-widget';
import { initDevertHistory } from './devert-history.mjs?v=20261024-widget';

function initialize() {
  initDevertTab({ radio });
  initDevertPaidQueue();
  initDevertHistory();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
