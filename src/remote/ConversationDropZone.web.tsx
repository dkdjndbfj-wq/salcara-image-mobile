import {WorkbenchReveal} from './ConversationMotion';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { useDesk } from '../theme';
import { showToast } from '../components/ui';
import { readComposerFiles } from './composer-file-reader.web';
import { COMPOSER_FILE_ACCEPT } from './composer-files';
import { conversationFontFamily } from './conversation-typography';
import type { ConversationDropZoneProps } from './ConversationDropZone';
export type { ConversationFilesHandle, ConversationDropZoneProps } from './ConversationDropZone';

export function ConversationDropZone({ scopeKey, enabled, onFiles, children, importRef }: ConversationDropZoneProps) {
  const d = useDesk(), [dragging, setDragging] = useState<string>(), [working, setWorking] = useState<string>();
  const input = useRef<HTMLInputElement>(null), root = useRef<HTMLDivElement>(null), depth = useRef(0), alive = useRef(true);
  const latest = useRef({ scopeKey, enabled, onFiles }); latest.current = { scopeKey, enabled, onFiles };
  const ownership=useRef({scopeKey,enabled,epoch:0});
  if(ownership.current.scopeKey!==scopeKey||ownership.current.enabled!==enabled)ownership.current={scopeKey,enabled,epoch:ownership.current.epoch+1};
  const epoch=ownership.current.epoch,pickerOwner=useRef<number|undefined>(undefined);
  const flight = useRef<object | undefined>(undefined);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => { depth.current = 0; pickerOwner.current=undefined;flight.current=undefined;setDragging(undefined); setWorking(undefined); }, [scopeKey, enabled]);
  const current = () => alive.current && ownership.current.epoch===epoch && latest.current.scopeKey === scopeKey && latest.current.enabled;
  const add = async (files: readonly File[]) => {
    if (!current() || flight.current || !files.length) return;
    const token = {}; flight.current = token; setWorking(scopeKey);
    try {
      const batch = await readComposerFiles(files, current);
      if (current() && await latest.current.onFiles(batch) && current()) showToast('已加入草稿', 'check');
    } catch (error) { if (current()) showToast(error instanceof Error ? error.message : '文件添加失败，原草稿已保留', 'alert'); }
    finally { if (flight.current === token) { flight.current = undefined; if (alive.current && latest.current.scopeKey === scopeKey) setWorking(undefined); } }
  };
  useLayoutEffect(() => {
    const handle = { pick: () => { if (current() && !flight.current) {pickerOwner.current=epoch;input.current?.click();} } };
    if (importRef) importRef.current = handle;
    return () => { if (importRef?.current === handle) importRef.current = undefined; };
  }, [scopeKey, enabled, importRef]);
  const filesDragged = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const owns = (target: EventTarget | null) => {
    if(!(target instanceof Element)||target.closest('[data-conversation-drop-zone]')!==root.current)return false;
    // On phones the whole conversation lives in a modal sheet. Only a dialog
    // inside this conversation (e.g. editing a queued message) owns its paste.
    const dialog=target.closest('[role="dialog"]');
    return !dialog||!root.current?.contains(dialog);
  };
  return <div ref={root} data-conversation-drop-zone="true" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}
    onDragEnter={event => { if (filesDragged(event) && owns(event.target)) { event.preventDefault(); depth.current++; setDragging(scopeKey); } }}
    onDragOver={event => { if (filesDragged(event) && owns(event.target)) { event.preventDefault(); event.dataTransfer.dropEffect = enabled && !flight.current ? 'copy' : 'none'; } }}
    onDragLeave={event => { if (owns(event.target)) { depth.current = Math.max(0, depth.current - 1); if (!depth.current || !(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(undefined); } }}
    onDrop={event => { if (filesDragged(event) && owns(event.target)) { event.preventDefault(); event.stopPropagation(); depth.current = 0; setDragging(undefined); void add(Array.from(event.dataTransfer.files)); } }}
    onPasteCapture={event => { if (owns(event.target) && event.clipboardData.files.length) { event.preventDefault(); event.stopPropagation(); void add(Array.from(event.clipboardData.files)); } }}>
    {children}
    <input ref={input} type="file" multiple accept={COMPOSER_FILE_ACCEPT} aria-label="选择本地附件" style={{ display: 'none' }}
      onChange={event => { const files = Array.from(event.currentTarget.files ?? []),owner=pickerOwner.current;pickerOwner.current=undefined;event.currentTarget.value = ''; if(owner===epoch&&current())void add(files); }} />
    <div style={{position:'absolute',inset:8,zIndex:10,pointerEvents:'none',display:'flex'}}><WorkbenchReveal pointerEvents="none" visible={dragging===scopeKey||working===scopeKey} style={{flex:1}}><div role="status" aria-live="polite" data-testid="conversation-drop-feedback" style={{ position: 'absolute', inset: 0, border: `1px dashed ${d.muted}`, borderRadius: 14, background: 'rgba(250,250,250,.95)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: d.text, fontFamily: conversationFontFamily, fontSize: 13 }}>
      {working === scopeKey ? '正在读取附件…' : enabled ? '松开以加入当前对话草稿' : '当前状态暂不能添加附件'}
    </div></WorkbenchReveal></div>
  </div>;
}
