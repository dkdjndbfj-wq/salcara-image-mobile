import { skillKey, type AgentFeatures, type CollaborationMode, type SkillReference } from './agent-features';
import { copySkillReference } from './skill-display-metadata';
import type { IconName } from '../components/Icon';

export type SlashActionId = 'model' | 'reasoning' | 'new' | 'side' | 'fork' | 'archive' | 'init' | 'mcp' | 'review' | 'permissions';
export interface SlashActionEntry {
  action: SlashActionId;
  label: string;
  command: string;
  description: string;
  icon?: IconName;
  disabled?: boolean;
  disabledReason?: string;
  submenu?: boolean;
}
const actionAliases: Record<SlashActionId, string> = {
  model: 'model 模型 型号', reasoning: 'reasoning effort 推理 思考 强度', new: 'new 新聊天 新建 新对话',
  side: 'side sidechat 侧边 侧聊 临时聊天', fork: 'fork branch 分支 派生', archive: 'archive 归档',
  init: 'init initialize 初始化 AGENTS.md 项目指令', mcp: 'mcp servers MCP 服务器 状态',
  review: 'review 审查 检查 代码', permissions: 'permissions approval 批准 权限',
};
const actionIcons: Record<SlashActionId, IconName> = {
  model: 'bot', reasoning: 'memory', new: 'compose', side: 'chat', fork: 'external', archive: 'archive',
  init: 'file', mcp: 'paperclip', review: 'listCheck', permissions: 'settings',
};

export interface SlashQuery {
  query: string;
  skillsOnly: boolean;
  trigger: '/' | '$';
  replaceStart: number;
  replaceEnd: number;
  remainder: string;
  source: string;
}
export interface SlashCommandEntry {
  id: string;
  kind: 'mode' | 'skill' | 'skills' | 'compact' | 'action';
  label: string;
  command: string;
  description: string;
  mode?: CollaborationMode;
  skill?: SkillReference;
  pathLabel?: string;
  action?: SlashActionId;
  icon?: IconName;
  disabled?: boolean;
  disabledReason?: string;
  submenu?: boolean;
}

/** Local commands remain usable when only the remote skill catalogue fails. */
export function slashCommandDisabled(entry: SlashCommandEntry, state: { disabled?: boolean; loading?: boolean; error?: string } = {}): boolean {
  return Boolean(state.disabled || entry.disabled || entry.disabledReason
    || (entry.kind === 'mode' || entry.kind === 'skill' || entry.kind === 'skills') && (state.loading || state.error));
}

/** Match the token before the caret, after whitespace, like Codex's composer.
 * Text after the caret is never part of the query or replacement range. */
export function parseSlashQuery(text: string, caret = text.length): SlashQuery | undefined {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return undefined;
  const match = /(?:^|\s)([/$])(?!\s)([\p{L}\p{N}\p{M}.:_\\ -]*)$/u.exec(text.slice(0, caret));
  if (!match) return undefined;
  const trigger = match[1] as '/' | '$', raw = match[2];
  if (trigger === '$' && /\s/u.test(raw)) return undefined;
  const skillsOnly = trigger === '$' || /^skills(?:\s|$)/iu.test(raw);
  return { query: trigger === '/' && skillsOnly ? raw.replace(/^skills\s*/iu, '') : raw,
    skillsOnly, trigger, replaceStart: caret - raw.length - 1, replaceEnd: caret,
    remainder: text.slice(caret), source: text };
}

/** Plan is a toggle, separate from permission policy. */
export function buildSlashCommands(features: AgentFeatures | undefined, query: SlashQuery, currentMode?: CollaborationMode, compactSupported = false, actions: readonly SlashActionEntry[] = []): SlashCommandEntry[] {
  const terms = query.query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = (value: string) => terms.every(term => value.toLowerCase().includes(term));
  const entries: SlashCommandEntry[] = [];
  if (!query.skillsOnly) {
    const seen = new Set<SlashActionId>();
    for (const action of actions) {
      if (!Object.hasOwn(actionAliases, action.action) || seen.has(action.action) || !action.label.trim() || !/^\/[a-z][a-z0-9_-]*$/i.test(action.command)) continue;
      seen.add(action.action);
      if (!matches(`${actionAliases[action.action]} ${action.command} ${action.label} ${action.description}`)) continue;
      entries.push({ id: `action:${action.action}`, kind: 'action', action: action.action, label: action.label, command: action.command,
        description: action.description, icon: action.icon ?? actionIcons[action.action], disabled: Boolean(action.disabled || action.disabledReason),
        ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}), ...(action.submenu ? { submenu: true } : {}) });
    }
    if (compactSupported && matches('compact 压缩上下文')) {
      entries.push({ id: 'context:compact', kind: 'compact', label: '压缩上下文', command: '/compact', description: '缩短当前聊天的上下文', icon: 'minimize' });
    }
    const nextMode = currentMode === 'plan' ? 'default' : 'plan';
    if (features?.collaborationModes.includes(nextMode) && matches('plan 计划 规划 方案 planning')) {
      entries.push({ id: 'mode:plan', kind: 'mode', mode: nextMode, label: '计划模式', command: '/plan',
        description: currentMode === 'plan' ? '关闭计划模式' : '开启计划模式', icon: 'listCheck' });
    }
    if (features?.skillsSupported && matches('skills skill 技能 搜索技能 浏览技能')) {
      entries.push({ id: 'skills', kind: 'skills', label: '技能', command: '/skills', description: '浏览和搜索技能', icon: 'sparkle', submenu: true });
    }
  }
  if (!features?.skillsSupported) return entries;
  const names = new Map<string, number>(), seen = new Set<string>();
  const catalog = features.skills.filter(skill => {
    const key = skillKey(skill);
    if (seen.has(key)) return false;
    seen.add(key); names.set(skill.name.toLowerCase(), (names.get(skill.name.toLowerCase()) ?? 0) + 1);
    return true;
  });
  for (const skill of catalog) {
    if (!matches(`${skill.name} ${skill.displayName ?? ''} ${skill.description} ${skill.path ?? ''} 技能 skill`)) continue;
    const reference: SkillReference = copySkillReference(skill);
    entries.push({ id: `skill:${skillKey(reference)}`, kind: 'skill', skill: reference, icon: 'sparkle',
      label: skill.displayName || skill.name, command: `/${skill.name}`, description: skill.description,
      ...((names.get(skill.name.toLowerCase()) ?? 0) > 1 ? { pathLabel: skill.path || '运行时技能' } : {}) });
  }
  return entries;
}

/** Selection edits the command range only; sending is a separate action. */
export function applySlashCommand(text: string, query: SlashQuery, entry: SlashCommandEntry): string {
  if (query.source !== text || slashCommandDisabled(entry)) return text;
  const replacement = entry.kind === 'skills' ? '/skills ' : '';
  return text.slice(0, query.replaceStart) + replacement + text.slice(query.replaceEnd);
}

