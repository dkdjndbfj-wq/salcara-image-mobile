import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';

import { readSse } from '../api/sse';
import { canonicalHubUrl, remoteDiscoveryCandidates, type PairQr } from './pairing';
import { notificationScopeFor } from './notification-scope';
import { parseBrowserNavigation, type BrowserNavigation } from './browser-navigation';
import { parseComputerActivity, type ComputerActivity } from './computer-activity';
import { executionRetryAt, validRetryAt } from './execution-retry';
import { ingressRuntime } from './ingress-runtime';
import { IngressIdentityError } from './ingress';
export type { BrowserNavigation } from './browser-navigation';

/** Salcara Hub client — see remote/docs/PROTOCOL.md. The hub sits on the relay's own origin. */

// Matches Hub/Bridge's 64 KiB signed snapshot, encoded as unpadded base64url.
const MAX_SOURCE_GRANT_PAYLOAD_CHARS = Math.ceil((64 * 1024 * 4) / 3);

// Built-ins keep autocomplete and strict routing for the current adapters;
// extension adapters may advertise another stable id (for example Hermes)
// without forcing a mobile release or pretending it is Codex/Claude.
export type ToolId = 'codex' | 'claude' | (string & {});
export type SessionStatus = 'running' | 'idle' | 'waiting_approval' | 'failed' | 'unknown';
export type ApprovalMode = 'ask' | 'auto_edits' | 'auto_all';
export type PermissionMode = 'ask' | 'auto_review' | 'full_access';
export type Decision = 'allow' | 'allow_session' | 'deny';
import type { ContextReference } from './context-references';
import type { CollaborationMode, SkillReference } from './agent-features';

export type ToolKind = 'command' | 'file_change' | 'read' | 'image_view' | 'image_generation' | 'search' | 'web' | 'mcp' | 'plan' | 'subagent' | 'skill' | 'other';

export interface DeviceTool { id: string; name: string; available: boolean; version?: string }
export type AgentId = 'codex' | 'claude' | 'claude-desktop' | (string & {});
export type ClaudeDesktopScope = 'desktop-chat' | 'desktop-cowork';
/** Remote product surface: project-backed Code or an isolated Work task. */
export type WorkspaceMode = 'code' | 'work';
export type ApiSource = 'phone' | 'computer' | 'tool';
/** Normalized adapter capabilities. An omitted capability is unknown/false;
 * the phone never infers it from an Agent name or model string. */
export interface AgentCapabilities {
  list: boolean; read: boolean; send: boolean; interrupt: boolean; approval: boolean;
  questions: boolean; subagents: boolean; attachments: boolean; imageInput: boolean;
  imageOutput: boolean; modelOverride: boolean; startModelOverride?: boolean;
  preciseInterrupt?: boolean; continue?: boolean; steer?: boolean; latestTurnRevert?: boolean;
  features?: boolean;
  context?: boolean; compact?: boolean; contextReferences?: boolean; contextAnnotations?: boolean; contextDiffAnnotations?: boolean;
	 sessionActions?: boolean; archivedSessions?: boolean; sessionWorkflows?: boolean; sideQuestion?: boolean;
  permissionModes?: PermissionMode[];
  approvalModes?: ApprovalMode[];
}
/** The executor for writable Code sessions, not the card's display identity.
 * Native desktop history/live control have their own separately scoped fields. */
export interface AgentExecution { tool: ToolId; controlSurface: 'cli'; entrypoint?: 'claude-desktop' }
/** Public metadata only: model credentials remain on the paired computer. */
export interface AgentProfile {
  /** Absent on older Bridges; never send an in-conversation change to them. */
  conversationApiSwitch?: boolean;
  id: AgentId; name: string; tool: ToolId; available: boolean;
  /** Stable API-account routing family. Desktop/CLI aliases may share one. */
  apiFamily?: string;
  /** undefined: older in-memory metadata; null: explicitly invalid, never fall back. */
  execution?: AgentExecution | null;
  capabilities?: AgentCapabilities;
  /** What remote tasks of this agent use right now. accountId is an opaque per-computer handle. */
  api: { name: string; model: string; protocol: string; configured: boolean; pending: boolean; source: ApiSource; accountId?: string };
  remoteSendSupported: boolean;
  /** Codex Desktop live mode: messages to these threads run inside the desktop app (window stays in sync). */
  desktopLive?: { expiresAt: number; sessionKeys: string[]; capabilities?: DesktopCapabilities; approvalTransport?: 'codex-hook-v1';
    modelOverrideTransport?: 'codex-tool-schema-v1'; modelOptions?: { model: true; thinking: Effort[] };
    accountId?: string; apiName?: string; apiModel?: string };
  sessionScope?: 'code';
  desktopHistory?: { available: true; readOnly: true; identity: string; scopes: ClaudeDesktopScope[] };
}
export interface DesktopCapabilities { list: boolean; read: boolean; send: boolean; interrupt: boolean; approval: boolean; attachments: boolean; modelOverride: boolean; navigate?: boolean }
/** One API in the computer's vault the phone may pick. No key ever leaves the computer. */
export interface RemoteApiOption {
  id: string; name: string; models: string[];
  sourceType?: 'api_key' | 'reverse_proxy' | 'official_account' | 'oauth';
  remoteEligibility?: { supported: boolean; reason: 'unsupported' | 'station_mismatch' | 'external_api_not_allowed' | 'reverse_proxy_not_allowed' | 'unavailable' | 'supported'; apiRemote: boolean; accountRemote: boolean };
  stations?: Array<{ hubUrl: string; deviceId: string; apiRemote: boolean; accountRemote: boolean; checkedAt: number }>;
  /** Present only when the computer can unambiguously tie this API origin to
   * an already-paired station. It is public routing metadata, not a secret. */
  station?: { hubUrl: string; deviceId: string };
}
/** Missing capability fields mean unknown, not inferred from a model name. */
export interface ModelCapability {
  source: 'codex-model-list' | 'relay-model-list' | 'unknown';
  reasoningKnown: boolean;
  reasoningEfforts?: Effort[];
  inputModalities?: Array<'text' | 'image'>;
}
export interface ModelCatalog { models: string[]; api?: string; modelCapabilities?: Record<string, ModelCapability> }
export type { Effort } from './effort';
import type { Effort } from './effort';
export interface Project { path: string; name: string }
export interface DeviceStatus {
  deviceId: string; name: string; os: 'windows' | 'darwin' | 'linux' | string; version?: string;
  tools: DeviceTool[]; projects: Project[]; online: boolean; lastSeen: number;
  capabilities?: string[];
}
export interface SessionInfo {
  projectless?: true;
  latestTurnRevert?: boolean;
	archived?: boolean;
  sessionKey: string; tool: ToolId; client: string; title: string; cwd: string; updatedAt: number;
  /** Explicit Bridge classification; older sessions are classified from cwd on the phone. */
  workspaceMode?: WorkspaceMode;
  status: SessionStatus; controllable: boolean; model?: string;
  /** Effective mode confirmed by the host; never an optimistic phone choice. */
  collaborationMode?: CollaborationMode;
  permissionMode?: PermissionMode;
  approvalMode?: ApprovalMode;
  activeTurnId?: string; lastTerminalTurnId?: string;
  controlSurface?: 'cli' | 'desktop' | 'read-only';
  /** Genuine native directory order, never inferred from history timestamps. */
  pinnedIndex?: number;
  sidebarIndex?: number;
  parentSessionKey?: string;
  /** Observed upstream metadata only, not permission to control this thread. */
  agentNickname?: string;
  agentRole?: string;
  forkedFromSessionKey?: string;
  sessionScope?: ClaudeDesktopScope;
}
/** Delegation was explicitly reported by the host. It does not prove which
 * task or ChatGPT account sent the message, and grants no navigation authority. */
export interface MessageOrigin { kind: 'delegation' | 'user_cross_task'; sourceSessionKey?: string; sourceTitle?: string; targetSessionKey?: string; receiptId?: string; verification?: 'bridge_receipt' | 'native_reported' }
export interface RemoteQuestion {
  id: string; header?: string; question: string; options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean; allowCustom?: boolean; required?: boolean; inputType?: 'text' | 'enum' | 'boolean' | 'number' | 'integer';
  min?: number; max?: number;
  preserveWhitespace?: boolean; allowEmpty?: boolean;
}
export type QuestionAnswers = Record<string, string[]>;
export interface Usage { inputTokens?: number; outputTokens?: number; costUsd?: number }
export interface ApprovalOptions { version: number; decisions: Decision[]; denyEffect?: 'cancel_turn' }

/**
 * A conversation attachment is a reference, not inline binary data.  The
 * reference is safe to persist in Hub history; the actual bytes stay on the
 * paired computer and are fetched only when the phone needs to display them.
 */
export interface AttachmentRef {
  id: string;
  mime: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  sha256?: string;
}

