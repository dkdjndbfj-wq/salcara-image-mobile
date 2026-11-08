import type { SlashActionEntry, SlashQuery } from './slash-commands';

export interface ComposerSlashActions {
  model?: boolean; reasoning?: boolean; reasoningLabel?: string; permissions?: boolean;
  newChat?: boolean; sideChat?: boolean; fork?: boolean; archive?: boolean; review?: boolean; initialize?: boolean;
}

/** Only expose actions with a live route in the current conversation. */
export function composerSlashActions(available: ComposerSlashActions): SlashActionEntry[] {
  const entries: SlashActionEntry[] = [];
  if (available.model) entries.push({ action: 'model', label: '模型', command: '/model', description: '选择模型', icon: 'bot', submenu: true });
  if (available.reasoning) entries.push({ action: 'reasoning', label: '推理强度', command: '/reasoning', description: available.reasoningLabel || '调整思考程度', icon: 'lightbulb', submenu: true });
  if (available.permissions) entries.push({ action: 'permissions', label: '权限', command: '/permissions', description: '调整批准方式', icon: 'settings', submenu: true });
  if (available.newChat) entries.push({ action: 'new', label: '新聊天', command: '/new', description: '在当前项目中新建聊天', icon: 'compose' });
  if (available.sideChat) entries.push({ action: 'side', label: '侧边聊天', command: '/side', description: '发起独立的侧边聊天', icon: 'chat', submenu: true });
  if (available.fork) entries.push({ action: 'fork', label: '创建聊天分支', command: '/fork', description: '从当前聊天创建分支', icon: 'external', submenu: true });
  if (available.initialize) entries.push({ action: 'init', label: '初始化', command: '/init', description: '准备 AGENTS.md 初始化任务', icon: 'file' });
  if (available.review) entries.push({ action: 'review', label: '代码审查', command: '/review', description: '审查未提交的变更', icon: 'listCheck', submenu: true });
  if (available.archive) entries.push({ action: 'archive', label: '归档', command: '/archive', description: '归档当前聊天', icon: 'archive', submenu: true });
  return entries;
}

/** Initialization is a visible draft, sent only through the normal send action. */
export function initializationDraft(text: string, query: SlashQuery): { text: string; caret: number } {
  if (query.source !== text) return { text, caret: query.replaceEnd };
  const request = '请检查当前项目，为后续编程任务创建或完善 AGENTS.md。先阅读已有说明，保留仍然有效的内容；根据实际代码整理项目结构、构建与测试命令、代码约定。只修改必要的说明文件。';
  return { text: text.slice(0, query.replaceStart) + request + text.slice(query.replaceEnd), caret: query.replaceStart + request.length };
}
