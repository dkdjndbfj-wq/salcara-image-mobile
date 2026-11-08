import { getSetting, setSetting } from '../storage/database';
import * as FileSystem from 'expo-file-system/legacy';
import type { RemoteImage, RemoteImageMime } from './attachments';
import type { ApprovalMode, Effort, PermissionMode } from './client';
import { copyTurnFeatures, validTurnFeatures, type TurnFeatures } from './agent-features';
import { isEffort } from './effort';
import { isApprovalMode, isPermissionMode } from './permission-mode';
import { markRemoteImagesInUse, retireQueuedImageScope, verifyManagedQueuedImage, withQueueImageTransaction } from './queued-image-files';
import { clearComposerDraftScope } from './composer-drafts';

const SETTING = 'remote_drafts_v1';
const QUEUED_SETTING = 'remote_queued_v1';
export interface QueuedImageDraft { uri: string; mime: RemoteImageMime; width: number; height: number }
export const MAX_REMOTE_QUEUE = 10;
export interface QueuedRemoteDraft {
  id?: string; text: string; images: QueuedImageDraft[]; missingImages?: boolean;
  imageCount?: number;
  state?: 'waiting' | 'attempting' | 'blocked'; scope?: string; apiIdentity?: string;
  attempted?: boolean;
  sendOptions?: TurnFeatures & { model?: string; effort?: Effort; permissionMode?: PermissionMode; approval?: ApprovalMode; accountId?: string; surface: 'cli' | 'desktop' };
  /** Require a newer finished turn before advancing to the next submission. */
  afterTurn?: string;
}
export interface LoadedQueuedRemoteDraft extends Omit<QueuedRemoteDraft, 'images'> { images: RemoteImage[] }
type QueuedDraftInput = Omit<QueuedRemoteDraft, 'images'> & { images: Array<QueuedImageDraft | RemoteImage> };
let edits: Promise<unknown> = Promise.resolve();
// Stale render/stop callbacks exist only in this process. Publish consumption
// on the same serial queue as every save, after its durable deletion. On a
// cold start no old callback survives; the committed row is already absent.
const consumedQueueIds = new Map<string, Set<string>>();
// Preserve recognizable legacy blocked entries while a different queued
// submission is edited. Do not turn merely reading them into a migration.
const queuedOrigins = new WeakMap<object, { raw: Record<string, unknown>; fingerprint: string }>();
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const referenced = (options: unknown): boolean => record(options) && validTurnFeatures(options, 'cli') && Array.isArray(options.contextReferences) && options.contextReferences.length > 0;
async function readTable(setting: string, limit: number): Promise<Record<string, unknown>> {
  const stored = await getSetting(setting);
  if (stored === null) return {};
  if (stored.length > 10_000_000) throw new Error('本地草稿记录无效，请核对应用存储');
  let raw: unknown;
  try { raw = JSON.parse(stored); } catch { throw new Error('本地草稿记录无效，请核对应用存储'); }
  if (!record(raw) || Object.keys(raw).length > limit || Object.keys(raw).some(key => !key || key.length > 2048)) throw new Error('本地草稿记录无效，请核对应用存储');
  return Object.assign(Object.create(null), raw) as Record<string, unknown>;
}
async function read(): Promise<Record<string, string>> {
  const raw = await readTable(SETTING, 50);
  if (Object.values(raw).some(value => typeof value !== 'string' || value.length > 100_000)) throw new Error('本地草稿记录无效，请核对应用存储');
  return raw as Record<string, string>;
}
export function loadRemoteDraft(key: string): Promise<string> {
  const run = edits.then(async () => (await read())[key] ?? '');
  edits = run.catch(() => undefined); return run;
}
export function saveRemoteDraft(key: string, text: string, scope?: string): Promise<void> {
  const write = async () => {
    if (!key || key.length > 2048 || text.length > 100_000) throw new Error('本地草稿超出限制，内容仍保留在输入框');
    const drafts = await read();
    delete drafts[key];
    if (text) Object.defineProperty(drafts, key, { value: text, configurable: true, enumerable: true, writable: true });
    await setSetting(SETTING, JSON.stringify(Object.fromEntries(Object.entries(drafts).slice(-50))));
  };
  const run = edits.then(() => scope ? withQueueImageTransaction(async transaction => {
    if (!key.startsWith(`${scope}|`)) throw new Error('草稿配对身份不匹配');
    await transaction.assertActive(scope); await write();
  }) : write());
  edits = run.catch(() => undefined);
  return run;
}

