import type { ApprovalMode, Effort, PermissionMode, ToolId, WorkspaceMode } from './client';
import { copyTurnFeatures, validTurnFeatures, type TurnFeatures } from './agent-features';
import { isEffort } from './effort';
import { isPermissionMode } from './permission-mode';
import { validAgentId } from './projection';

/** The outbox identity is not a real Agent thread and must never be opened. */
export function newSessionReceiptKey(tool: ToolId, desktop = false): string {
  if (!validAgentId(tool) || desktop && tool !== 'claude') throw new Error('Agent 与会话归属不一致');
  return `${tool}:__salcara_start_v1__${desktop ? ':desktop' : ':code'}`;
}

export interface NewTaskSnapshot extends TurnFeatures {
  version: 1; tool: ToolId; cwd: string; prompt: string; approval: ApprovalMode; workspaceMode?: WorkspaceMode;
  accountId?: string; model?: string; effort?: Effort; permissionMode?: PermissionMode; desktop?: true;
  images: Array<{ mime: string; width: number; height: number; digest: string }>;
  composerDraft?: { key: string; revision: number; identity?: string };
}

/** Exact canonical metadata only: no key, image bytes or temporary file URI. */
export function encodeNewTask(value: NewTaskSnapshot): string {
  const encoded = JSON.stringify({ version: 1, tool: value.tool, cwd: value.cwd, prompt: value.prompt, approval: value.approval, ...(value.workspaceMode ? { workspaceMode: value.workspaceMode } : {}),
    ...(value.accountId ? { accountId: value.accountId } : {}), ...(value.model ? { model: value.model } : {}),
    ...(value.effort ? { effort: value.effort } : {}), ...(value.permissionMode !== undefined ? { permissionMode: value.permissionMode } : {}), ...(value.desktop ? { desktop: true } : {}),
    ...(value.composerDraft ? { composerDraft: { key: value.composerDraft.key, revision: value.composerDraft.revision,
      ...(value.composerDraft.identity !== undefined ? { identity: value.composerDraft.identity } : {}) } } : {}),
    ...copyTurnFeatures(value),
    images: value.images.map(image => ({ mime: image.mime, width: image.width, height: image.height, digest: image.digest })) });
  // Validate before writing a receipt, not after the task has been dispatched.
  decodeNewTask(encoded);
  return encoded;
}

export function decodeNewTask(encoded: string): NewTaskSnapshot {
  const invalid = () => new Error('新任务的原始记录无法确认，未发送，请先核对电脑上的任务');
  if (typeof encoded !== 'string' || encoded.length > 512_000) throw invalid();
  let raw: unknown;
  try { raw = JSON.parse(encoded); } catch { throw invalid(); }
  // These are app-generated canonical records, not arbitrary JSON imports.
  // A round trip must retain every byte, including keys/escapes: duplicate
  // (also escaped duplicate) keys cannot silently select their last value.
  if (JSON.stringify(raw) !== encoded) throw invalid();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const item = raw as Record<string, unknown>;
  const fields = new Set(['version', 'tool', 'cwd', 'prompt', 'approval', 'workspaceMode', 'accountId', 'model', 'effort', 'permissionMode', 'collaborationMode', 'skills', 'contextReferences', 'desktop', 'images', 'composerDraft']);
  if (Object.keys(item).some(key => !fields.has(key)) || item.version !== 1 || !validAgentId(item.tool)
      || typeof item.cwd !== 'string' || !item.cwd || item.cwd.length > 4096 || /[\r\n\x00]/.test(item.cwd)
      || typeof item.prompt !== 'string' || item.prompt.length > 100_000
      || item.workspaceMode !== undefined && item.workspaceMode !== 'code' && item.workspaceMode !== 'work'
      || !['ask', 'auto_edits', 'auto_all'].includes(item.approval as string)
      || item.accountId !== undefined && (typeof item.accountId !== 'string' || !item.accountId || item.accountId.length > 256 || /[\r\n\x00]/.test(item.accountId))
      || item.model !== undefined && (typeof item.model !== 'string' || !item.model || item.model.length > 200 || /[\r\n\x00]/.test(item.model))
      || item.effort !== undefined && !isEffort(item.effort)
      || item.permissionMode !== undefined && (!isPermissionMode(item.permissionMode) || item.tool !== 'codex' || item.desktop !== undefined)
      || !validTurnFeatures(item)
      || (item.collaborationMode !== undefined || item.skills !== undefined) && !['codex', 'claude'].includes(item.tool as string)
      || item.desktop !== undefined && (item.desktop !== true || item.tool !== 'claude')
      || item.composerDraft !== undefined && (!item.composerDraft || typeof item.composerDraft !== 'object' || Array.isArray(item.composerDraft)
        || Object.keys(item.composerDraft).some(key => !['key', 'revision', 'identity'].includes(key))
        || (item.composerDraft as Record<string, unknown>).identity !== undefined && (typeof (item.composerDraft as Record<string, unknown>).identity !== 'string'
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test((item.composerDraft as { identity: string }).identity))
        || typeof (item.composerDraft as Record<string, unknown>).key !== 'string' || !(item.composerDraft as { key: string }).key || (item.composerDraft as { key: string }).key.length > 4096
        || !Number.isSafeInteger((item.composerDraft as Record<string, unknown>).revision) || Number((item.composerDraft as Record<string, unknown>).revision) < 1)
      || !Array.isArray(item.images) || item.images.length > 4 || item.images.some(rawImage => {
        if (!rawImage || typeof rawImage !== 'object' || Array.isArray(rawImage)) return true;
        const image = rawImage as Record<string, unknown>;
        return Object.keys(image).some(key => !['mime', 'width', 'height', 'digest'].includes(key))
          || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mime as string)
          || !Number.isSafeInteger(image.width) || Number(image.width) < 1 || Number(image.width) > 20_000
          || !Number.isSafeInteger(image.height) || Number(image.height) < 1 || Number(image.height) > 20_000
          || typeof image.digest !== 'string' || !/^[a-f0-9]{64}$/.test(image.digest);
      }) || !item.prompt.trim() && !item.images.length && !(item.contextReferences as TurnFeatures['contextReferences'])?.length) throw invalid();
  return item as unknown as NewTaskSnapshot;
}
