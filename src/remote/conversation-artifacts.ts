import { sha256 } from '@noble/hashes/sha2.js';
import { attachmentBytes } from './attachment-ref';
import { command, HubError, type AgentId, type Command, type Hub, type SessionInfo } from './client';
import { getRemoteState, onRemoteChange, remoteDeliveryScope, timelineKey, watchCredentials } from './store';
import { workspaceRelativePath } from './workspace-files';

export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const ARTIFACT_EDIT_MAX_BYTES = 128 * 1024;
export const ARTIFACT_CHUNK_BYTES = 64 * 1024;
export interface ArtifactDescriptor {
  id: string; path: string; name: string;
  kind: 'image' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'html' | 'text' | 'svg';
  mime: string; size: number; revision: string; updatedAt: number;
}
export interface ArtifactPayload { artifact: ArtifactDescriptor; encoding: 'utf8' | 'base64'; content: string }
export interface ArtifactPage { artifacts: ArtifactDescriptor[]; nextCursor?: string }
export interface ConversationArtifacts {
  readonly writable: boolean;
  list(cursor?: string, signal?: AbortSignal): Promise<ArtifactPage>;
  read(path: string, signal?: AbortSignal): Promise<ArtifactPayload>;
  save(path: string, text: string, expectedRevision: string, signal?: AbortSignal): Promise<ArtifactPayload>;
  dispose(): void;
}

const formats: Record<string, readonly [ArtifactDescriptor['kind'], string]> = {
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'],
  webp: ['image', 'image/webp'], gif: ['image', 'image/gif'], pdf: ['pdf', 'application/pdf'],
  docx: ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  html: ['html', 'text/html'], htm: ['html', 'text/html'], svg: ['svg', 'image/svg+xml'],
  md: ['text', 'text/markdown'], txt: ['text', 'text/plain'], json: ['text', 'application/json'],
};
const format = (path: string) => formats[path.split('.').pop()!.toLowerCase()];
const hash = (bytes: Uint8Array) => Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const revisionValid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HubError('文件成果响应无效');
  return value as Record<string, unknown>;
};
export const artifactEditable = (artifact: Pick<ArtifactDescriptor, 'path' | 'size'>) =>
  artifact.size <= ARTIFACT_EDIT_MAX_BYTES && ['text', 'html', 'svg'].includes(format(artifact.path)?.[0]);

export function parseArtifactDescriptor(value: unknown, expectedPath?: string): ArtifactDescriptor {
  const raw = record(value);
  if (!workspaceRelativePath(raw.path) || expectedPath !== undefined && raw.path !== expectedPath) throw new HubError('文件成果路径已变化');
  const type = format(raw.path);
  if (!type || raw.kind !== type[0] || raw.mime !== type[1] || raw.name !== raw.path.split('/').pop()
    || raw.id !== `artifact_${hash(new TextEncoder().encode(raw.path))}` || !revisionValid(raw.revision)
    || !Number.isSafeInteger(raw.size) || Number(raw.size) < 0 || Number(raw.size) > ARTIFACT_MAX_BYTES
    || !Number.isSafeInteger(raw.updatedAt) || Number(raw.updatedAt) < 0) throw new HubError('文件成果元数据无效');
  return { id: raw.id as string, path: raw.path, name: raw.name as string, kind: type[0], mime: type[1],
    size: raw.size as number, revision: raw.revision, updatedAt: raw.updatedAt as number };
}

export function artifactBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += 12288) {
    let part = '';
    for (let i = start; i < Math.min(start + 12288, bytes.length); i += 3) {
      const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
      part += alphabet[a >> 2] + alphabet[(a & 3) << 4 | b >> 4]
        + (i + 1 < bytes.length ? alphabet[(b & 15) << 2 | c >> 6] : '=')
        + (i + 2 < bytes.length ? alphabet[c & 63] : '=');
    }
    parts.push(part);
  }
  return parts.join('');
}

/** Transport-independent, bounded artifact protocol. The caller owns a frozen
 * computer/session/project lease. Every chunk is checked before it is exposed. */
