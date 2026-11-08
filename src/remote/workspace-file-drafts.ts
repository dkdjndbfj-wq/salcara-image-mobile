import type { WorkspaceFileText } from './workspace-files';
import { getSetting, setSetting } from '../storage/database';

export interface WorkspaceFileDraftIdentity {
  scope: string;
  deviceId: string;
  agentId: string;
  sessionKey: string;
  surface: 'cli' | 'desktop';
  cwd: string;
  path: string;
}
export interface WorkspaceFileDraft { base: WorkspaceFileText; text: string }
export const WORKSPACE_DRAFT_FILES = 8;
export const WORKSPACE_DRAFT_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const drafts = new Map<string, { scope: string; identity: WorkspaceFileDraftIdentity; draft: WorkspaceFileDraft; bytes: number }>();
let totalBytes = 0;
const key = (identity: WorkspaceFileDraftIdentity) => JSON.stringify([identity.scope, identity.deviceId, identity.agentId, identity.sessionKey, identity.surface, identity.cwd, identity.path]);
const storageKey = (scope: string) => `remote.workspace.file-drafts.v2:${scope}`;
const hydration = new Map<string, Promise<void>>(), writes = new Map<string, Promise<void>>();
const writeRevisions = new Map<string, number>();
const changed = new Set<string>(), cleared = new Set<string>(), errors = new Map<string, string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const subscribeWorkspaceDraftPersistence = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const workspaceDraftPersistenceError = (scope: string) => errors.get(scope) ?? '';

/** Restore private local drafts before reconciling them against a fresh host read.
 * A late disk read cannot resurrect a discarded draft or replace newer typing. */
export function hydrateWorkspaceFileDrafts(scope: string): Promise<void> {
  if (!scope) return Promise.resolve();
  const existing = hydration.get(scope); if (existing) return existing;
  const work = (async () => {
    const raw = await getSetting(storageKey(scope));
    if (!raw || cleared.has(scope)) return;
    if (raw.length > WORKSPACE_DRAFT_BYTES * 8) throw new Error('草稿记录过大，原记录已保留');
    const payload = JSON.parse(raw);
    if (payload?.version !== 2 || !Array.isArray(payload.entries) || payload.entries.length > WORKSPACE_DRAFT_FILES) throw new Error('草稿记录无法恢复，原记录已保留');
    const incoming: Array<{ identity: WorkspaceFileDraftIdentity; draft: WorkspaceFileDraft; bytes: number }> = [];
    const ids = new Set<string>();
    for (const entry of payload.entries) {
      const identity = entry?.identity, base = entry?.draft?.base, text = entry?.draft?.text;
      if (!identity || identity.scope !== scope || !['cli', 'desktop'].includes(identity.surface)
        || ['scope', 'deviceId', 'agentId', 'sessionKey', 'cwd', 'path'].some(field => typeof identity[field] !== 'string' || !identity[field] || identity[field].length > 8192 || /[\u0000-\u001f]/.test(identity[field]))
        || !base || base.path !== identity.path || typeof base.text !== 'string' || typeof text !== 'string' || !/^[a-f0-9]{64}$/.test(base.revision)
        || !Number.isFinite(base.size) || !Number.isFinite(base.modifiedAt)) throw new Error('草稿记录无法恢复，原记录已保留');
      const id = key(identity), textBytes = new TextEncoder().encode(text).length, baseBytes = new TextEncoder().encode(base.text).length;
      if (ids.has(id) || textBytes > MAX_FILE_BYTES || baseBytes > MAX_FILE_BYTES) throw new Error('草稿记录无法恢复，原记录已保留');
      ids.add(id);
      if (!changed.has(id) && !drafts.has(id)) incoming.push({ identity, draft: { base, text }, bytes: textBytes + baseBytes });
    }
    if (drafts.size + incoming.length > WORKSPACE_DRAFT_FILES || totalBytes + incoming.reduce((n, item) => n + item.bytes, 0) > WORKSPACE_DRAFT_BYTES) throw new Error('草稿容量不足，请先保存其他草稿；磁盘草稿未删除');
    for (const entry of incoming) { drafts.set(key(entry.identity), { ...entry, scope }); totalBytes += entry.bytes; }
  })().catch(error => { hydration.delete(scope); errors.set(scope, '未能恢复文件草稿：' + (error instanceof Error ? error.message : '本地存储不可用')); notify(); throw error; });
  hydration.set(scope, work);
  return work;
}

