import { getSetting, setSetting } from '../storage/database';

export const ARTIFACT_STATE_MAX = 64 * 1024;
const memory = new Map<string, Record<string, unknown>>(), writes = new Map<string, Promise<void>>();
export const artifactStateKey = (scope: string, artifact: string, revision: string): string => `remote.artifact.state.v1:${JSON.stringify([scope, artifact, revision])}`;
export function boundedArtifactState(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  try { const json = JSON.stringify(value); return json.length <= ARTIFACT_STATE_MAX ? JSON.parse(json) : undefined; } catch { return; }
}
export async function readArtifactState(key: string): Promise<Record<string, unknown> | undefined> {
  if (memory.has(key)) return boundedArtifactState(memory.get(key));
  const raw = await getSetting(key);
  if (memory.has(key)) return boundedArtifactState(memory.get(key));
  if (!raw || raw.length > ARTIFACT_STATE_MAX) return;
  try { return boundedArtifactState(JSON.parse(raw)); } catch { return; }
}
export function writeArtifactState(key: string, value: unknown): Promise<void> {
  const state = boundedArtifactState(value);
  if (!state) return Promise.reject(new Error('交互状态太大，未保存'));
  memory.set(key, state);
  if (memory.size > 200) memory.delete(memory.keys().next().value!);
  const snapshot = JSON.stringify(state);
  const write = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => setSetting(key, snapshot));
  writes.set(key, write);
  void write.finally(() => { if (writes.get(key) === write) writes.delete(key); }).catch(() => undefined);
  return write;
}
