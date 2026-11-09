import * as FileSystem from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import { getSetting, setSetting } from '../storage/database';
import type { RemoteImage, RemoteImageMime } from './attachments';
import { copyComposerFeatureIntent, isComposerFeatureIntent, type ComposerFeatureIntent } from './composer-feature-intent';
import { markRemoteImagesInUse, verifyManagedQueuedImage, withQueueImageTransaction } from './queued-image-files';
import { composerOriginMatchesKey, confirmedMissingSession, sameComposerDraftOrigin, validComposerDraftOrigin, type ComposerDraftOrigin, type MissingSessionEvidence } from './composer-draft-origin';
export type { ComposerDraftOrigin, MissingSessionEvidence } from './composer-draft-origin';

const SETTING = 'remote_composer_drafts_v1';
const LIMIT = 50;
// An edit backup stores its complete text and context inside a JSON envelope.
// Escaping can use six characters per input character; this private namespace
// needs an envelope budget distinct from the ordinary 100k composer limit.
const draftTextLimit = (key: string, scope: string) => /^[^|]+\|sent-edit:[a-f0-9]{64}$/.test(key.slice(scope.length + 1)) ? 800_000 : 100_000;
type ImageRef = Omit<RemoteImage, 'base64'>;
type StoredDraft = { scope: string; revision: number; identity?: string; text: string; images: ImageRef[]; imageCount: number; missingImages?: boolean; consumedFrom?: number; featureIntent?: ComposerFeatureIntent; origin?: ComposerDraftOrigin; lastRestoredEdit?: string };
export type ComposerDraft = Omit<StoredDraft, 'images'> & { images: RemoteImage[] };
export type ComposerDraftInput = Pick<ComposerDraft, 'text' | 'images'> & Partial<Pick<ComposerDraft, 'imageCount' | 'missingImages' | 'featureIntent' | 'origin' | 'lastRestoredEdit'>>;
export interface ComposerDraftSession {
  restore: () => Promise<ComposerDraft | undefined>;
  save: (draft: ComposerDraftInput) => Promise<ComposerDraft>;
  consume: (revision: number, identity?: string) => Promise<boolean>;
  pruneEmpty: () => Promise<void>;
  dispose: () => void;
}
// A second mounted composer for the same exact private key fences callbacks
// from the first. This is separate from persisted optimistic revisions.
const owners = new Map<string, symbol>();
const validImage = (value: unknown): value is ImageRef => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const image = value as ImageRef;
  return Object.keys(image).every(key => ['uri', 'mime', 'width', 'height'].includes(key))
    && typeof image.uri === 'string' && image.uri.length <= 4096 && /^file:\/\//i.test(image.uri)
    && ['image/jpeg', 'image/png', 'image/webp'].includes(image.mime)
    && Number.isSafeInteger(image.width) && image.width > 0 && image.width <= 20_000
    && Number.isSafeInteger(image.height) && image.height > 0 && image.height <= 20_000;
};
const matchesScope = (key: string, scope: string) => key.startsWith(`${scope}|`) && !key.slice(scope.length + 1).startsWith('credential:');
async function readTable(): Promise<Record<string, StoredDraft>> {
  const raw = await getSetting(SETTING);
  if (raw === null) return {};
  if (raw.length > 2_000_000) throw new Error('本地草稿记录无效，请核对应用存储');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('本地草稿记录无效，请核对应用存储'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > LIMIT) throw new Error('本地草稿记录无效，请核对应用存储');
  for (const [key, value] of Object.entries(parsed)) {
    const row = value as StoredDraft;
    if (!key || key.length > 2048 || !row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(field => !['scope', 'revision', 'identity', 'text', 'images', 'imageCount', 'missingImages', 'consumedFrom', 'featureIntent', 'origin', 'lastRestoredEdit'].includes(field))
      || row.lastRestoredEdit !== undefined && (typeof row.lastRestoredEdit !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.lastRestoredEdit))
      || typeof row.scope !== 'string' || !row.scope || row.scope.length > 4096 || !matchesScope(key, row.scope)
      || !Number.isSafeInteger(row.revision) || row.revision <= 0 || row.revision >= Number.MAX_SAFE_INTEGER
      || row.identity !== undefined && (typeof row.identity !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.identity))
      || typeof row.text !== 'string' || row.text.length > draftTextLimit(key, row.scope) || !Array.isArray(row.images) || row.images.length > 4 || !row.images.every(validImage)
      || !Number.isSafeInteger(row.imageCount) || row.imageCount < row.images.length || row.imageCount > 4
      || (row.missingImages !== undefined && typeof row.missingImages !== 'boolean')
      || (row.origin !== undefined && !composerOriginMatchesKey(row.origin, key, row.scope))
      || (row.featureIntent !== undefined && (!isComposerFeatureIntent(row.featureIntent, row.text)
        || row.featureIntent.source.scope !== row.scope || !key.startsWith(`${row.scope}|${row.featureIntent.source.deviceId}|`)))
      || (row.consumedFrom !== undefined && (!Number.isSafeInteger(row.consumedFrom) || row.consumedFrom <= 0 || row.consumedFrom >= row.revision || row.text || row.imageCount || row.featureIntent))) throw new Error('本地草稿记录无效，请核对应用存储');
  }
  return Object.assign(Object.create(null), parsed) as Record<string, StoredDraft>;
}
const metadata = (row: StoredDraft): ComposerDraft => ({ ...row, images: row.images.map(image => ({ ...image, base64: '' })), ...(row.origin ? { origin: { ...row.origin } } : {}),
  ...(row.featureIntent ? { featureIntent: copyComposerFeatureIntent(row.featureIntent, row.text) } : {}) });