function persist(scope: string): void {
  const revision = (writeRevisions.get(scope) ?? 0) + 1; writeRevisions.set(scope, revision);
  // Serialize writes per scope; snapshots are taken after hydration and previous
  // writes, so older edits cannot overwrite the last keystroke or a deletion.
  const work = (writes.get(scope) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await hydrateWorkspaceFileDrafts(scope);
    if (writeRevisions.get(scope) !== revision) return;
    const entries = [...drafts.values()].filter(entry => entry.scope === scope).map(({ identity, draft }) => ({ identity, draft }));
    await setSetting(storageKey(scope), entries.length ? JSON.stringify({ version: 2, entries }) : null);
    errors.delete(scope); notify();
  }).catch(error => { errors.set(scope, '文件草稿尚未保存到本机，请勿退出；' + (error instanceof Error ? error.message : '存储失败')); notify(); });
  writes.set(scope, work);
}

export async function flushWorkspaceFileDrafts(scope: string): Promise<void> {
  await writes.get(scope); if (errors.has(scope)) throw new Error(errors.get(scope));
}

/** No expiry/LRU: accepted edits are never silently evicted for another file. */
export function saveWorkspaceFileDraft(identity: WorkspaceFileDraftIdentity, base: WorkspaceFileText, text: string): { ok: true } | { ok: false; message: string } {
  if (!identity.scope || !identity.cwd || identity.path !== base.path || !base.revision) return { ok: false, message: '文件身份或版本不可用，暂时无法编辑' };
  if (text === base.text) { discardWorkspaceFileDraft(identity); return { ok: true }; }
  const textBytes = new TextEncoder().encode(text).length;
  if (textBytes > MAX_FILE_BYTES) return { ok: false, message: '文件最多支持 128 KiB，本次输入未应用；已有草稿已保留' };
  const bytes = textBytes + new TextEncoder().encode(base.text).length;
  const id = key(identity), previous = drafts.get(id);
  if (!previous && drafts.size >= WORKSPACE_DRAFT_FILES || totalBytes - (previous?.bytes ?? 0) + bytes > WORKSPACE_DRAFT_BYTES) {
    return { ok: false, message: '草稿内存已满（最多 8 个文件 / 1 MiB）。请先保存或丢弃其他草稿；本次输入未应用，已有草稿已保留' };
  }
  drafts.set(id, { scope: identity.scope, identity: { ...identity }, draft: { base: { ...base }, text }, bytes });
  changed.add(id);
  totalBytes += bytes - (previous?.bytes ?? 0);
  persist(identity.scope);
  return { ok: true };
}

export function readWorkspaceFileDraft(identity: WorkspaceFileDraftIdentity): WorkspaceFileDraft | undefined {
  const draft = drafts.get(key(identity))?.draft;
  return draft ? { base: { ...draft.base }, text: draft.text } : undefined;
}

/** Call only after an explicit discard or a confirmed save. Unmounting a tab
 * does not discard its draft, and must not write it back after this call. */
export function discardWorkspaceFileDraft(identity: WorkspaceFileDraftIdentity): void {
  const id = key(identity), previous = drafts.get(id);
  changed.add(id);
  if (previous) { drafts.delete(id); totalBytes -= previous.bytes; }
  persist(identity.scope);
}

export function workspaceFileDraftUsage(): { files: number; bytes: number } { return { files: drafts.size, bytes: totalBytes }; }

export function hasWorkspaceFileDraft(target: Pick<WorkspaceFileDraftIdentity, 'scope' | 'deviceId' | 'cwd' | 'path'>): boolean {
  const normalize = (value: string) => /^[A-Za-z]:/.test(target.cwd) ? value.replace(/\\/g, '/').toLowerCase() : value;
  return [...drafts.values()].some(entry => entry.scope === target.scope && entry.identity.deviceId === target.deviceId
    && normalize(entry.identity.cwd) === normalize(target.cwd) && normalize(entry.identity.path) === normalize(target.path));
}

/** Reserved for an explicit user request to discard all drafts for an identity.
 * Switching computers/conversations or replacing credentials must not call it. */
export function discardWorkspaceFileDraftsForScope(scope: string): void {
  cleared.add(scope);
  for (const [id, entry] of drafts) if (entry.scope === scope) { drafts.delete(id); totalBytes -= entry.bytes; }
  persist(scope);
}

/** Test process-restart boundary; never used by normal navigation. */
export function resetWorkspaceFileDraftMemoryForTests(): void {
  drafts.clear(); totalBytes = 0; hydration.clear(); writes.clear(); writeRevisions.clear(); changed.clear(); cleared.clear(); errors.clear();
}
