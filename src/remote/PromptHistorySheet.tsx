import React,{useEffect,useRef,useState} from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Sheet } from '../components/ui';
import { Icon } from '../components/Icon';
import { MotionPressable } from '../components/MotionPressable';
import { useDesk } from '../theme';
import { conversationFontFamily } from './conversation-typography';
import { splitPastedText } from './pasted-text';
import type { PromptHistoryEntry } from './prompt-history';

export interface PromptHistoryHandle { open: () => void }
export function PromptHistorySheet({ visible, entries, disabled, append, onPick, onRestore, onClose }: {
  visible: boolean; entries: readonly PromptHistoryEntry[]; disabled: boolean; append: boolean;
  onPick: (entry: PromptHistoryEntry) => void; onClose: () => void;
  onRestore?:(entry:PromptHistoryEntry,signal:AbortSignal)=>Promise<boolean>;
}) {
  const d = useDesk();
  const [busy,setBusy]=useState<string>(),[error,setError]=useState('');
  const flight=useRef<AbortController|undefined>(undefined);
  useEffect(()=>{if(!visible){flight.current?.abort();flight.current=undefined;setBusy(undefined);setError('');}return()=>{flight.current?.abort();};},[visible]);
  const restore=async(entry:PromptHistoryEntry)=>{
    if(flight.current||disabled||!visible||!onRestore)return;
    const controller=new AbortController();flight.current=controller;setBusy(entry.id);setError('');
    try{if(!await onRestore(entry,controller.signal)&&!controller.signal.aborted)setError('当前草稿或来源已变化，原内容仍保留，请重试');}
    catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'原内容未能完整恢复，当前草稿未改变');}
    finally{if(flight.current===controller){flight.current=undefined;setBusy(undefined);}}
  };
  return <Sheet visible={visible} title="最近输入" subtitle="当前会话 · 恢复后由你发送" onClose={onClose}>
    <View style={{ paddingHorizontal: 18, paddingBottom: 10, gap: 10 }}>
      <Text style={{ fontFamily: conversationFontFamily, fontSize: 11, lineHeight: 17, color: d.muted }}>{onRestore?'文字、图片、技能与引用一起恢复':'只复用文字'}，{append ? '追加到当前草稿' : '放入输入框'}。</Text>
      {error?<Text accessibilityRole="alert" style={{fontSize:12,lineHeight:18,color:d.warn}}>{error}</Text>:null}
      <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{gap:6}} keyboardShouldPersistTaps="handled">
        {entries.length ? entries.map(entry => {
          const value = splitPastedText(entry.text);
          return <MotionPressable key={entry.id} scaleTo={0.99} accessibilityRole="button" accessibilityLabel={`复用输入 ${entry.id}`} accessibilityState={{disabled:disabled||Boolean(busy),busy:busy===entry.id}} disabled={disabled||Boolean(busy)}
            onPress={() => onRestore&&entry.message?void restore(entry):onPick(entry)} style={({pressed})=>({ padding: 12, gap: 10, flexDirection:'row',alignItems:'center',borderRadius:12,backgroundColor:pressed?d.surface3:d.surface2,opacity:disabled||Boolean(busy&&busy!==entry.id) ? 0.5 : 1 })}>
            <View style={{flex:1,minWidth:0,gap:4}}>
              <Text numberOfLines={3} style={{ fontFamily: conversationFontFamily, fontSize: 12, lineHeight: 19, color: d.text }}>{value.prompt || value.attachments.map(item => item.name).join('、')||'图片或引用消息'}</Text>
              {busy===entry.id?<Text style={{fontFamily:conversationFontFamily,fontSize:11,color:d.muted}}>正在完整恢复…</Text>:entry.hasImages ? <Text style={{ fontFamily: conversationFontFamily, fontSize: 11, color: d.muted }}>{onRestore?'含原图片':'原消息含图片，需要重新添加'}</Text> : null}
            </View>
            <Icon name="undo" size={14} color={d.muted}/>
          </MotionPressable>;
        }) : <Text style={{ fontFamily: conversationFontFamily, padding: 14, borderRadius:12,backgroundColor:d.surface2,fontSize:12,lineHeight:19,color:d.muted }}>当前对话还没有可复用的输入</Text>}
      </ScrollView>
    </View>
  </Sheet>;
}
