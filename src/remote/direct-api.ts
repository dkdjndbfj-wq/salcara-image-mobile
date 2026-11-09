import { randomUUID } from 'expo-crypto';

import type { Command } from './client';
import type { ComputerManagementCommand } from './direct-computer-management';

// Credential-bearing management commands deliberately do not join the Hub
// Command union. Only this authenticated direct transport can send them.
type DirectCommand = Command | ComputerManagementCommand;
import {
  getDirectConnectionState,
  sendDirectPayload,
  subscribeDirectConnection,
  subscribeDirectMessages,
} from './direct-pairing';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PENDING = 32;
const MAX_FRAME_BYTES = 256 * 1024;
const stringFields = new Set(['expectedMessageId','agent', 'accountId', 'model', 'sessionKey', 'targetHubUrl', 'targetDeviceId', 'targetComputerId', 'terminalId', 'pageId', 'url', 'operationId', 'tool', 'client', 'cursor', 'controlSurface', 'historyIdentity', 'cwd', 'expectedCwd', 'path', 'prompt', 'workspaceMode', 'effort', 'approval', 'permissionMode', 'collaborationMode', 'entrypoint', 'cooperationTicket', 'sourceSessionKey', 'text', 'id', 'mime', 'data', 'expectedTurnId', 'approvalId', 'decision', 'message', 'ifRevision', 'chainId', 'expectedRevision', 'question', 'previousOperationId', 'kind', 'action', 'name', 'destination', 'downloadId', 'branch', 'title', 'body', 'reviewScope', 'reviewRef', 'sourceDiff', 'patchRevision', 'hunk', 'operation', 'repositoryPath']);
const integerFields = new Set(['limit', 'messageLimit', 'index', 'total', 'offset', 'length', 'pageSize', 'tokenBudget', 'syncVersion', 'cols', 'rows', 'sequence', 'width', 'height']);
const booleanFields = new Set(['sourceOnly', 'refresh', 'force', 'capture']);
const arrayFields = new Set(['skills', 'contextReferences', 'attachments']);
const objectFields = new Set(['answers', 'target', 'selection', 'input']);
const projectPreviewStrings = new Set(['sourcePath', 'projectPath', 'script', 'manifestRevision', 'runId']);

export type DirectApiErrorCode = 'disconnected' | 'timeout' | 'remote' | 'protocol' | 'busy';

export class DirectApiError extends Error {
  constructor(readonly code: DirectApiErrorCode, message: string) {
    super(message);
    this.name = 'DirectApiError';
  }
}

export interface DirectEventEnvelope {
  event: string;
  data: unknown;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: DirectApiError): void;
  timer: ReturnType<typeof setTimeout>;
  deviceId: string;
};

