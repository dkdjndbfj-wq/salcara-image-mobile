import type { AgentId, AgentProfile, ToolId } from './client';

/** Presentation only. Installation, routing and operations come from the host. */
export const AGENT_CHOICES: ReadonlyArray<{ id: AgentId; name: string; tool: ToolId; client?: string; detail: string }> = [
  { id: 'codex', name: 'Codex', tool: 'codex', detail: 'Codex App、CLI 与 IDE' },
  { id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude', client: 'Claude Desktop', detail: 'Code 续聊 · Chat / Cowork 只读' },
  { id: 'claude', name: 'Claude Code', tool: 'claude', detail: '终端与 IDE' },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', tool: 'deepseek-harness', detail: 'DeepSeek 编程会话' },
  { id: 'hermes', name: 'Hermes Agent', tool: 'hermes', detail: 'Hermes 任务与会话' },
];

export function agentDisplayName(id: string | null | undefined, profiles?: readonly Pick<AgentProfile, 'id' | 'name'>[]): string {
  return profiles?.find(profile => profile.id === id)?.name || AGENT_CHOICES.find(choice => choice.id === id)?.name || id || 'Agent';
}
