import { AGENT_CHOICES, agentApiLabel, agentSessions, desktopLiveFor, fallbackAgentProfiles, groupSessionsByProject, matchesSearch, parseAgentStatus } from '../remote/projection';
import type { DeviceStatus, SessionInfo } from '../remote/client';

const api = { name: '工作 API', model: 'grok-code-fast', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_00112233445566778899' };
const session = (key: string, cwd: string, updatedAt: number, tool: 'codex' | 'claude' = 'codex', client = 'Codex App'): SessionInfo => ({
  sessionKey: key, client, cwd, tool, title: key, updatedAt, status: 'idle', controllable: true, controlSurface: 'cli',
});
const device: DeviceStatus = { deviceId: 'pc', name: 'PC', os: 'windows', online: true, lastSeen: 1, projects: [],
  tools: [{ id: 'codex', name: 'Codex', available: true }, { id: 'claude', name: 'Claude Code', available: false }] };

test('Codex, Claude Desktop and Claude Code are offered; unknown fields and credentials are dropped', () => {
  const parsed = parseAgentStatus({ agents: [
    { id: 'codex-desktop', available: true, api },
    { id: 'codex', available: true, api: { ...api, key: 'sk-private', baseUrl: 'https://private.example' }, token: 'private' },
    { id: 'rogue', available: true, api },
  ], apis: [{ id: 'api_00112233445566778899', name: '主力', models: ['gpt-5', 'sk-leak'], url: 'private' }] }, device);
  expect(parsed.agents.map((item) => item.id)).toEqual(['codex', 'claude-desktop', 'claude']);
  expect(AGENT_CHOICES.map((item) => item.id)).toEqual(['codex', 'claude-desktop', 'claude']);
  expect(parsed.agents[0].api).toEqual({ name: '工作 API', model: 'grok-code-fast', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_00112233445566778899' });
  expect(parsed.agents[1].available).toBe(false);
  expect(parsed.apis).toEqual([{ id: 'api_00112233445566778899', name: '主力', models: ['gpt-5'] }]);
  expect(JSON.stringify(parsed)).not.toContain('private');
  expect(() => parseAgentStatus({ sessions: [] })).toThrow();
});

test('an older Bridge without the new fields still works and uses the tool registration', () => {
  const parsed = parseAgentStatus({ agents: [{ id: 'codex', available: false, api: { name: '旧 API', configured: true } }] }, device);
  expect(parsed.agents[0]).toMatchObject({ available: true, api: { source: 'computer', name: '旧 API' } });
  expect(parsed.apis).toEqual([]);
  expect(fallbackAgentProfiles(device).map((item) => item.available)).toEqual([true, false, false]);
});

test('API labels never show raw addresses or keys', () => {
  for (const name of ['https://provider.example/v1', 'sk-secret', 'Bearer private', 'C:\\private', 'a'.repeat(64)]) {
    const { agents } = parseAgentStatus({ agents: [{ id: 'codex', available: true, api: { ...api, name } }] });
    expect(agents[0].api.name).toBe('');
  }
  const [codex] = parseAgentStatus({ agents: [{ id: 'codex', available: true, api: { source: 'tool' } }] }).agents;
  expect(agentApiLabel(codex)).toBe('Codex 自己的登录');
});

test('threads group by project like the Codex sidebar, newest project first, and filter by agent', () => {
  const list = [session('a', 'C:\\code\\app', 1), session('b', 'C:\\code\\web\\', 5), session('c', 'C:\\code\\app', 9), session('d', '/x', 3, 'claude', 'Claude Code'), session('e', '', 2)];
  const codex = agentSessions(list, { tool: 'codex' });
  expect(codex.map((item) => item.sessionKey)).toEqual(['a', 'b', 'c', 'e']);
  const groups = groupSessionsByProject(codex);
  expect(groups.map((group) => [group.name, group.sessions.map((item) => item.sessionKey)])).toEqual([['app', ['c', 'a']], ['web', ['b']], ['未关联项目', ['e']]]);
  expect(matchesSearch(session('Fix login', '/repo', 1), 'repo')).toBe(true);
  expect(matchesSearch(session('Fix login', '/repo', 1), 'zzz')).toBe(false);
});

test('Codex Desktop live mode is kept only for valid, unexpired thread scopes', () => {
  const key = 'codex:01a0ae56-e9f6-4933-9ad4-5e08cd7874e5';
  const live = (desktopLive: unknown) => parseAgentStatus({ agents: [{ id: 'codex', available: true, api, desktopLive }] }).agents[0];
  const ok = live({ active: true, expiresAt: Date.now() + 60_000, sessionKeys: [key, 'https://bad'] });
  expect(ok.desktopLive).toMatchObject({ expiresAt: expect.any(Number), sessionKeys: [key], capabilities: { send: false, approval: false, interrupt: false } });
  expect(desktopLiveFor(ok, key)).toBe(true);
  expect(desktopLiveFor(ok, 'codex:other')).toBe(false);
  expect(live({ active: true, expiresAt: Date.now() - 1, sessionKeys: [key] }).desktopLive).toBeUndefined();
  expect(live({ active: false, expiresAt: Date.now() + 60_000, sessionKeys: [key] }).desktopLive).toBeUndefined();
});

test('Claude Desktop lists only its Code-tab sessions and needs the Claude Code CLI to continue them', () => {
  const list = [session('claude:a', '/x', 1, 'claude', 'Claude Desktop'), session('claude:b', '/x', 2, 'claude', 'Claude Code'), session('codex:c', '/x', 3)];
  expect(agentSessions(list, { id: 'claude-desktop', tool: 'claude' }).map((item) => item.sessionKey)).toEqual(['claude:a']);
  expect(agentSessions(list, { id: 'claude', tool: 'claude' }).map((item) => item.sessionKey)).toEqual(['claude:b']);
  const desktop = (remoteSendSupported: boolean) => parseAgentStatus({ agents: [{ id: 'claude-desktop', available: true, remoteSendSupported, api }] }).agents[1];
  expect(desktop(true).available).toBe(true);
  expect(desktop(false).available).toBe(false);
});

test('only explicit native hook transport can enable approvals, never stop/image/model overrides', () => {
  const key = 'codex:01a0ae56-e9f6-4933-9ad4-5e08cd7874e5';
  const live = (approvalTransport?: string) => parseAgentStatus({ agents: [{ id: 'codex', available: true, api, desktopLive: {
    active: true, expiresAt: Date.now() + 60000, sessionKeys: [key], approvalTransport,
    capabilities: { list: true, read: true, send: true, approval: true, interrupt: true, attachments: true, modelOverride: true },
  } }] }).agents[0];
  expect(live().desktopLive?.capabilities?.approval).toBe(false);
  expect(live('unverified').desktopLive?.capabilities?.approval).toBe(false);
  expect(live('codex-hook-v1').desktopLive?.capabilities).toMatchObject({ approval: true, interrupt: false, attachments: false, modelOverride: false });
});
