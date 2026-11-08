import { apiProblem, executionErrorDetail } from '../remote/api-errors';
import { command, HubError, setHubFetch, type FetchLike, type HubEvent } from '../remote/client';
import { applyEvent, EMPTY_TIMELINE, mergeHistory, type Timeline } from '../remote/store';

jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => '' }));
afterEach(() => setHubFetch(null));

const base = { deviceId: 'pc', sessionKey: 'codex:target', tool: 'codex' as const, ts: 1 };

test('typed capacity failure survives command transport without automatic resend', async () => {
  const transport = jest.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: '本轮暂时无法服务', code: 'model_capacity' }) }));
  setHubFetch(transport as FetchLike);
  let failure: unknown;
  try { await command({ url: 'https://fixture.test', pairToken: 'fixture', deviceId: 'pc' }, 'pc', { type: 'session.send', sessionKey: 'codex:target', text: 'continue', controlSurface: 'cli' }); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ status: 200, code: 'model_capacity' });
  expect(apiProblem(failure)).toMatchObject({ kind: 'model_capacity' });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(apiProblem(new HubError('暂时无法连接', 503, 'model_capacity'))).toBeNull();
});

test('403 insufficient balance is classified as quota while Hub 403 stays a pairing/server error', () => {
  const provider = new HubError('unexpected status 403 Forbidden: insufficient balance, url: https://ai.example.test/responses?token=private', 200, 'upstream_forbidden');
  expect(apiProblem(provider)).toMatchObject({ kind: 'quota', message: 'API 余额不足，请充值或更换 API' });
  expect(apiProblem(new HubError('Forbidden', 403))).toBeNull();
});

test('error detail removes URL queries and credential values without hiding request diagnostics', () => {
  const safe = executionErrorDetail('unexpected status 403 Forbidden: insufficient balance, url: https://ai.example.test/responses?token=private, cf-ray: abc-SIN, request id: req-123 Authorization: Bearer super-secret api_key=another-secret');
  expect(safe).toContain('https://ai.example.test/responses');
  expect(safe).toContain('cf-ray: abc-SIN');
  expect(safe).toContain('request id: req-123');
  expect(safe).not.toContain('?token=private');
  expect(safe).not.toContain('super-secret');
  expect(safe).not.toContain('another-secret');
});

test('interrupted subagent events remain terminal against a delayed running acknowledgement', () => {
  const spawn = { ...base, type: 'tool' as const, id: 'child', kind: 'subagent' as const, title: '子任务', status: 'interrupted' as const, childSessionKeys: ['codex:child'] };
  let timeline = applyEvent(EMPTY_TIMELINE, spawn);
  timeline = applyEvent(timeline, { ...spawn, ts: 2, status: 'running' });
  expect(timeline.items).toHaveLength(1);
  expect(timeline.items[0]).toMatchObject({ kind: 'tool', status: 'interrupted' });
});

test('timeline retains typed failed turn and explicit runtime retry', () => {
  let timeline = applyEvent(EMPTY_TIMELINE, { ...base, type: 'notice', level: 'warn', text: '暂时无法服务', errorCode: 'model_capacity', retrying: true });
  timeline = applyEvent(timeline, { ...base, ts: 2, type: 'turn', turnId: 'turn', status: 'failed', error: '暂时无法服务', errorCode: 'model_capacity' });
  expect(timeline.items[0]).toMatchObject({ kind: 'notice', errorCode: 'model_capacity', retrying: true });
  expect(timeline.items[1]).toMatchObject({ kind: 'turn', status: 'failed', errorCode: 'model_capacity' });
  expect(apiProblem('暂时无法服务', 'model_capacity')).toMatchObject({ kind: 'model_capacity' });
});

test('equal text from another client or a child cannot consume the phone echo', () => {
  const local: Timeline = { ...EMPTY_TIMELINE, items: [{ kind: 'message', id: 'local', role: 'user', text: 'continue', local: true, final: true, ts: 0, clientId: 'phone-receipt' }] };
  const incoming: HubEvent = { ...base, type: 'message', id: 'other', role: 'user', text: 'continue', final: true, clientId: 'other-client' };
  let timeline = applyEvent(local, incoming);
  expect(timeline.items.map(item => item.id)).toContain('local');
  expect(mergeHistory(local, undefined, [incoming]).items.map(item => item.id)).toContain('local');
  timeline = applyEvent(timeline, { ...incoming, id: 'child', clientId: 'phone-receipt', parentId: 'child-tool' });
  expect(timeline.items.map(item => item.id)).toContain('local');
  timeline = applyEvent(timeline, { ...incoming, id: 'echo', clientId: 'phone-receipt' });
  expect(timeline.items.map(item => item.id)).not.toContain('local');
  expect(timeline.items.map(item => item.id)).toEqual(expect.arrayContaining(['other', 'child', 'echo']));
});

test('assistant phase is preserved rather than inferred from completed text', () => {
  const timeline = applyEvent(EMPTY_TIMELINE, { ...base, type: 'message', id: 'progress', role: 'assistant', text: 'still working', final: true, messagePhase: 'commentary' });
  expect(timeline.items[0]).toMatchObject({ messagePhase: 'commentary', final: true });
});
