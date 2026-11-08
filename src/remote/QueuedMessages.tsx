import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { MotionPressable } from '../components/MotionPressable';
import { Sheet } from '../components/ui';
import { useDesk } from '../theme';
import { conversationFontFamily } from './conversation-typography';
import { ManagedImage } from './ManagedImage';
import { ImageViewer } from './thread-extras';
import { WorkbenchReveal } from './ConversationMotion';
import {useInlineEditDraft} from './useInlineEditDraft';

export interface QueuedMessageView {
  id: string; text: string; images: readonly { uri: string }[]; imageCount?: number;
  detail: string; options?: string; editable: boolean; removable: boolean; resumable?: boolean;
  uncertain?: boolean; missingImages?: boolean;
}
export interface QueuedMessagesProps {
  draftScope?:string;draftDeviceId?:string;
  scopeKey: string; entries: readonly QueuedMessageView[]; disabled?: boolean;
  onPause: () => Promise<unknown>; onEdit: (id: string, text: string, originalText: string) => Promise<unknown>;
  onMove: (id: string, offset: -1 | 1) => Promise<unknown>; onRemove: (id: string) => Promise<unknown>;
  onResume: (id: string) => Promise<unknown>; onReview?: () => void; onRetrieve?: () => void;
}
export function QueuedMessages(props: QueuedMessagesProps) { return <QueuePanel key={props.scopeKey} {...props} />; }
function QueuePanel({ scopeKey, draftScope, draftDeviceId, entries, disabled = false, onPause, onEdit, onMove, onRemove, onResume, onReview, onRetrieve }: QueuedMessagesProps) {
  const d = useDesk(), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState<{ id: string; edit: boolean; originalText: string }>(), [image, setImage] = useState<string>();
  const alive = useRef(true), flight = useRef(false), latest = useRef(entries); latest.current = entries;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const row = entries.find(entry => entry.id === selected?.id), locked = busy || disabled;
  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    if (flight.current || disabled || !alive.current) return;
    flight.current = true; setBusy(true); setError('');
    try { await action(); if (alive.current) after?.(); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '排队操作失败，原内容已保留'); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  };
  const show = (entry: QueuedMessageView, edit: boolean) => {
    if (!edit) { setSelected({ id: entry.id, edit: false, originalText: entry.text }); return; }
    if (!entry.editable) return;
    void run(onPause, () => { const current = latest.current.find(value => value.id === entry.id); if (!current || current.text !== entry.text) { setError('排队内容已变化，请重新查看'); return; }
      setSelected({ id: entry.id, edit: true, originalText: entry.text }); });
  };
  const label = { fontFamily: conversationFontFamily, fontSize: 12, lineHeight: 18, color: d.text };
  if (!entries.length) return null;
  const icon = (name: React.ComponentProps<typeof Icon>['name'], accessibilityLabel: string, action: () => void, blocked = false) =>
    <MotionPressable scaleTo={0.94} accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={locked || blocked} onPress={action} style={{ width: 34, height: 34, justifyContent: 'center', alignItems: 'center', opacity: locked || blocked ? .35 : 1 }}><Icon name={name} size={14} color={d.muted} /></MotionPressable>;
  return <View testID="queued-messages" accessibilityLabel={`排队中：${entries[0].text}`} style={{ marginHorizontal: 12, paddingVertical: 4, borderBottomWidth: 1, borderColor: d.line }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <MotionPressable scaleTo={0.99} wrapperStyle={{ flex: 1, minWidth: 0 }} accessibilityRole="button" accessibilityLabel={open ? '收起排队消息' : '展开排队消息'} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <Icon name="hourglass" size={13} color={d.muted} /><Text numberOfLines={1} style={[label, { flex: 1 }]}>{open ? `排队消息 · ${entries.length}` : `${entries[0].text || '图片消息'}${entries.length > 1 ? ` · ${entries.length} 条` : ''}`}</Text><Icon name={open ? 'arrowUp' : 'chevronDown'} size={12} color={d.muted} />
      </MotionPressable>
      {icon('pause', '暂停排队消息', () => void run(onPause))}
      {onRetrieve ? icon('arrowDown', '取消排队，放回输入框', onRetrieve) : null}
    </View>
    {!open ? <Text numberOfLines={1} style={[label, { fontSize: 10, color: d.muted, paddingLeft: 20 }]}>{entries[0].detail}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={[label, { color: d.warn }]}>{error}</Text> : null}
    <WorkbenchReveal visible={open} testID="queue-list-reveal"><ScrollView nestedScrollEnabled style={{ maxHeight: 180 }} keyboardShouldPersistTaps="handled">
      {entries.map((entry, index) => <WorkbenchReveal key={entry.id} style={{ paddingVertical: 5, gap: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`查看排队消息 ${index + 1}`} onPress={() => show(entry, false)} style={{ flex: 1, minWidth: 0, paddingVertical: 5 }}>
            <Text numberOfLines={2} style={label}>{entry.text || `${entry.imageCount ?? entry.images.length} 张图片`}</Text>
            <Text numberOfLines={1} style={[label, { fontSize: 10, color: d.muted }]}>{entry.detail}{entry.images.length ? ` · ${entry.imageCount ?? entry.images.length} 张图` : ''}</Text>
          </Pressable>
          {entry.resumable ? icon('chevronRight', `继续发送排队消息 ${index + 1}`, () => void run(() => onResume(entry.id))) : null}
          {entry.uncertain && onReview ? <MotionPressable scaleTo={0.94} accessibilityRole="button" accessibilityLabel="核对排队消息送达状态" onPress={onReview} style={{ width: 34, height: 34, justifyContent: 'center', alignItems: 'center' }}><Icon name="regenerate" size={14} color={d.muted} /></MotionPressable> : null}
          {icon('edit', `编辑排队消息 ${index + 1}`, () => show(entry, true), !entry.editable)}
          {icon('close', `移除排队消息 ${index + 1}`, () => void run(() => onRemove(entry.id)), !entry.removable)}
        </View>
        {entry.editable && entries.length > 1 ? <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          {icon('arrowUp', `上移排队消息 ${index + 1}`, () => void run(() => onMove(entry.id, -1)), !entries[index - 1]?.editable)}
          {icon('chevronDown', `下移排队消息 ${index + 1}`, () => void run(() => onMove(entry.id, 1)), !entries[index + 1]?.editable)}
        </View> : null}
      </WorkbenchReveal>)}
    </ScrollView></WorkbenchReveal>
    <Sheet visible={Boolean(row)} title={selected?.edit ? '编辑排队消息' : '排队消息'} subtitle={row?.options || row?.detail} dismissible={!busy} onClose={() => { if (!busy) { setSelected(undefined); setImage(undefined); } }}>
      {row ? <WorkbenchReveal transitionKey={`${row.id}:${selected?.edit ? 'edit' : 'preview'}`} style={{ paddingHorizontal: 18, paddingBottom: 10, gap: 10 }}>
        {selected?.edit ? <QueuedMessageEditor key={JSON.stringify([scopeKey,row.id,selected.originalText])} row={row} scopeKey={scopeKey} draftScope={draftScope} draftDeviceId={draftDeviceId} disabled={disabled} originalText={selected.originalText}
          onBusy={setBusy} onSave={value=>onEdit(row.id,value,selected.originalText)} onClose={()=>setSelected(undefined)}>
          <QueuedAttachments row={row} onImage={setImage}/>
        </QueuedMessageEditor>
          : <><ScrollView nestedScrollEnabled style={{ maxHeight: 240, backgroundColor: d.surface2, borderRadius: 12 }} contentContainerStyle={{padding:12}}><Text selectable style={[label,{fontSize:13,lineHeight:20}]}>{row.text || '图片消息'}</Text></ScrollView><QueuedAttachments row={row} onImage={setImage}/></>}
        {error ? <Text accessibilityRole="alert" style={[label, { color: d.warn }]}>{error}</Text> : null}
      </WorkbenchReveal> : null}
    </Sheet>
    <ImageViewer key={scopeKey} uri={image && row?.images.some(value => value.uri === image) ? image : null} onClose={() => setImage(undefined)} />
  </View>;
}

function QueuedAttachments({row,onImage}:{row:QueuedMessageView;onImage:(uri:string)=>void}){
  const d=useDesk();
  return <>
    {row.images.length ? <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>{row.images.map((value, index) => <Pressable key={`${value.uri}:${index}`} accessibilityRole="button" accessibilityLabel={`预览排队图片 ${index + 1}`} onPress={() => onImage(value.uri)}><ManagedImage uri={value.uri} resizeMode="cover" style={{ width: 56, height: 56, borderRadius: 10 }} /></Pressable>)}</ScrollView> : null}
    {row.missingImages ? <Text style={{fontFamily:conversationFontFamily,fontSize:12,lineHeight:18,color:d.warn}}>原图片尚未恢复，消息会保持暂停。</Text> : null}
  </>;
}

function QueuedMessageEditor({row,scopeKey,draftScope,draftDeviceId,originalText,disabled,onBusy,onSave,onClose,children}:{row:QueuedMessageView;scopeKey:string;draftScope?:string;draftDeviceId?:string;originalText:string;disabled:boolean;onBusy:(busy:boolean)=>void;onSave:(text:string)=>Promise<unknown>;onClose:()=>void;children?:React.ReactNode}){
  const d=useDesk(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[focused,setFocused]=useState(false);
  const identity=JSON.stringify(['queued-message',scopeKey,row.id,originalText]);
  const draft=useInlineEditDraft(originalText,identity,draftScope,draftDeviceId);
  const latest=useRef({identity,row,disabled,text:draft.text});latest.current={identity,row,disabled,text:draft.text};
  const alive=useRef(true),flight=useRef(false);useEffect(()=>{alive.current=true;return()=>{alive.current=false;onBusy(false);};},[onBusy]);
  const act=async(save:boolean)=>{
    if(flight.current||!draft.ready||save&&(disabled||!row.editable||row.text!==originalText))return;
    flight.current=true;setBusy(true);onBusy(true);setError('');
    try{
      if(save){const saved=await draft.flush();if(!alive.current)return;
        if(latest.current.identity!==identity||latest.current.disabled||!latest.current.row.editable||latest.current.row.text!==originalText||latest.current.text!==draft.text)throw new Error('排队内容或连接已变化，修改仍保留，请重新核对');
        await onSave(draft.text);await saved.draft?.consume(saved.receipt);}
      else await draft.discard();
      if(alive.current)onClose();
    }catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'编辑未完成，修改已保留');}
    finally{flight.current=false;if(alive.current){setBusy(false);onBusy(false);}}
  };
  const label={fontFamily:conversationFontFamily,fontSize:12,lineHeight:18,color:d.text};
  const saveDisabled=busy||disabled||!draft.ready||!row.editable||row.text!==originalText;
  const cancelDisabled=busy||!draft.ready;
  return <View style={{gap:10}}>
    <TextInput accessibilityLabel="排队消息正文" value={draft.text} onChangeText={draft.change} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)} multiline editable={draft.ready&&!busy&&!disabled&&row.editable} maxLength={100_000} style={[label,{fontSize:13,lineHeight:20,minHeight:104,maxHeight:200,padding:12,borderWidth:1,borderColor:focused?d.lineStrong:'transparent',backgroundColor:d.surface2,borderRadius:12,textAlignVertical:'top'}]}/>
    {children}
    <Text style={[label,{fontSize:11,lineHeight:17,color:d.muted}]}>修改会暂存，保存后仍保持暂停。</Text>
    {error||draft.error?<Text accessibilityRole="alert" style={[label,{color:d.warn}]}>{error||draft.error}</Text>:null}
    <View style={{flexDirection:'row',justifyContent:'flex-end',gap:8,marginTop:2}}>
      <MotionPressable scaleTo={0.98} hitSlop={4} accessibilityRole="button" accessibilityLabel="取消编辑排队消息" accessibilityState={{disabled:cancelDisabled}} disabled={cancelDisabled} onPress={()=>void act(false)} style={{minHeight:34,paddingHorizontal:16,borderRadius:10,alignItems:'center',justifyContent:'center',backgroundColor:d.surface2,opacity:cancelDisabled ? 0.4 : 1}}><Text style={label}>取消</Text></MotionPressable>
      <MotionPressable scaleTo={0.98} hitSlop={4} accessibilityRole="button" accessibilityLabel="保存排队消息" accessibilityState={{disabled:saveDisabled,busy}} disabled={saveDisabled} onPress={()=>void act(true)} style={{minHeight:34,minWidth:68,paddingHorizontal:16,borderRadius:10,alignItems:'center',justifyContent:'center',backgroundColor:d.ink,opacity:saveDisabled ? 0.4 : 1}}><Text style={[label,{color:d.onInk,fontWeight:'500'}]}>{busy?'保存中…':'保存'}</Text></MotionPressable>
    </View>
  </View>;
}
