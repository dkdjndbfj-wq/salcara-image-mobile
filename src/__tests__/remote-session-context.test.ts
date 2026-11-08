import { contextCompactionBusy, contextStateLabel, contextUsageLabel, parseSessionContext } from '../remote/session-context';

const state = () => ({ sessionKey: 'codex:s', revision: 'runtime-1', canCompact: true });
const snapshot = () => ({ usedTokens: 12000, windowTokens: 200000, source: 'codex_token_usage', basis: 'last_request', windowKind: 'model', measuredAt: 100 });
test('unknown observations never become zero usage or a fabricated percentage', () => {
  expect(contextUsageLabel(parseSessionContext(state(), 'codex:s'))).toBe('上下文 —');
  expect(contextUsageLabel(parseSessionContext({ ...state(), snapshot: { ...snapshot(), windowTokens: null } }, 'codex:s'))).toContain('12,000 tokens');
  expect(contextUsageLabel(parseSessionContext({ ...state(), snapshot: snapshot(), totalTokens: 2000000 }, 'codex:s'))).toBe('最近上下文 6%');
});
test('Claude summary is labelled estimated and retains effective window semantics', () => {
  const value = parseSessionContext({ ...state(), sessionKey: 'claude:s', snapshot: { ...snapshot(), source: 'claude_context_usage', basis: 'runtime_estimate', windowKind: 'effective', estimated: true } }, 'claude:s');
  expect(contextUsageLabel(value)).toBe('上下文 ≈ 6%');
  expect(value?.snapshot?.windowKind).toBe('effective');
});
test.each([
  { usedTokens: -1 }, { usedTokens: Infinity }, { usedTokens: 0.5 }, { usedTokens: Number.MAX_SAFE_INTEGER + 1 },
  { windowTokens: 0 }, { windowTokens: -1 }, { measuredAt: 0 }, { source: 'billing_total' }, { basis: 'total' },
  { model: 'model\nwrong' }, { windowKind: 'effective' },
])('rejects malformed or mislabelled native counters: %o', change => {
  expect(parseSessionContext({ ...state(), snapshot: { ...snapshot(), ...change } }, 'codex:s')).toBeUndefined();
});
test.each(['requested', 'running', 'completed', 'failed', 'unconfirmed'])('an occupying %s operation cannot be retried as a new compact', status => {
  const value = parseSessionContext({ ...state(), compaction: { state: status, blocking: true, startedAt: 1, updatedAt: 2 } }, 'codex:s');
  expect(value?.canCompact).toBe(false);
  expect(contextCompactionBusy(value)).toBe(true);
});
test.each(['requested', 'running', 'completed', 'failed', 'unconfirmed'])('a detached or terminal %s receipt cannot lock the current runtime', status => {
  const value = parseSessionContext({ ...state(), compaction: { state: status, blocking: false, startedAt: 1, updatedAt: 2 } }, 'codex:s');
  expect(value?.canCompact).toBe(true);
  expect(contextCompactionBusy(value)).toBe(false);
});
test('only a native completed state renders completed; error text is retained', () => {
  expect(contextStateLabel(parseSessionContext({ ...state(), compaction: { state: 'completed', blocking: false, startedAt: 1, updatedAt: 2 } }, 'codex:s'))).toBe('已压缩');
  const value = parseSessionContext({ ...state(), compaction: { state: 'failed', blocking: false, startedAt: 1, updatedAt: 2, error: '原生压缩失败' } }, 'codex:s');
  expect(value?.compaction?.error).toBe('原生压缩失败');
});
test.each([undefined, null, 'false', 0])('missing or malformed runtime occupancy is not guessed: %o', blocking => {
  expect(parseSessionContext({ ...state(), compaction: { state: 'completed', blocking, startedAt: 1, updatedAt: 2 } }, 'codex:s')).toBeUndefined();
});
test('session identity and malformed operation receipts are rejected', () => {
  expect(parseSessionContext({ ...state(), snapshot: { ...snapshot(), source: 'claude_context_usage', basis: 'runtime_estimate', windowKind: 'effective', estimated: true } }, 'codex:s')).toBeUndefined();
  expect(parseSessionContext({ ...state(), revision: '   ' }, 'codex:s')).toBeUndefined();
  expect(parseSessionContext(state(), 'codex:other')).toBeUndefined();
  expect(parseSessionContext({ ...state(), revision: '' }, 'codex:s')).toBeUndefined();
  expect(parseSessionContext({ ...state(), compaction: { state: 'completed', blocking: false, operationId: 'bad', startedAt: 1, updatedAt: 2 } }, 'codex:s')).toBeUndefined();
  expect(parseSessionContext({ ...state(), compaction: { state: 'running', blocking: true, startedAt: 2, updatedAt: 1 } }, 'codex:s')).toBeUndefined();
});