// This is intentionally the complete set of command discriminants in the
// existing Command union. The bridge remains responsible for authorization
// and full per-command validation; the phone never forwards arbitrary frames.
type CommandSchema = { keys: readonly string[]; required: readonly string[] };
const commandSchemas: Record<DirectCommand['type'], CommandSchema> = {
  'workspace.projects': { keys: ['type', 'controlSurface', 'tool', 'workspaceMode', 'action', 'cwd', 'path', 'cursor', 'name'], required: ['type', 'controlSurface', 'tool', 'workspaceMode', 'action', 'cwd', 'path'] },
  'computer.management.status': { keys: ['type', 'controlSurface'], required: ['type', 'controlSurface'] },
  'computer.api.create': { keys: ['type', 'controlSurface', 'requestId', 'name', 'baseUrl', 'key', 'wire', 'authMode', 'models'], required: ['type', 'controlSurface', 'requestId', 'name', 'baseUrl', 'key', 'wire', 'authMode', 'models'] },
  'computer.agent.install': { keys: ['type', 'controlSurface', 'requestId', 'tool', 'confirmed'], required: ['type', 'controlSurface', 'requestId', 'tool', 'confirmed'] },
  'workspace.artifacts': {keys:['type','sessionKey','controlSurface','expectedCwd','action','path','cursor','offset','length','expectedRevision','text'],required:['type','sessionKey','controlSurface','expectedCwd','action']},
  'workspace.git.read': {keys:['type','sessionKey','controlSurface','expectedCwd','action','repositoryPath','path','reviewScope','reviewRef','sourceDiff'],required:['type','sessionKey','controlSurface','expectedCwd','action']},
  'workspace.git.mutate': {keys:['type','sessionKey','controlSurface','expectedCwd','action','expectedRevision','repositoryPath','path','branch','message','name','title','body','reviewScope','reviewRef','sourceDiff','patchRevision','hunk','operation'],required:['type','sessionKey','controlSurface','expectedCwd','action','expectedRevision']},
  'agents.status': { keys: ['type'], required: ['type'] },
  'remote.connections.sync': { keys: ['type'], required: ['type'] },
  'agents.api.set': { keys: ['type', 'agent', 'accountId', 'model', 'sessionKey'], required: ['type', 'agent', 'accountId'] },
  'remote.station.switch': { keys: ['type', 'targetHubUrl', 'targetDeviceId', 'targetComputerId', 'agent', 'accountId', 'model', 'sessionKey', 'sourceOnly', 'operationId'], required: ['type', 'targetHubUrl', 'targetDeviceId', 'targetComputerId', 'operationId'] },
  'remote.station.receipt': { keys: ['type', 'operationId'], required: ['type', 'operationId'] },
  'sessions.list': { keys: ['type', 'tool', 'client', 'cursor', 'limit', 'controlSurface', 'historyIdentity'], required: ['type'] },
  'desktop.sessions.list': { keys: ['type', 'tool', 'controlSurface', 'cursor', 'limit'], required: ['type', 'tool', 'controlSurface'] },
  'desktop.session.open': { keys: ['type', 'sessionKey', 'controlSurface', 'cursor', 'limit', 'messageLimit'], required: ['type', 'sessionKey', 'controlSurface'] },
  'session.open': { keys: ['type', 'sessionKey', 'cursor', 'limit', 'messageLimit', 'controlSurface', 'historyIdentity', 'client'], required: ['type', 'sessionKey'] },
  'workspace.project.files.list': { keys: ['type', 'tool', 'cwd', 'expectedCwd', 'controlSurface', 'path', 'cursor'], required: ['type', 'tool', 'cwd', 'expectedCwd', 'controlSurface'] },
  'workspace.project.files.read': { keys: ['type', 'tool', 'cwd', 'expectedCwd', 'controlSurface', 'path'], required: ['type', 'tool', 'cwd', 'expectedCwd', 'controlSurface', 'path'] },
  'workspace.files.list': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'path', 'cursor'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd'] },
  'workspace.files.read': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'path'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'path'] },
  'workspace.files.write': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'path', 'text', 'expectedRevision'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'path', 'text', 'expectedRevision'] },
  'workspace.files.mutate': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'action', 'path', 'text', 'expectedRevision', 'destination'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'action', 'path'] },
  'workspace.project.preview': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'action', 'sourcePath', 'projectPath', 'script', 'manifestRevision', 'operationId', 'runId', 'cursor'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'action'] },
  'workspace.preview.file': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'pageId', 'downloadId', 'offset'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'pageId', 'downloadId', 'offset'] },
  'workspace.preview.open': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'operationId', 'url', 'width', 'height'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'operationId', 'url', 'width', 'height'] },
  'workspace.preview.frame': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'pageId', 'capture'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'pageId', 'capture'] },
  'workspace.preview.input': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'pageId', 'sequence', 'input'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'pageId', 'sequence', 'input'] },
  'workspace.preview.close': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'pageId'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'pageId'] },
  'workspace.terminal.open': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'operationId', 'cols', 'rows'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'operationId', 'cols', 'rows'] },
  'workspace.terminal.read': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'terminalId', 'cursor'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'terminalId', 'cursor'] },
  'workspace.terminal.input': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'terminalId', 'sequence', 'data'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'terminalId', 'sequence', 'data'] },
  'workspace.terminal.resize': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'terminalId', 'cols', 'rows'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'terminalId', 'cols', 'rows'] },
  'workspace.terminal.close': { keys: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'terminalId'], required: ['type', 'sessionKey', 'controlSurface', 'expectedCwd', 'terminalId'] },
  'session.describe': { keys: ['type', 'sessionKey', 'controlSurface', 'historyIdentity'], required: ['type', 'sessionKey', 'controlSurface', 'historyIdentity'] },
  'session.start': { keys: ['type', 'tool', 'cwd', 'prompt', 'controlSurface', 'workspaceMode', 'model', 'effort', 'approval', 'permissionMode', 'collaborationMode', 'skills', 'contextReferences', 'accountId', 'attachments', 'entrypoint', 'operationId'], required: ['type', 'tool', 'cwd', 'prompt', 'controlSurface'] },
  'session.send': { keys: ['type', 'cooperationTicket', 'sourceSessionKey', 'sessionKey', 'text', 'model', 'effort', 'permissionMode', 'collaborationMode', 'skills', 'contextReferences', 'approval', 'accountId', 'attachments', 'controlSurface', 'operationId'], required: ['type', 'sessionKey', 'text', 'controlSurface'] },
  'attachment.put': { keys: ['type', 'id', 'mime', 'index', 'total', 'data', 'accountId', 'agent', 'controlSurface'], required: ['type', 'id', 'mime', 'index', 'total', 'data'] },
  'attachment.read': { keys: ['type', 'id', 'sessionKey', 'offset', 'length'], required: ['type', 'id', 'sessionKey'] },
  'session.interrupt': { keys: ['type', 'sessionKey', 'expectedTurnId', 'operationId', 'controlSurface'], required: ['type', 'sessionKey', 'expectedTurnId', 'operationId', 'controlSurface'] },
  'session.revert': { keys: ['type', 'sessionKey', 'expectedTurnId', 'expectedMessageId', 'operationId', 'accountId', 'controlSurface'], required: ['type', 'sessionKey', 'expectedTurnId', 'expectedMessageId', 'operationId', 'controlSurface'] },
  'session.steer': { keys: ['type', 'sessionKey', 'text', 'expectedTurnId', 'operationId', 'accountId', 'controlSurface'], required: ['type', 'sessionKey', 'text', 'expectedTurnId', 'operationId', 'controlSurface'] },
  'session.continue': { keys: ['type', 'sessionKey', 'text', 'expectedTurnId', 'operationId', 'accountId', 'model', 'effort', 'permissionMode', 'collaborationMode', 'skills', 'contextReferences', 'approval', 'controlSurface'], required: ['type', 'sessionKey', 'text', 'expectedTurnId', 'operationId', 'controlSurface'] },
  'approval.respond': { keys: ['type', 'approvalId', 'sessionKey', 'decision', 'message', 'answers', 'accountId', 'controlSurface'], required: ['type', 'approvalId', 'decision', 'controlSurface'] },
  'desktop.approval.respond': { keys: ['type', 'sessionKey', 'approvalId', 'decision', 'message', 'operationId', 'accountId', 'controlSurface'], required: ['type', 'sessionKey', 'approvalId', 'decision', 'operationId', 'controlSurface'] },
  'projects.list': { keys: ['type'], required: ['type'] },
  'features.list': { keys: ['type', 'tool', 'cwd', 'sessionKey', 'accountId', 'controlSurface', 'ifRevision', 'force', 'syncVersion', 'cursor', 'pageSize'], required: ['type', 'tool', 'controlSurface'] },
  'session.cooperation.prepare': { keys: ['type', 'tool', 'sessionKey', 'sourceSessionKey', 'accountId', 'controlSurface'], required: ['type', 'tool', 'sessionKey', 'sourceSessionKey', 'controlSurface'] },
  'session.context': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface'], required: ['type', 'tool', 'sessionKey', 'controlSurface'] },
  'session.actions': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface'], required: ['type', 'tool', 'sessionKey', 'controlSurface'] },
  'session.workflows': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface'], required: ['type', 'tool', 'sessionKey', 'controlSurface'] },
  'session.side-question.open': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface', 'chainId'], required: ['type', 'tool', 'sessionKey', 'controlSurface', 'chainId'] },
  'session.side-question.catalog': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface'], required: ['type', 'tool', 'sessionKey', 'controlSurface'] },
  'session.side-question.tools': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface', 'action', 'chainId', 'expectedRevision', 'operationId', 'permission', 'question', 'model', 'effort', 'skills', 'collaborationMode', 'expectedTurnId', 'approvalId', 'decision'], required: ['type', 'tool', 'sessionKey', 'controlSurface', 'action', 'chainId', 'expectedRevision'] },
  'session.side-question.ask': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface', 'expectedRevision', 'operationId', 'question', 'selection', 'previousOperationId', 'model', 'effort', 'attachments'], required: ['type', 'tool', 'sessionKey', 'controlSurface', 'expectedRevision', 'operationId', 'question'] },
  'session.side-question.read': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface', 'chainId', 'cursor'], required: ['type', 'tool', 'sessionKey', 'controlSurface', 'chainId'] },
  'session.side-question.send': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface', 'chainId', 'expectedRevision', 'operationId', 'question', 'selection', 'previousOperationId'], required: ['type', 'tool', 'sessionKey', 'controlSurface', 'chainId', 'expectedRevision', 'operationId', 'question'] },
  'session.side-question.delete': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface', 'chainId', 'operationId'], required: ['type', 'tool', 'sessionKey', 'controlSurface', 'chainId', 'operationId'] },
  'session.workflow': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface', 'expectedRevision', 'operationId', 'kind', 'target', 'objective', 'tokenBudget'], required: ['type', 'tool', 'sessionKey', 'controlSurface', 'expectedRevision', 'operationId', 'kind'] },
  'session.action': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface', 'action', 'expectedRevision', 'operationId', 'name'], required: ['type', 'tool', 'sessionKey', 'controlSurface', 'action', 'expectedRevision', 'operationId'] },
  'sessions.archived': { keys: ['type', 'tool', 'accountId', 'controlSurface', 'cursor', 'limit'], required: ['type', 'tool', 'controlSurface'] },
  'session.compact': { keys: ['type', 'tool', 'sessionKey', 'accountId', 'controlSurface', 'expectedRevision', 'operationId'], required: ['type', 'tool', 'sessionKey', 'controlSurface', 'expectedRevision', 'operationId'] },
  'models.list': { keys: ['type', 'tool', 'refresh', 'controlSurface', 'sessionKey', 'agent', 'accountId'], required: ['type', 'tool'] },
  'desktop.navigate': { keys: ['type', 'sessionKey', 'controlSurface', 'accountId'], required: ['type', 'sessionKey', 'controlSurface'] },
};

