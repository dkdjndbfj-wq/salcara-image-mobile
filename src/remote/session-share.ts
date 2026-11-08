import type { SessionInfo } from './client';
import { sessionKeyAgentId } from './projection';

/**
 * Shareable values for a remote session.  These helpers deliberately include
 * only public session metadata: API names, credentials and relay URLs never
 * belong in a copied session card.
 */
export interface SessionShareContext {
  deviceId: string;
  connectionId?: string;
  agentId?: string;
  deviceName?: string;
  agentName?: string;
}

/** Prefer an exact, observed Claude Desktop surface over its shared Claude namespace. */
export function sessionShareAgentId(session: Pick<SessionInfo, 'sessionKey' | 'tool' | 'client' | 'controlSurface' | 'sessionScope'>): string | undefined {
  const namespace = sessionKeyAgentId(session.sessionKey);
  const desktopClient = session.tool === 'claude' && session.client === 'Claude Desktop';
  if (!namespace || namespace !== session.tool && !(desktopClient && namespace === 'claude-desktop')
    || namespace === 'claude-desktop' && !desktopClient) return undefined;
  if (desktopClient) return 'claude-desktop';
  return namespace;
}

function safe(value: string, max = 512): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f\p{Cf}]/u.test(value);
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

/** A Salcara-owned deep link with exact connection, computer and Agent scope. */
export function sessionDeepLink(session: Pick<SessionInfo, 'sessionKey' | 'tool' | 'client' | 'controlSurface' | 'sessionScope'>, context: SessionShareContext): string | null {
  if (!safe(context.connectionId ?? '', 64) || !/^[a-f0-9]{64}$/.test(context.connectionId!)) return null;
  if (!safe(context.deviceId, 128) || !safe(session.sessionKey, 512) || !safe(session.tool, 64)) return null;
  const agentId = sessionShareAgentId(session);
  if (!agentId || context.agentId !== undefined && context.agentId !== agentId) return null;
  const surface = session.controlSurface;
  if (surface !== undefined && !['cli', 'desktop', 'read-only'].includes(surface)) return null;
  if (surface === 'desktop' && agentId !== 'codex' || surface === 'read-only' && agentId !== 'claude-desktop') return null;
  if (surface === 'read-only' && session.sessionScope !== 'desktop-chat' && session.sessionScope !== 'desktop-cowork') return null;
  return `salcara://remote/thread?connection=${encode(context.connectionId!)}&device=${encode(context.deviceId)}&agent=${encode(agentId)}&session=${encode(session.sessionKey)}`
    + (surface && surface !== 'cli' ? `&surface=${encode(surface)}` : '')
    + (surface === 'read-only' ? `&scope=${encode(session.sessionScope!)}` : '');
}

export function sessionInfoText(session: SessionInfo, context: SessionShareContext): string {
  const cwd = oneLine(session.cwd) || '临时任务';
  return [
    `标题：${oneLine(session.title) || '无标题对话'}`,
    `来源：${oneLine(context.agentName || session.client || session.tool)}`,
    `电脑：${oneLine(context.deviceName || context.deviceId)}`,
    `工作目录：${cwd}`,
    `状态：${session.archived ? '已归档' : session.status === 'running' ? '运行中' : session.status === 'waiting_approval' ? '待回复' : session.status === 'failed' ? '失败' : '空闲'}`,
    `会话：${oneLine(session.sessionKey)}`,
  ].join('\n');
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f\p{Cf}]+/gu, ' ').trim();
}

function markdownText(value: string): string {
  return oneLine(value).replace(/[\\`*_{}[\]()#+.!|>~-]/g, '\\$&');
}

function markdownCode(value: string): string {
  const content = oneLine(value);
  const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padded = /^`|`$|^ | $/.test(content) ? ` ${content} ` : content;
  return `${fence}${padded}${fence}`;
}

export function sessionMarkdown(session: SessionInfo, context: SessionShareContext): string {
  const title = markdownText(session.title?.trim() || '无标题对话');
  const link = sessionDeepLink(session, context) ?? '';
  const cwd = oneLine(session.cwd) || '临时任务';
  const sessionKey = oneLine(session.sessionKey);
  return [
    link ? `## [${title}](${link})` : `## ${title}`,
    '',
    `- 来源：${markdownText(context.agentName?.trim() || session.client || session.tool)}`,
    `- 电脑：${markdownText(context.deviceName?.trim() || context.deviceId)}`,
    `- 工作目录：${markdownCode(cwd)}`,
    `- 会话：${markdownCode(sessionKey)}`,
  ].join('\n');
}

export function sessionWorkingDirectory(session: Pick<SessionInfo, 'cwd'>): string {
  return session.cwd?.trim() || '';
}