const fingerprint = (draft: { text: string; images: ImageRef[]; imageCount?: number; missingImages?: boolean; featureIntent?: ComposerFeatureIntent }) => JSON.stringify({ text: draft.text.trim(), imageCount: draft.imageCount ?? draft.images.length,
  missingImages: Boolean(draft.missingImages), images: draft.images.map(({ uri, mime, width, height }) => ({ uri, mime, width, height })),
  featureIntent: copyComposerFeatureIntent(draft.featureIntent, draft.text) ?? null });
const writeTable = (rows: Record<string, StoredDraft>) => {
  const encoded = JSON.stringify(rows);
  if (encoded.length > 2_000_000) throw new Error('本地草稿超出限制，内容仍保留在输入框');
  return setSetting(SETTING, encoded);
};

/** Acceptance may outlive its mounted composer. Consume only the frozen
 * revision; a newer edit owns its row. Keep a tombstone so a stale mounted
 * writer or legacy text fallback cannot resurrect the accepted input. */
export function consumeAcceptedComposerDraft(key: string, scope: string, expected: number, identity: string): Promise<void> {
  return withQueueImageTransaction(async transaction => {
    if (!key || key.length > 2048 || !matchesScope(key, scope) || !Number.isSafeInteger(expected) || expected <= 0 || expected >= Number.MAX_SAFE_INTEGER - 1) throw new Error('消息草稿归属无效');
    await transaction.assertActive(scope);
    const rows = await readTable(), row = rows[key];
    if (row && row.scope !== scope) throw new Error('草稿配对身份不匹配');
    // Empty rows may have been pruned while the receipt was outstanding. A
    // later draft can reuse revision 1; its unique identity still fences it.
    if (row && row.identity !== identity) return;
    if (row && row.revision !== expected) {
      if (row.revision > expected) return;
      throw new Error('原消息草稿版本无法确认');
    }
    if (!row && Object.keys(rows).length >= LIMIT) throw new Error('草稿会话过多，请先处理已有消息');
    Object.defineProperty(rows, key, { value: { scope, revision: expected + 1, identity, text: '', images: [], imageCount: 0, consumedFrom: expected }, configurable: true, enumerable: true, writable: true });
    await writeTable(rows);
  });
}

/** The database contains metadata only. Snapshot bytes share the existing
 * exact pairing-private image budget; startup collection preserves all rows
 * and only reclaims snapshots no durable owner still references. */