const pending = new Map<string, PendingRequest>();
const eventListeners = new Set<(event: DirectEventEnvelope) => void>();

function rejectAll(reason: DirectApiError): void {
  const requests = [...pending.values()];
  pending.clear();
  for (const request of requests) {
    clearTimeout(request.timer);
    request.reject(reason);
  }
}

function onConnectionChange(): void {
  const state = getDirectConnectionState();
  if (state.status !== 'connected') {
    rejectAll(new DirectApiError('disconnected', state.error || '电脑直连已断开'));
    return;
  }
  for (const [requestId, request] of pending) {
    if (request.deviceId !== state.deviceId) {
      pending.delete(requestId);
      clearTimeout(request.timer);
      request.reject(new DirectApiError('disconnected', '直连目标电脑已变更'));
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onMessage(value: unknown): void {
  if (!record(value)) return;
  if (value.type === 'response') {
    if (typeof value.requestId !== 'string') return;
    const request = pending.get(value.requestId);
    if (!request) return; // Unknown, forged, late, or duplicate receipt.
    const current = getDirectConnectionState();
    if (current.status !== 'connected' || current.deviceId !== request.deviceId) {
      pending.delete(value.requestId);
      clearTimeout(request.timer);
      request.reject(new DirectApiError('disconnected', '电脑直连已断开'));
      return;
    }
    pending.delete(value.requestId);
    clearTimeout(request.timer);
    const keys = Object.keys(value);
    const isError = keys.length === 3 && keys.every(key => ['type', 'requestId', 'error'].includes(key))
      && typeof value.error === 'string';
    const isResult = keys.length === 3 && keys.every(key => ['type', 'requestId', 'result'].includes(key))
      && Object.hasOwn(value, 'result');
    if (isError) {
      request.reject(new DirectApiError('remote', (value.error as string).slice(0, 4096) || '电脑拒绝了直连请求'));
      return;
    }
    if (!isResult) {
      request.reject(new DirectApiError('protocol', '电脑返回的直连回执无效'));
      return;
    }
    request.resolve(value.result);
    return;
  }
  if (value.type !== 'event' || Object.keys(value).length !== 3
    || !['type', 'event', 'data'].every(key => Object.hasOwn(value, key))
    || typeof value.event !== 'string' || !value.event || value.event.length > 128) return;
  const event = { event: value.event, data: value.data };
  eventListeners.forEach(listener => { try { listener(event); } catch { /* isolate observers */ } });
}

// Install only local in-memory listeners. No Hub client or network fallback is
// imported or called by this module.
// Keep module initialization tolerant of older test doubles / optional native
// transport builds. The production pairing module always provides both
// subscriptions; a missing listener must never make the QR screen crash.
if (typeof subscribeDirectMessages === 'function') subscribeDirectMessages(onMessage);
if (typeof subscribeDirectConnection === 'function') subscribeDirectConnection(onConnectionChange);

function validCommand(value: unknown): value is DirectCommand {
  try {
    if (!record(value) || Object.getPrototypeOf(value) !== Object.prototype || typeof value.type !== 'string') return false;
    const schema = commandSchemas[value.type as DirectCommand['type']];
    if (!schema || value.type === 'remote.station.switch' || value.type === 'remote.station.receipt'
      || !schema.required.every(key => Object.hasOwn(value, key))
      || !Object.keys(value).every(key => schema.keys.includes(key))) return false;
    return Object.entries(value).every(([key, field]) => {
      if (field === undefined) return !schema.required.includes(key);
      if (typeof value.type === 'string' && value.type.startsWith('computer.')) {
        if (key === 'controlSurface') return field === 'cli';
        if (key === 'requestId') return typeof field === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,63}$/.test(field);
        if (key === 'confirmed') return field === true;
        if (key === 'models') return Array.isArray(field) && field.length <= 100 && field.every(model => typeof model === 'string' && model.length <= 200);
        if (['baseUrl', 'key', 'wire', 'authMode'].includes(key)) return typeof field === 'string';
      }
      if (key === 'permission') return field === 'workspace-write';
      if (key === 'cursor' && (value.type === 'workspace.terminal.read' || value.type === 'workspace.project.preview')) return Number.isSafeInteger(field) && (field as number) >= 0;
      if (value.type === 'workspace.project.preview' && projectPreviewStrings.has(key)) return typeof field === 'string';
      if (stringFields.has(key)) return typeof field === 'string';
      if (integerFields.has(key)) return Number.isSafeInteger(field) && (field as number) >= 0;
      if (booleanFields.has(key)) return typeof field === 'boolean';
      if (arrayFields.has(key)) return Array.isArray(field);
      if (objectFields.has(key)) return record(field);
      return key === 'type' && typeof field === 'string';
    });
  } catch { return false; }
}

function requestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > MAX_TIMEOUT_MS) {
    throw new DirectApiError('protocol', `直连请求超时时间必须在 100–${MAX_TIMEOUT_MS} 毫秒之间`);
  }
  return timeout;
}