async function readQueuedTable(): Promise<Record<string, unknown>> {
  const raw = await readTable(QUEUED_SETTING, 20);
  for (const value of Object.values(raw)) {
    if (!record(value) && !Array.isArray(value)) throw new Error('本地排队记录无效，请核对应用存储');
    const entries = Array.isArray(value) ? value : [value];
    if (entries.length > MAX_REMOTE_QUEUE || entries.some(row => !record(row) || typeof row.text !== 'string' || row.text.length > 100_000
      || !Array.isArray(row.images) || row.images.length > 4 || (!row.text && !row.images.length && !referenced(row.sendOptions)))) throw new Error('本地排队记录无效，请核对应用存储');
  }
  return raw;
}
function decodeQueued(raw: Record<string, unknown>): Record<string, QueuedRemoteDraft[]> {
    const out: Record<string, QueuedRemoteDraft[]> = Object.create(null);
    for (const [key, value] of Object.entries(raw)) {
      const entries = Array.isArray(value) ? value : [value]; // v1 was one merged submission.
      const drafts: QueuedRemoteDraft[] = [];
      for (const value of entries) {
        const row = value as Record<string, unknown>;
        const sourceImages = row.images as unknown[];
        const images = sourceImages.filter((item): item is QueuedImageDraft => {
          if (!item || typeof item !== 'object') return false;
          const image = item as Record<string, unknown>;
          return typeof image.uri === 'string' && /^(?:file|content):\/\//i.test(image.uri) && image.uri.length <= 4096
            && typeof image.mime === 'string' && /^(?:image\/jpeg|image\/png|image\/webp)$/i.test(image.mime) && Number.isSafeInteger(image.width) && Number(image.width) > 0 && Number(image.width) <= 20000
            && Number.isSafeInteger(image.height) && Number(image.height) > 0 && Number(image.height) <= 20000;
        }).map((image) => ({ uri: image.uri, mime: image.mime.toLowerCase() as RemoteImageMime, width: image.width, height: image.height }));
        const options = row.sendOptions && typeof row.sendOptions === 'object' ? row.sendOptions as Record<string, unknown> : undefined;
        const known = Object.keys(row).every(field => ['id', 'text', 'images', 'imageCount', 'missingImages', 'state', 'scope', 'apiIdentity', 'sendOptions', 'afterTurn', 'attempted'].includes(field))
          && (row.missingImages === undefined || typeof row.missingImages === 'boolean')
          && (row.attempted === undefined || typeof row.attempted === 'boolean')
          && (row.imageCount === undefined || Number.isSafeInteger(row.imageCount) && Number(row.imageCount) >= sourceImages.length && Number(row.imageCount) <= 4)
          && (row.afterTurn === undefined || typeof row.afterTurn === 'string' && row.afterTurn.length <= 512)
          && options && Object.keys(options).every(field => ['model', 'effort', 'collaborationMode', 'skills', 'contextReferences', 'permissionMode', 'approval', 'accountId', 'surface'].includes(field));
        const identified = known && typeof row.id === 'string' && Boolean(row.id) && row.id.length <= 128 && typeof row.scope === 'string' && Boolean(row.scope) && row.scope.length <= 4096
          && typeof row.apiIdentity === 'string' && Boolean(row.apiIdentity) && row.apiIdentity.length <= 512 && options && ['cli', 'desktop'].includes(String(options.surface))
          && validTurnFeatures(options, String(options.surface))
          && (options.model === undefined || typeof options.model === 'string' && options.model.length <= 200)
          && (options.effort === undefined || isEffort(options.effort))
          && (options.permissionMode === undefined || isPermissionMode(options.permissionMode) && options.surface === 'cli')
          && (options.approval === undefined || isApprovalMode(options.approval) && options.surface === 'cli')
          && (options.accountId === undefined || typeof options.accountId === 'string' && options.accountId.length <= 256);
        if (row.text || sourceImages.length || referenced(options)) {
        const decoded: QueuedRemoteDraft = { text: row.text as string, images, imageCount: Number.isSafeInteger(row.imageCount) && Number(row.imageCount) >= sourceImages.length && Number(row.imageCount) <= 4 ? Number(row.imageCount) : sourceImages.length,
          ...(images.length !== sourceImages.length || row.missingImages === true ? { missingImages: true } : {}),
          // Old/partly written records require explicit review, never automatic replay.
          state: identified && images.length === sourceImages.length && row.missingImages !== true && row.state === 'waiting' ? 'waiting' : 'blocked',
          ...(row.attempted !== undefined || row.state === 'attempting' ? { attempted: row.attempted === true || row.state === 'attempting' } : {}),
          ...(identified ? { id: row.id as string, scope: row.scope as string, apiIdentity: row.apiIdentity as string,
            sendOptions: { ...copyTurnFeatures(options!), surface: options!.surface as 'cli' | 'desktop',
              ...(typeof options!.model === 'string' && options!.model.length <= 200 ? { model: options!.model } : {}),
              ...(isEffort(options!.effort) ? { effort: options!.effort } : {}),
              ...(isPermissionMode(options!.permissionMode) ? { permissionMode: options!.permissionMode } : {}),
              ...(isApprovalMode(options!.approval) ? { approval: options!.approval } : {}),
              ...(typeof options!.accountId === 'string' && options!.accountId.length <= 256 ? { accountId: options!.accountId } : {}) } } : {}),
          ...(typeof row.afterTurn === 'string' && row.afterTurn.length <= 512 ? { afterTurn: row.afterTurn } : {}),
        };
        if (decoded.state === 'blocked') queuedOrigins.set(decoded, { raw: row, fingerprint: JSON.stringify(decoded) });
        drafts.push(decoded);
        }
      }
      if (drafts.length) out[key] = drafts;
    }
    return out;
}

