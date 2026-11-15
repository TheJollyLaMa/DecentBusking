export function renderAfterpartyChecklist(rows, { documentRef = globalThis.document } = {}) {
  if (!documentRef?.createElement || !Array.isArray(rows) || rows.length === 0) return null;
  const section = documentRef.createElement('details');
  section.className = 'live-afterparty-checklist';
  section.open = true;
  const summary = documentRef.createElement('summary');
  summary.textContent = 'Show, fee and recording status';
  const list = documentRef.createElement('ol');
  for (const row of rows) {
    const item = documentRef.createElement('li');
    item.setAttribute('data-state', row.state);
    const title = documentRef.createElement('strong');
    title.textContent = `${row.label}: ${row.text}`;
    item.append(title);
    if (row.detail) {
      const detail = documentRef.createElement('p');
      detail.textContent = row.detail;
      item.append(detail);
    }
    if (row.next) {
      const next = documentRef.createElement('p');
      next.className = 'live-afterparty-next';
      next.textContent = `Next: ${row.next}`;
      item.append(next);
    }
    for (const link of row.links || []) {
      const anchor = documentRef.createElement('a');
      anchor.href = link.href;
      anchor.rel = 'noopener noreferrer';
      anchor.target = '_blank';
      anchor.textContent = link.label;
      item.append(anchor);
    }
    list.append(item);
  }
  section.append(summary, list);
  return section;
}
