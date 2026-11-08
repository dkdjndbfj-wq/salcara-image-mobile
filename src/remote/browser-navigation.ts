/** A completed browser operation reported by the paired computer's Agent. */
export interface BrowserNavigation {
  action: 'open' | 'navigate';
  url: string;
  /** Stable, server-qualified page identity, when the browser tool exposes one. */
  pageId?: string;
}

/** Optional metadata must never break the conversation stream or execute arbitrary schemes. */
export function parseBrowserNavigation(value: unknown): BrowserNavigation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (row.action !== 'open' && row.action !== 'navigate') return;
  if (typeof row.url !== 'string' || !row.url || row.url.length > 4096 || row.url.trim() !== row.url
    || !/^https?:\/\/[^/]/i.test(row.url) || /[\\\s\p{Cc}\p{Cf}]/u.test(row.url)
    || /%(?![0-9a-f]{2})|%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(row.url)) return;
  if (row.pageId !== undefined && (typeof row.pageId !== 'string' || !row.pageId || row.pageId.length > 256
    || row.pageId.trim() !== row.pageId || /[\p{Cc}\p{Cf}]/u.test(row.pageId))) return;
  try {
    const url = new URL(row.url);
    if (!url.hostname || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return;
    return { action: row.action, url: url.toString(), ...(typeof row.pageId === 'string' ? { pageId: row.pageId } : {}) };
  } catch { return; }
}
