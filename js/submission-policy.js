document.addEventListener('DOMContentLoaded', () => {
  const policy = document.getElementById('submission-policy-dialog');
  document.getElementById('submission-policy-open')?.addEventListener('click', () => {
    if (policy && !policy.open) policy.showModal();
  });
  document.getElementById('submission-policy-close')?.addEventListener('click', () => policy?.close());
  policy?.addEventListener('click', event => { if (event.target === policy) policy.close(); });
});