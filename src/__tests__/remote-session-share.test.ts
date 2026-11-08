import type { SessionInfo } from '../remote/client';
import { parseSalcaraThreadLink } from '../remote/remote-links';
import { sessionDeepLink, sessionInfoText, sessionMarkdown, sessionShareAgentId, sessionWorkingDirectory } from '../remote/session-share';

const session: SessionInfo = { sessionKey: 'codex:thread-123', tool: 'codex', client: 'Codex App', title: 'Fix [orders] (mobile)', cwd: 'C:\\work\\shop',
  updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' };
const context = { connectionId: 'a'.repeat(64), deviceId: 'work-pc', deviceName: '工作电脑', agentId: 'codex', agentName: 'Codex App' };

test('deep links preserve exact pairing, computer, agent and session scope', () => {
  const link = sessionDeepLink(session, context)!;
  expect(parseSalcaraThreadLink(link)).toEqual({ connectionId: context.connectionId, deviceId: context.deviceId, agentId: 'codex', sessionKey: session.sessionKey });
  expect(sessionDeepLink(session, { ...context, connectionId: undefined })).toBeNull();
  expect(sessionDeepLink(session, { ...context, connectionId: 'bad' })).toBeNull();
  expect(sessionShareAgentId({ ...session, tool: 'claude', sessionKey: 'codex:thread-123' })).toBeUndefined();
});

test('Claude desktop links use its distinct source identity only for observed desktop sessions', () => {
  const desktop: SessionInfo = { ...session, tool: 'claude', client: 'Claude Desktop', sessionKey: 'claude:desktop-thread', controlSurface: 'read-only', sessionScope: 'desktop-chat' };
  expect(sessionShareAgentId(desktop)).toBe('claude-desktop');
  const link = sessionDeepLink(desktop, { ...context, agentId: sessionShareAgentId(desktop) });
  expect(parseSalcaraThreadLink(link!)).toMatchObject({ agentId: 'claude-desktop', sessionKey: desktop.sessionKey });
  expect(sessionShareAgentId({ ...desktop, controlSurface: 'cli' })).toBe('claude-desktop');
});

test('copy formats include actionable metadata while keeping missing paths empty', () => {
  expect(sessionInfoText(session, context)).toContain('工作目录：C:\\work\\shop');
  expect(sessionInfoText(session, context)).toContain('会话：codex:thread-123');
  expect(sessionMarkdown(session, context)).toContain('[Fix \\[orders\\] \\(mobile\\)]');
  expect(sessionMarkdown(session, context)).toContain('`C:\\work\\shop`');
  expect(sessionWorkingDirectory(session)).toBe('C:\\work\\shop');
  expect(sessionWorkingDirectory({ cwd: '  ' })).toBe('');
});
