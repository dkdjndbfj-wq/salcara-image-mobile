/** Select a bounded, rotating batch so a long list of active threads cannot starve later rows. */
export function nextBackgroundSyncBatch<T>(
  items: readonly T[],
  cursorKey: string | null,
  inFlight: ReadonlySet<string>,
  keyOf: (item: T) => string,
  limit = 4,
): { items: T[]; cursorKey: string | null } {
  if (!items.length || !Number.isSafeInteger(limit) || limit < 1) return { items: [], cursorKey: null };
  const startAt = cursorKey ? Math.max(0, items.findIndex(item => keyOf(item) === cursorKey)) : 0;
  const selected: T[] = [];
  let scanned = 0;
  while (scanned < items.length && selected.length < limit) {
    const item = items[(startAt + scanned) % items.length];
    scanned += 1;
    if (!inFlight.has(keyOf(item))) selected.push(item);
  }
  return { items: selected, cursorKey: items[(startAt + scanned) % items.length] ? keyOf(items[(startAt + scanned) % items.length]) : null };
}
