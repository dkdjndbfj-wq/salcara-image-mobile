/**
 * Shared agent types. An assistant message can carry an AgentTrace: the steps
 * the assistant took (searching, reading, drawing…), the sources it used,
 * follow-up suggestions, files it created and phone actions awaiting the
 * user's confirmation. The trace is stored as JSON on the message row.
 */

export type StepKind = 'search' | 'read' | 'image' | 'memory' | 'recall' | 'action' | 'file' | 'plan' | 'check' | 'history' | 'tool';
export type StepStatus = 'running' | 'done' | 'error' | 'skipped';

export interface Source {
  title: string;
  url: string;
  snippet?: string;
}

export interface AgentStep {
  id: string;
  kind: StepKind;
  /** Short line shown in the timeline, e.g. “搜索：今天上海天气”. */
  title: string;
  /** Result summary, e.g. “找到 5 条结果”. */
  detail?: string;
  status: StepStatus;
  error?: string;
  sources?: Source[];
  /** Text the assistant wrote before deciding to use this step's tools. */
  note?: string;
  startedAt: number;
  endedAt?: number;
}

export interface GeneratedFile {
  id: string;
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

export type PhoneActionKind = 'alarm' | 'timer' | 'calendar' | 'sms' | 'email' | 'call' | 'map' | 'open_url' | 'share_text';

export interface PhoneAction {
  id: string;
  kind: PhoneActionKind;
  /** Human summary shown on the card, e.g. “明天 07:30 闹钟 · 晨跑”. */
  summary: string;
  /** Normalized parameters, validated when the action is created. */
  params: Record<string, string | number | boolean | number[]>;
  status: 'ready' | 'done' | 'dismissed' | 'failed';
  error?: string;
}

export interface PlanItem { title: string; done: boolean }

export interface AgentTrace {
  steps: AgentStep[];
  /** Deduplicated citations for the answer, in first-use order. */
  sources?: Source[];
  suggestions?: string[];
  files?: GeneratedFile[];
  actions?: PhoneAction[];
  plan?: PlanItem[];
  /** Earlier images drawn in this turn and replaced by a redraw (self-check). */
  drafts?: string[];
  /** Deep research turn. */
  research?: boolean;
  /** Name of the custom agent that answered. */
  agentName?: string;
  /** Chat space: memory notes this reply drew on (记忆线路). */
  recalled?: Array<{ id: string; title: string }>;
}

export function emptyTrace(): AgentTrace { return { steps: [] }; }

/** Every local file a trace owns (for cleanup and the startup sweep). */
export function traceFileUris(trace: AgentTrace | null | undefined): string[] {
  if (!trace) return [];
  return [...(trace.files ?? []).map((file) => file.uri), ...(trace.drafts ?? [])].filter((uri) => typeof uri === 'string' && Boolean(uri));
}

export function parseTrace(json: string | null | undefined): AgentTrace | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<AgentTrace> | null;
    if (!value || typeof value !== 'object' || !Array.isArray(value.steps)) return null;
    return {
      ...value,
      steps: value.steps.filter((step) => step && typeof step === 'object' && typeof step.title === 'string')
        // A step still “running” in storage was cut off when the app closed.
        .map((step) => (step.status === 'running' ? { ...step, status: 'error' as const, error: step.error ?? '已中断' } : step)),
    } as AgentTrace;
  } catch {
    return null;
  }
}

export function hasTraceContent(trace: AgentTrace | null | undefined): boolean {
  return Boolean(trace && (trace.steps.length || trace.sources?.length || trace.suggestions?.length || trace.files?.length || trace.actions?.length || trace.plan?.length || trace.recalled?.length));
}

/** What a custom agent is allowed to do. */
export type AgentCapability = 'search' | 'image' | 'files' | 'actions' | 'memory';
export const ALL_CAPABILITIES: AgentCapability[] = ['search', 'image', 'files', 'actions', 'memory'];

/** A reusable assistant with its own instructions and tools (like a custom GPT). */
export interface CustomAgent {
  id: string;
  name: string;
  /** A single emoji or character shown as its avatar. */
  icon: string;
  /** Avatar tint. */
  color: string;
  description: string;
  instructions: string;
  capabilities: AgentCapability[];
  /** Conversation starters shown on its home screen. */
  starters: string[];
  /** Preferred chat provider/model; null uses the app's current choice. */
  providerId: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Memory {
  id: string;
  content: string;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryHit {
  conversationId: string;
  title: string;
  messageId: string;
  role: 'user' | 'assistant';
  snippet: string;
  createdAt: number;
}