export async function loadRemoteQueuedDraft(key: string): Promise<{ text: string; images: RemoteImage[]; missingImages?: boolean } | undefined> {
  return (await loadRemoteQueuedDrafts(key))[0];
}

export async function loadRemoteQueuedDrafts(key: string): Promise<LoadedQueuedRemoteDraft[]> {
  markRemoteImagesInUse();
  const reading = edits.then(async () => decodeQueued(await readQueuedTable())[key] ?? []);
  edits = reading.catch(() => undefined);
  const rows = await reading;
  return Promise.all(rows.map(async row => {
    const images: RemoteImage[] = [];
    let missingImages = Boolean(row.missingImages);
    for (const image of row.images) {
      try {
        const info = await FileSystem.getInfoAsync(image.uri);
        if (!info.exists || info.isDirectory !== false) { missingImages = true; continue; }
        // Restore metadata only. Loading forty base64 payloads at once can
        // consume hundreds of MB; only the next submitted row needs bytes.
        images.push({ ...image, base64: '' });
      } catch { missingImages = true; }
    }
    const loaded = { ...row, images, ...(missingImages ? { missingImages: true } : {}) };
    const original = queuedOrigins.get(row);
    if (original) queuedOrigins.set(loaded, { raw: original.raw, fingerprint: JSON.stringify(loaded) });
    return loaded;
  }));
}

