import { useCallback, useEffect, useRef, useState } from 'react';
import { getSetting, setSetting } from '../storage/database';
import { initialWorkspacePages, type WorkspacePage } from './WorkspaceTabs';
import { workspaceBrowserTarget } from './workspace-browser';

export interface WorkspaceLayout { scope: string; pages: WorkspacePage[]; activeId: string; browserEvents?: string[]; closedPages?:WorkspacePage[] }
const memory = new Map<string, WorkspaceLayout>(), writes = new Map<string, Promise<void>>();
const storageKey = (scope: string) => `remote.workspace.layout.v1:${scope}`;
const fresh = (scope: string): WorkspaceLayout => ({ scope, pages: initialWorkspacePages(), activeId: 'newtab' });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const restored = (value: WorkspaceLayout): WorkspaceLayout => ({...clone(value), pages:value.pages.map(page=>page.kind==='terminal'?{...clone(page),restored:true}:clone(page))});
const text = (value: unknown, max = 8192): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value);

/** Conversation previews contain transient source, not durable workspace data. */
function durableWorkspaceLayout(value:WorkspaceLayout):WorkspaceLayout {
  const pages=value.pages.filter(page=>page.kind!=='artifact').map(({artifact:_,...page})=>page);
  const safePages=pages.length?pages:initialWorkspacePages();
  return {...value,pages:safePages,activeId:safePages.some(page=>page.id===value.activeId)?value.activeId:safePages[0].id,
    ...(value.closedPages?{closedPages:value.closedPages.filter(page=>page.kind!=='artifact').map(({artifact:_,...page})=>page)}:{})};
}

export function parseWorkspaceLayout(raw: string, scope: string): WorkspaceLayout | undefined {
  if (raw.length > 1024 * 1024) return;
  let value: WorkspaceLayout; try { value = JSON.parse(raw); } catch { return; }
  if (!value || value.scope !== scope || !Array.isArray(value.pages) || value.pages.length > 48 || !text(value.activeId, 1024)) return;
  if (value.browserEvents && (!Array.isArray(value.browserEvents) || value.browserEvents.length > 4096 || value.browserEvents.some(item => !text(item, 16384)))) return;
  if(value.closedPages){if(!Array.isArray(value.closedPages)||value.closedPages.length>20)return;const check=parseWorkspaceLayout(JSON.stringify({scope,pages:value.closedPages,activeId:value.closedPages[0]?.id??'newtab'}),scope);if(!check)return;}
  const ids = new Set<string>();
  for (const page of value.pages) {
    if (!page || page.artifact!==undefined || !text(page.id, 1024) || !page.id || ids.has(page.id) || !text(page.title, 4096)
      || !['terminal', 'changes', 'agents', 'tools', 'files', 'preview', 'diff', 'side-chat', 'side-history', 'newtab', 'git', 'computer', 'project-preview'].includes(page.kind)) return;
    ids.add(page.id);
    if (page.kind === 'project-preview' || page.projectPreview !== undefined) {
      const target = page.projectPreview, selection = target?.selection;
      if (!target || page.kind !== 'project-preview' || !selection || !text(target.sourcePath, 4096)
        || !target.sourcePath || /[\\:\p{Cf}]/u.test(target.sourcePath) || target.sourcePath.split('/').some(part => !part || part === '.' || part === '..')
        || !text(selection.cwd, 4096) || !selection.cwd || !text(selection.deviceId, 512) || !selection.deviceId
        || !text(selection.sessionKey, 1024) || !selection.sessionKey || !text(selection.agentId, 128) || !selection.agentId
        || !['cli', 'desktop'].includes(selection.surface)
        || Object.keys(target).some(key => !['sourcePath', 'selection'].includes(key))
        || Object.keys(selection).some(key => !['deviceId', 'agentId', 'sessionKey', 'surface', 'cwd'].includes(key))) return;
    }
    if (page.file && (!text(page.file.path) || !text(page.file.expectedCwd) || !text(page.file.sessionKey) || !['cli', 'desktop'].includes(page.file.surface) || !Number.isFinite(page.file.nonce))) return;
    if (page.preview && (!text(page.preview.url) || !workspaceBrowserTarget(page.preview.url))) return;
    if (page.browserPageId !== undefined && !text(page.browserPageId, 512)) return;
    if (page.browserScroll?.url && (!text(page.browserScroll.url) || !workspaceBrowserTarget(page.browserScroll.url))) return;
    if (page.browserScroll && (![page.browserScroll.x,page.browserScroll.y].every(number=>Number.isFinite(number)&&number>=0&&number<=100_000_000))) return;
    if (page.browserHistory && (!Array.isArray(page.browserHistory.urls) || page.browserHistory.urls.length > 100 || !Number.isInteger(page.browserHistory.index)
      || page.browserHistory.index < -1 || page.browserHistory.index >= page.browserHistory.urls.length || page.browserHistory.urls.some(url => !text(url) || !workspaceBrowserTarget(url)))) return;
    if (!Array.isArray(page.changes ?? [])) return;
    const edits = [...(page.changes ?? []), ...(page.diff ? [page.diff] : [])];
    if (edits.length > 100 || edits.some(edit => !edit || !text(edit.path) || !text(edit.id) || !['done', 'running', 'failed', 'interrupted'].includes(edit.status) || !Number.isFinite(edit.add) || !Number.isFinite(edit.del) || edit.diff !== undefined && (typeof edit.diff !== 'string' || edit.diff.length > 256 * 1024))) return;
  }
  if (!ids.has(value.activeId)) value.activeId = value.pages[0]?.id ?? 'newtab';
  if (!value.pages.length) value.pages = [{ id: 'newtab', title: '新标签页', kind: 'newtab' }];
  return value;
}

