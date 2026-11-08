import { command, HubError, type Command, type Hub } from './client';
import { getRemoteState, onRemoteChange, remoteDeliveryScope, timelineKey, watchCredentials } from './store';
import type { TerminalSelection } from './workspace-terminal';
import { parsePreviewLog, PREVIEW_LOG_LIMIT, PREVIEW_LOG_CHARS, type PreviewLogEntry } from './preview-logs';

export type PreviewInput = { action: 'click'; x: number; y: number } | { action: 'scroll'; deltaY: number }
  | { action: 'text'; text: string } | { action: 'key'; key: string; modifiers?: number } | { action: 'resize'; width: number; height: number }
  | { action: 'navigate'; url: string } | { action: 'reload' } | { action: 'mouse'; phase: 'down' | 'move' | 'up'; x: number; y: number }
  | { action: 'scrollTo'; x: number; y: number } | { action: 'dialog'; dialogId: string; accept: boolean; prompt?: string }
  | { action: 'upload'; chooserId: string; uploadId: string; name: string; total: number; offset: number; dataBase64: string; final: boolean }
  | { action: 'inspect' }
  | { action: 'element-pick'; documentId: string; x: number; y: number }
  | { action: 'style-preview'; documentId: string; elementId: string; revision: number; property: string; value: string; important: boolean }
  | { action: 'style-undo'; documentId: string; elementId: string; revision: number };
