import * as FileSystem from 'expo-file-system/legacy';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { getSetting, setSetting, remoteImageReferenceRecords } from '../storage/database';
import type { RemoteImage, RemoteImageMime } from './attachments';

const SETTING = 'remote_image_files_v2';
const ROOT_NAME = 'remote-images-v2/';
const MAX_FILES = 2048;
const MAX_RETIRED = 8192;
const MAX_KIND_SCOPE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
type Kind = 'queue' | 'submission';
type ImageSource = { uri: string; mime: RemoteImageMime; width: number; height: number; base64?: string };
type OwnedFile = { scope: string; digest: string; kind: Kind; mime: RemoteImageMime; size: number; uri: string };
type Manifest = { version: 2; files: OwnedFile[]; retired: string[] };
let writes: Promise<unknown> = Promise.resolve();
// Collection runs only at cold startup, before any remote image consumer or
// publisher. During use, in-memory previews and debounced history writers may
// outlive their durable rows; those references must survive until next boot.
let imagesInUse = false;
let maintenance: Promise<ImageCollectionResult> | undefined;
export function markRemoteImagesInUse(): void { imagesInUse = true; }
export type ImageCollectionResult = { removedFiles: number; freedBytes: number; deferred: boolean };

const privateRoot = () => {
  const root = FileSystem.documentDirectory;
  if (!root || !/^file:\/\//i.test(root) || !root.endsWith('/')) throw new Error('本地图片存储不可用');
  return `${root}${ROOT_NAME}`;
};
const extension = (mime: RemoteImageMime) => mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
const producedURI = (file: Pick<OwnedFile, 'scope' | 'digest' | 'kind' | 'mime'>) => `${privateRoot()}${file.scope}/${file.kind}-${file.digest}.${extension(file.mime)}`;
const hash = async (value: string) => {
  const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
  if (!HEX.test(digest)) throw new Error('本地图片标识生成失败');
  return digest;
};
function validFile(value: unknown): value is OwnedFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as OwnedFile;
  return typeof file.scope === 'string' && HEX.test(file.scope) && typeof file.digest === 'string' && HEX.test(file.digest)
    && (file.kind === 'queue' || file.kind === 'submission') && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mime)
    && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 8 * 1024 * 1024 && file.uri === producedURI(file);
}
async function readManifest(): Promise<Manifest> {
  const raw = await getSetting(SETTING);
  if (raw === null) return { version: 2, files: [], retired: [] };
  if (raw.length > 10_000_000) throw new Error('本地图片清单无效，请核对应用存储');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('本地图片清单无效，请核对应用存储'); }
  const manifest = parsed as Manifest;
  if (!manifest || manifest.version !== 2 || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES
    || !manifest.files.every(validFile) || new Set(manifest.files.map(file => file.uri)).size !== manifest.files.length
    || !Array.isArray(manifest.retired) || manifest.retired.length > MAX_RETIRED || !manifest.retired.every(scope => typeof scope === 'string' && HEX.test(scope))) {
    throw new Error('本地图片清单无效，请核对应用存储');
  }
  return manifest;
}
const writeManifest = (manifest: Manifest) => setSetting(SETTING, JSON.stringify(manifest));
const serial = <T,>(run: () => Promise<T>): Promise<T> => {
  const next = writes.then(run, run);
  writes = next.catch(() => undefined);
  return next;
};

/** Recognize only this implementation's private queue namespace, not legacy
 * flat files or arbitrary documentDirectory paths. This is not deletion auth. */
export function isManagedQueuedImageUri(uri: string): boolean {
  try { return new RegExp(`^[a-f0-9]{64}/queue-[a-f0-9]{64}\\.(?:jpg|png|webp)$`).test(uri.slice(privateRoot().length)) && uri.startsWith(privateRoot()); }
  catch { return false; }
}