export function createConversationArtifacts(
  send: (type: 'workspace.artifacts', payload: Record<string, unknown>) => Promise<unknown>,
  guard: () => void,
  release: () => void,
  options: { writable?: () => boolean } = {},
): ConversationArtifacts {
  let disposed = false, busy = false;
  const check = (signal?: AbortSignal) => {
    if (disposed || signal?.aborted) throw new HubError('文件读取已取消', 499, 'artifact_cancelled');
    guard();
  };
  const perform = async <T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    check(signal); if (busy) throw new HubError('文件成果正在读取，请稍后重试'); busy = true;
    try { const result = await action(); check(signal); return result; } finally { busy = false; }
  };
  return {
    get writable() { return !disposed && (options.writable?.() ?? false); },
    list: (cursor, signal) => perform(async () => {
      if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,8192}$/.test(cursor)) throw new HubError('文件成果分页位置无效');
      const reply = record(await send('workspace.artifacts', { action: 'list', ...(cursor ? { cursor } : {}) })); check(signal);
      if (!Array.isArray(reply.artifacts) || reply.artifacts.length > 50 || reply.nextCursor !== undefined
        && (typeof reply.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/.test(reply.nextCursor) || reply.nextCursor === cursor)) throw new HubError('文件成果列表无效');
      const artifacts = reply.artifacts.map(item => parseArtifactDescriptor(item));
      if (new Set(artifacts.map(item => item.path)).size !== artifacts.length) throw new HubError('文件成果列表重复');
      return { artifacts, ...(reply.nextCursor ? { nextCursor: reply.nextCursor as string } : {}) };
    }, signal),
    read: (path, signal) => perform(async () => {
      if (!workspaceRelativePath(path) || !format(path)) throw new HubError('不支持的文件成果路径');
      let descriptor: ArtifactDescriptor | undefined, bytes: Uint8Array | undefined, offset = 0;
      do {
        check(signal);
        const reply = record(await send('workspace.artifacts', { action: 'read', path, offset, length: ARTIFACT_CHUNK_BYTES,
          ...(descriptor ? { expectedRevision: descriptor.revision } : {}) })); check(signal);
        const artifact = parseArtifactDescriptor(reply.artifact, path);
        if (descriptor && JSON.stringify(artifact) !== JSON.stringify(descriptor)) throw new HubError('电脑上的文件已变化，请重新读取', 409, 'artifact_changed');
        descriptor ??= artifact;
        bytes ??= new Uint8Array(artifact.size);
        if (reply.encoding !== 'base64' || typeof reply.content !== 'string' || reply.offset !== offset
          || reply.nextOffset !== Math.min(offset + ARTIFACT_CHUNK_BYTES, artifact.size)) throw new HubError('文件分块响应无效');
        const chunk = reply.content === '' ? new Uint8Array() : attachmentBytes(reply.content, ARTIFACT_CHUNK_BYTES);
        if (chunk.length !== Number(reply.nextOffset) - offset || artifactBase64(chunk) !== reply.content
          || offset < artifact.size && chunk.length === 0) throw new HubError('文件分块长度或编码无效');
        bytes.set(chunk, offset); offset += chunk.length;
      } while (offset < descriptor.size);
      if (hash(bytes!) !== descriptor.revision) throw new HubError('文件完整性校验失败，请重新读取');
      if (['html', 'svg', 'text'].includes(descriptor.kind)) {
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (hash(new TextEncoder().encode(content)) !== descriptor.revision) throw new HubError('文件文本编码无效');
        return { artifact: descriptor, encoding: 'utf8' as const, content };
      }
      return { artifact: descriptor, encoding: 'base64' as const, content: artifactBase64(bytes!) };
    }, signal),
    save: (path, text, expectedRevision, signal) => perform(async () => {
      const bytes = new TextEncoder().encode(text);
      if (!options.writable?.()) throw new HubError('电脑尚未开放文件成果保存');
      if (!workspaceRelativePath(path) || !artifactEditable({ path, size: bytes.length }) || !revisionValid(expectedRevision)
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new HubError('只可保存 128 KB 以内的 HTML、SVG、Markdown、TXT 或 JSON');
      // Reserve space for both Hub and Direct envelopes. Quote-heavy source
      // can expand during JSON serialization even below the UTF-8 byte limit.
      if (new TextEncoder().encode(JSON.stringify({ path, text, expectedRevision })).length > 240 * 1024) throw new HubError('文件转义后的传输内容过大，请缩小内容后保存');
      const reply = record(await send('workspace.artifacts', { action: 'save', path, text, expectedRevision })); check(signal);
      if (!options.writable?.()) throw new HubError('文件保存授权已变化，请重新读取后确认结果', 499, 'workspace_scope_changed');
      const artifact = parseArtifactDescriptor(reply.artifact, path);
      if (artifact.size !== bytes.length || artifact.revision !== hash(bytes)) throw new HubError('保存结果无法确认，请重新读取文件后比较', 409, 'artifact_save_unconfirmed');
      return { artifact, encoding: 'utf8' as const, content: text };
    }, signal),
    dispose: () => { if (!disposed) { disposed = true; release(); } },
  };
}