/** Never turn a prior image-bearing prompt into a text-only retry. */
export async function readRemoteRetryImages(images: QueuedImageDraft[]): Promise<RemoteImage[]> {
  markRemoteImagesInUse();
  if (!images.length || images.length > 4) throw new Error('原消息的图片无法恢复，请重新选择全部原图片');
  return Promise.all(images.map(async image => {
    if (!/^(?:file|content):\/\//i.test(image.uri) || !/^(?:image\/jpeg|image\/png|image\/webp)$/.test(image.mime)
      || !Number.isSafeInteger(image.width) || image.width <= 0 || image.width > 20_000 || !Number.isSafeInteger(image.height) || image.height <= 0 || image.height > 20_000) {
      throw new Error('原消息的图片无法恢复，请重新选择全部原图片');
    }
    const info = await FileSystem.getInfoAsync(image.uri);
    if (!info.exists || info.isDirectory !== false) throw new Error('原图片已不存在，请重新选择全部原图片');
    const base64 = await FileSystem.readAsStringAsync(image.uri, { encoding: FileSystem.EncodingType.Base64 });
    if (!base64 || base64.length > 11_200_000 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('原图片无法读取，请重新选择全部原图片');
    if (base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0) > 8 * 1024 * 1024) throw new Error('原图片太大，请重新选择全部原图片');
    await verifyManagedQueuedImage(image.uri, image.mime, base64);
    return { ...image, base64 };
  }));
}

export function saveRemoteQueuedDraft(key: string, draft: QueuedRemoteDraft | null): Promise<void> {
  return saveRemoteQueuedDrafts(key, draft ? [draft] : []).then(() => undefined);
}

const canonicalQueueValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalQueueValue)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonicalQueueValue(value[key])])) : value;
export function remoteQueueRevision(row: QueuedRemoteDraft): string {
  return JSON.stringify(canonicalQueueValue({ ...row, images: row.images.map(({ uri, mime, width, height }) => ({ uri, mime, width, height })), imageCount: row.imageCount ?? row.images.length }));
}
export function remoteQueueEditable(row: QueuedRemoteDraft): boolean {
  return Boolean(row.id && row.scope && row.apiIdentity && row.sendOptions && row.attempted !== true
    && (row.state === 'waiting' || row.state === 'blocked' && row.attempted === false));
}
export type RemoteQueueMutation = { type: 'pause' } | {
  type: 'edit' | 'remove' | 'move' | 'resume'; id: string; expected: string;
  text?: string; offset?: -1 | 1; order?: string[];
};
/** Atomic targeted edits never rewrite a consumed or remotely attempted row. */
export function mutateRemoteQueue(key: string, scope: string, apiIdentity: string, mutation: RemoteQueueMutation, isCurrent: () => boolean): Promise<LoadedQueuedRemoteDraft[]> {
  const run = edits.then(() => withQueueImageTransaction(async transaction => {
    const guard = () => { if (!isCurrent() || !key.startsWith(`${scope}|`)) throw new Error('电脑、会话或 API 已变化，原排队消息已保留'); };
    guard(); await transaction.assertActive(scope); guard();
    const table = await readQueuedTable(), stored = table[key]; guard();
    const rows = (Array.isArray(stored) ? stored : stored ? [stored] : []) as QueuedRemoteDraft[];
    const owned = (row: QueuedRemoteDraft) => row.scope === scope && row.apiIdentity === apiIdentity;
    const pause = () => { for (const row of rows) if (owned(row) && row.state === 'waiting') { row.attempted ??= false; row.state = 'blocked'; } };
    if (mutation.type === 'pause') pause();
    else {
      const index = rows.findIndex(row => row.id === mutation.id), row = rows[index];
      if (!row || !owned(row) || remoteQueueRevision(row) !== mutation.expected) throw new Error('排队消息已改变，请重新查看');
      if (!remoteQueueEditable(row)) throw new Error('这条消息已尝试送达或来源未确认，不能修改');
      if (mutation.type === 'edit') {
        if (typeof mutation.text !== 'string' || mutation.text.length > 100_000 || !mutation.text.trim() && !row.images.length && !referenced(row.sendOptions)) throw new Error('请输入消息内容');
        row.text = mutation.text; pause(); row.state = 'blocked'; row.attempted = false;
      } else if (mutation.type === 'remove') rows.splice(index, 1);
      else if (mutation.type === 'move') {
        if (!mutation.offset || mutation.order?.join('\0') !== rows.map(value => value.id ?? '').join('\0')) throw new Error('排队顺序已改变，请重新查看');
        const other = rows[index + mutation.offset];
        if (!other || !owned(other) || !remoteQueueEditable(other)) throw new Error('只能调整尚未尝试发送的消息');
        [rows[index], rows[index + mutation.offset]] = [other, row]; pause();
      } else {
        if (index !== 0 || row.missingImages) throw new Error('请先核对队首消息及原图片');
        row.state = 'waiting'; row.attempted = false; delete row.afterTurn;
      }
    }
    if (rows.length) table[key] = rows; else delete table[key];
    guard(); await setSetting(QUEUED_SETTING, JSON.stringify(table));
  }));
  edits = run.catch(() => undefined);
  return run.then(() => loadRemoteQueuedDrafts(key));
}

