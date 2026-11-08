/** Opt-in UI data only; it never reads or compacts a real conversation. */
export function createContextFixture(sessionKey, scope) {
  const mode = new URLSearchParams(globalThis.location?.search ?? '').get('context');
  const enabled = Boolean(mode && mode !== 'unavailable' && mode !== 'new');
  const calls = { reads: 0, compactions: 0 };
  globalThis.__contextPreview = calls;
  let value = { sessionKey, revision: 'preview-context-1', canCompact: true,
    ...(mode === 'unknown' ? {} : { snapshot: { usedTokens: mode === 'over' ? 220000 : 40000, windowTokens: 200000,
      source: 'codex_token_usage', basis: 'last_request', windowKind: 'model', measuredAt: 1 } }) };
  return { enabled, mode, scope: () => scope,
    read: async () => {
      ++calls.reads;
      if (mode === 'error') throw new Error('暂时无法读取上下文');
      return { scope, value };
    },
    compact: async () => {
      ++calls.compactions;
      value = { ...value, revision: 'preview-context-2', canCompact: false,
        snapshot: { ...value.snapshot, usedTokens: 12000, windowTokens: 200000 },
        compaction: { state: 'completed', blocking: false, startedAt: 1, updatedAt: 2 } };
      return { scope, value };
    },
  };
}