/**
 * `seq` is the Hub's monotonic event cursor (it is not necessarily
 * contiguous for one session because the cursor is station-wide).  `turnId`
 * is an optional stable identity for a turn; older Bridges simply omit it.
 */
type Base = { seq?: number; turnId?: string; deviceId: string; sessionKey: string; tool: ToolId; ts: number; parentId?: string; childSessionKeys?: string[] };
export type HubEvent = Base & (
  | { type: 'session.reverted'; id: string; operationId: string; turnId: string }
  | { type: 'workflows.changed' }
  | { type: 'context.updated'; context?: unknown }
  | { type: 'session.updated'; session: SessionInfo }
  | { type: 'message'; id: string; role: 'user' | 'assistant'; text: string; final: boolean; attachments?: AttachmentRef[]; clientId?: string; messagePhase?: 'commentary' | 'final_answer'; messageOrigin?: MessageOrigin; skills?: SkillReference[]; contextReferences?: ContextReference[] }
  | { type: 'reasoning'; id: string; text: string; final: boolean }
  | { type: 'tool'; id: string; kind: ToolKind; title: string; detail?: string; status: 'running' | 'done' | 'failed' | 'interrupted'; output?: string; outputFinal?: boolean; planKind?: 'proposal' | 'tasks'; diff?: string; exitCode?: number; durationMs?: number; attachments?: AttachmentRef[]; browser?: BrowserNavigation; computer?: ComputerActivity }
  | { type: 'approval.request'; approvalId: string; kind: 'command' | 'file_change' | 'tool' | 'permission' | 'question'; title: string; detail?: string; diff?: string; cwd?: string; questions?: RemoteQuestion[]; questionMode?: string; expiresAt?: number; approvalTransport?: 'codex-hook-v1'; approvalOptions?: ApprovalOptions }
  | { type: 'approval.resolved'; approvalId: string; decision: Decision; by: 'phone' | 'desktop' | 'timeout' }
  | { type: 'turn'; status: 'started' | 'completed' | 'failed' | 'interrupted'; error?: string; errorCode?: string; retryAt?: number; usage?: Usage; durationMs?: number }
  | { type: 'notice'; id?: string; level: 'info' | 'warn' | 'error'; text: string; errorCode?: string; retryAt?: number; retrying?: boolean; noticeKind?: 'context_compaction'; progress?: boolean }
);

