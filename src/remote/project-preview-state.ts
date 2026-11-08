import { getSetting, setSetting } from '../storage/database';
import { conversationArtifactRevision } from './conversation-artifact-target';
import { projectPreviewPath, type ProjectPreviewRun, type ProjectPreviewStart } from './workspace-project-preview';

const key = (scope: string) => `remote.project-preview.pending.v1:${conversationArtifactRevision(scope)}`;
const writes = new Map<string, Promise<unknown>>();
function parse(raw: string, scope: string): ProjectPreviewStart {
  let value: { scope: string; input: ProjectPreviewStart };
  try { value = JSON.parse(raw); } catch { throw new Error('项目启动恢复记录无法读取，原记录已保留'); }
  const input = value?.input;
  if (value?.scope !== scope || !input || !projectPreviewPath(input.projectPath) || typeof input.operationId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId) || typeof input.manifestRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.manifestRevision)
    || typeof input.script !== 'string' || !input.script || input.script.length > 128 || /[\u0000-\u001f]/.test(input.script)) throw new Error('项目启动恢复记录无效，原记录已保留');
  return input;
}
export async function loadProjectPreviewStart(scope: string): Promise<ProjectPreviewStart | undefined> {
  await writes.get(scope)?.catch(() => undefined);
  const raw = await getSetting(key(scope)); return raw ? parse(raw, scope) : undefined;
}
function write(scope: string, task: () => Promise<void>): Promise<void> {
  const promise = (writes.get(scope) ?? Promise.resolve()).catch(() => undefined).then(task);
  writes.set(scope, promise);
  void promise.finally(() => { if (writes.get(scope) === promise) writes.delete(scope); }).catch(() => undefined);
  return promise;
}
/** Persist before dispatch. An unconfirmed start must never acquire a new ID. */
export function saveProjectPreviewStart(scope: string, input: ProjectPreviewStart): Promise<void> {
  const raw = JSON.stringify({ scope, input }); parse(raw, scope);
  return write(scope, async () => {
    const existing = await getSetting(key(scope));
    if (existing && parse(existing, scope).operationId !== input.operationId) throw new Error('上次项目启动尚未确认，请先查询运行状态');
    await setSetting(key(scope), raw);
  });
}
export function clearProjectPreviewStart(scope: string, operationId: string): Promise<void> {
  return write(scope, async () => {
    const raw = await getSetting(key(scope));
    if (raw && parse(raw, scope).operationId === operationId) await setSetting(key(scope), null);
  });
}
export const projectPreviewSource = (path: string): boolean => /(?:^|\/)package\.json$|\.(?:[cm]?[jt]sx?|vue|svelte|html)$/i.test(path) && projectPreviewPath(path);
export function appendProjectPreviewLogs(previous: ProjectPreviewRun | undefined, incoming: ProjectPreviewRun, incremental: boolean): ProjectPreviewRun {
  if (!incremental || previous?.runId !== incoming.runId) return incoming;
  if (incoming.cursor < previous.cursor) throw new Error('项目日志进度已变化，请重新查询');
  if (incoming.cursor === previous.cursor) return { ...incoming, logs: previous.logs };
  return { ...incoming, logs: `${previous.logs}${incoming.truncated ? '\n[较早日志已截断]\n' : ''}${incoming.logs}`.slice(-131072) };
}