async function snapshot(manifest: Manifest, scope: string, kind: Kind, image: ImageSource): Promise<ImageSource> {
  if (!scope || scope.length > 4096 || !Number.isSafeInteger(image.width) || image.width <= 0 || image.width > 20_000
    || !Number.isSafeInteger(image.height) || image.height <= 0 || image.height > 20_000 || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mime)) throw new Error('排队图片信息无效');
  const scopeId = await hash(scope);
  if (manifest.retired.includes(scopeId)) throw new Error('原配对已解除，图片未发送');
  if (!image.base64 && isManagedQueuedImageUri(image.uri)) {
    const existing = manifest.files.find(file => file.uri === image.uri && file.scope === scopeId && file.kind === 'queue' && file.mime === image.mime);
    if (!existing) throw new Error('排队图片来源已改变，请重新选择图片');
    const info = await FileSystem.getInfoAsync(existing.uri);
    if (!info.exists || info.isDirectory !== false) throw new Error('原图片无法恢复，请重新选择图片');
    // Re-saving metadata must not hydrate every earlier queue entry. Its
    // exact immutable payload is checked when this row reaches the head.
    return { uri: existing.uri, mime: image.mime, width: image.width, height: image.height };
  }
  let base64 = image.base64;
  if (!base64) {
    if (!/^(?:file|content):\/\//i.test(image.uri)) throw new Error('原图片无法恢复，请重新选择图片');
    base64 = await FileSystem.readAsStringAsync(image.uri, { encoding: FileSystem.EncodingType.Base64 });
  }
  if (!base64 || base64.length > 11_200_000 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('排队图片数据无效');
  const size = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (size <= 0 || size > 8 * 1024 * 1024) throw new Error('图片太大（最大 8 MB）');
  const digest = await hash(base64);
  const file: OwnedFile = { scope: scopeId, kind, digest, mime: image.mime, size, uri: '' };
  file.uri = producedURI(file);
  let owned = manifest.files.find(item => item.uri === file.uri);
  if (!owned) {
    if (manifest.files.length >= MAX_FILES || manifest.files.reduce((sum, item) => sum + item.size, 0) + size > MAX_TOTAL_BYTES
      || manifest.files.filter(item => item.scope === scopeId && item.kind === kind).reduce((sum, item) => sum + item.size, 0) + size > MAX_KIND_SCOPE_BYTES) {
      throw new Error('本地远程图片存储已满，请重启应用回收已不用的图片');
    }
    // Durable produced-file intent precedes any bytes. A failed queue commit
    // is recoverable without discovering or guessing files in a directory.
    manifest.files.push(file); owned = file;
    await writeManifest(manifest);
  }
  const info = await FileSystem.getInfoAsync(owned.uri);
  if (info.exists && info.isDirectory) throw new Error('本地图片路径异常');
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(`${privateRoot()}${scopeId}/`, { intermediates: true });
    try { await FileSystem.writeAsStringAsync(owned.uri, base64, { encoding: FileSystem.EncodingType.Base64 }); }
    catch { throw new Error('排队图片保存失败，内容仍保留在输入框'); }
  } else {
    // A partially written intent must never be accepted as immutable content.
    const existing = await FileSystem.readAsStringAsync(owned.uri, { encoding: FileSystem.EncodingType.Base64 });
    if (existing !== base64) {
      // Repair only our exact produced intent with its digest-matching
      // payload; never accept old partial bytes or mutate another identity.
      try { await FileSystem.writeAsStringAsync(owned.uri, base64, { encoding: FileSystem.EncodingType.Base64 }); }
      catch { throw new Error('排队图片保存失败，内容仍保留在输入框'); }
    }
  }
  return { uri: owned.uri, mime: image.mime, width: image.width, height: image.height };
}

/** Every candidate is an exact validated produced file. Never enumerate or
 * recursively delete a directory, and never delete a manifest path directory. */
async function removeOwned(manifest: Manifest, files: OwnedFile[], canRemove: () => boolean = () => true): Promise<{ removedFiles: number; freedBytes: number }> {
  let removedFiles = 0, freedBytes = 0;
  for (const file of files) {
    if (!canRemove()) break;
    if (!validFile(file)) continue;
    try {
      const info = await FileSystem.getInfoAsync(file.uri);
      if (!canRemove()) break;
      if (info.exists) {
        if (info.isDirectory !== false) continue;
        await FileSystem.deleteAsync(file.uri, { idempotent: true });
      }
      // Publish the smaller manifest only after its write commits. If a
      // filesystem/DB operation fails, keep ownership for the next retry.
      const next = { ...manifest, files: manifest.files.filter(item => item.uri !== file.uri) };
      await writeManifest(next);
      manifest.files = next.files;
      removedFiles += 1; freedBytes += file.size;
    } catch { /* retain the exact ownership record for a later safe retry */ }
  }
  return { removedFiles, freedBytes };
}

function referencedImages(records: Array<{ key: string; value: string }>): Set<string> {
  const uris = new Set<string>();
  let nodes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 1_000_000 || depth > 64) throw new Error('远程图片引用记录无效');
    if (typeof value === 'string') { if (value.startsWith(privateRoot())) uris.add(value); return; }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); }
    else if (value && typeof value === 'object') { for (const item of Object.values(value)) visit(item, depth + 1); }
  };
  for (const { key, value } of records) {
    const parsed: unknown = JSON.parse(value);
    if (key === 'remote_pending_delivery_v1') {
      if (!Array.isArray(parsed)) throw new Error('远程送达记录无效');
    } else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('远程图片引用记录无效');
    if (key.startsWith('remote.cache.t.') && !Array.isArray((parsed as { items?: unknown }).items)) throw new Error('远程会话缓存无效');
    visit(parsed, 0);
  }
  return uris;
}

/** Reclaims only unreferenced, manifest-proven files before restoring any
 * remote UI state. All pairings' drafts, queued sends, delivery receipts and
 * history rows protect their files. Never retire an active pairing, walk a
 * directory, delete by age, or sweep while callbacks may still hold a URI. */