export function createComposerDraftSession(key: string, scope: string): ComposerDraftSession {
  if (!key || key.length > 2048 || !scope || scope.length > 4096 || !matchesScope(key, scope)) throw new Error('草稿配对身份不匹配');
  const token = Symbol(); owners.set(key, token);
  let disposed = false, restored = false, revision = 0, restoredFingerprint = '';
  let writes: Promise<unknown> = Promise.resolve();
  const current = () => { if (disposed || owners.get(key) !== token) throw new Error('草稿会话已改变，内容未覆盖'); };
  const restore = (): Promise<ComposerDraft | undefined> => {
    const run = writes.then(() => withQueueImageTransaction(async transaction => {
      current(); await transaction.assertActive(scope);
      const row = (await readTable())[key]; current();
      if (row && row.scope !== scope) throw new Error('草稿配对身份不匹配');
      const result = row ? metadata(row) : undefined;
      if (result) {
        for (const image of result.images) {
          await transaction.assertOwned(scope, image); current();
          try { const info = await FileSystem.getInfoAsync(image.uri); if (!info.exists || info.isDirectory !== false) result.missingImages = true; }
          catch { result.missingImages = true; }
        }
        if (result.imageCount !== result.images.length) result.missingImages = true;
      }
      current(); revision = row?.revision ?? 0; restoredFingerprint = fingerprint(result ?? { text: '', images: [] }); restored = true; return result;
    }));
    writes = run.catch(() => undefined); return run;
  };
  const save = (input: ComposerDraftInput): Promise<ComposerDraft> => {
    // Freeze supplied bytes/metadata before any awaited read or earlier save.
    let featureIntent: ComposerFeatureIntent | undefined;
    try {
      featureIntent = copyComposerFeatureIntent(input.featureIntent, input.text);
      if(input.lastRestoredEdit&&!/^[a-f0-9-]{36}$/i.test(input.lastRestoredEdit))throw new Error('修改恢复记录无效');
      if (input.origin !== undefined && !composerOriginMatchesKey(input.origin, key, scope)) throw new Error('草稿来源与当前电脑或项目不匹配');
      if (featureIntent && (featureIntent.source.scope !== scope || !key.startsWith(`${scope}|${featureIntent.source.deviceId}|`))) throw new Error('草稿技能来源与当前配对或电脑不匹配');
    } catch (error) { return Promise.reject(error); }
    const draft = { ...input, images: input.images.map(image => ({ ...image })), featureIntent, ...(input.origin ? { origin: { ...input.origin } } : {}) };
    const run = writes.then(() => withQueueImageTransaction(async transaction => {
      current(); if (!restored) throw new Error('草稿尚未读取，原内容未覆盖');
      await transaction.assertActive(scope);
      const rows = await readTable(); current();
      let baseRevision = revision;
      if ((rows[key]?.revision ?? 0) !== revision) {
        const currentRow = rows[key];
        // An accepted old submission may clear the row after a new view
        // already restored it. New deliberate edits may advance from that
        // exact tombstone; the identical old snapshot may never resurrect.
        if (currentRow?.consumedFrom === revision && !currentRow.text && !currentRow.imageCount && fingerprint(draft) !== restoredFingerprint) baseRevision = currentRow.revision;
        else throw new Error('草稿已在其他窗口改变，原内容未覆盖');
      }
      if (baseRevision >= Number.MAX_SAFE_INTEGER - 1) throw new Error('本地草稿记录无效，请核对应用存储');
      const count = draft.imageCount ?? draft.images.length;
      if (draft.text.length > draftTextLimit(key, scope) || draft.images.length > 4 || !Number.isSafeInteger(count) || count < draft.images.length || count > 4) throw new Error('本地草稿超出限制，内容仍保留在输入框');
      if (!rows[key] && Object.keys(rows).length >= LIMIT) throw new Error('草稿会话过多，请先处理已有消息');
      const images: ImageRef[] = [];
      for (const image of draft.images) {
        // A recovered missing file stays a blocked reference; editing its
        // text must not discard the evidence or pretend it was reattached.
        const staged = image.base64 ? await transaction.stage(scope, image) : (await transaction.assertOwned(scope, image), image);
        current();
        images.push({ uri: staged.uri, mime: staged.mime, width: staged.width, height: staged.height });
      }
      const row: StoredDraft = { scope, revision: baseRevision + 1, identity: randomUUID(), text: draft.text, images, imageCount: count,
        ...(draft.lastRestoredEdit??rows[key]?.lastRestoredEdit?{lastRestoredEdit:draft.lastRestoredEdit??rows[key]?.lastRestoredEdit}:{}),
        ...(draft.missingImages || count !== images.length ? { missingImages: true } : {}),
        ...(draft.featureIntent ? { featureIntent: draft.featureIntent } : {}),
        ...(draft.origin ?? rows[key]?.origin ? { origin: { ...(draft.origin ?? rows[key]!.origin!) } } : {}) };
      // Keep an authoritative empty row until the legacy text row is also
      // cleared. A failed secondary write must not revive a sent prompt.
      Object.defineProperty(rows, key, { value: row, configurable: true, enumerable: true, writable: true });
      current(); await writeTable(rows);
      revision = row.revision;
      restoredFingerprint = fingerprint(row);
      return metadata(row);
    }));
    writes = run.catch(() => undefined); return run;
  };
  const consume = (expected: number, identity?: string): Promise<boolean> => {
    const run = writes.then(() => withQueueImageTransaction(async transaction => {
      await transaction.assertActive(scope);
      const rows = await readTable(), row = rows[key];
      if (!row || row.scope !== scope || row.revision !== expected) return false;
      if (identity !== undefined && row.identity !== identity) return false;
      if (row.revision >= Number.MAX_SAFE_INTEGER - 1) throw new Error('本地草稿记录无效，请核对应用存储');
      const empty: StoredDraft = { scope, revision: row.revision + 1, text: '', images: [], imageCount: 0, consumedFrom: row.revision };
      rows[key] = empty; await writeTable(rows);
      revision = empty.revision;
      restoredFingerprint = fingerprint(empty);
      return true;
    }));
    writes = run.catch(() => undefined); return run;
  };
  const pruneEmpty = (): Promise<void> => {
    const expected = revision;
    const run = writes.then(() => withQueueImageTransaction(async transaction => {
      await transaction.assertActive(scope);
      const rows = await readTable(), row = rows[key];
      if (!row || row.scope !== scope || row.revision !== expected || row.text || row.imageCount || row.featureIntent) return;
      if (owners.has(key) && owners.get(key) !== token) return;
      delete rows[key]; await writeTable(rows);
      if (owners.get(key) === token) revision = 0;
    }));
    writes = run.catch(() => undefined); return run;
  };
  return { restore, save, consume, pruneEmpty, dispose: () => { disposed = true; if (owners.get(key) === token) owners.delete(key); } };
}

