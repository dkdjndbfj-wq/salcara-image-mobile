/**
 * Copyright Wegent contributors. Licensed under Apache-2.0.
 * Source: wecode-ai/Wegent @ ac8951007b336c573ee8d34517e31ecfed047cbd.
 * See THIRD_PARTY_NOTICES.md and licenses/Wegent-APACHE-2.0.txt.
 */
// Upstream algorithms; generic tab types replace the desktop route-specific shape.
export function moveWorkspaceTab<T extends { id: string; fixed?: boolean }>(
  tabs: T[],
  sourceId: string,
  targetId: string
): T[] {
  const sourceIndex = tabs.findIndex(tab => tab.id === sourceId)
  const targetIndex = tabs.findIndex(tab => tab.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return tabs
  if (tabs[sourceIndex].fixed !== tabs[targetIndex].fixed) return tabs
  const next = [...tabs]
  const [source] = next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, source)
  return next
}

export function closeWorkspaceTab<T extends { id: string }>(
  tabs: T[],
  activeTabId: string,
  closingTabId: string,
  fallback: T
): { tabs: T[]; activeTabId: string } {
  const closingIndex = tabs.findIndex(tab => tab.id === closingTabId)
  if (closingIndex < 0) return { tabs, activeTabId }
  const remaining = tabs.filter(tab => tab.id !== closingTabId)
  if (remaining.length === 0) return { tabs: [fallback], activeTabId: fallback.id }
  if (activeTabId !== closingTabId) return { tabs: remaining, activeTabId }
  const nextActive = remaining[Math.min(closingIndex, remaining.length - 1)]
  return { tabs: remaining, activeTabId: nextActive.id }
}