type Selection = { deviceId: string; sessionKey: string; agentId: AgentId; surface: 'cli' | 'desktop'; expectedCwd?: string; expectedSessionKey?: string; expectedSurface?: 'cli' | 'desktop' };
export function captureConversationArtifacts(selection: Selection, onInvalidated?: () => void): ConversationArtifacts {
  const credentials = watchCredentials(), scope = remoteDeliveryScope(), controller = new AbortController();
  const { deviceId, sessionKey, agentId, surface } = selection;
  const owner: Hub | undefined = credentials?.pairToken ? { ...credentials, deviceId } : undefined;
  let disposed = false, invalidated = false;
  const profile = () => getRemoteState().agents[deviceId]?.list.find(item => item.id === agentId);
  const agentIdentity = JSON.stringify([profile()?.tool, profile()?.execution, profile()?.api,
    surface === 'desktop' ? [profile()?.desktopLive?.accountId, profile()?.desktopLive?.apiName, profile()?.desktopLive?.apiModel] : undefined]);
  const session = (): SessionInfo | undefined => {
    const state = getRemoteState(), directory = state.sessions[deviceId];
    return state.timelines[timelineKey(deviceId, sessionKey)]?.session
      ?? (surface === 'desktop' ? directory?.native?.list : directory?.list)?.find(item => item.sessionKey === sessionKey);
  };
  const cwd = selection.expectedCwd ?? session()?.cwd;
  const valid = () => {
    const state = getRemoteState(), now = watchCredentials(), info = session();
    const device = state.devices.find(item => item.deviceId === deviceId), agent = profile();
    if (disposed || invalidated || !owner || !cwd || scope !== remoteDeliveryScope() || now?.url !== owner.url || now?.pairToken !== owner.pairToken
      || selection.expectedSessionKey !== undefined && selection.expectedSessionKey !== sessionKey
      || selection.expectedSurface !== undefined && selection.expectedSurface !== surface
      || !device?.online || !device.capabilities?.includes('workspace.artifacts.v1') || !device.projects.some(project => project.path === cwd)
      || !agent || JSON.stringify([agent.tool, agent.execution, agent.api,
        surface === 'desktop' ? [agent.desktopLive?.accountId, agent.desktopLive?.apiName, agent.desktopLive?.apiModel] : undefined]) !== agentIdentity
      || info?.sessionKey !== sessionKey || info.cwd !== cwd || info.controlSurface === 'read-only'
      || (info.controlSurface === 'desktop' ? 'desktop' : 'cli') !== surface) return false;
    if (surface === 'desktop') {
      const lease = state.agents[deviceId]?.list.find(item => item.id === agentId)?.desktopLive;
      return Boolean(lease && lease.expiresAt > Date.now() && lease.capabilities?.list && lease.capabilities.read && lease.sessionKeys.includes(sessionKey));
    }
    return agent.execution !== null && (agent.execution?.controlSurface ?? 'cli') === 'cli'
      && info.tool === (agent.execution?.tool ?? agent.tool);
  };
  const guard = () => { if (!valid()) throw new HubError('电脑、会话或项目授权已变化，请重新打开文件成果', 499, 'workspace_scope_changed'); };
  const unsubscribe = onRemoteChange(() => { if (!disposed && !invalidated && !valid()) { invalidated = true; controller.abort(); onInvalidated?.(); } });
  return createConversationArtifacts(async (type, payload) => {
    guard();
    const reply = await command<unknown>(owner!, deviceId, { type, sessionKey, controlSurface: surface, expectedCwd: cwd!, ...payload } as Command, undefined, controller.signal);
    guard(); return reply;
  }, guard, () => { disposed = true; controller.abort(); unsubscribe(); }, {
    writable: () => valid() && Boolean(getRemoteState().devices.find(item => item.deviceId === deviceId)?.capabilities?.includes('workspace.artifacts.write.v1')),
  });
}
