import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { retainCachedAttachment } from './attachment-cache-policy';
import { managedImagePreview, releaseInactiveImageMemory, type ImageVariant, type ManagedImageResource } from './image-preview-cache';
import type { ImagePixelRegion } from './image-dimensions';

let snapshot = { active: AppState.currentState !== 'background' && AppState.currentState !== 'inactive', revision: 0 };
const subscribers = new Set<() => void>();
let appSubscription: { remove(): void } | undefined, pressureSubscription: { remove(): void } | undefined;
let budget = 32 * 1024 * 1024, used = 0;
const decoded = new Map<string, { bytes: number; readers: number }>(), waiting = new Set<() => void>();
function publish(active: boolean, pressure = false) {
  snapshot = { active, revision: snapshot.revision + 1 };
  if (pressure) budget = 16 * 1024 * 1024;
  for (const listener of subscribers) listener();
}
function subscribe(listener: () => void) {
  subscribers.add(listener);
  if (!appSubscription) {
    snapshot = { ...snapshot, active: AppState.currentState !== 'background' && AppState.currentState !== 'inactive' };
    appSubscription = AppState.addEventListener('change', state => publish(state === 'active'));
    pressureSubscription = AppState.addEventListener('memoryWarning', () => publish(snapshot.active, true));
  }
  return () => { subscribers.delete(listener); if (!subscribers.size) { appSubscription?.remove(); pressureSubscription?.remove(); appSubscription = pressureSubscription = undefined; } };
}
/** Count unique managed render sources; this is a working-set target, not a
 * guarantee about native/GPU copies or process RSS. */
export function reserveDecodedImage(key: string, pixels: number, signal: AbortSignal): Promise<() => void> {
  const bytes = Math.ceil(pixels * 4);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 16 * 1024 * 1024) return Promise.reject(new Error('图片预览超过像素预算'));
  return new Promise((resolve, reject) => {
    const abort = () => { waiting.delete(enter); signal.removeEventListener('abort', abort); reject(new Error('图片预览已取消')); };
    const enter = () => {
      if (signal.aborted) { abort(); return; }
      const old = decoded.get(key);
      if (!old && used + bytes > budget) { waiting.add(enter); return; }
      waiting.delete(enter); signal.removeEventListener('abort', abort);
      if (old) old.readers++; else { decoded.set(key, { bytes, readers: 1 }); used += bytes; }
      let released = false;
      resolve(() => {
        if (released) return; released = true;
        const value = decoded.get(key);
        if (value && --value.readers === 0) { decoded.delete(key); used -= value.bytes; }
        for (const wake of [...waiting]) wake();
      });
    };
    signal.addEventListener('abort', abort, { once: true }); enter();
  });
}
export function managedImageWorkingSetBytes(): number { return used; }

export function useManagedImage(uri?: string | null, variant: ImageVariant = 'thumbnail', visible = true, region?: ImagePixelRegion, retry = 0) {
  const lifecycle = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const active = Boolean(uri && visible && lifecycle.active);
  const request = JSON.stringify([uri, variant, region, retry]);
  const [value, setValue] = useState<{ source: string; revision: number; resource?: ManagedImageResource; error?: string }>();
  useEffect(() => {
    if (!uri || !active) { setValue(undefined); return; }
    const controller = new AbortController();
    let live = true, releasePixels: (() => void) | undefined, releaseFile: (() => void) | undefined, releaseResource: (() => void) | undefined;
    setValue(undefined);
    void managedImagePreview(uri, variant, controller.signal, region).then(async resource => {
      if (!live) { resource.release?.(); return; }
      releaseResource = resource.release;
      releaseFile = retainCachedAttachment(resource.uri);
      const release = await reserveDecodedImage(resource.uri, resource.width * resource.height, controller.signal);
      if (!live) { release(); return; }
      releasePixels = release;
      setValue({ source: request, revision: lifecycle.revision, resource });
    }).catch(error => { if (live && !controller.signal.aborted) setValue({ source: request, revision: lifecycle.revision, error: error instanceof Error ? error.message : '图片预览不可用' }); });
    return () => { live = false; controller.abort(); releasePixels?.(); releaseFile?.(); releaseResource?.(); if (!snapshot.active) releaseInactiveImageMemory(); };
  }, [request, active, lifecycle.revision]);
  const current = active && value && value.source === request && value.revision === lifecycle.revision ? value : undefined;
  return { uri: current?.resource?.uri, resource: current?.resource, error: current?.error, active, foreground: lifecycle.active, loading: active && !current };
}
