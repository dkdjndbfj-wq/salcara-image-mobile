import { parseHubEvent, type HubEvent } from '../remote/client';
import { isDirectEvent, normalizeDirectEvent } from '../remote/direct-history';
import { applyEvent, EMPTY_TIMELINE, mergeHistory } from '../remote/store';

const base = { deviceId: 'pc', sessionKey: 'codex:thread', tool: 'codex', ts: 1794016800000, turnId: 'turn' };
const retryAt = 1794016860000;

test.each(['turn', 'notice'] as const)('explicit reset time survives %s through hub, direct and history reduction', type => {
  const raw = { ...base, type, ...(type === 'turn' ? { id: 'turn:turn', status: 'failed', error: 'quota' } : { id: 'notice', level: 'warn', text: 'quota', retrying: true }), errorCode: 'usage_limit', retryAt };
  const event = parseHubEvent(raw)!;
  expect(event).toMatchObject({ errorCode: 'usage_limit', retryAt });
  expect(isDirectEvent(raw, base.deviceId, base.sessionKey)).toBe(true);
  expect(normalizeDirectEvent(event, base.deviceId)).toMatchObject({ retryAt });
  expect(applyEvent(EMPTY_TIMELINE, event).items[0]).toMatchObject({ retryAt });
  expect(mergeHistory(EMPTY_TIMELINE, undefined, [event]).items[0]).toMatchObject({ retryAt });
});

test('missing reset metadata and other error categories cannot invent a retry schedule', () => {
  for (const errorCode of ['model_capacity', 'context_limit', 'unknown_execution_error', undefined]) {
    const raw = { ...base, type: 'turn' as const, status: 'failed' as const, ...(errorCode === undefined ? {} : { errorCode }), retryAt };
    expect(parseHubEvent(raw)).not.toHaveProperty('retryAt');
    expect(normalizeDirectEvent(raw, base.deviceId)).not.toHaveProperty('retryAt');
    expect(applyEvent(EMPTY_TIMELINE, raw).items[0]).toMatchObject({ retryAt: undefined });
  }
  const raw = { ...base, type: 'turn' as const, status: 'failed' as const, errorCode: 'upstream_rate_limit' };
  expect(parseHubEvent(raw)).not.toHaveProperty('retryAt');
  expect(applyEvent(EMPTY_TIMELINE, raw).items[0]).toMatchObject({ retryAt: undefined });
});

test.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER, '1794016860000'])('rejects malformed reset timestamp %s without scheduling it', value => {
  const raw = { ...base, type: 'notice', id: 'notice', level: 'warn', text: 'quota', errorCode: 'upstream_rate_limit', retryAt: value };
  expect(() => parseHubEvent(raw)).toThrow();
  expect(isDirectEvent(raw, base.deviceId, base.sessionKey)).toBe(false);
  expect(applyEvent(EMPTY_TIMELINE, raw as HubEvent).items[0]).toMatchObject({ retryAt: undefined });
});

test('a later terminal update without reset metadata clears the previous timestamp', () => {
  const event = { ...base, type: 'turn' as const, status: 'failed' as const, errorCode: 'usage_limit', retryAt };
  const previous = applyEvent(EMPTY_TIMELINE, event);
  expect(applyEvent(previous, { ...event, errorCode: 'upstream_internal_error', retryAt: undefined }).items[0]).toMatchObject({ retryAt: undefined });
});

test('later duplicate limit notices without an explicit reset do not retain an old retry schedule', () => {
  const event = { ...base, type: 'notice' as const, id: 'quota', level: 'warn' as const, text: 'rate limited', errorCode: 'upstream_rate_limit', retryAt };
  const previous = applyEvent(EMPTY_TIMELINE, event);
  const { retryAt: _previousReset, ...later } = event;
  expect(applyEvent(previous, later).items[0]).toMatchObject({ errorCode: 'upstream_rate_limit', retryAt: undefined });
});