export interface PreviewElement {
  id: string; documentId: string; revision: number; url: string; tag: string; selector: string; text: string; outerHTML: string;
  rect: { x: number; y: number; width: number; height: number };
  computed: Record<string, string>;
  changes: Array<{ property: string; before: string; beforePriority: string; value: string; priority: string }>;
  sources: Array<{ url: string; line: number; column: number; selector: string }>;
}
export const previewStyleProperties = 'color background-color font-size font-weight font-family line-height letter-spacing text-align text-decoration-color opacity display visibility width height min-width min-height max-width max-height margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left border-top-width border-right-width border-bottom-width border-left-width border-top-color border-right-color border-bottom-color border-left-color border-top-style border-right-style border-bottom-style border-left-style border-radius gap row-gap column-gap flex-direction align-items justify-content flex-grow flex-shrink flex-basis position top right bottom left z-index overflow-x overflow-y box-shadow transform'.split(' ');
export interface PreviewFrame { pageId: string; url: string; imageBase64?: string; width: number; height: number; nextSequence: number;
  logsSupported?: boolean; logs?: PreviewLogEntry[];
  selectionText?: string; scrollX?: number; scrollY?: number; inspection?: string;
  domSupported?: boolean; documentId?: string; element?: PreviewElement; domError?: string;
  dialog?: { id: string; type: string; message: string; defaultPrompt?: string };
  chooser?: { id: string; multiple: boolean };
  downloads?: Array<{ id: string; name: string; size: number; state: 'inProgress' | 'completed' | 'canceled' }>;
}
export interface PreviewDownload { pageId: string; downloadId: string; name: string; offset: number; total: number; dataBase64: string; done: boolean }
export interface ComputerPreview { open(url: string, width: number, height: number): Promise<PreviewFrame>; frame(capture: boolean): Promise<PreviewFrame>; input(input: PreviewInput): Promise<void>; download?(downloadId: string, offset: number): Promise<PreviewDownload>; dispose(): void }
export const isComputerLoopbackURL = (raw: string) => {
  try { const url = new URL(raw); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
  catch { return false; }
};
export function parsePreviewFrame(raw: unknown, pageId?: string): PreviewFrame {
  const value = raw as PreviewFrame;
  if (!value || typeof value !== 'object' || !/^[A-Za-z0-9_-]{12,128}$/.test(value.pageId) || pageId && value.pageId !== pageId
    || typeof value.url !== 'string' || value.url.length > 4096 || !/^https?:\/\//.test(value.url)
    || !Number.isSafeInteger(value.width) || value.width < 320 || value.width > 1440
    || !Number.isSafeInteger(value.height) || value.height < 240 || value.height > 1200
    || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 1
    || value.imageBase64 !== undefined && (typeof value.imageBase64 !== 'string' || value.imageBase64.length > 220 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(value.imageBase64))) throw new HubError('电脑预览响应无效');
  if (value.selectionText !== undefined && (typeof value.selectionText !== 'string' || value.selectionText.length > 65536)
    || value.inspection !== undefined && (typeof value.inspection !== 'string' || value.inspection.length > 65536)
    || value.scrollX !== undefined && (!Number.isFinite(value.scrollX) || Math.abs(value.scrollX) > 10000000)
    || value.scrollY !== undefined && (!Number.isFinite(value.scrollY) || Math.abs(value.scrollY) > 10000000)
    || value.dialog !== undefined && (!value.dialog || typeof value.dialog.id !== 'string' || !/^\d{1,20}$/.test(value.dialog.id) || !['alert', 'confirm', 'prompt', 'beforeunload'].includes(value.dialog.type) || typeof value.dialog.message !== 'string' || value.dialog.message.length > 8192 || value.dialog.defaultPrompt !== undefined && (typeof value.dialog.defaultPrompt !== 'string' || value.dialog.defaultPrompt.length > 2048))
    || value.chooser !== undefined && (!value.chooser || typeof value.chooser.id !== 'string' || !/^\d{1,20}$/.test(value.chooser.id) || typeof value.chooser.multiple !== 'boolean')
    || value.downloads !== undefined && (!Array.isArray(value.downloads) || value.downloads.length > 8 || value.downloads.some(item => !item || !/^[a-fA-F0-9-]{8,100}$/.test(item.id) || typeof item.name !== 'string' || item.name.length > 512 || /[\\/\p{Cc}]/u.test(item.name) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 8 * 1024 * 1024 || !['inProgress','completed','canceled'].includes(item.state)))) throw new HubError('电脑网页交互状态无效');
  validatePreviewDOM(value);
  if (value.logsSupported !== undefined && typeof value.logsSupported !== 'boolean'
    || value.logs !== undefined && (!value.logsSupported || !Array.isArray(value.logs) || value.logs.length > PREVIEW_LOG_LIMIT
      || value.logs.some(entry => !parsePreviewLog(entry)) || new Set(value.logs.map(entry => entry.id)).size !== value.logs.length
      || value.logs.reduce((sum, entry) => sum + entry.message.length + (entry.source?.length ?? 0), 0) > PREVIEW_LOG_CHARS)) throw new HubError('网页日志响应无效');
  if (value.logs) value.logs = value.logs.map(entry => parsePreviewLog(entry)!);
  return value;
}

function validatePreviewDOM(frame: PreviewFrame) {
  const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value);
  const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
  const e = frame.element;
  if (frame.domSupported !== undefined && typeof frame.domSupported !== 'boolean'
    || frame.documentId !== undefined && !id(frame.documentId)
    || frame.domSupported && !id(frame.documentId)
    || frame.domError !== undefined && !text(frame.domError, 1024)
    || e !== undefined && (!e || !frame.domSupported || !id(e.id) || e.documentId !== frame.documentId
      || !Number.isSafeInteger(e.revision) || e.revision < 1 || e.revision > 1 << 30
      || !text(e.url,4096) || !isComputerLoopbackURL(e.url) || !text(e.tag,128) || !/^[a-z][a-z0-9:-]*$/.test(e.tag)
      || !text(e.selector,2048) || !text(e.text,2048) || !text(e.outerHTML,8192)
      || !e.rect || ![e.rect.x,e.rect.y,e.rect.width,e.rect.height].every(n => Number.isFinite(n) && Math.abs(n) <= 10000000) || e.rect.width < 0 || e.rect.height < 0
      || !e.computed || Array.isArray(e.computed) || typeof e.computed !== 'object' || Object.entries(e.computed).some(([key,value])=>!previewStyleProperties.includes(key) || !text(value,512))
      || !Array.isArray(e.changes) || e.changes.length > 16 || e.changes.some(c=>!c || !previewStyleProperties.includes(c.property) || !text(c.before,512) || !text(c.value,512) || !['','important'].includes(c.beforePriority) || !['','important'].includes(c.priority))
      || !Array.isArray(e.sources) || e.sources.length > 12 || e.sources.some(s=>!s || !text(s.url,4096) || !text(s.selector,2048) || !Number.isSafeInteger(s.line) || s.line < 1 || !Number.isSafeInteger(s.column) || s.column < 1))) throw new HubError('网页元素状态无效');
}

export function parsePreviewDownload(raw: unknown, pageId: string, downloadId: string, offset: number): PreviewDownload {
  const value = raw as PreviewDownload;
  if (!value || value.pageId !== pageId || value.downloadId !== downloadId || value.offset !== offset || typeof value.name !== 'string' || !value.name || value.name.length > 512 || /[\\/\p{Cc}]/u.test(value.name)
    || !Number.isSafeInteger(value.total) || value.total < offset || value.total > 8 * 1024 * 1024 || typeof value.done !== 'boolean'
    || typeof value.dataBase64 !== 'string' || value.dataBase64.length > 45000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.dataBase64)) throw new HubError('下载内容响应无效');
  const length = value.dataBase64.length * 3 / 4 - (value.dataBase64.endsWith('==') ? 2 : value.dataBase64.endsWith('=') ? 1 : 0);
  if (offset + length > value.total || value.done !== (offset + length === value.total) || !value.done && length === 0) throw new HubError('下载内容不完整');
  return value;
}