export function saveRemoteQueuedDrafts(key: string, drafts: QueuedDraftInput[]): Promise<LoadedQueuedRemoteDraft[]> {
  let retained = drafts.map(draft => {
    const origin = queuedOrigins.get(draft);
    return origin && draft.state === 'blocked' && origin.fingerprint === JSON.stringify(draft) ? origin.raw : undefined;
  });
  drafts = drafts.map(draft => ({ ...draft, images: draft.images.map(image => ({ ...image })), ...(draft.sendOptions ? { sendOptions: { ...draft.sendOptions, ...copyTurnFeatures(draft.sendOptions) } } : {}) }));
  const run = edits.then(() => withQueueImageTransaction(async transaction => {
    if (key.length > 2048 || drafts.length > MAX_REMOTE_QUEUE || drafts.some(draft => draft.text.length > 100_000 || draft.images.length > 4
      || draft.images.some(image => !/^(?:file|content):\/\//i.test(image.uri) || image.uri.length > 4096 || !/^(?:image\/jpeg|image\/png|image\/webp)$/.test(image.mime)
        || !Number.isSafeInteger(image.width) || image.width <= 0 || image.width > 20_000 || !Number.isSafeInteger(image.height) || image.height <= 0 || image.height > 20_000
        || ('base64' in image && image.base64.length > 11_200_000)))) {
      throw new Error('排队消息超出限制，内容仍保留在输入框');
    }
    const rows = await readQueuedTable();
    const consumed = consumedQueueIds.get(key);
    if (consumed?.size && drafts.some(draft => draft.id && consumed.has(draft.id))) {
      const stored = rows[key], current = (Array.isArray(stored) ? stored : stored ? [stored] : []) as QueuedRemoteDraft[];
      const keep = drafts.map((draft, index) => ({ draft, origin: retained[index] })).filter(({ draft }) => !draft.id || !consumed.has(draft.id));
      // A snapshot containing a consumed row predates that commit. It cannot
      // delete a later row that was never present in the old render either.
      for (const row of current) if (!keep.some(({ draft }) => row.id ? draft.id === row.id : JSON.stringify(draft) === JSON.stringify(row))) {
        keep.push({ draft: row, origin: row as unknown as Record<string, unknown> });
      }
      drafts = keep.map(({ draft }) => {
        const latest = current.find(row => row.id === draft.id && row.scope === draft.scope);
        return latest?.afterTurn !== undefined ? { ...draft, afterTurn: latest.afterTurn } : draft;
      });
      retained = keep.map(({ origin }, index) => origin ? { ...origin, ...(drafts[index].afterTurn !== undefined ? { afterTurn: drafts[index].afterTurn } : {}) } : undefined);
    }
    if (drafts.length > MAX_REMOTE_QUEUE) throw new Error('排队消息已改变，请重新读取已有消息');
    if (drafts.length && !rows[key] && Object.keys(rows).length >= 20) throw new Error('排队会话过多，请先处理已有消息');
    delete rows[key];
    if (drafts.length) {
      const staged: QueuedRemoteDraft[] = [];
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index];
        if (draft.scope) await transaction.assertActive(draft.scope);
        if (retained[index]) { staged.push(retained[index] as unknown as QueuedRemoteDraft); continue; }
        if (draft.images.length && !draft.scope) throw new Error('排队图片缺少配对身份，请核对后重新排队');
        const images: QueuedImageDraft[] = [];
        for (const image of draft.images) images.push(await transaction.stage(draft.scope!, image));
        staged.push({ ...draft, images });
      }
      Object.defineProperty(rows, key, { value: staged, configurable: true, enumerable: true, writable: true });
    }
    const encoded = JSON.stringify(rows);
    if (encoded.length > 10_000_000) throw new Error('排队消息超出限制，内容仍保留在输入框');
    await setSetting(QUEUED_SETTING, encoded);
    // Keep runtime snapshots alive while receipts/renderers may still hold
    // them; cold startup reclaims files with no remaining durable reference.
    const normalized = decodeQueued(rows)[key] ?? [];
    return ((rows[key] ?? []) as QueuedRemoteDraft[]).map((staged, index) => {
      const row = retained[index] ? normalized[index] : staged;
      const loaded = { ...row, images: row.images.map(image => ({ ...image, base64: '' })) };
      const original = retained[index] ? queuedOrigins.get(row) : undefined;
      if (original) queuedOrigins.set(loaded, { raw: original.raw, fingerprint: JSON.stringify(loaded) });
      return loaded;
    });
  }));
  edits = run.catch(() => undefined);
  return run;
}