export interface MissingComposerDraftCopy {
  scope: string; sourceKey: string; targetKey: string; origin: ComposerDraftOrigin; evidence: MissingSessionEvidence;
  expectedRevision: number; expectedIdentity?: string; isCurrent?: () => boolean;
}
export interface ComposerDraftRecoveryReceipt {
  scope: string; sourceKey: string; targetKey: string; targetRevision: number; targetIdentity: string; targetOrigin: ComposerDraftOrigin;
}
/** One durable table write adds the new draft. The original is deliberately
 * retained, including its image ownership, even after a successful copy. */
export function copyMissingComposerDraft(input: MissingComposerDraftCopy, rewriteText?: (draft: ComposerDraft) => string): Promise<{ receipt: ComposerDraftRecoveryReceipt; draft: ComposerDraft }> {
  const sourceOrigin = { ...input.origin }, { sessionKey: _sourceSession, ...targetOrigin } = sourceOrigin;
  if (targetOrigin.projectless) targetOrigin.cwd = '';
  const captured = { ...input, origin: sourceOrigin, evidence: { ...input.evidence } };
  const sourceOwner = owners.get(input.sourceKey), targetOwner = owners.get(input.targetKey);
  return withQueueImageTransaction(async transaction => {
    const current = () => { if (owners.get(captured.sourceKey) !== sourceOwner || owners.get(captured.targetKey) !== targetOwner || captured.isCurrent && !captured.isCurrent()) throw new Error('当前电脑或会话已变化，草稿未恢复'); };
    current();
    if (!validComposerDraftOrigin(sourceOrigin) || !sourceOrigin.sessionKey || !confirmedMissingSession(captured.evidence, sourceOrigin)
      || !captured.scope || captured.scope.length > 4096 || !Number.isSafeInteger(captured.expectedRevision) || captured.expectedRevision <= 0
      || !captured.sourceKey || captured.sourceKey.length > 2048 || !captured.targetKey || captured.targetKey.length > 2048 || captured.sourceKey === captured.targetKey
      || !composerOriginMatchesKey(sourceOrigin, captured.sourceKey, captured.scope) || !composerOriginMatchesKey(targetOrigin, captured.targetKey, captured.scope)
      || (sourceOrigin.transport === 'direct') !== Boolean(rewriteText)) throw new Error('未确认原会话已删除，或草稿恢复来源不匹配');
    await transaction.assertActive(captured.scope); current();
    const rows = await readTable(), source = rows[captured.sourceKey], target = rows[captured.targetKey]; current();
    if (!source || source.scope !== captured.scope || source.revision !== captured.expectedRevision || source.identity !== captured.expectedIdentity
      || !source.origin || !sameComposerDraftOrigin(source.origin, sourceOrigin)) throw new Error('原草稿已变化，请重新读取后恢复');
    if (!source.text && !source.imageCount && !source.featureIntent) throw new Error('原会话没有待恢复的草稿');
    if (target && (target.scope !== captured.scope || target.text || target.imageCount || target.featureIntent || target.missingImages
      || target.origin && !sameComposerDraftOrigin(target.origin, targetOrigin))) throw new Error('新对话已有草稿，原内容未覆盖');
    if (!target && Object.keys(rows).length >= LIMIT) throw new Error('草稿会话过多，请先处理已有消息');
    const revision = (target?.revision ?? 0) + 1;
    if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('本地草稿版本无效');
    let missing = Boolean(source.missingImages || source.imageCount !== source.images.length);
    for (const image of source.images) {
      await transaction.assertOwned(captured.scope, image); current();
      try { const info = await FileSystem.getInfoAsync(image.uri); if (!info.exists || info.isDirectory !== false) missing = true; } catch { missing = true; }
      current();
    }
    const text = rewriteText ? rewriteText(metadata(source)) : source.text;
    if (typeof text !== 'string' || text.length > 100_000) throw new Error('恢复内容超出草稿限制，原草稿已保留');
    const row: StoredDraft = { scope: captured.scope, revision, identity: randomUUID(), text, images: source.images.map(image => ({ ...image })), imageCount: source.imageCount,
      origin: targetOrigin, ...(missing ? { missingImages: true } : {}), ...(source.featureIntent ? { featureIntent: copyComposerFeatureIntent(source.featureIntent, text) } : {}) };
    Object.defineProperty(rows, captured.targetKey, { value: row, configurable: true, enumerable: true, writable: true });
    current(); await transaction.assertActive(captured.scope); current(); await writeTable(rows);
    return { draft: metadata(row), receipt: { scope: captured.scope, sourceKey: captured.sourceKey, targetKey: captured.targetKey, targetRevision: revision, targetIdentity: row.identity!, targetOrigin: { ...targetOrigin } } };
  });
}