export function captureComputerPreview(selection: TerminalSelection, onInvalidated: () => void): ComputerPreview {
  const credentials = watchCredentials(), scope = remoteDeliveryScope(), controller = new AbortController();
  const owner: Hub | undefined = credentials?.pairToken ? { ...credentials, deviceId: selection.deviceId } : undefined;
  let disposed = false, invalidated = false, pageId: string | undefined, sequence = 1, inputFailed = false;
  let writes: Promise<void> = Promise.resolve();
  const operationId = `preview_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  const valid = () => {
    const state = getRemoteState(), current = watchCredentials();
    const device = state.devices.find(item => item.deviceId === selection.deviceId);
    const directory = state.sessions[selection.deviceId];
    const info = state.timelines[timelineKey(selection.deviceId, selection.sessionKey)]?.session
      ?? (selection.surface === 'desktop' ? directory?.native?.list : directory?.list)?.find(item => item.sessionKey === selection.sessionKey);
    if (disposed || invalidated || !owner || scope !== remoteDeliveryScope() || current?.url !== owner.url || current?.pairToken !== owner.pairToken
      || !device?.online || !device.capabilities?.includes('workspace.preview.v1') || !device.projects.some(project => project.path === selection.cwd)
      || info?.cwd !== selection.cwd || info.controlSurface === 'read-only' || (info.controlSurface === 'desktop' ? 'desktop' : 'cli') !== selection.surface) return false;
    if (selection.surface === 'desktop') {
      const lease = state.agents[selection.deviceId]?.list.find(item => item.id === selection.agentId)?.desktopLive;
      return Boolean(lease && lease.expiresAt > Date.now() && lease.capabilities?.read && lease.sessionKeys.includes(selection.sessionKey));
    }
    return true;
  };
  const guard = () => {
    if (valid()) return;
    const device=getRemoteState().devices.find(item=>item.deviceId===selection.deviceId);
    if (!device?.online) throw new HubError('电脑已离线，恢复连接后重新打开网页预览');
    if (!device.capabilities?.includes('workspace.preview.v1')) throw new HubError('电脑端尚未开放本地网页预览，请更新电脑端和中转站');
    throw new HubError('电脑或会话已变化，请重新连接网页预览');
  };
  const unsubscribe = onRemoteChange(() => { if (!disposed && !invalidated && !valid()) { invalidated = true; controller.abort(); onInvalidated(); } });
  const base = { sessionKey: selection.sessionKey, controlSurface: selection.surface, expectedCwd: selection.cwd };
  const send = async (type: string, payload: Record<string, unknown>) => {
    guard(); const reply = await command(owner!, selection.deviceId, { ...base, type, ...payload } as Command, undefined, controller.signal); guard(); return reply;
  };
  return {
    open: async (url, width, height) => {
      if (!isComputerLoopbackURL(url)) throw new HubError('此预览只连接电脑本机网址');
      const frame = parsePreviewFrame(await send('workspace.preview.open', { operationId, url, width, height }), pageId);
      pageId = frame.pageId; sequence = frame.nextSequence; return frame;
    },
    frame: async capture => { if (!pageId) throw new HubError('网页预览尚未连接'); return parsePreviewFrame(await send('workspace.preview.frame', { pageId, capture }), pageId); },
    download: async (downloadId, offset) => { if (!pageId) throw new HubError('网页预览尚未连接'); return parsePreviewDownload(await send('workspace.preview.file', { pageId, downloadId, offset }), pageId, downloadId, offset); },
    input: input => {
      const pending = writes.then(async () => {
        guard(); if (!pageId || inputFailed) throw new HubError('网页操作未确认，请重新连接预览');
        try {
          const reply = await send('workspace.preview.input', { pageId, sequence, input }) as { pageId: string; sequence: number };
          if (reply.pageId !== pageId || reply.sequence !== sequence) throw new HubError('网页操作未确认'); sequence++;
        } catch (error) { inputFailed = true; throw error; }
      });
      writes = pending.catch(() => {}); return pending;
    },
    dispose: () => {
      if (disposed) return;
      if (pageId && valid()) void command(owner!, selection.deviceId, { ...base, type: 'workspace.preview.close', pageId } as Command).catch(() => {});
      disposed = true; controller.abort(); unsubscribe();
    },
  };
}