export function collectRemoteImagesAtStartup(): Promise<ImageCollectionResult> {
  if (maintenance) return maintenance;
  maintenance = serial(async () => {
    const deferred = { removedFiles: 0, freedBytes: 0, deferred: true };
    if (imagesInUse) return deferred;
    try {
      const manifest = await readManifest();
      if (!manifest.files.length) return { ...deferred, deferred: false };
      const referenced = referencedImages(await remoteImageReferenceRecords());
      if (imagesInUse) return deferred;
      const removed = await removeOwned(manifest, manifest.files.filter(file => !referenced.has(file.uri)), () => !imagesInUse);
      return { ...removed, deferred: imagesInUse };
    } catch { return deferred; } // Optional maintenance must never overwrite uncertain storage.
  });
  return maintenance;
}

/** Test-only cold process boundary; callers must first drain their publishers. */
export async function resetQueuedImageLifecycleForTests(): Promise<void> {
  await writes;
  imagesInUse = false; maintenance = undefined;
}

export interface QueueImageTransaction {
  stage: (scope: string, image: ImageSource) => Promise<ImageSource>;
  assertActive: (scope: string) => Promise<void>;
  /** Metadata restoration must not accept another pairing's private URI. */
  assertOwned: (scope: string, image: ImageSource) => Promise<void>;
}

/** Managed bytes must match the immutable produced manifest before sending.
 * A file replaced outside the app cannot silently change a queued prompt. */
export function verifyManagedQueuedImage(uri: string, mime: RemoteImageMime, base64: string, scope?: string): Promise<void> {
  markRemoteImagesInUse();
  if (!isManagedQueuedImageUri(uri)) {
    if (scope) return Promise.reject(new Error('草稿图片来源已改变，请重新选择全部原图片'));
    return Promise.resolve();
  }
  return serial(async () => {
    const manifest = await readManifest();
    const file = manifest.files.find(item => item.uri === uri && item.mime === mime && item.kind === 'queue');
    if (!file || (scope && file.scope !== await hash(scope)) || manifest.retired.includes(file.scope) || await hash(base64) !== file.digest) throw new Error('排队图片内容已改变，请重新选择全部原图片');
  });
}
export function withQueueImageTransaction<T>(run: (transaction: QueueImageTransaction) => Promise<T>): Promise<T> {
  markRemoteImagesInUse();
  return serial(async () => {
    const manifest = await readManifest();
    // Runtime consumers can retain prior snapshots; orphan collection waits
    // until cold startup, when durable reference owners are authoritative.
    return run({ stage: (scope, image) => snapshot(manifest, scope, 'queue', image), assertOwned: async (scope, image) => {
      const scopeId = await hash(scope);
      if (manifest.retired.includes(scopeId)) throw new Error('原配对已解除，图片未发送');
      if (!isManagedQueuedImageUri(image.uri) || !manifest.files.some(file => file.uri === image.uri && file.scope === scopeId && file.kind === 'queue' && file.mime === image.mime)) {
        throw new Error('草稿图片来源已改变，请重新选择全部原图片');
      }
    }, assertActive: async scope => {
      if (manifest.retired.includes(await hash(scope))) throw new Error('原配对已解除，消息未发送');
    } });
  });
}

/** Both new-task and continuation sends call this before publishing receipt
 * refs, separating durable submissions from their composer/queue snapshots. */
export function handoffQueuedImages(scope: string, images: RemoteImage[]): Promise<RemoteImage[]> {
  markRemoteImagesInUse();
  return serial(async () => {
    const manifest = await readManifest();
    const scopeId = await hash(scope);
    if (manifest.retired.includes(scopeId)) throw new Error('原配对已解除，图片未发送');
    const out: RemoteImage[] = [];
    for (const image of images) {
      if (!isManagedQueuedImageUri(image.uri)) { out.push(image); continue; }
      const produced = manifest.files.find(file => file.uri === image.uri && file.kind === 'queue' && file.scope === scopeId);
      if (!produced || produced.mime !== image.mime) throw new Error('排队图片来源已改变，请重新选择图片');
      if (await hash(image.base64) !== produced.digest) throw new Error('排队图片内容已改变，请重新选择图片');
      const transferred = await snapshot(manifest, scope, 'submission', image);
      out.push({ ...image, ...transferred });
    }
    return out;
  });
}

/** Explicitly revoking this pairing is authority to remove its private
 * managed media, including independently retained submissions. Persist the
 * fence first so a delayed writer cannot revive the retired scope. */
export function retireQueuedImageScope(scope: string): Promise<void> {
  markRemoteImagesInUse();
  return serial(async () => {
    const manifest = await readManifest();
    const scopeId = await hash(scope);
    if (!manifest.retired.includes(scopeId)) {
      if (manifest.retired.length >= MAX_RETIRED) throw new Error('本地配对清理记录已满，请核对应用存储');
      manifest.retired.push(scopeId); await writeManifest(manifest);
    }
    await removeOwned(manifest, manifest.files.filter(file => file.scope === scopeId));
  });
}