/** Remove only the accepted submission. Later rows/edits remain owned by the
 * queue, and the next row still waits for a newer completed turn. */
export function consumeAcceptedQueuedDraft(key: string, scope: string, id: string, afterTurn: string): Promise<void> {
  const run = edits.then(() => withQueueImageTransaction(async transaction => {
    if (!key.startsWith(`${scope}|`) || key.length > 2048 || !id || id.length > 128 || afterTurn.length > 512) throw new Error('排队消息归属无效');
    await transaction.assertActive(scope);
    const rows = await readQueuedTable(), stored = rows[key];
    const remember = () => { const consumed = consumedQueueIds.get(key) ?? new Set<string>(); consumed.add(id); consumedQueueIds.set(key, consumed); };
    if (!stored) { remember(); return; }
    const entries = (Array.isArray(stored) ? stored : [stored]) as Record<string, unknown>[];
    const index = entries.findIndex(row => row.id === id && row.scope === scope);
    if (index < 0) { remember(); return; }
    entries.splice(index, 1);
    if (index === 0 && entries.length) entries[0] = { ...entries[0], afterTurn };
    if (entries.length) rows[key] = entries; else delete rows[key];
    await setSetting(QUEUED_SETTING, JSON.stringify(rows));
    remember();
  }));
  edits = run.catch(() => undefined); return run;
}

/** Called for the exact retired credential scope, not a URL or guessed folder. */
export function clearRemoteQueuedScope(scope: string): Promise<void> {
  const run = edits.then(async () => {
    await retireQueuedImageScope(scope);
    const rows = await readQueuedTable();
    // Legacy cleanup still passes a bare connection ID. That ID is not
    // authority over its credential:<digest> child namespaces, especially a
    // new pairing created while old cleanup is draining.
    const privateKeyInScope = (key: string) => key.startsWith(`${scope}|`) && !key.slice(scope.length + 1).startsWith('credential:');
    const retained = Object.fromEntries(Object.entries(rows).filter(([key]) => !privateKeyInScope(key)).map(([key, value]) => [key, (Array.isArray(value) ? value : [value]).filter(entry => (entry as Record<string, unknown>).scope !== scope)])
      .filter(([, entries]) => (entries as QueuedRemoteDraft[]).length));
    await setSetting(QUEUED_SETTING, JSON.stringify(retained));
    const drafts = await read();
    await setSetting(SETTING, JSON.stringify(Object.fromEntries(Object.entries(drafts).filter(([key]) => !privateKeyInScope(key)))));
    await clearComposerDraftScope(scope);
  });
  edits = run.catch(() => undefined);
  return run;
}
