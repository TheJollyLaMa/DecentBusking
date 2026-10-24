// Load the site's optional celebration UI only after a confirmed payment.
export function announcePaymentCelebration(payment) {
  if (typeof document === 'undefined') return;
  import('./payment-celebration.mjs').then(module => module.announcePaymentCelebration(payment))
    .catch(error => console.warn('Payment confirmed; celebration unavailable', error));
}