const MAX_EVENT_TEXT = 2 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validText = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max;
const validId = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const validCounter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const knownValue = (value: unknown, choices: readonly string[]): boolean => typeof value === 'string' && choices.includes(value);
const optionalField = (row: Record<string, unknown>, key: string, valid: (value: unknown) => boolean) => !Object.prototype.hasOwnProperty.call(row, key) || valid(row[key]);
const validRecordArray = (value: unknown, max: number, validate?: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.length <= max && value.every(item => isRecord(item) && (!validate || validate(item)));
const boundedMetadataArray = (value: unknown, max: number, textMax: number): boolean => validRecordArray(value, max, item =>
  Object.keys(item).length <= 64 && Object.values(item).every(field => field === null || typeof field === 'boolean' || typeof field === 'number'
    && Number.isFinite(field) || typeof field === 'string' && field.length <= textMax || Array.isArray(field) && field.length <= 128
    || isRecord(field) && Object.keys(field).length <= 64));

function validAttachment(value: Record<string, unknown>): boolean {
  return validId(value.id, 512) && validId(value.mime, 256)
    && optionalField(value, 'name', item => validText(item, 1024))
    && optionalField(value, 'size', item => validCounter(item))
    && optionalField(value, 'width', item => validCounter(item))
    && optionalField(value, 'height', item => validCounter(item))
    && optionalField(value, 'sha256', item => typeof item === 'string' && /^[a-f0-9]{64}$/i.test(item));
}

function validSessionEventIdentity(value: unknown, sessionKey: string, _tool: string): boolean {
  if (!isRecord(value)) return false;
  // The reducer performs the semantic tool/agent check. Keep validation
  // structural here so a foreign-tool row can be safely discarded without
  // aborting an otherwise valid page.
  return value.sessionKey === sessionKey
    && validId(value.sessionKey, 4096) && validId(value.tool, 128)
    && validText(value.client, 256) && validText(value.title, 16_384) && validText(value.cwd, 16_384)
    && validCounter(value.updatedAt) && validText(value.status, 128) && typeof value.controllable === 'boolean';
}

function parseDeviceStatus(input: unknown): DeviceStatus | undefined {
  if (!isRecord(input) || !validId(input.deviceId, 128) || !validText(input.name, 1024) || !validText(input.os, 128)
    || input.online !== undefined && typeof input.online !== 'boolean'
    || input.lastSeen !== undefined && !validCounter(input.lastSeen)) return;
  const tools = input.tools === undefined ? [] : input.tools;
  const projects = input.projects === undefined ? [] : input.projects;
  if (!validRecordArray(tools, 256, tool => validId(tool.id, 128) && validText(tool.name, 256) && typeof tool.available === 'boolean'
      && optionalField(tool, 'version', version => validText(version, 256)))
    || !validRecordArray(projects, 512, project => validText(project.path, 16_384) && validText(project.name, 1024))
    || !optionalField(input, 'capabilities', capabilities => Array.isArray(capabilities) && capabilities.length <= 256 && capabilities.every(capability => validId(capability, 256)))) return;
  // Older Bridges omitted inventory fields. Normalize those omissions into an
  // empty inventory so consumers never need version-specific assumptions.
  return { ...input, online: input.online === true, lastSeen: validCounter(input.lastSeen) ? input.lastSeen : 0,
    tools, projects } as DeviceStatus;
}

/**
 * Validate network events before they reach state reducers. Unknown event
 * kinds are deliberately ignored after validating the shared envelope, while
 * additive fields on known events are accepted for forward compatibility.
 */
export function parseHubEvent(value: unknown): HubEvent | undefined {
  if (!isRecord(value) || !validId(value.type, 128)) throw new HubError('中转站返回了无效的事件内容');
  if (value.type === 'features.changed') {
    // Feature invalidations are advisory control records. Ignore malformed
    // ones without failing the conversation stream or its cursor.
    if (!parseFeatureChange(value)) return undefined;
    return undefined;
  }
  if (!validId(value.deviceId, 128)
    || !validId(value.sessionKey, 4096) || !validId(value.tool, 128) || !validCounter(value.ts)) {
    throw new HubError('中转站返回了无效的事件内容');
  }
  if (!optionalField(value, 'seq', validCounter)) throw new HubError('中转站返回了无效的事件游标');
  if (!optionalField(value, 'turnId', item => validId(item, 4096))
    || !optionalField(value, 'parentId', item => validId(item, 4096))
    || !optionalField(value, 'childSessionKeys', item => Array.isArray(item) && item.length <= 256 && item.every(key => validId(key, 4096)))) {
    throw new HubError('中转站返回了无效的事件内容');
  }

  const optionalAttachments = () => optionalField(value, 'attachments', item => validRecordArray(item, 128, validAttachment));
  const optionalObjects = (name: string, max = 256) => optionalField(value, name, item => validRecordArray(item, max));
  switch (value.type) {
    case 'session.reverted':
      if (!validId(value.id,512) || !validId(value.turnId,256) || !validId(value.operationId,256) || value.parentId) throw new HubError('会话回退事件无效');
      break;
    case 'workflows.changed':
    case 'context.updated':
      break;
    case 'session.updated':
      if (!validSessionEventIdentity(value.session, value.sessionKey, value.tool)) throw new HubError('中转站返回了无效的会话更新');
      break;
    case 'message':
      // A future role has no safe presentation mapping. Skip that one event
      // after its envelope has been validated; the caller can still advance
      // the event cursor and continue receiving later messages.
      if (typeof value.role === 'string' && !knownValue(value.role, ['user', 'assistant'])) return undefined;
      if (!validId(value.id) || (value.role !== 'user' && value.role !== 'assistant') || !optionalField(value, 'text', item => validText(item, MAX_EVENT_TEXT))
        || !optionalField(value, 'final', item => typeof item === 'boolean') || !optionalAttachments()
        || !optionalField(value, 'clientId', item => validId(item, 4096))
        || !optionalField(value, 'messagePhase', item => validText(item, 128))
        || !optionalField(value, 'messageOrigin', isRecord)
        || !optionalField(value, 'skills', item => boundedMetadataArray(item, 8, 16_384))
        || !optionalField(value, 'contextReferences', item => boundedMetadataArray(item, 8, 32 * 1024))) throw new HubError('中转站返回了无效的消息事件');
      break;
    case 'reasoning':
      if (!validId(value.id) || !optionalField(value, 'text', item => validText(item, MAX_EVENT_TEXT))
        || !optionalField(value, 'final', item => typeof item === 'boolean')) throw new HubError('中转站返回了无效的思考事件');
      break;
    case 'tool':
      if (!validId(value.id) || !validId(value.kind, 128) || !validText(value.title, 16_384)
        || typeof value.status !== 'string' || value.status.length > 128
        || !optionalField(value, 'detail', item => validText(item, MAX_EVENT_TEXT))
        || !optionalField(value, 'output', item => validText(item, MAX_EVENT_TEXT))
        || !optionalField(value, 'diff', item => validText(item, MAX_EVENT_TEXT))
        || !optionalField(value, 'outputFinal', item => typeof item === 'boolean')
        || !optionalField(value, 'exitCode', item => typeof item === 'number' && Number.isSafeInteger(item))
        || !optionalField(value, 'durationMs', validCounter) || !optionalAttachments()) throw new HubError('中转站返回了无效的工具事件');
      // New tool states have no presentation/merge semantics on this client.
      // Ignore the event without pinning replay to the same unsupported row.
      if (!knownValue(value.status, ['running', 'done', 'failed', 'interrupted'])) return undefined;
      break;
    case 'approval.request':
      if (typeof value.kind === 'string' && !knownValue(value.kind, ['command', 'file_change', 'tool', 'permission', 'question'])) return undefined;
      if (!validId(value.approvalId) || !['command', 'file_change', 'tool', 'permission', 'question'].includes(String(value.kind))
        || !validText(value.title, 16_384)
        || !optionalField(value, 'detail', item => validText(item, MAX_EVENT_TEXT))
        || !optionalField(value, 'diff', item => validText(item, MAX_EVENT_TEXT))
        || !optionalField(value, 'cwd', item => validText(item, 16_384))
        || !optionalField(value, 'questions', item => validRecordArray(item, 128, question => validId(question.id, 512) && validText(question.question, 16_384)))
        || !optionalField(value, 'expiresAt', validCounter)
        || !optionalField(value, 'approvalOptions', item => isRecord(item) && validCounter(item.version) && Array.isArray(item.decisions) && item.decisions.length <= 16)) {
        throw new HubError('中转站返回了无效的审批事件');
      }
      break;
    case 'approval.resolved':
      if (typeof value.decision === 'string' && !knownValue(value.decision, ['allow', 'allow_session', 'deny'])
        || typeof value.by === 'string' && !knownValue(value.by, ['phone', 'desktop', 'timeout'])) return undefined;
      if (!validId(value.approvalId) || !['allow', 'allow_session', 'deny'].includes(String(value.decision))
        || !['phone', 'desktop', 'timeout'].includes(String(value.by))) throw new HubError('中转站返回了无效的审批结果');
      break;
    case 'turn':
      if (typeof value.status === 'string' && !knownValue(value.status, ['started', 'completed', 'failed', 'interrupted'])) return undefined;
      if (!['started', 'completed', 'failed', 'interrupted'].includes(String(value.status))
        || !optionalField(value, 'error', item => validText(item, MAX_EVENT_TEXT))
        || !optionalField(value, 'errorCode', item => validText(item, 512))
        || !optionalField(value, 'retryAt', validRetryAt)
        || !optionalField(value, 'usage', item => isRecord(item)
          && optionalField(item, 'inputTokens', validCounter) && optionalField(item, 'outputTokens', validCounter)
          && optionalField(item, 'costUsd', field => typeof field === 'number' && Number.isFinite(field) && field >= 0))
        || !optionalField(value, 'durationMs', validCounter)) throw new HubError('中转站返回了无效的任务状态事件');
      break;
    case 'notice':
      if (typeof value.level === 'string' && !knownValue(value.level, ['info', 'warn', 'error'])) return undefined;
      if (!['info', 'warn', 'error'].includes(String(value.level)) || !validText(value.text, MAX_EVENT_TEXT)
        || !optionalField(value, 'id', item => validId(item, 4096))
        || !optionalField(value, 'errorCode', item => validText(item, 512))
        || !optionalField(value, 'retryAt', validRetryAt)
        || !optionalField(value, 'retrying', item => typeof item === 'boolean')
        || !optionalField(value, 'progress', item => typeof item === 'boolean')
        || !optionalField(value, 'noticeKind', item => validText(item, 128))) throw new HubError('中转站返回了无效的提示事件');
      break;
    default:
      return undefined;
  }
  if (value.type === 'message' || value.type === 'reasoning') {
    // Bridge protocol.Event omits empty text and false final on the wire.
    // Normalize after validating present fields, without mutating the payload.
    return { ...value, text: value.text ?? '', final: value.final ?? false } as HubEvent;
  }
  if (value.type === 'tool') {
    const { browser: rawBrowser, computer: rawComputer, ...event } = value;
    const browser = value.status === 'done' ? parseBrowserNavigation(rawBrowser) : undefined;
    const computer = parseComputerActivity(rawComputer);
    return { ...event, ...(browser ? { browser } : {}), ...(computer ? {computer} : {}) } as HubEvent;
  }
  if (value.type === 'turn' || value.type === 'notice') {
    const { retryAt, ...event } = value;
    const at = executionRetryAt(value.errorCode, retryAt);
    return { ...event, ...(at === undefined ? {} : { retryAt: at }) } as HubEvent;
  }
  return value as HubEvent;
}

export type Command =
  | { type: 'workspace.projects'; controlSurface: 'cli'; tool: ToolId; workspaceMode: WorkspaceMode; action: 'list' | 'select' | 'mkdir'; cwd: string; path: string; cursor?: string; name?: string }
  | { type: 'workspace.explorer'; controlSurface: 'cli'; tool: ToolId; workspaceMode: WorkspaceMode; action: 'list' | 'mkdir'; cwd: string; path: string; cursor?: string; name?: string }
  | { type: 'workspace.git.read'; sessionKey:string; controlSurface:'cli'|'desktop'; expectedCwd:string; action:'status'|'diff'|'staged-diff'|'review'|'repositories'; repositoryPath?:string; path?:string;reviewScope?:import('./workspace-git').ReviewScope;reviewRef?:string;sourceDiff?:string }
  | ({ type: 'workspace.git.mutate'; sessionKey:string; controlSurface:'cli'|'desktop'; expectedCwd:string; action:import('./workspace-git').GitAction; expectedRevision:string } & import('./workspace-git').GitInput)
  | { type: 'agents.status' }
  | { type: 'remote.connections.sync' }
  | { type: 'agents.api.set'; agent: AgentId; accountId: string; model?: string; sessionKey?: string }
  | { type: 'remote.station.switch'; targetHubUrl: string; targetDeviceId: string; targetComputerId: string; agent?: AgentId; accountId?: string; model?: string; sessionKey?: string; sourceOnly?: boolean; operationId: string }
  | { type: 'remote.station.receipt'; operationId: string }
  | { type: 'sessions.list'; tool?: ToolId; client?: 'code' | 'desktop-code' | ClaudeDesktopScope; cursor?: string; limit?: number; controlSurface?: 'cli' | 'read-only'; historyIdentity?: string }
  | { type: 'desktop.sessions.list'; tool: 'codex'; controlSurface: 'desktop'; cursor?: string; limit?: number }
  | { type: 'desktop.session.open'; sessionKey: string; controlSurface: 'desktop'; cursor?: string; limit?: number; messageLimit?: number }
  | { type: 'session.open'; sessionKey: string; cursor?: string; limit?: number; messageLimit?: number; controlSurface?: 'cli' | 'read-only'; historyIdentity?: string; client?: ClaudeDesktopScope }
  | { type: 'workspace.project.files.list'; tool: ToolId; cwd: string; expectedCwd: string; controlSurface: 'cli'; path?: string; cursor?: string }
  | { type: 'workspace.project.files.read'; tool: ToolId; cwd: string; expectedCwd: string; controlSurface: 'cli'; path: string }
  | { type: 'workspace.artifacts'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; action:'list'|'read'|'save'; path?:string; cursor?:string; offset?:number; length?:number; expectedRevision?:string; text?:string }
  | { type: 'workspace.files.list'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; path?: string; cursor?: string }
  | { type: 'workspace.files.read'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; path: string }
  | { type: 'workspace.files.write'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; path: string; text: string; expectedRevision: string }
  | { type: 'workspace.files.mutate'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; action: 'create' | 'delete' | 'rename'; path: string; text?: string; expectedRevision?: string; destination?: string }
  | ({ type: 'workspace.project.preview'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string } & (
    { action: 'inspect'; sourcePath: string } | ({ action: 'start' } & import('./workspace-project-preview').ProjectPreviewStart)
    | ({ action: 'status' | 'stop' } & import('./workspace-project-preview').ProjectPreviewLookup)))
  | { type: 'workspace.preview.file'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; pageId: string; downloadId: string; offset: number }
  | { type: 'workspace.preview.open'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; operationId: string; url: string; width: number; height: number }
  | { type: 'workspace.preview.frame'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; pageId: string; capture: boolean }
  | { type: 'workspace.preview.input'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; pageId: string; sequence: number; input: import('./workspace-preview').PreviewInput }
  | { type: 'workspace.preview.close'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; pageId: string }
  | { type: 'workspace.terminal.open'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; operationId: string; cols: number; rows: number }
  | { type: 'workspace.terminal.read'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; terminalId: string; cursor: number }
  | { type: 'workspace.terminal.input'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; terminalId: string; sequence: number; data: string }
  | { type: 'workspace.terminal.resize'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; terminalId: string; cols: number; rows: number }
  | { type: 'workspace.terminal.close'; sessionKey: string; controlSurface: 'cli' | 'desktop'; expectedCwd: string; terminalId: string }
  | { type: 'session.describe'; sessionKey: string; controlSurface: 'read-only'; historyIdentity: string }
  | { type: 'session.start'; tool: ToolId; cwd: string; projectless?: true; prompt: string; controlSurface?: 'cli'; workspaceMode?: WorkspaceMode; model?: string; effort?: Effort; approval?: ApprovalMode; permissionMode?: PermissionMode; collaborationMode?: CollaborationMode; skills?: SkillReference[]; contextReferences?: ContextReference[]; accountId?: string; attachments?: string[]; entrypoint?: 'claude-desktop'; operationId?: string }
  | { type: 'session.send'; cooperationTicket?: string; sourceSessionKey?: string; sessionKey: string; text: string; model?: string; effort?: Effort; permissionMode?: PermissionMode; collaborationMode?: CollaborationMode; skills?: SkillReference[]; contextReferences?: ContextReference[]; approval?: ApprovalMode; accountId?: string; attachments?: string[]; controlSurface: 'cli' | 'desktop'; operationId?: string }
  | { type: 'attachment.put'; id: string; mime: string; index: number; total: number; data: string; accountId?: string; agent?: AgentId; controlSurface?: 'cli' }
  | { type: 'attachment.read'; id: string; sessionKey: string; offset?: number; length?: number; variant?: 'thumbnail' | 'original' }
  | { type: 'session.interrupt'; sessionKey: string; expectedTurnId: string; operationId: string; controlSurface: 'cli' }
  | { type: 'session.revert'; sessionKey: string; expectedTurnId: string; expectedMessageId: string; operationId: string; accountId?: string; controlSurface: 'cli' }
  | { type: 'session.steer'; sessionKey: string; text: string; expectedTurnId: string; operationId: string; accountId?: string; controlSurface: 'cli' }
  | { type: 'session.continue'; sessionKey: string; text: string; expectedTurnId: string; operationId: string; accountId?: string; model?: string; effort?: Effort; permissionMode?: PermissionMode; collaborationMode?: CollaborationMode; skills?: SkillReference[]; contextReferences?: ContextReference[]; approval?: ApprovalMode; controlSurface: 'cli' }
  | { type: 'approval.respond'; approvalId: string; sessionKey?: string; decision: Decision; message?: string; answers?: QuestionAnswers; accountId?: string; controlSurface: 'cli' }
  | { type: 'desktop.approval.respond'; sessionKey: string; approvalId: string; decision: 'allow' | 'deny'; message?: string; operationId: string; accountId?: string; controlSurface: 'desktop' }
  | { type: 'projects.list' }
  | { type: 'features.list'; tool: ToolId; cwd?: string; sessionKey?: string; accountId?: string; controlSurface: 'cli'; ifRevision?: string; force?: boolean; syncVersion?: 1; cursor?: string; pageSize?: number }
  | { type: 'session.cooperation.prepare'; tool: ToolId; sessionKey: string; sourceSessionKey: string; accountId?: string; controlSurface: 'cli' }
  | { type: 'session.context'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli' }
	| { type: 'session.actions'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli' }
  | { type: 'session.workflows'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli' }
  | { type: 'session.side-question.open'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli'; chainId: string }
  | { type: 'session.side-question.catalog'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli' }
  | ({type:'session.side-question.tools';tool:ToolId;sessionKey:string;accountId?:string;controlSurface:'cli'} & import('./side-question-tools').SideToolRequest)
  | ({ type: 'session.side-question.ask'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli'; expectedRevision: string; operationId: string } & import('./side-question').TemporarySideQuestionInput)
  | { type: 'session.side-question.read'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli'; chainId: string; cursor?: string }
  | ({ type: 'session.side-question.send'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli'; chainId: string; expectedRevision: string; operationId: string } & import('./side-question').SideQuestionInput)
  | { type: 'session.side-question.delete'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli'; chainId: string; operationId: string }
  | ({ type: 'session.workflow'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli'; expectedRevision: string; operationId: string } & import('./session-workflows').WorkflowInput)
	| { type: 'session.action'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli'; action: import('./session-actions').SessionAction; expectedRevision: string; operationId: string; name?: string }
	| { type: 'sessions.archived'; tool: ToolId; accountId?: string; controlSurface: 'cli'; cursor?: string; limit?: number }
  | { type: 'session.compact'; tool: ToolId; sessionKey: string; accountId?: string; controlSurface: 'cli'; expectedRevision: string; operationId: string }
  | { type: 'models.list'; tool: ToolId; refresh?: boolean; controlSurface?: 'cli' | 'desktop'; sessionKey?: string; agent?: 'codex-desktop'; accountId?: string }
  | { type: 'desktop.navigate'; sessionKey: string; controlSurface: 'desktop'; accountId?: string };

export type Hub = { url: string; key?: string; pairToken?: string; botToken?: string; deviceId?: string };
export interface InterruptResult { status: 'requested' | 'stopped' | 'already_finished' | 'unconfirmed'; turnId: string }
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; url?: string; redirected?: boolean; headers?: { get?: (name: string) => string | null } | null; body?: unknown; text?: () => Promise<string>; json?: () => Promise<unknown>;
}>;

export class HubError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) { super(message); this.name = 'HubError'; }
}

export function originOf(baseUrl: string): string | null {
  return baseUrl.trim().match(/^(https?:\/\/[^/?#\s]+)/i)?.[1] ?? null;
}

export function hubUrlFor(baseUrl: string): string | null {
  try { return remoteDiscoveryCandidates(baseUrl)[0] ?? null; } catch { return null; }
}

let fetchImpl: FetchLike = expoFetch as unknown as FetchLike;
let ingress = ingressRuntime((url, init) => fetchImpl(url, init));
let ingressEnabled = true;
/** Tests swap the transport; ingress protocol tests opt into the discovery traffic. */
export function setHubFetch(next: FetchLike | null, enableIngress = false) {
  fetchImpl = next ?? (expoFetch as unknown as FetchLike);
  ingressEnabled = !next || enableIngress;
  ingress = ingressRuntime((url, init) => fetchImpl(url, init));
}
/** Public, already validated authority handed to the Android background watcher. */
export function hubIngressSnapshot(canonical: string) { return ingressEnabled ? ingress.pinSnapshot(canonical) : undefined; }
/** A candidate may reuse a saved pairing only after signed membership and a fresh pinned proof. */
export async function verifyHubAlias(canonical: string, candidate: string): Promise<boolean> { return ingressEnabled && await ingress.verifyAlias(canonical, candidate); }
export async function confirmPairingHubIdentity(canonical: string, active: () => boolean): Promise<void> { if (ingressEnabled) await ingress.confirmPairingIdentity(canonical, active); }
async function transportFetch(canonical: string, path: string, init: Record<string, unknown>) {
  if (!ingressEnabled) return { response: await fetchImpl(`${canonical}${path}`, init), endpoint: canonical };
  const result = await ingress.fetch(canonical, path, init);
  // Discovery is bounded and public. It never delays a working single-origin Hub.
  void ingress.refresh(canonical);
  return result;
}

async function readJson(response: Awaited<ReturnType<FetchLike>>): Promise<Record<string, unknown>> {
  const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json?.());
  // A paired Hub is an untrusted network boundary.  Bound the decoded body
  // before JSON parsing so a malformed/history response cannot allocate an
  // unbounded string or object graph in the phone process.
  if (text.length > 8 * 1024 * 1024) throw new HubError('中转站响应过大，已停止读取');
  try {
    const value: unknown = JSON.parse(text || '');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch { throw new HubError('响应未接收完整，保留原请求等待重试'); }
}

function httpMessage(status: number, error: unknown, pairedRequest: boolean): string {
  if (status === 401 || status === 403) return pairedRequest ? '配对凭证无效或已撤销，请重新扫码连接电脑' : '中转站拒绝远程服务检测，请联系管理员检查远程入口';
  if (typeof error === 'string' && error) return error;
  if (status === 404) return '这个 API 不支持远程编程';
  if (status === 409) return '电脑不在线';
  return `中转站暂时不可用（HTTP ${status}）`;
}

function httpFailure(status: number, json: Record<string, unknown>, pairedRequest: boolean): HubError {
  const code = typeof json.code === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(json.code) ? json.code : json.code === undefined || json.code === '' ? undefined : 'remote_error_unknown';
  const message = code?.startsWith('source_') ? '这个来源暂时无法在本站运行'
    : code?.startsWith('station_') ? '本站远程能力尚未就绪，请更新或刷新后重试'
    : code === 'remote_execution_disabled' ? '本站已暂停远程执行'
    : code === 'device_credentials_invalid' || code === 'device_enrollment_required' || code === 'enrollment_claim_invalid' ? '电脑的远程登记需要恢复，请在电脑端重新登记'
    : (status === 401 || status === 403) && code && !pairingErrorCodes.has(code) ? '远程访问未获授权，请检查电脑端授权或联系管理员'
    : httpMessage(status, json.error, pairedRequest);
  return new HubError(message, status, code);
}

const pairingErrorCodes = new Set(['pair_credentials_invalid', 'phone_pairing_invalid', 'phone_pairing_required', 'pairing_invalid', 'bot_phone_credentials_invalid', 'diagnostic_pairing_invalid']);
/** Only an authenticated phone request can use this compatibility fallback. */
export function isPairingAuthenticationError(error: unknown): boolean {
  return error instanceof HubError && (error.status === 401 || error.status === 403)
    && (!error.code || pairingErrorCodes.has(error.code));
}

function authHeaders(hub: Hub | { url: string; key?: string }) {
  return { ...(hub.key ? { Authorization: `Bearer ${hub.key}` } : {}), ...('botToken' in hub && hub.botToken ? { 'X-Salcara-Bot-Token': hub.botToken } : 'pairToken' in hub && hub.pairToken ? { 'X-Salcara-Pair-Token': hub.pairToken } : {}) };
}
function checkResponseScope(response: Awaited<ReturnType<FetchLike>>, hubUrl: string) {
  // Never follow station redirects with a device credential, even within the same origin.
  if (response.redirected || (response.url && !response.url.startsWith(`${hubUrl}/`))) throw new HubError('中转站接口发生重定向，已停止连接以保护配对凭证');
}

// Some native transports stop the socket but leave a pending body read alive.
// A request must release its UI owner even when that transport ignores abort.
function withAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(new Error('request aborted')); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('request aborted');
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function request(hub: Hub | { url: string; key?: string }, path: string, init: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal; exact?: boolean } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  const forwardAbort = () => controller.abort();
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', forwardAbort, { once: true });
  }
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    const wire = {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...authHeaders(hub), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal, credentials: 'omit', redirect: 'error',
    };
    // A QR ticket belongs to the newly confirmed exact URL. Old routing
    // authority must not forward a replacement Hub's one-time pairing secret.
    const transport = await withAbort(controller.signal, async () => init.exact
      ? { response: await fetchImpl(`${hub.url}${path}`, wire), endpoint: hub.url }
      : transportFetch(hub.url, path, wire));
    response = transport.response;
    checkResponseScope(response, transport.endpoint);
    if (init.exact && response.url && response.url !== `${hub.url}${path}`) throw new HubError('中转站接口发生重定向，已停止连接以保护配对凭证');
    const json = await withAbort(controller.signal, () => response.ok ? readJson(response) : readJson(response).catch(() => ({} as Record<string, unknown>)));
    if (!response.ok) {
      throw httpFailure(response.status, path === '/ping' ? { ...json, error: undefined } : json, Boolean('pairToken' in hub && hub.pairToken || 'botToken' in hub && hub.botToken));
    }
    return json;
  } catch (error) {
    if (error instanceof HubError) throw error;
    if (error instanceof IngressIdentityError) throw new HubError(error.message, 409, 'hub_identity_changed');
    if (init.signal?.aborted) throw new HubError('请求已取消', 499, 'aborted');
    throw new HubError(controller.signal.aborted ? '中转站响应超时，请稍后再试' : '连不上中转站，请检查网络', 0, controller.signal.aborted ? 'hub_timeout' : 'hub_unreachable');
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', forwardAbort);
  }
}

/** An execution policy denial is not a lost pairing or an offline computer. */
export function isExecutionPolicyError(error: unknown): boolean {
  return error instanceof HubError && error.status === 403 && Boolean(error.code && (
    error.code.startsWith('source_') || error.code.startsWith('station_') || error.code === 'remote_execution_disabled'));
}

/** True when this origin runs a Salcara Hub (no key needed). */
export async function ping(hubUrl: string): Promise<boolean> {
  try { return (await request({ url: hubUrl }, '/ping', { timeoutMs: 6000, exact: true })).service === 'salcara-hub'; } catch { return false; }
}

/** A paired, side-effect-free probe; never falls back to the command API. */
export async function diagnosticProbe(hub: Hub, deviceId: string, nonce: string, target: 'hub' | 'device', signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!hub.pairToken && !hub.botToken || hub.deviceId && hub.deviceId !== deviceId) throw new HubError('请先连接已配对的电脑', 403, 'diagnostic_pairing_invalid');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = target === 'hub' ? 6000 : 10000;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  try {
    return await request({ ...hub }, '/app/diagnostics', { method: 'POST', body: { deviceId, nonce, target }, timeoutMs: timeout + 1000, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw new HubError('检测已取消', 499, 'aborted');
    if (timedOut) throw new HubError('连接诊断超时', 504, 'diagnostic_timeout');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export interface HubDiscovery { url: string; service: 'salcara-hub'; protocol: 'salcara-remote'; protocolVersion: 1; capabilities: string[] }
/** Discovery is public and requires all device-only pairing capabilities, not an API-user login. */
export async function discoverStation(stationUrl: string): Promise<HubDiscovery> {
  let failure: unknown;
  for (const url of remoteDiscoveryCandidates(stationUrl)) {
    try {
      const result = await request({ url }, '/ping', { timeoutMs: 2500, exact: true });
      const capabilities = Array.isArray(result.capabilities) ? result.capabilities.filter((item): item is string => typeof item === 'string') : [];
      if (result.service !== 'salcara-hub' || result.protocol !== 'salcara-remote' || result.protocolVersion !== 1
        || !Array.isArray(result.authModes) || !result.authModes.includes('device-pairing')
        || !['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'].every((item) => capabilities.includes(item))) {
        throw new HubError('这个中转站没有安装兼容的扫码远程插件，请联系站长', 404, 'remote_unsupported');
      }
      return { url, service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, capabilities };
    } catch (error) {
      if (!failure || failure instanceof HubError && (failure.status === 404 || failure.status === 405)) failure = error;
    }
  }
  throw failure;
}

export async function confirmQrPair(qr: PairQr, phoneId?: string): Promise<{ token: string; device: DeviceStatus }> {
  if (qr.computerId && (!phoneId || !/^[a-f0-9]{64}$/.test(phoneId))) throw new HubError('请更新手机端后重新扫码');
  const result = await request({ url: qr.hubUrl }, '/app/pair/qr', { method: 'POST', body: { deviceId: qr.deviceId, ticket: qr.ticket, ...(phoneId ? { phoneId } : {}) }, exact: true });
  const device = result.device as DeviceStatus | undefined;
  if (qr.computerId && result.computerId !== qr.computerId) throw new HubError('二维码的电脑身份与中转站不一致，请重新生成');
  if (typeof result.pair_token !== 'string' || !/^[a-f0-9]{64}$/.test(result.pair_token) || !device
    || device.deviceId !== qr.deviceId || typeof device.name !== 'string' || !Array.isArray(device.tools) || !Array.isArray(device.projects)) {
    throw new HubError('中转站返回的电脑配对信息无效');
  }
  return { token: result.pair_token, device };
}

export async function revokePair(hub: Hub): Promise<void> {
  await request(hub, hub.botToken ? '/bot/phone/revoke' : '/app/pair/revoke', { method: 'POST' });
}

/** Hub capability push.fcm.v1: this phone's FCM token for task news while the app is closed; '' unregisters. */
export async function registerPushToken(hub: Hub, deviceId: string, token: string, platform: 'android' | 'ios' = 'android'): Promise<'fcm' | 'off'> {
  const notificationScope = notificationScopeFor(hub, deviceId);
  const result = await request(hub, '/app/push/register', { method: 'POST', body: { deviceId, token, platform, ...(notificationScope ? { notificationScope } : {}) }, timeoutMs: 15_000 });
  return result.push === 'fcm' ? 'fcm' : 'off';
}

export async function me(hub: Hub): Promise<string> {
  return String((await request(hub, '/me')).account ?? '');
}

/** A one-time code must be displayed by the local desktop app. */
export async function confirmPair(hub: Hub, code: string): Promise<{ token: string; device: DeviceStatus }> {
  const result = await request(hub, '/app/pair/confirm', { method: 'POST', body: { code: code.trim().toUpperCase() } });
  if (typeof result.pair_token !== 'string' || !result.device || typeof result.device !== 'object') {
    throw new HubError('中转站没有返回配对凭证');
  }
  return { token: result.pair_token, device: result.device as unknown as DeviceStatus };
}

export async function devices(hub: Hub): Promise<DeviceStatus[]> {
  const list = (await request(hub, '/app/devices')).devices;
  return Array.isArray(list) ? (list as DeviceStatus[]).filter((device) => device && (!hub.deviceId || device.deviceId === hub.deviceId)) : [];
}

export interface BotBindingPackage { type: 'salcara-hub-bot-binding'; version: 1; hubUrl: string; groupId: string; invite: string; signature: string }
export interface BotPhoneBindResult { groupId: string; botToken: string; devices: DeviceStatus[] }
/** The signed package keeps its public base URL; API calls use the versioned endpoint. */
export const botBindingEndpoint = (binding: BotBindingPackage): string => canonicalHubUrl(`${binding.hubUrl}/v1`);

export function parseBotBindingPackage(raw: string): BotBindingPackage {
  if (raw.length > 16 * 1024) throw new HubError('Bot 绑定包过大', 400, 'bot_binding_invalid');
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new HubError('Bot 绑定包不是有效 JSON', 400, 'bot_binding_invalid'); }
  if (!value || typeof value !== 'object') throw new HubError('Bot 绑定包无效', 400, 'bot_binding_invalid');
  const p = value as Record<string, unknown>;
  const fields = ['type', 'version', 'hubUrl', 'groupId', 'invite', 'signature'];
  if (Object.keys(p).length !== fields.length || fields.some(field => !Object.prototype.hasOwnProperty.call(p, field))) {
    throw new HubError('Bot 绑定包字段无效', 400, 'bot_binding_invalid');
  }
  let hubUrl: URL;
  try { hubUrl = new URL(String(p.hubUrl)); } catch { throw new HubError('Bot 绑定包字段无效', 400, 'bot_binding_invalid'); }
  if (p.type !== 'salcara-hub-bot-binding' || p.version !== 1 || typeof p.hubUrl !== 'string' || typeof p.groupId !== 'string' || typeof p.invite !== 'string' || typeof p.signature !== 'string'
    || hubUrl.protocol !== 'https:' || !hubUrl.hostname || hubUrl.username !== '' || hubUrl.password !== '' || hubUrl.search !== '' || hubUrl.hash !== '' || hubUrl.pathname !== '/salcara-hub'
    || !/^[A-Za-z0-9._-]{1,128}$/.test(p.groupId) || !/^[a-f0-9]{64}$/.test(p.invite) || !/^[a-f0-9]{64}$/.test(p.signature)) {
    throw new HubError('Bot 绑定包字段无效', 400, 'bot_binding_invalid');
  }
  const binding = p as unknown as BotBindingPackage;
  botBindingEndpoint(binding);
  return binding;
}

export async function bindBotPhone(binding: BotBindingPackage, phoneId: string): Promise<BotPhoneBindResult> {
  if (!/^[a-f0-9]{64}$/.test(phoneId)) throw new HubError('手机身份无效', 400, 'bot_phone_invalid');
  const result = await request({ url: botBindingEndpoint(binding) }, '/bot/phone/bind', { method: 'POST', body: { binding, phoneId }, timeoutMs: 20_000 });
  if (typeof result.botToken !== 'string' || !/^[a-f0-9]{64}$/.test(result.botToken) || !Array.isArray(result.devices)
    || result.groupId !== binding.groupId || !result.devices.length || result.devices.length > 1000
    || result.devices.some((item: unknown) => {
      if (!item || typeof item !== 'object') return true;
      const device = item as DeviceStatus;
      return typeof device.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(device.deviceId)
        || typeof device.name !== 'string' || !device.name.trim() || device.name.length > 200 || /[\u0000-\u001f]/.test(device.name)
        || !Array.isArray(device.tools) || !Array.isArray(device.projects);
    }) || new Set(result.devices.map(item => (item as DeviceStatus).deviceId)).size !== result.devices.length) throw new HubError('Hub 返回的 Bot 手机凭据无效', 502, 'bot_binding_invalid');
  return { groupId: result.groupId, botToken: result.botToken, devices: result.devices as DeviceStatus[] };
}

/** Runs one command on a computer; the hub waits up to 45 s for the reply. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HubError('请求已取消', 499, 'aborted');
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HubError('请求已取消', 499, 'aborted'));
      return;
    }
    const timer = setTimeout(done, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new HubError('请求已取消', 499, 'aborted'));
    };
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export async function command<T = Record<string, unknown>>(hub: Hub, deviceId: string, cmd: Command, requestId?: string, signal?: AbortSignal, options?: { transportOnlyHandover?: boolean; receiptOnly?: boolean; executionTicket?: string }): Promise<T> {
  if (hub.deviceId && hub.deviceId !== deviceId) throw new HubError('这台电脑不属于当前配对连接');
  throwIfAborted(signal);
  // Freeze before the first await. A UI selection change or caller mutation
  // cannot alter the command/paired station while its grant is acquired.
  const owner = { ...hub };
  const encodedCommand = JSON.stringify(cmd);
  if (['session.start', 'session.send', 'session.continue'].includes(cmd.type) && new TextEncoder().encode(encodedCommand).length > 240 * 1024) throw new HubError('内容过多，请减少正文、技能或引用后重试', 413, 'command_too_large');
  const frozenCommand = JSON.parse(encodedCommand) as Command;
  const receiptOnly = options?.receiptOnly === true;
  const workspaceGit = !receiptOnly && (frozenCommand.type === 'workspace.git.read' || frozenCommand.type === 'workspace.git.mutate');
  if (receiptOnly && !requestId) throw new HubError('核对回执必须使用原请求编号', 400, 'invalid_request_id');
  let frozenRequestId = requestId;
  let sourceGrant: { payload: string; signature: string } | undefined;
  let acquisitionAttempted = false;
  const readOnly = receiptOnly || (cmd.type === 'workspace.projects' || cmd.type === 'workspace.explorer') && cmd.action === 'list' || cmd.type === 'workspace.project.preview' && (cmd.action === 'inspect' || cmd.action === 'status') || cmd.type === 'session.side-question.tools' && cmd.action === 'read' || cmd.type === 'workspace.artifacts' && cmd.action !== 'save' || ['remote.connections.sync', 'agents.status', 'sessions.list', 'desktop.sessions.list', 'session.open', 'desktop.session.open', 'session.describe', 'projects.list', 'models.list', 'features.list', 'session.context', 'session.actions', 'sessions.archived', 'session.workflows', 'session.cooperation.prepare', 'session.side-question.read', 'remote.station.receipt', 'attachment.read', 'workspace.files.list', 'workspace.files.read', 'workspace.project.files.list', 'workspace.project.files.read', 'workspace.terminal.read', 'workspace.preview.frame', 'workspace.preview.file', 'workspace.git.read'].includes(cmd.type);
  // Model discovery is read-only in conversation terms but can contact the
  // upstream provider; station policy and a restricted source grant still apply.
  // v2 handovers only move an already-paired transport. They must not acquire
  // a grant for B's API through A (or send that key to A's issuer). This hint
  // never authorizes execution: both Hub and Bridge still enforce pairing,
  // station policy and the exact saved destination.
  const transportOnlyHandover = frozenCommand.type === 'remote.station.switch' && options?.transportOnlyHandover === true;
  // These tools are authorized by the paired computer and exact workspace.
  // They never call a model provider; even a server requesting a source grant
  // must not cause the phone to acquire or disclose unrelated API authority.
  const workspaceLocal = ['workspace.projects', 'workspace.explorer', 'workspace.artifacts', 'workspace.git.read', 'workspace.git.mutate', 'workspace.files.mutate', 'workspace.preview.file', 'workspace.files.write', 'workspace.terminal.open', 'workspace.terminal.read', 'workspace.terminal.input', 'workspace.terminal.resize', 'workspace.terminal.close',
    'workspace.preview.open', 'workspace.preview.frame', 'workspace.preview.input', 'workspace.preview.close', 'workspace.project.preview'].includes(frozenCommand.type);
  const sourceProtected = !receiptOnly && !workspaceLocal && (!readOnly || cmd.type === 'models.list' || cmd.type === 'features.list' || cmd.type === 'session.context' || cmd.type === 'session.actions' || cmd.type === 'sessions.archived' || cmd.type === 'session.workflows' || cmd.type === 'session.cooperation.prepare' || cmd.type === 'session.side-question.read' || cmd.type === 'session.side-question.tools') && !transportOnlyHandover;
  // A dead/slow read formerly occupied the spinner for 3 × 55 seconds. Keep
  // reconnection retries, but share one wall-clock budget; task writes retain
  // their original delivery/idempotency behavior and timeout.
  // Git snapshots/reviews can hash large worktrees and run several child
  // processes. Reserve ten seconds beyond the Bridge's 90-second execution budget for its receipt.
  const deadline = readOnly ? Date.now() + (workspaceGit ? 100_000 : 30_000) : Infinity;
  const timeoutFor = (maximum: number) => {
    throwIfAborted(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new HubError('读取超时，请重试', 408, 'read_timeout');
    return Math.min(maximum, remaining);
  };
  let reply: Record<string, unknown> = {};
  for (let attempt = 0; ; attempt += 1) {
    try {
      const envelope = { deviceId, command: frozenCommand, ...(frozenRequestId ? { requestId: frozenRequestId } : {}), ...(sourceGrant ? { sourceGrant } : {}), ...(receiptOnly ? { receiptOnly: true } : {}), ...(options?.executionTicket ? { executionTicket: options.executionTicket } : {}) };
      if (new TextEncoder().encode(JSON.stringify(envelope)).length > 256 * 1024) throw new HubError('内容过多，请减少正文、技能或引用后重试', 413, 'command_too_large');
      reply = await request(owner, '/app/commands', { method: 'POST', body: envelope, timeoutMs: timeoutFor(workspaceGit ? 100_000 : readOnly ? 20_000 : 55_000), signal });
      throwIfAborted(signal);
      break;
    } catch (error) {
      if (sourceProtected && !acquisitionAttempted && error instanceof HubError && error.code === 'source_grant_required') {
        acquisitionAttempted = true;
        frozenRequestId ??= frozenCommand.type === 'remote.station.switch' ? frozenCommand.operationId : randomUUID();
        const challenge = await request(owner, '/app/source/challenge', { method: 'POST', body: { deviceId, command: frozenCommand, requestId: frozenRequestId }, timeoutMs: timeoutFor(20_000), signal });
        if (typeof challenge.challengeId !== 'string' || !/^challenge-[a-zA-Z0-9_-]{1,100}$/.test(challenge.challengeId)) throw new HubError('中转站返回了无效的来源挑战');
        const acquired = await request(owner, '/app/source/grant', { method: 'POST', body: { challengeId: challenge.challengeId }, timeoutMs: timeoutFor(55_000), signal });
        const grant = acquired.sourceGrant as Record<string, unknown> | undefined;
        if (!grant || typeof grant.payload !== 'string' || grant.payload.length > MAX_SOURCE_GRANT_PAYLOAD_CHARS || !/^[A-Za-z0-9_-]+$/.test(grant.payload)
          || typeof grant.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(grant.signature)) throw new HubError('中转站未返回完整的来源授权');
        sourceGrant = { payload: grant.payload, signature: grant.signature };
        throwIfAborted(signal);
        continue;
      }
      // Reconnect may replace the Bridge stream between an online check and a
      // history read. Retry only reads, never a task, API change or approval.
      if (!readOnly || requestId || attempt >= 2 || !(error instanceof HubError)
        || Date.now() >= deadline || !(error.status === 0 || error.status === 409 && !error.code || error.status >= 500)) throw error;
      await waitForRetry(Math.min(attempt === 0 ? 600 : 1200, deadline - Date.now()), signal);
    }
  }
  throwIfAborted(signal);
  if (reply.state === 'queued' || reply.queued === true) throw new HubError('服务器已保存，等待电脑连接后执行', 409, 'command_receipt_pending');
  if (reply.ok === false) throw new HubError(typeof reply.error === 'string' && reply.error ? reply.error : '电脑没有完成这个操作', 200, typeof reply.code === 'string' ? reply.code : undefined);
  if (reply.ok !== true || (reply.result !== undefined && (!reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result)))) throw new HubError('未收到完整送达确认，保留原请求等待重试');
  return (reply.result ?? {}) as T;
}

export interface ExecutionTicket { operationId: string; ticket: string; dispatchNotAfter: number; storageEpoch: string }
export interface DurableOperation extends ExecutionTicket {
  state: 'prepared' | 'queued' | 'pending' | 'completed' | 'uncertain' | 'expired';
  ok: boolean; result?: Record<string, unknown>; error?: string; code?: string; httpStatus?: number; retainedUntil?: number;
}
export function validExecutionTicket(value: unknown): value is ExecutionTicket {
  if (!value || typeof value !== 'object') return false;
  const row = value as ExecutionTicket;
  return typeof row.operationId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.operationId)
    && typeof row.ticket === 'string' && row.ticket.length > 0 && row.ticket.length <= 16384
    && Number.isSafeInteger(row.dispatchNotAfter) && row.dispatchNotAfter > 0
    && typeof row.storageEpoch === 'string' && row.storageEpoch.length > 0 && row.storageEpoch.length <= 256;
}
export async function prepareCommand(hub: Hub, deviceId: string, requestId: string, command: Command, signal?: AbortSignal): Promise<ExecutionTicket> {
  const result = await request(hub, '/app/commands/prepare', { method: 'POST', body: { deviceId, requestId, command }, signal });
  if (!validExecutionTicket(result) || !['prepared', 'expired'].includes(String(result.state))) throw new HubError('服务器返回的执行票据无效，未派发', 502, 'invalid_execution_ticket');
  return { operationId: result.operationId, ticket: result.ticket, dispatchNotAfter: result.dispatchNotAfter, storageEpoch: result.storageEpoch };
}
export async function readOperation(hub: Hub, deviceId: string, ticket: ExecutionTicket, signal?: AbortSignal): Promise<DurableOperation> {
  const result = await request(hub, `/app/operations?deviceId=${encodeURIComponent(deviceId)}&operationId=${encodeURIComponent(ticket.operationId)}&ticket=${encodeURIComponent(ticket.ticket)}`, { signal });
  if (result.operationId !== ticket.operationId || result.storageEpoch !== ticket.storageEpoch || result.dispatchNotAfter !== ticket.dispatchNotAfter
    || !['prepared', 'queued', 'pending', 'completed', 'uncertain', 'expired'].includes(String(result.state)) || typeof result.ok !== 'boolean'
    || result.result !== undefined && (!result.result || typeof result.result !== 'object' || Array.isArray(result.result))) throw new HubError('服务器返回的恢复记录无效', 502, 'invalid_operation_record');
  return { ...result, ...ticket } as DurableOperation;
}
export async function acknowledgeOperation(hub: Hub, deviceId: string, ticket: ExecutionTicket): Promise<void> {
  await request(hub, '/app/operations/ack', { method: 'POST', body: { deviceId, operationId: ticket.operationId, ticket: ticket.ticket } });
}
export async function acknowledgeSessionEvents(hub: Hub, deviceId: string, sessionKey: string, through: number, storageEpoch: string): Promise<void> {
  await request(hub, '/app/events/ack', { method: 'POST', body: { deviceId, sessionKey, through, storageEpoch } });
}

export async function sessionEvents(hub: Hub, deviceId: string, sessionKey: string, after = 0): Promise<HubEvent[]> {
  return (await sessionEventsPage(hub, deviceId, sessionKey, after)).events;
}
/** Control snapshots are separate from conversation events and their cursors. */
export interface FeatureChangedEvent { type: 'features.changed'; deviceId: string; tool: ToolId; sessionKey: ''; seq: number; ts?: number }
const FEATURE_CHANGE_EVENT_FIELDS = new Set(['id', 'role', 'text', 'skills', 'context', 'status', 'final', 'approvalId', 'output', 'questions',
  'attachments', 'parentId', 'childSessionKeys', 'turnId', 'error', 'detail', 'diff', 'kind', 'title', 'level']);
export function parseFeatureChange(value: unknown, deviceId?: string, surface: 'stream' | 'snapshot' = 'stream'): FeatureChangedEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  const emptySession = row.sessionKey === '' || surface === 'snapshot' && !Object.prototype.hasOwnProperty.call(row, 'sessionKey');
  // New control metadata is ignored by this client after validation and is
  // therefore safe to accept. Fields that identify a conversation payload
  // remain forbidden so a mixed event cannot become an invalidation hint.
  if (Object.keys(row).some(key => FEATURE_CHANGE_EVENT_FIELDS.has(key)) || row.type !== 'features.changed' || !emptySession
    || typeof row.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(row.deviceId) || deviceId !== undefined && row.deviceId !== deviceId
    || typeof row.tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.tool)
    || !Number.isSafeInteger(row.seq) || (row.seq as number) <= 0
    || row.ts !== undefined && (!Number.isSafeInteger(row.ts) || (row.ts as number) < 0)) return;
  return { type: 'features.changed', deviceId: row.deviceId, tool: row.tool, sessionKey: '', seq: row.seq as number,
    ...(row.ts !== undefined ? { ts: row.ts as number } : {}) };
}
export interface SessionEventsPage { events: HubEvent[]; storageEpoch?: string; durableEvents?: unknown[]; /** Scoped records scanned, including future event variants intentionally omitted from `events`. */ scannedEventCount: number; nextSeq: number; lastSeq: number; hasMore: boolean; resetRequired: boolean; featureChanges?: FeatureChangedEvent[] }
/** With waitSeconds > 0 (Hub capability events.wait.v1) the Hub holds an empty read until a new event arrives. */
export async function sessionEventsPage(hub: Hub, deviceId: string, sessionKey: string, after = 0, waitSeconds = 0, limit = 100, signal?: AbortSignal, beforeParse?: () => void): Promise<SessionEventsPage> {
  if (hub.deviceId && hub.deviceId !== deviceId) throw new HubError('这台电脑不属于当前配对连接');
  const wait = Math.max(0, Math.min(25, Math.floor(waitSeconds)));
  const query = `deviceId=${encodeURIComponent(deviceId)}&sessionKey=${encodeURIComponent(sessionKey)}&after=${after}&limit=${Math.max(1, Math.min(500, limit))}${wait ? `&wait=${wait}` : ''}`;
  const result = await request(hub, `/app/events?${query}`, { timeoutMs: wait ? (wait + 15) * 1000 : 20_000, signal });
  // Re-check capability/connection ownership before decoding a late page.
  // This prevents a revoked adapter from being blamed on a malformed stale
  // payload and, more importantly, avoids publishing any part of that page.
  beforeParse?.();
  if (result.events !== undefined && (!Array.isArray(result.events) || result.events.length > 500 || result.events.some((event) => !event || typeof event !== 'object' || Array.isArray(event)))) {
    throw new HubError('中转站返回了无效的事件页');
  }
  // A missing event array is an older/malformed response, not an empty page
  // with permission to jump its cursor. Known malformed events fail the page;
  // future event kinds are ignored after their common envelope is checked.
  const rawEvents = Array.isArray(result.events) ? result.events : [];
  // Control-plane invalidations are returned in their own validated field.
  // A copy placed in the timeline page is discarded and cannot move the
  // conversation cursor, whether current or from a newer Bridge.
  const scopedRaw = rawEvents.filter(event => isRecord(event) && event.type !== 'features.changed'
    && event.deviceId === deviceId && event.sessionKey === sessionKey);
  const malformedScoped = rawEvents.some(event => isRecord(event) && event.type !== 'features.changed'
    && event.deviceId === deviceId && event.sessionKey === sessionKey && (!validId(event.type, 128)));
  if (malformedScoped) throw new HubError('中转站返回了无效的事件内容');
  const events = scopedRaw.map(parseHubEvent).filter((event): event is HubEvent => event !== undefined);
  const featureChanges = Array.isArray(result.featureChanges) && result.featureChanges.length <= 256
    ? result.featureChanges.map(value => parseFeatureChange(value, deviceId, 'snapshot')).filter((value): value is FeatureChangedEvent => value !== undefined) : [];
  // A malformed cursor must never make the phone skip events.  In particular,
  // some older relays returned `nextSeq: 0` while still returning events.  Use
  // the greatest valid event cursor as a lower bound even when the relay's
  // advertised cursor is present but stale.  Invalid optional seq values are
  // rejected rather than being treated as a legacy event: otherwise a broken
  // page could be accepted and the next request would advance past it.
  const eventSeq = scopedRaw.reduce((seq, event) => Math.max(seq, isRecord(event) && validCounter(event.seq) ? event.seq : after), after);
  const rawLastSeq = validCounter(result.lastSeq) ? result.lastSeq : 0;
  const candidateNextSeq = validCounter(result.nextSeq) && result.nextSeq >= after ? result.nextSeq : after;
  const scopeIsClean = rawEvents.filter(event => isRecord(event) && event.type !== 'features.changed')
    .every(event => isRecord(event) && event.deviceId === deviceId && event.sessionKey === sessionKey);
  const advertisedSeq = scopeIsClean && scopedRaw.length > 0 && result.events !== undefined && (!rawLastSeq || candidateNextSeq <= rawLastSeq) ? candidateNextSeq : after;
  return { events, scannedEventCount: scopedRaw.length, nextSeq: Math.max(after, advertisedSeq, eventSeq),
    ...(typeof result.storageEpoch === 'string' && result.storageEpoch.length > 0 && result.storageEpoch.length <= 256 ? { storageEpoch: result.storageEpoch, durableEvents: scopedRaw } : {}),
    lastSeq: rawLastSeq,
    hasMore: result.hasMore === true, resetRequired: result.resetRequired === true,
    ...(result.featureChanges !== undefined ? { featureChanges } : {}) };
}

// ——— live stream ———

export type StreamState = 'connecting' | 'open' | 'retrying' | 'closed';
export interface StreamOptions {
  hub: Hub; after?: number;
  onEvent: (event: HubEvent) => void;
  onFeatureChange?: (event: FeatureChangedEvent) => void;
  onDevice: (device: DeviceStatus) => void;
  onState?: (state: StreamState, info?: { retryInMs?: number; error?: string }) => void;
  /** Reconnect when nothing (not even the 20 s `: ping`) arrives for this long. */
  idleMs?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export interface StreamHandle { close: () => void; lastSeq: () => number }

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

export const BACKOFF_MIN = 1000;
export const BACKOFF_MAX = 30_000;

/**
 * Follows /app/stream until closed: resumes with `after=<last seq>` and backs off 1 s → 30 s between
 * attempts. A 401 stops for good (the key is no longer a relay user).
 */
export function openStream(options: StreamOptions): StreamHandle {
  const { hub, onEvent, onDevice, onState, idleMs = 65_000, wait = sleep } = options;
  const outer = new AbortController();
  let seq = options.after ?? 0;
  let delay = BACKOFF_MIN;
  const featureSeqs = new Map<string, number>();

  const connect = async () => {
    const attempt = new AbortController();
    const stop = () => attempt.abort();
    outer.signal.addEventListener('abort', stop, { once: true });
    let alive = Date.now();
    let endpoint = hub.url;
    const watchdog = setInterval(() => { if (Date.now() - alive > idleMs) attempt.abort(); }, Math.min(idleMs, 5000));
    try {
      const transport = await withAbort(attempt.signal, () => transportFetch(hub.url, `/app/stream?after=${seq}${hub.deviceId ? `&deviceId=${encodeURIComponent(hub.deviceId)}` : ''}`, {
        method: 'GET', headers: { Accept: 'text/event-stream', ...authHeaders(hub) }, signal: attempt.signal, credentials: 'omit', redirect: 'error',
      }));
      const response = transport.response;
      endpoint = transport.endpoint;
      checkResponseScope(response, endpoint);
      if (!response.ok) {
        const json = await readJson(response).catch(() => ({} as Record<string, unknown>));
        throw httpFailure(response.status, json, Boolean(hub.pairToken || hub.botToken));
      }
      if (!response.headers?.get?.('content-type')?.toLowerCase().includes('text/event-stream')) throw new HubError('中转站没有返回远程事件流，请检查插件和反向代理配置');
      delay = BACKOFF_MIN;
      onState?.('open');
      const body = response.body as { getReader?: () => { read: () => Promise<{ done: boolean; value?: unknown }>; cancel?: () => unknown } } | undefined;
      const reader = body?.getReader?.();
      const tracked = reader ? { getReader: () => ({ read: async () => { const chunk = await reader.read(); alive = Date.now(); return chunk; }, cancel: () => reader.cancel?.() }) } : body;
      await readSse({ headers: response.headers, body: tracked, text: response.text }, (event) => {
        let data: unknown;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!isRecord(data)) return;
        if (event.event === 'device') {
          const device = parseDeviceStatus(data);
          if (device && (!hub.deviceId || device.deviceId === hub.deviceId)) onDevice(device);
          return;
        }
        if (event.event !== 'event' && event.event !== null) return;
        // The stream is device-scoped, but keep the boundary local too. A
        // malformed or future event from another device must not tear down
        // this computer's stream or advance its cursor.
        if (hub.deviceId && data.deviceId !== hub.deviceId) return;
        if ((data as { type?: unknown }).type === 'features.changed') {
          if (outer.signal.aborted || attempt.signal.aborted) return;
          const change = parseFeatureChange(data, hub.deviceId);
          if (!change) return;
          const key = JSON.stringify([change.deviceId, change.tool]);
          if (change.seq <= (featureSeqs.get(key) ?? 0)) return;
          options.onFeatureChange?.(change);
          featureSeqs.set(key, change.seq);
          if (featureSeqs.size > 256) featureSeqs.delete(featureSeqs.keys().next().value!);
          return;
        }
        const hubEvent = parseHubEvent(data);
        if (validCounter(data.seq) && data.seq <= seq) return;
        if (hubEvent) onEvent(hubEvent);
        if (validCounter(data.seq)) seq = data.seq;
      }, attempt.signal);
      if (!outer.signal.aborted && ingressEnabled) ingress.fail(hub.url, endpoint);
      return null;
    } catch (error) {
      if (error instanceof HubError && (error.status === 401 || error.status === 403)) throw error;
      if (!outer.signal.aborted && ingressEnabled) ingress.fail(hub.url, endpoint);
      return error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(watchdog);
      outer.signal.removeEventListener('abort', stop);
    }
  };

  void (async () => {
    while (!outer.signal.aborted) {
      onState?.('connecting');
      let error: string | null;
      try { error = await connect(); } catch (fatal) {
        if (!outer.signal.aborted) onState?.('closed', { error: (fatal as Error).message });
        return;
      }
      if (outer.signal.aborted) break;
      onState?.('retrying', { retryInMs: delay, error: error ?? undefined });
      await wait(delay, outer.signal);
      delay = Math.min(delay * 2, BACKOFF_MAX);
    }
    onState?.('closed');
  })();

  return { close: () => outer.abort(), lastSeq: () => seq };
}
