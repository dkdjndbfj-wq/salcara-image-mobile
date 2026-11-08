import { getSetting, setSetting } from '../storage/database';

const cache = new Map<string, string | null>(), writes = new Map<string, Promise<void>>();
export const artifactDraftKey = (scope: string, id: string, path: string, revision: string) => `remote.artifact.draft.v1:${JSON.stringify([scope, id, path, revision])}`;
export async function readArtifactDraft(key: string): Promise<string | null> {
  if (cache.has(key)) return cache.get(key) ?? null;
  const stored = await getSetting(key);
  if (cache.has(key)) return cache.get(key) ?? null;
  return stored;
}
export function writeArtifactDraft(key: string, content: string | null): Promise<void> {
  cache.set(key, content);
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
  const write = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => setSetting(key, content));
  writes.set(key, write);
  void write.finally(() => { if (writes.get(key) === write) writes.delete(key); }).catch(() => undefined);
  return write;
}
