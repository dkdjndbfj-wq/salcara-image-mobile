import { AGENT_CHOICES, agentApiFamily, agentApiLabel, agentSessions, agentSupports, desktopLiveFor, desktopApprovalFor, fallbackAgentProfiles, groupSessionsByProject, matchesSearch, parseAgentStatus, resolveAgentExecution } from '../remote/projection';
import type { DeviceStatus, SessionInfo, ToolId } from '../remote/client';

const api = { name: '工作 API', model: 'grok-code-fast', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_00112233445566778899' };
const session = (key: string, cwd: string, updatedAt: number, tool: ToolId = 'codex', client = 'Codex App'): SessionInfo => ({
  sessionKey: key, client, cwd, tool, title: key, updatedAt, status: 'idle', controllable: true, controlSurface: 'cli',
});
const device: DeviceStatus = { deviceId: 'pc', name: 'PC', os: 'windows', online: true, lastSeen: 1, projects: [],
  tools: [{ id: 'codex', name: 'Codex', available: true }, { id: 'claude', name: 'Claude Code', available: false }] };

test('native approval requires a current exact-session lease, affirmative capability and hook transport', () => {
  const desktopLive = { expiresAt: 10, sessionKeys: ['codex:task'], approvalTransport: 'codex-hook-v1' as const,
    capabilities: { list: true, read: true, send: false, interrupt: false, approval: true, attachments: false, modelOverride: false } };
  expect(desktopApprovalFor({ desktopLive }, 'codex:task', 1)).toBe(true);
  expect(desktopApprovalFor({ desktopLive }, 'codex:other', 1)).toBe(false);
  expect(desktopApprovalFor({ desktopLive }, 'codex:task', 10)).toBe(false);
  expect(desktopApprovalFor({}, 'codex:task', 1)).toBe(false);
  expect(desktopApprovalFor({ desktopLive: { ...desktopLive, approvalTransport: undefined } }, 'codex:task', 1)).toBe(false);
  expect(desktopApprovalFor({ desktopLive: { ...desktopLive, capabilities: { ...desktopLive.capabilities, approval: false } } }, 'codex:task', 1)).toBe(false);
});

test('Codex, Claude Desktop and Claude Code are offered; unknown fields and credentials are dropped', () => {
  const parsed = parseAgentStatus({ agents: [
    { id: 'codex-desktop', available: true, api },
    { id: 'codex', available: true, api: { ...api, key: 'sk-private', baseUrl: 'https://private.example' }, token: 'private' },
    { id: 'hermes', name: 'Hermes', tool: 'hermes', available: true, remoteSendSupported: true, api },
  ], apis: [{ id: 'api_00112233445566778899', name: '主力', models: ['gpt-5', 'sk-leak'], url: 'private' }] }, device);
  expect(parsed.agents.map((item) => item.id)).toEqual(['codex', 'claude-desktop', 'claude', 'hermes']);
  expect(AGENT_CHOICES.map((item) => item.id)).toEqual(['codex', 'claude-desktop', 'claude', 'deepseek-harness', 'hermes']);
  expect(fallbackAgentProfiles(device).some(item => item.id === 'hermes' || item.id === 'deepseek-harness')).toBe(false);
  expect(parsed.agents[0].api).toEqual({ name: '工作 API', model: 'grok-code-fast', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_00112233445566778899' });
  expect(parsed.agents[1].available).toBe(false);
  expect(parsed.apis).toEqual([{ id: 'api_00112233445566778899', name: '主力', models: ['gpt-5'] }]);
  expect(JSON.stringify(parsed)).not.toContain('private');
  expect(() => parseAgentStatus({ sessions: [] })).toThrow();
});

test('extension Agent metadata is preserved without inheriting a built-in adapter', () => {
  const parsed = parseAgentStatus({ agents: [{ id: 'hermes', name: 'Hermes', tool: 'hermes', apiFamily: 'shared-api', available: true, remoteSendSupported: true, capabilities: { send: true }, api }] });
  const hermes = parsed.agents[parsed.agents.length - 1];
  expect(hermes).toMatchObject({ id: 'hermes', name: 'Hermes', tool: 'hermes', apiFamily: 'shared-api', remoteSendSupported: true });
  expect(agentApiFamily(hermes)).toBe('shared-api');
  expect(agentSessions([session('hermes:1', '/x', 1, 'hermes', 'Hermes')], hermes)).toHaveLength(1);
});

test('legacy Codex Desktop control-surface records do not become a duplicate Agent', () => {
  const parsed = parseAgentStatus({ agents: [{ id: 'codex-desktop', name: 'Codex Desktop', tool: 'codex', available: true, remoteSendSupported: true }] });
  expect(parsed.agents.map((item) => item.id)).toEqual(['codex', 'claude-desktop', 'claude']);
});

test('extension capabilities are preserved explicitly and never inferred from the name', () => {
  const parsed = parseAgentStatus({ agents: [
    { id: 'hermes', name: 'Hermes', tool: 'hermes', available: true, remoteSendSupported: true,
      capabilities: { list: true, read: true, send: true, attachments: true, imageInput: true, imageOutput: true } },
    { id: 'mystery', name: 'Claude-like helper', tool: 'mystery', available: true, remoteSendSupported: true },
  ] });
  const hermes = parsed.agents.find((item) => item.id === 'hermes');
  const mystery = parsed.agents.find((item) => item.id === 'mystery');
  expect(hermes?.capabilities).toMatchObject({ list: true, read: true, send: true, attachments: true, imageInput: true, imageOutput: true, approval: false });
  expect(mystery?.capabilities).toBeUndefined();
  expect(mystery?.remoteSendSupported).toBe(false);
  const readOnly = parseAgentStatus({ agents: [{ id: 'hermes-read', name: 'Hermes Read', tool: 'hermes-read', available: true, remoteSendSupported: true,
    capabilities: { list: true, read: true, send: false } }] }).agents.find((item) => item.id === 'hermes-read');
  expect(readOnly?.remoteSendSupported).toBe(false);
});

test('duplicate adapter IDs and tool aliases cannot shadow another namespace', () => {
  expect(() => parseAgentStatus({ agents: [{ id: 'hermes', tool: 'hermes' }, { id: 'hermes', tool: 'claude' }] })).toThrow('重复');
  const result = parseAgentStatus({ agents: [{ id: 'hermes', tool: 'codex', available: true, capabilities: { send: true } },
    { id: 'hermes-desktop', tool: 'hermes-desktop', controlSurface: 'desktop', capabilities: { send: true } }] });
  expect(result.agents.map(item => item.id)).toEqual(['codex', 'claude-desktop', 'claude']);
  expect(agentApiFamily('hermes-desktop')).toBe('hermes-desktop');
});

test('an explicit built-in send prohibition overrides installation and legacy compatibility', () => {
  for (const fields of [{ remoteSendSupported: false }, { capabilities: { send: false } }]) {
    expect(parseAgentStatus({ agents: [{ id: 'codex', available: true, ...fields }] }, device).agents[0].remoteSendSupported).toBe(false);
  }
});

test('an older Bridge without the new fields still works and uses the tool registration', () => {
  const parsed = parseAgentStatus({ agents: [{ id: 'codex', api: { name: '旧 API', configured: true } }] }, device);
  expect(parsed.agents[0]).toMatchObject({ available: true, api: { source: 'computer', name: '旧 API' } });
  expect(parsed.apis).toEqual([]);
  expect(fallbackAgentProfiles(device).map((item) => item.available)).toEqual([true, false, false]);
});

test('explicit unavailable and absent adapters cannot inherit a stale installation probe', () => {
  const installed = { ...device, tools: [...device.tools, { id: 'claude', name: 'Claude Code', available: true }] };
  installed.tools = installed.tools.filter(item => item.available);
  for (const id of ['codex', 'claude', 'claude-desktop']) {
    for (const available of [false, null, 'true']) {
      const profile = parseAgentStatus({ agents: [{ id, available }] }, installed).agents.find(item => item.id === id)!;
      expect(profile.available).toBe(false);
      expect(profile.remoteSendSupported).toBe(false);
      expect(agentSupports(profile, id, 'send')).toBe(false);
    }
  }
  expect(parseAgentStatus({ agents: [] }, installed).agents.every(item => !item.available)).toBe(true);
  expect(fallbackAgentProfiles(installed).find(item => item.id === 'claude-desktop')?.available).toBe(false);
});

test('empty or malformed capabilities fail closed rather than enabling legacy operations', () => {
  for (const id of ['codex', 'claude', 'claude-desktop']) {
    for (const capabilities of [{}, null, [], 'all', { send: 'true' }]) {
      const profile = parseAgentStatus({ agents: [{ id, available: true, capabilities }] }).agents.find(item => item.id === id)!;
      expect(profile.remoteSendSupported).toBe(false);
      for (const operation of ['send', 'interrupt', 'approval', 'questions', 'attachments', 'modelOverride'] as const) {
        expect(agentSupports(profile, id, operation)).toBe(false);
      }
    }
  }
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
  const groups = groupSessionsByProject(codex, { caseSensitivePaths: false });
  expect(groups.map((group) => [group.name, group.sessions.map((item) => item.sessionKey)])).toEqual([['app', ['c', 'a']], ['web', ['b']], ['临时任务', ['e']]]);
  expect(matchesSearch(session('Fix login', '/repo', 1), 'repo')).toBe(true);
  expect(matchesSearch(session('Fix login', '/repo', 1), 'zzz')).toBe(false);
});

test('native Codex sessions group by project and keep host order within each group', () => {
  const native = [session('a1', 'C:\\work\\app', 1), session('b1', 'C:\\work\\web', 9), session('a2', 'C:\\work\\app', 3), session('temp', '', 8)];
  const groups = groupSessionsByProject(native, { nativeOrder: true, nativeSessionOrder: native.map(item => item.sessionKey), caseSensitivePaths: false });
  expect(groups.map(group => [group.name, group.sessions.map(item => item.sessionKey)])).toEqual([
    ['app', ['a1', 'a2']], ['web', ['b1']], ['临时任务', ['temp']],
  ]);
});

test('Windows project paths compare case-insensitively while case-sensitive paths stay separate', () => {
  const rows = [session('upper', 'C:\\Work\\Repo', 1), session('lower', 'c:\\work\\repo\\', 2),session('slash','C:/Work/Repo/',3)];
  expect(groupSessionsByProject(rows, { caseSensitivePaths: false })).toHaveLength(1);
  const linux = [session('upper', '/work/Repo', 1), session('lower', '/work/repo', 2)];
  expect(groupSessionsByProject(linux, { caseSensitivePaths: true }).map(group => group.sessions.map(item => item.sessionKey))).toEqual([['lower'], ['upper']]);
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

const desktopExecution = { tool: 'claude', controlSurface: 'cli', entrypoint: 'claude-desktop' };
const desktopHistory = { available: true, readOnly: true, identity: 'a'.repeat(64), scopes: ['desktop-chat', 'desktop-cowork'] };
test('explicit Claude Desktop executor routes Code independently of native read-only history', () => {
  const desktop = parseAgentStatus({ agents: [{ id: 'claude-desktop', tool: 'claude', controlSurface: 'desktop', available: true,
    execution: desktopExecution, remoteSendSupported: true, capabilities: { send: true, read: true, approval: true }, desktopHistory }] }).agents[1];
  expect(desktop).toMatchObject({ id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude', sessionScope: 'code', remoteSendSupported: true,
    execution: desktopExecution, desktopHistory });
  expect(resolveAgentExecution(desktop)).toEqual(desktopExecution);
  expect(agentSupports(desktop, desktop.id, 'approval')).toBe(true);
});

test.each([
  null, undefined, [], 'cli', {}, { ...desktopExecution, tool: 'codex' }, { ...desktopExecution, controlSurface: 'desktop' },
  { ...desktopExecution, controlSurface: 'read-only' }, { tool: 'claude', controlSurface: 'cli' },
  { ...desktopExecution, entrypoint: 'unknown' }, { ...desktopExecution, extra: 'private' },
])('explicit invalid Claude Desktop execution fails closed: %j', execution => {
  for (const history of [undefined, desktopHistory]) {
    const desktop = parseAgentStatus({ agents: [{ id: 'claude-desktop', tool: 'claude', available: true, remoteSendSupported: true,
      conversationApiSwitch: true, capabilities: { send: true, approval: true, read: true, list: true, modelOverride: true, continue: true },
      execution, ...(history ? { desktopHistory: history } : {}) }] }).agents[1];
    expect(desktop.execution).toBeNull();
    expect(resolveAgentExecution(desktop)).toBeNull();
    expect(desktop.remoteSendSupported).toBe(false);
    expect(desktop.conversationApiSwitch).toBe(false);
    expect(desktop.available).toBe(Boolean(history));
    expect(desktop.sessionScope).toBeUndefined();
    expect(agentSupports(desktop, desktop.id, 'send')).toBe(false);
    expect(agentSupports(desktop, desktop.id, 'approval')).toBe(false);
    expect(agentSupports(desktop, desktop.id, 'continue')).toBe(false);
    expect(agentSupports(desktop, desktop.id, 'read')).toBe(Boolean(history));
    expect(desktop.desktopHistory).toEqual(history);
    expect(JSON.stringify(desktop)).not.toContain('private');
  }
});

test('only omitted legacy descriptors are inferred; claimed tools and extension aliases cannot cross-route', () => {
  const desktop = parseAgentStatus({ agents: [{ id: 'claude-desktop', available: true, remoteSendSupported: true }] }).agents[1];
  expect(desktop.execution).toEqual(desktopExecution);
  expect(resolveAgentExecution(undefined, 'claude-desktop')).toEqual(desktopExecution);
  expect(resolveAgentExecution(undefined, 'hermes')).toBeNull();
  expect(resolveAgentExecution({ id: 'claude-desktop', tool: 'codex' })).toBeNull();
  expect(resolveAgentExecution({ id: 'claude-desktop', tool: 'claude', execution: null }, 'claude')).toBeNull();
  for (const id of ['codex', 'claude-desktop', 'claude', 'hermes']) {
    const tool = id === 'claude-desktop' ? 'claude' : id;
    const parsed = parseAgentStatus({ agents: [{ id, tool, available: true, remoteSendSupported: true,
      capabilities: { send: true }, execution: { tool: 'wrong-adapter', controlSurface: 'cli' } }] });
    const profile = parsed.agents.find(item => item.id === id)!;
    expect(profile.execution).toBeNull();
    expect(profile.remoteSendSupported).toBe(false);
    expect(resolveAgentExecution(profile)).toBeNull();
  }
  expect(parseAgentStatus({ agents: [{ id: 'claude-desktop', tool: 'codex', available: true,
    remoteSendSupported: true, execution: desktopExecution }] }).agents[1].remoteSendSupported).toBe(false);
  const hermes = parseAgentStatus({ agents: [{ id: 'hermes', tool: 'hermes', available: true, remoteSendSupported: true,
    capabilities: { send: true } }] }).agents.find(item => item.id === 'hermes')!;
  expect(resolveAgentExecution(hermes)).toEqual({ tool: 'hermes', controlSurface: 'cli' });
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