export async function loadWorkspaceLayout(scope: string): Promise<WorkspaceLayout | undefined> {
  const cached = memory.get(scope); if (cached) return restored(cached);
  const raw = await getSetting(storageKey(scope));
  if (memory.has(scope)) return restored(memory.get(scope)!);
  if (!raw) return;
  const value = parseWorkspaceLayout(raw, scope);
  if (!value) throw new Error('工作区恢复记录无效，原记录已保留');
  value.pages = value.pages.map(page => page.kind === 'terminal' ? { ...page, restored: true } : page);
  memory.set(scope, value); return clone(value);
}

export function saveWorkspaceLayout(value: WorkspaceLayout): Promise<void> {
  const snapshot = JSON.stringify(durableWorkspaceLayout(value));
  if (!parseWorkspaceLayout(snapshot, value.scope)) return Promise.reject(new Error('工作区标签数量或内容超出恢复容量'));
  memory.set(value.scope, clone(value));
  const write = (writes.get(value.scope) ?? Promise.resolve()).catch(() => undefined).then(() => setSetting(storageKey(value.scope), JSON.stringify(durableWorkspaceLayout(memory.get(value.scope)!))));
  writes.set(value.scope, write); return write;
}

/** Scope-bound restoration: newer navigation always wins over a late disk read. */
export function useWorkspaceLayout(scope: string, enabled: boolean) {
  const owner = useRef({ scope, revision: 0 });
  const hydrated = useRef('');
  if (owner.current.scope !== scope) owner.current = { scope, revision: 0 };
  const [state, setState] = useState<WorkspaceLayout>(() => restored(memory.get(scope) ?? fresh(scope)));
  const [ready, setReady] = useState(''), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const current = owner.current; let mounted = true;
    hydrated.current = ''; setReady('');
    setError(''); setState(restored(memory.get(scope) ?? fresh(scope)));
    void loadWorkspaceLayout(scope).then(saved => {
      if (!mounted || owner.current !== current || current.revision) return;
      hydrated.current = scope; setState(saved ?? fresh(scope)); setReady(scope);
    }).catch(reason => { if (mounted && owner.current === current) setError(reason instanceof Error ? reason.message : '工作区恢复失败'); });
    return () => { mounted = false; };
  }, [scope, enabled, attempt]);
  const retry = useCallback(() => {
    const current = owner.current;
    if (ready === scope) {
      void saveWorkspaceLayout(state).then(() => {if(owner.current===current)setError('');}).catch(reason => {if(owner.current===current)setError(reason instanceof Error ? reason.message : '工作区保存失败');});
    } else setAttempt(value => value + 1);
  }, [ready, scope, state]);
  const update = useCallback((value: WorkspaceLayout | ((previous: WorkspaceLayout) => WorkspaceLayout)) => {
    if (owner.current.scope !== scope || enabled && hydrated.current !== scope) return;
    owner.current.revision++;
    setReady(scope);
    setState(previous => {
      const current = previous.scope === scope ? previous : clone(memory.get(scope) ?? fresh(scope));
      const next = typeof value === 'function' ? value(current) : value;
      if(next===current)return current;
      return { ...next, browserEvents: next.browserEvents ?? current.browserEvents,closedPages:next.closedPages??current.closedPages };
    });
  }, [scope, enabled]);
  useEffect(() => {
    if (!enabled || hydrated.current !== scope || ready !== scope || state.scope !== scope) return;
    const current = owner.current;
    void saveWorkspaceLayout(state).then(() => { if (owner.current === current) setError(''); })
      .catch(reason => { if (owner.current === current) setError(`工作区尚未保存到本机：${reason instanceof Error ? reason.message : '存储失败'}`); });
  }, [state, scope, ready, enabled]);
  return [state.scope === scope ? state : clone(memory.get(scope) ?? fresh(scope)), update, error, !enabled || ready === scope, retry] as const;
}

export function resetWorkspaceLayoutMemoryForTests() { memory.clear(); writes.clear(); }
