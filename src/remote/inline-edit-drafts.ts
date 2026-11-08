import { sha256 } from '@noble/hashes/sha2.js';
import { createComposerDraftSession, type ComposerDraft, type ComposerDraftSession } from './composer-drafts';

type PendingEdit = { text: string; error?: string };
const pending = new Map<string, PendingEdit>();
const lanes = new Map<string, Promise<unknown>>();
const active = new Map<string, symbol>();
export function inlineEditDraftKey(scope: string, deviceId: string, identity: string): string {
  const digest = Array.from(sha256(new TextEncoder().encode(identity)), value => value.toString(16).padStart(2, '0')).join('');
  return `${scope}|${deviceId}|inline-edit:${digest}`;
}
function serial<T>(key: string, action: () => Promise<T>): Promise<T> {
  const task = (lanes.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
  lanes.set(key, task);
  void task.finally(() => { if (lanes.get(key) === task) lanes.delete(key); }).catch(() => undefined);
  return task;
}
const failure = (reason: unknown) => reason instanceof Error ? reason.message : '编辑草稿未能保存';

/** Separate from both the main composer and the submitted-edit recovery backup.
 * The per-key lane drains a departing editor before the next editor restores.
 * A failed disk write keeps its text in memory and is never reported as saved. */
export function createInlineEditDraft(scope: string, deviceId: string, identity: string) {
  const key = inlineEditDraftKey(scope, deviceId, identity);
  const token = Symbol();
  let writer: ComposerDraftSession | undefined, saved: ComposerDraft | undefined, staged: PendingEdit | undefined, closed = false;
  const opening = serial(key, async () => {
    active.set(key,token);
    writer = createComposerDraftSession(key, scope);
    saved = await writer.restore();
    const unsaved = pending.get(key);
    if (unsaved) { staged = { ...unsaved }; pending.set(key, staged); }
    return { text: staged?.text ?? (saved && saved.consumedFrom === undefined ? saved.text : undefined), error: staged?.error };
  });
  const stage = (text: string) => {
    if (closed || active.get(key)!==token) throw new Error('编辑来源已变化');
    staged = { text }; pending.set(key, staged);
  };
  const flush = (): Promise<ComposerDraft | undefined> => {
    const value = staged;
    return serial(key, async () => {
      await opening;
      if (!value) return saved;
      try {
        if (value.text.length > 100_000) throw new Error('编辑内容超过 100,000 字符，尚未保存');
        const row = await writer!.save({ text: value.text, images: [] });
        saved = row;
        if (staged === value) staged = undefined;
        if (pending.get(key) === value) pending.delete(key);
        return row;
      } catch (reason) {
        if (active.get(key)===token) value.error = failure(reason);
        else { if (pending.get(key)===value) pending.delete(key); if (staged===value) staged=undefined; }
        throw reason;
      }
    });
  };
  const consume = (receipt: ComposerDraft | undefined): Promise<void> => serial(key, async () => {
    await opening;
    if (!receipt) return;
    if (!await writer!.consume(receipt.revision, receipt.identity)) throw new Error('编辑草稿已在其他窗口改变，未清除新内容');
    if (saved?.revision === receipt.revision && saved.identity === receipt.identity) saved = undefined;
    await writer!.pruneEmpty();
  });
  const discard = (): Promise<void> => {
    const value = staged;
    return serial(key, async () => {
      await opening;
      // Earlier scheduled saves have settled by now. Consume only this editor's
      // exact latest receipt; a newer window's deliberate edit stays intact.
      if (saved && !await writer!.consume(saved.revision, saved.identity)) throw new Error('编辑草稿已变化，请重新打开后核对');
      saved = undefined;
      if (staged === value) staged = undefined;
      if (pending.get(key) === value) pending.delete(key);
      await writer!.pruneEmpty();
    });
  };
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    const saving = flush();
    const cleanup = serial(key, async () => { writer?.dispose(); if(active.get(key)===token)active.delete(key); });
    return saving.then(() => cleanup, async reason => { await cleanup; if (staged) throw reason; });
  };
  return { key, restore: () => opening, stage, flush, consume, discard, close };
}

export type InlineEditDraft = ReturnType<typeof createInlineEditDraft>;