/** Sends one typed command over the current authenticated direct socket only. */
export function requestDirect(command: DirectCommand, options: { timeoutMs?: number } = {}): Promise<unknown> {
  const state = getDirectConnectionState();
  if (state.status !== 'connected' || !state.deviceId) return Promise.reject(new DirectApiError('disconnected', '电脑直连尚未就绪'));
  if (!validCommand(command)) return Promise.reject(new DirectApiError('protocol', '直连命令类型或字段无效'));
  if (pending.size >= MAX_PENDING) return Promise.reject(new DirectApiError('busy', '直连请求过多，请稍后重试'));
  let timeout: number;
  let commandSnapshot: DirectCommand;
  try {
    timeout = requestTimeout(options.timeoutMs);
    const encoded = JSON.stringify(command);
    if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_FRAME_BYTES) throw new Error('oversize');
    commandSnapshot = JSON.parse(encoded) as DirectCommand;
  } catch (error) {
    if (error instanceof DirectApiError) return Promise.reject(error);
    return Promise.reject(new DirectApiError('protocol', '直连命令无法编码或超出大小限制'));
  }

  let requestId: string;
  try { requestId = randomUUID(); }
  catch { return Promise.reject(new DirectApiError('protocol', '无法创建直连请求标识')); }
  if (!requestId || requestId.length > 128 || pending.has(requestId)) return Promise.reject(new DirectApiError('protocol', '直连请求标识无效或重复'));
  const frame = { type: 'command', requestId, command: commandSnapshot };
  const frameText = JSON.stringify(frame);
  if (new TextEncoder().encode(frameText).byteLength > MAX_FRAME_BYTES) return Promise.reject(new DirectApiError('protocol', '直连请求超出大小限制'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      request.reject(new DirectApiError('timeout', '电脑直连请求超时'));
    }, timeout);
    pending.set(requestId, { resolve, reject, timer, deviceId: state.deviceId! });
    try {
      sendDirectPayload(frame);
    } catch (error) {
      const request = pending.get(requestId);
      if (request) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new DirectApiError('disconnected', error instanceof Error ? error.message : '直连请求发送失败'));
      }
    }
  });
}

/** Subscribe to authenticated direct event envelopes; events are never polled through Hub. */
export function subscribeDirectEvents(listener: (event: DirectEventEnvelope) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/** Reject pending RPCs when the caller explicitly retires a direct flow. */
export function cancelDirectRequests(reason = '直连请求已取消'): void {
  rejectAll(new DirectApiError('disconnected', reason));
}
