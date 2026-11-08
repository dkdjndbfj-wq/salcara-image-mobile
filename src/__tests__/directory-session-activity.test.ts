import type { AgentProfile, SessionInfo, WorkspaceMode } from '../remote/client';
import { directorySessionActivities } from '../remote/directory-session-activity';

const agent: Pick<AgentProfile, 'id' | 'tool'> = { id: 'codex', tool: 'codex' };
const session = (key: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionKey: key, title: key, tool: 'codex', client: 'Codex CLI', workspaceMode: 'code', cwd: '/project', updatedAt: 1,
  status: 'idle', controllable: true, controlSurface: 'cli', ...extra,
});
const parent = session('codex:parent');
const child = session('codex:child', { parentSessionKey: parent.sessionKey, status: 'running' });

test.each(['code', 'work'] as WorkspaceMode[])('%s recursively attributes a grandchild to its root without exposing child rows', mode => {
  const rows = [parent, { ...child, status: 'idle' as const }, session('codex:grandchild', { parentSessionKey: child.sessionKey, status: 'running' })].map(row => ({ ...row, workspaceMode: mode }));
  expect([...directorySessionActivities(rows, agent, mode)]).toEqual([[parent.sessionKey, { status: 'running', includesChildren: true }]]);
  expect(directorySessionActivities(rows.map(row => ({ ...row, status: 'idle' })), agent, mode).get(parent.sessionKey)).toEqual({ status: 'idle', includesChildren: false });
});

test('pending child approval wins over a running root and resets when it resolves', () => {
  const rows = [{ ...parent, status: 'running' as const }, child];
  expect(directorySessionActivities(rows, agent, 'code', { pending: new Set([child.sessionKey]) }).get(parent.sessionKey))
    .toEqual({ status: 'waiting_approval', includesChildren: true });
  expect(directorySessionActivities(rows, agent, 'code', { pending: new Set(['codex:other-child']) }).get(parent.sessionKey))
    .toEqual({ status: 'running', includesChildren: true });
  expect(directorySessionActivities(rows, agent, 'code', { statusFor: () => 'idle' }).get(parent.sessionKey))
    .toEqual({ status: 'idle', includesChildren: false });
});

test.each([
  { workspaceMode: 'work' }, { tool: 'claude', client: 'Claude Code' }, { controlSurface: 'desktop' },
  { controlSurface: 'read-only' }, { sessionScope: 'desktop-chat' }, { archived: true }, { parentSessionKey: 'codex:missing' },
] as Partial<SessionInfo>[])('does not attribute a foreign or unavailable child: %j', extra => {
  expect(directorySessionActivities([parent, { ...child, ...extra }], agent, 'code').get(parent.sessionKey))
    .toEqual({ status: 'idle', includesChildren: false });
});

test('does not infer relationships from a shared project or leak across computer directory calls', () => {
  expect(directorySessionActivities([parent, { ...child, parentSessionKey: undefined }], agent, 'code').get(parent.sessionKey)?.status).toBe('idle');
  expect(directorySessionActivities([parent, child], agent, 'code').get(parent.sessionKey)?.status).toBe('running');
  expect(directorySessionActivities([{ ...parent }], agent, 'code').get(parent.sessionKey)).toEqual({ status: 'idle', includesChildren: false });
});

test('a grandchild cannot cross a mismatched intermediate source, mode, or Agent', () => {
  for (const extra of [{ controlSurface: 'desktop' }, { workspaceMode: 'work' }, { tool: 'claude', client: 'Claude Code' }] as Partial<SessionInfo>[]) {
    const middle = { ...child, status: 'idle' as const, ...extra };
    const grandchild = session('codex:grandchild', { parentSessionKey: child.sessionKey, status: 'running' });
    expect(directorySessionActivities([parent, middle, grandchild], agent, 'code').get(parent.sessionKey)?.status).toBe('idle');
  }
});

test('Claude Code and Claude Desktop stay separate even though both use the Claude tool', () => {
  const root = { ...parent, sessionKey: 'claude:root', tool: 'claude', client: 'Claude Code' };
  const task = { ...child, sessionKey: 'claude:child', parentSessionKey: root.sessionKey, tool: 'claude', client: 'Claude Desktop' };
  expect(directorySessionActivities([root, task], { id: 'claude', tool: 'claude' }, 'code').get(root.sessionKey)?.status).toBe('idle');
  expect(directorySessionActivities([root, task], { id: 'claude-desktop', tool: 'claude' }, 'code').size).toBe(0);
});

test('cycles, duplicate keys and missing native ancestors cannot contribute activity', () => {
  const cycle = [{ ...child, parentSessionKey: 'codex:cycle' }, session('codex:cycle', { parentSessionKey: child.sessionKey, status: 'running' })];
  expect([...directorySessionActivities([parent, ...cycle], agent, 'code')]).toEqual([[parent.sessionKey, { status: 'idle', includesChildren: false }]]);
  expect(directorySessionActivities([parent, child, { ...child }], agent, 'code').get(parent.sessionKey)?.status).toBe('idle');
  expect(directorySessionActivities([parent, { ...parent }, child], agent, 'code').size).toBe(0);
});

test('child failures do not overwrite parent outcome and inputs remain unchanged', () => {
  const rows = [Object.freeze({ ...parent, status: 'failed' as const }), Object.freeze({ ...child, status: 'failed' as const })];
  expect(directorySessionActivities(rows, agent, 'code').get(parent.sessionKey)).toEqual({ status: 'failed', includesChildren: false });
  expect(rows[1].parentSessionKey).toBe(parent.sessionKey);
});
