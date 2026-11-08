import { useEffect, useRef } from 'react';
import type { RemoteToolPreviewTarget } from './RemoteToolPreview';
import { resolveRemoteLink } from './remote-links';
import { parseBrowserNavigation, type BrowserNavigation } from './browser-navigation';

export type BrowserOpenRequest = { target: RemoteToolPreviewTarget; pageId?: string };
export type BrowserActivity = {
  id: string; status: string;
  browser?: BrowserNavigation;
};

export function workspaceBrowserTarget(value: string): RemoteToolPreviewTarget | undefined {
  const input = value.trim();
  if (!input) return;
  const url = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`;
  const result = resolveRemoteLink(url);
  if (result.kind === 'web') return { kind: result.kind, url: result.url };
  if (result.kind === 'local-service') return { kind: result.kind, url: new URL(url).toString() };
}

export function browserPageTitle(url: string): string {
  try { const parsed = new URL(url); return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname === '/' ? '' : parsed.pathname}`; }
  catch { return '浏览器'; }
}

/** A desktop page keeps its identity as it navigates; duplicate URL opens reuse a tab. */
export function matchingBrowserTab(tabs: Array<{ id: string; url?: string; pageId?: string }>, request: BrowserOpenRequest) {
  return (request.pageId ? tabs.find(tab => tab.pageId === request.pageId) : undefined)
    ?? tabs.find(tab => tab.url === request.target.url && (!request.pageId || !tab.pageId));
}

/** Only structured, completed browser operations count, never URLs in chat/command output. */
export function useBrowserActivityEvents(activities: BrowserActivity[], scope: string, onOpen: (request: BrowserOpenRequest) => void,
  persistence?: { ready: boolean; seen?: string[]; onSeen: (keys: string[]) => void }) {
  const seen = useRef({ scope, events: new Set<string>() });
  const callback = useRef(onOpen); callback.current = onOpen;
  const persistenceRef = useRef(persistence); persistenceRef.current = persistence;
  useEffect(() => {
    if (persistenceRef.current && !persistenceRef.current.ready) return;
    if (seen.current.scope !== scope) seen.current = { scope, events: new Set() };
    for (const key of persistenceRef.current?.seen ?? []) seen.current.events.add(key);
    let changed = false;
    for (const item of activities) {
      const browser = item.status === 'done' ? parseBrowserNavigation(item.browser) : undefined;
      if (!browser) continue;
      const target = workspaceBrowserTarget(browser.url);
      if (!target) continue;
      const key = JSON.stringify([item.id, browser.action, browser.pageId, target.url]);
      if (seen.current.events.has(key)) continue;
      seen.current.events.add(key);
      changed = true;
      callback.current({ target, pageId: browser.pageId });
    }
    if (changed) persistenceRef.current?.onSeen([...seen.current.events].slice(-4096));
  }, [activities, scope, persistence?.ready]);
}
