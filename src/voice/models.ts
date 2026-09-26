import * as FileSystem from 'expo-file-system/legacy';
import { useSyncExternalStore } from 'react';

import { ASR_MODELS, fileUrl, localName, modelById, type AsrModelId, type DownloadMirror } from './catalog';
import { voiceNative } from './native';

export type ModelState = 'absent' | 'downloading' | 'installed' | 'error';
export interface ModelStatus { state: ModelState; received: number; total: number; error?: string }

type Statuses = Record<AsrModelId, ModelStatus>;

const initial = (): Statuses => Object.fromEntries(ASR_MODELS.map((model) => [
  model.id, { state: 'absent', received: 0, total: model.files.reduce((sum, file) => sum + file.size, 0) },
])) as Statuses;

let statuses: Statuses = initial();
const listeners = new Set<() => void>();
const active = new Map<AsrModelId, { cancelled: boolean; task: { pauseAsync?: () => Promise<unknown> } | null }>();

function set(id: AsrModelId, patch: Partial<ModelStatus>) {
  statuses = { ...statuses, [id]: { ...statuses[id], ...patch } };
  listeners.forEach((listener) => listener());
}

export function subscribeModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function modelStatuses(): Statuses { return statuses; }
export function useModelStatuses(): Statuses { return useSyncExternalStore(subscribeModels, modelStatuses, modelStatuses); }

export function modelsRoot(): string {
  return `${FileSystem.documentDirectory ?? ''}voice-models/`;
}
export function modelDirectory(id: AsrModelId): string { return `${modelsRoot()}${id}/`; }

async function sizeOf(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory && typeof info.size === 'number' ? info.size : -1;
  } catch {
    return -1;
  }
}

/** Re-checks every model on disk (sizes must match exactly). */
export async function refreshModels(): Promise<void> {
  for (const model of ASR_MODELS) {
    if (active.has(model.id)) continue;
    let received = 0;
    let complete = true;
    for (const file of model.files) {
      const size = await sizeOf(`${modelDirectory(model.id)}${localName(file)}`);
      if (size === file.size) received += size;
      else complete = false;
    }
    set(model.id, { state: complete ? 'installed' : 'absent', received: complete ? statuses[model.id].total : received, error: undefined });
  }
}

export function isInstalled(id: AsrModelId | null | undefined): boolean {
  return Boolean(id && statuses[id]?.state === 'installed');
}

/** Downloads every missing file; already complete files are kept, so a retry continues where it stopped. */
export async function installModel(id: AsrModelId, mirror: DownloadMirror): Promise<void> {
  const model = modelById(id);
  if (!model || active.has(id)) return;
  const job = { cancelled: false, task: null as { pauseAsync?: () => Promise<unknown> } | null };
  active.set(id, job);
  const directory = modelDirectory(id);
  set(id, { state: 'downloading', error: undefined });
  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => undefined);
    let done = 0;
    for (const file of model.files) {
      if (job.cancelled) throw new Error('已取消');
      const target = `${directory}${localName(file)}`;
      if (await sizeOf(target) === file.size) { done += file.size; set(id, { received: done }); continue; }
      const partial = `${target}.part`;
      await FileSystem.deleteAsync(partial, { idempotent: true });
      const base = done;
      const task = FileSystem.createDownloadResumable(fileUrl(file, mirror), partial, {}, (progress: { totalBytesWritten: number }) => {
        set(id, { received: base + Math.min(progress.totalBytesWritten, file.size) });
      });
      job.task = task;
      if (job.cancelled) throw new Error('已取消');
      const result = await task.downloadAsync();
      if (job.cancelled) throw new Error('已取消');
      if (!result || (typeof result.status === 'number' && result.status >= 400)) {
        throw new Error(result?.status ? `下载失败（HTTP ${result.status}）` : '下载失败');
      }
      if (await sizeOf(partial) !== file.size) throw new Error(`“${file.name}”下载不完整`);
      await FileSystem.deleteAsync(target, { idempotent: true });
      await FileSystem.moveAsync({ from: partial, to: target });
      done += file.size;
      set(id, { received: done });
    }
    set(id, { state: 'installed', received: statuses[id].total });
  } catch (error) {
    const message = job.cancelled ? '已取消' : error instanceof Error ? error.message : '下载失败';
    set(id, { state: job.cancelled ? 'absent' : 'error', error: job.cancelled ? undefined : `${message}。可在“下载线路”切换后重试` });
  } finally {
    active.delete(id);
  }
}

export async function cancelInstall(id: AsrModelId): Promise<void> {
  const job = active.get(id);
  if (!job) return;
  job.cancelled = true;
  try { await job.task?.pauseAsync?.(); } catch { /* already stopped */ }
}

export async function deleteModel(id: AsrModelId): Promise<void> {
  await cancelInstall(id);
  // Let the cancelled download stop writing before its folder is removed.
  for (let waited = 0; active.has(id) && waited < 3000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  try { voiceNative()?.releaseRecognizer(); } catch { /* not loaded */ }
  await FileSystem.deleteAsync(modelDirectory(id), { idempotent: true });
  set(id, { state: 'absent', received: 0, error: undefined });
}