/** Undo only the exact restored revision. A subsequent edit or submission is
 * never overwritten; an empty tombstone also fences an old mounted writer. */
export function undoMissingComposerDraft(receipt: ComposerDraftRecoveryReceipt, isCurrent?: () => boolean): Promise<boolean> {
  const copy = { ...receipt, targetOrigin: { ...receipt.targetOrigin } };
  return withQueueImageTransaction(async transaction => {
    if (!copy.scope || !composerOriginMatchesKey(copy.targetOrigin, copy.targetKey, copy.scope) || copy.targetOrigin.sessionKey
      || !Number.isSafeInteger(copy.targetRevision) || copy.targetRevision <= 0 || copy.targetRevision >= Number.MAX_SAFE_INTEGER - 1
      || typeof copy.targetIdentity !== 'string' || !copy.targetIdentity) throw new Error('恢复记录无效，现有草稿未修改');
    if (isCurrent && !isCurrent()) return false;
    await transaction.assertActive(copy.scope);
    const rows = await readTable(), row = rows[copy.targetKey];
    if (isCurrent && !isCurrent() || !row || row.scope !== copy.scope || row.revision !== copy.targetRevision || row.identity !== copy.targetIdentity
      || !row.origin || !sameComposerDraftOrigin(row.origin, copy.targetOrigin)) return false;
    rows[copy.targetKey] = { scope: copy.scope, revision: row.revision + 1, identity: randomUUID(), text: '', images: [], imageCount: 0, consumedFrom: row.revision, origin: { ...row.origin } };
    if (isCurrent && !isCurrent()) return false;
    await writeTable(rows); return true;
  });
}

/** All original images are required; a missing/changed image never becomes
 * a text-only prompt. Explicit expected scope also rejects cross-pair URIs. */
export async function hydrateComposerImages(scope: string, draft: Pick<ComposerDraft, 'images' | 'imageCount' | 'missingImages'>): Promise<RemoteImage[]> {
  markRemoteImagesInUse();
  if (draft.missingImages || draft.imageCount !== draft.images.length || draft.images.length > 4) throw new Error('请重新选择全部原图片，不会只发送文字');
  const out: RemoteImage[] = [];
  for (const image of draft.images) {
    const info = await FileSystem.getInfoAsync(image.uri);
    if (!info.exists || info.isDirectory !== false) throw new Error('原图片已不存在，请重新选择全部原图片');
    const base64 = await FileSystem.readAsStringAsync(image.uri, { encoding: FileSystem.EncodingType.Base64 });
    if (!base64 || base64.length > 11_200_000 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
      || base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0) > 8 * 1024 * 1024) throw new Error('原图片无法读取，请重新选择全部原图片');
    await verifyManagedQueuedImage(image.uri, image.mime as RemoteImageMime, base64, scope);
    out.push({ ...image, base64 });
  }
  return out;
}

/** Called only after the shared image manifest has durably fenced this
 * exact credential generation. No directory or unrelated row is scanned. */
export function clearComposerDraftScope(scope: string): Promise<void> {
  return withQueueImageTransaction(async () => {
    const rows = await readTable();
    for (const [key, row] of Object.entries(rows)) if (row.scope === scope && matchesScope(key, scope)) { delete rows[key]; owners.delete(key); }
    await writeTable(rows);
  });
}
