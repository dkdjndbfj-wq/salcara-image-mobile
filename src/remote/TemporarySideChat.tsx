import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { MessageContent } from '../components/MessageContent';
import { useDesk } from '../theme';
import { pickRemoteImages } from './attachments';
import { handleSystemPermissionError } from '../system-permissions';
import { ContextReferenceChips } from './ContextReferenceChips';
import type { ContextReference } from './context-references';
import { reportedEfforts, reportsTextOnly } from './effort';
import { CompactActionMenu } from './CompactActionMenu';
import { ComposerOptionMenu } from './ComposerPopover';
import { ModelPopover } from './ModelPopover';
import { MainComposerModelButton, MainComposerPermission, MainEffortControl } from './MainComposer';
import { temporarySideChatSession, type TemporarySideChatTransport } from './temporary-side-chat';
import {TemporarySideToolStatus} from './TemporarySideToolStatus';
import {SlashCommandMenu} from './SlashCommandMenu';
import {applySlashCommand,buildSlashCommands,parseSlashQuery,type SlashCommandEntry} from './slash-commands';
import {skillKey} from './agent-features';
import {SkillReferenceLabel} from './SkillReferenceLabel';
import {PERMISSION_LABEL} from './permission-mode';
import {SkillComposerInput} from './SkillComposerInput';

export type { TemporarySideChatTransport } from './temporary-side-chat';
export interface TemporarySideChatProps {
  visible: boolean; scopeKey: string; sessionKey: string; transport?: TemporarySideChatTransport;
  unavailableReason?: string; selection?: ContextReference; selectionNonce?: number; onSelectionConsumed?: () => void;
}
/** One component for real connections and explicit demo transports. Tab identity
 * belongs in scopeKey. No transcript or draft survives an application restart. */
export function TemporarySideChat({ visible, scopeKey, sessionKey, transport, unavailableReason, selection, selectionNonce, onSelectionConsumed }: TemporarySideChatProps) {
  const d = useDesk(), session = useMemo(() => temporarySideChatSession(scopeKey, sessionKey), [scopeKey, sessionKey]);
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const [menu, setMenu] = useState<'attachment' | 'permission' | 'model' | 'effort' | null>(null);
  const [caret,setCaret]=useState<number>(),[rangeEnd,setRangeEnd]=useState<number>(),[inputSelection,setInputSelection]=useState<{start:number;end:number}>(),[slashDismissed,setSlashDismissed]=useState(''),[slashFocus,setSlashFocus]=useState(0);
  const input=useRef<TextInput>(null);
  const modelAnchor=useRef<View>(null),permissionAnchor=useRef<View>(null),attachmentAnchor=useRef<View>(null);
  const current = useRef({ session, transport, visible, epoch: 0 });
  current.current = { session, transport, visible, epoch: current.current.epoch + (current.current.session === session && current.current.transport === transport ? 0 : 1) };
  const epoch = current.current.epoch;
  const [modelOwner, setModelOwner] = useState<{ epoch: number; token: object }>(), [imageOwner, setImageOwner] = useState<{ epoch: number; token: object }>();
  const modelRequest = useRef<{ epoch: number; token: object } | null>(null);
  const modelsBusy = modelOwner?.epoch === epoch, picking = imageOwner?.epoch === epoch;
  const mounted = useRef(true), scroll = useRef<ScrollView>(null), following = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setMenu(null);setCaret(undefined);setRangeEnd(undefined);setInputSelection(undefined);setSlashDismissed(''); }, [scopeKey, sessionKey]);
  useEffect(()=>{setMenu(null);},[transport,visible]);
  useEffect(() => { if (visible && transport && state.phase === 'idle') void session.read(transport); }, [visible, session, transport, state.phase]);
  useEffect(()=>{session.observeTools(visible?transport:undefined);return()=>session.observeTools(undefined);},[session,transport,visible]);
  useEffect(() => {
    if (!visible || !selection) return;
    session.select(selection, selectionNonce); onSelectionConsumed?.();
  }, [visible, session, selection, selectionNonce]);
  const inputOptions = state.reading?.value.inputOptions, model = state.model || inputOptions?.defaultModel || '';
  const levels = inputOptions?.effort ? reportedEfforts(state.models?.modelCapabilities?.[model]) : [];
  const effortForModel=(next:string)=>{const latest=session.snapshot(),options=latest.reading?.value.inputOptions;return next===(latest.model||options?.defaultModel||'')||!latest.effort||options?.effort&&reportedEfforts(latest.models?.modelCapabilities?.[next]).includes(latest.effort)?latest.effort:'';};
  const connected = transport?.isCurrent() === true, busy = state.phase === 'loading' || state.phase === 'sending' || picking || state.toolBusy===true || state.featuresLoading===true;
  const toolsMode=state.permission==='workspace-write',toolsAvailable=Boolean(inputOptions?.tools&&transport?.tools);
  const toolFeaturesAvailable=Boolean(toolsAvailable&&inputOptions?.tools?.features);
  const inputCaret=caret??state.draft.length,slashKey=JSON.stringify([epoch,state.draft,inputCaret,state.permission]);
  const slash=visible&&state.phase==='ready'&&slashDismissed!==slashKey&&(rangeEnd===undefined||rangeEnd===inputCaret)?parseSlashQuery(state.draft,inputCaret):undefined;
  const slashEntries=useMemo(()=>{
    if(!slash)return [];
    const entries=toolsMode?buildSlashCommands(state.features,slash,state.collaborationMode):[];
    const term=slash.query.trim().toLowerCase();
    const actions:SlashCommandEntry[]=[
      ...(!toolsMode&&toolFeaturesAvailable?[{id:'enable-plan',kind:'action' as const,label:'计划模式',command:'/plan',description:'选择执行权限后开启'},{id:'enable-skills',kind:'action' as const,label:'技能',command:'/skills',description:'选择执行权限后浏览技能'}]:[]),
      ...(inputOptions?.model?[{id:'model',kind:'action' as const,label:'模型',command:'/model',description:'选择模型'}]:[]),
      ...(inputOptions?.effort?[{id:'effort',kind:'action' as const,label:'推理强度',command:'/reasoning',description:'选择推理强度'}]:[]),
      {id:'permission',kind:'action',label:'权限',command:'/permissions',description:'选择操作的批准方式'},
    ];
    return [...entries.filter(entry=>entry.kind!=='skill'),...actions.filter(entry=>slash.skillsOnly?entry.id==='enable-skills':`${entry.command} ${entry.label}`.toLowerCase().includes(term)),...entries.filter(entry=>entry.kind==='skill')];
  },[slash?.source,slash?.replaceEnd,toolsMode,toolFeaturesAvailable,state.features,state.collaborationMode,inputOptions?.model,inputOptions?.effort]);
  useEffect(()=>{setSlashFocus(0);},[slash?.source,slash?.replaceEnd,state.features]);
  useEffect(()=>{if(slash&&toolsMode&&toolFeaturesAvailable&&!state.features&&!state.featuresLoading&&!state.featuresError&&transport)void session.loadToolFeatures(transport);},[Boolean(slash),toolsMode,toolFeaturesAvailable,session,transport,state.features,state.featuresLoading,state.featuresError]);
  const imagesEnabled = Boolean(!toolsMode&&inputOptions?.images && transport?.uploadImages && !reportsTextOnly(state.models?.modelCapabilities?.[model]));
  const canSend = connected && state.phase === 'ready' && Boolean(state.draft.trim()) && !busy;
  const scopeCurrent = () => mounted.current && current.current.epoch === epoch && current.current.session === session && current.current.transport === transport && transport?.isCurrent() === true;
  const loadModels = async (refresh = false) => {
    if (!transport?.models || !inputOptions?.model || !current.current.visible || !scopeCurrent()
      || modelRequest.current?.epoch === epoch || (!refresh && session.snapshot().models)) return;
    // Reuse this API's catalog and synchronously guard taps before React renders.
    const owner = { epoch, token: {} }; modelRequest.current = owner; setModelOwner(owner);
    try { const models = await transport.models(refresh); if (scopeCurrent()) session.update({ models, error: '' }); }
    catch (reason) { if (scopeCurrent()) session.update({ error: reason instanceof Error ? reason.message : '模型读取失败' }); }
    finally {
      if (modelRequest.current?.token === owner.token) modelRequest.current = null;
      if (mounted.current) setModelOwner(previous => previous?.token === owner.token ? undefined : previous);
    }
  };
  useEffect(()=>{if(visible&&state.phase==='ready'&&inputOptions?.model&&!state.models)void loadModels();},[visible,transport,session,state.phase,inputOptions?.model]);
  const openMenu = (value: typeof menu) => { if(!current.current.visible||!scopeCurrent())return;setMenu(value); if (value === 'model' || value === 'effort') void loadModels(); };
  const selectSlash=(entry:SlashCommandEntry)=>{
    const latest=session.snapshot();
    if(!slash||!current.current.visible||!scopeCurrent()||busy||state.featuresError&&toolsMode||!slashEntries.some(item=>item.id===entry.id)||latest.draft!==slash.source
      ||latest.permission!==state.permission||toolsMode&&(latest.featuresLoading||latest.featuresError||latest.features!==state.features))return;
    if(entry.id==='enable-plan'||entry.id==='enable-skills'){openMenu('permission');return;}
    const next=applySlashCommand(state.draft,slash,entry),position=slash.replaceStart+(entry.kind==='skills'?'/skills '.length:0);
    if(entry.kind==='skill'&&entry.skill){const skills=state.skills??[];if(skills.length>=8&&!skills.some(skill=>skillKey(skill)===skillKey(entry.skill!)))return;
      session.update({skills:skills.some(skill=>skillKey(skill)===skillKey(entry.skill!))?skills:[...skills,{...entry.skill}],draft:next});}
    else session.update({draft:next,...(entry.kind==='mode'&&entry.mode?{collaborationMode:entry.mode}:{})});
    setCaret(position);setRangeEnd(position);setInputSelection({start:position,end:position});
    if(entry.kind!=='skills')setSlashDismissed(JSON.stringify([epoch,next,position,state.permission]));
    if(entry.kind==='action')openMenu(entry.id==='model'?'model':entry.id==='effort'?'effort':'permission');
    else input.current?.focus();
  };
  const pick = async (source: 'gallery' | 'camera') => {
    setMenu(null); if (!imagesEnabled || !connected || busy) return;
    const token = {}; setImageOwner({ epoch, token });
    try {
      const images = await pickRemoteImages(source, 4 - state.images.length);
      if (scopeCurrent()) { const previous = session.snapshot().images; session.update({ images: [...previous, ...images].slice(0, 4), error: '' }); }
    } catch (reason) { if (scopeCurrent() && !handleSystemPermissionError(reason)) session.update({ error: reason instanceof Error ? reason.message : '图片选择失败' }); }
    finally { if (mounted.current) setImageOwner(owner => owner?.token === token ? undefined : owner); }
  };
  const beginNew = async () => {
    if(!mounted.current||current.current.epoch!==epoch||!transport)return;
    if(toolsMode&&session.hasToolExecution()&&!await session.controlTools('close'))return;
    if(mounted.current&&current.current.epoch===epoch&&session.restart())void session.read(transport);
  };
  const changePermission=async(value:'read-only'|'workspace-write')=>{
    if(!transport||!scopeCurrent())return;
    if(value==='read-only'&&toolsMode&&!state.turns.length&&session.hasToolExecution()){
      if(!await session.controlTools('close')||!scopeCurrent()||!session.restart())return;
      await session.read(transport);
    }else session.setPermission(value,transport);
    if(scopeCurrent())setMenu(null);
  };
  const canStopTools=visible&&connected&&toolsMode&&Boolean(state.toolState?.turnId)&&['running','waiting_approval'].includes(state.toolState?.state??'')&&!state.toolBusy;
  const submit = () => { if(slash){const entry=slashEntries[Math.min(slashFocus,slashEntries.length-1)];if(entry)selectSlash(entry);return;}if (mounted.current && current.current.visible && current.current.epoch === epoch && current.current.session === session && transport && canSend) void session.send(transport); };
  const canChooseSlash=Boolean(slash&&slashEntries.length&&!busy&&!(toolsMode&&state.featuresError));
  const sourceUnavailable = !transport ? unavailableReason || '当前连接没有提供临时侧边聊天能力' : !connected ? '当前电脑连接不可用，恢复连接后可继续查看；不会自动发送' : '';
  return <View style={[styles.root, { backgroundColor: d.surface }]}>
    {state.turns.length ? <View style={styles.top}><Text style={[styles.caption, { color: d.muted }]}>临时聊天</Text><Pressable accessibilityRole="button" accessibilityLabel="开始新的临时聊天" disabled={busy} onPress={beginNew} style={styles.icon}><Icon name="compose" size={18} color={d.muted} accent={d.muted}/></Pressable></View> : null}
    <ScrollView ref={scroll} style={styles.scroll} contentContainerStyle={state.turns.length ? styles.transcript : styles.empty}
      keyboardShouldPersistTaps="handled" onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; following.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80; }} scrollEventThrottle={100}
      onContentSizeChange={() => { if (following.current) scroll.current?.scrollToEnd({ animated: false }); }}>
      {state.turns.length ? state.turns.map((turn, index) => <View key={turn.operationId} style={styles.turn}>
        <View style={[styles.question, { backgroundColor: d.surface2 }]}><Text selectable style={[styles.body, { color: d.text }]}>{turn.question}</Text>
          {turn.images.length ? <View style={styles.images}>{turn.images.map((image, imageIndex) => <Image key={imageIndex} source={{ uri: image.uri }} style={styles.thumbnail} accessibilityLabel={`问题图片 ${imageIndex + 1}`}/>)}</View> : null}</View>
        {turn.answer?<View accessibilityLabel={`临时聊天回答 ${index+1}`}><MessageContent text={turn.answer}/></View>:null}
        {turn.state==='sending'&&(!toolsMode||!state.toolState)?<View style={styles.loading}><ActivityIndicator size="small" color={d.muted}/><Text style={[styles.caption,{color:d.muted}]}>{toolsMode?'临时任务处理中':'正在思考'}</Text></View>:turn.state==='unconfirmed'?<Text style={[styles.caption,{color:d.muted}]}>这次回答未确认，未自动重发。</Text>:turn.state==='failed'||turn.state==='interrupted'?<Text style={[styles.caption,{color:d.muted}]}>{turn.state==='failed'?'临时执行失败':'临时执行已停止'}</Text>:null}
      </View>) : <View style={styles.emptyCopy}><Text style={[styles.title, { color: d.text }]}>侧边聊天</Text><Text style={[styles.description, { color: d.muted }]}>侧边聊天是临时聊天，关闭应用后会消失。</Text>
        {state.phase === 'loading' ? <ActivityIndicator size="small" color={d.muted}/> : null}</View>}
      {toolsMode&&(state.turns.length||state.toolState?.error||state.phase==='unconfirmed')?<TemporarySideToolStatus state={state.toolState} busy={state.toolBusy===true} connected={connected&&visible} onRefresh={()=>{if(current.current.visible)void session.refreshTools();}} onClose={()=>{if(current.current.visible)void session.controlTools('close');}} onApprove={(id,decision)=>{if(current.current.visible)void session.controlTools('approve',id,decision);}}/>:null}
    </ScrollView>
    <View style={styles.bottom}>
      {sourceUnavailable || state.error ? <Text accessibilityRole="alert" style={[styles.notice, { color: d.muted }]}>{sourceUnavailable || state.error}</Text> : null}
      {(state.phase === 'unconfirmed' || state.phase === 'unavailable' || state.phase === 'ready' && Boolean(state.error)) && connected ? <Pressable accessibilityRole="button" onPress={beginNew} style={styles.retry}><Text style={[styles.caption, { color: d.text }]}>开始新侧聊</Text></Pressable> : null}
      {slash?<SlashCommandMenu entries={slashEntries} selectedId={slashEntries[Math.min(slashFocus,slashEntries.length-1)]?.id} loading={state.featuresLoading} error={toolsMode?state.featuresError:undefined} disabled={!connected||busy&&!state.featuresLoading} onSelect={selectSlash} onClose={()=>setSlashDismissed(slashKey)} onReload={()=>{if(transport)void session.loadToolFeatures(transport);}}/>:null}
      <View style={[styles.composer, { borderColor: d.line, backgroundColor: d.surface }]}>
        {state.collaborationMode==='plan'||state.skills?.length?<View style={styles.images}>
          {state.collaborationMode==='plan'?<Pressable accessibilityRole="button" accessibilityLabel="关闭临时聊天计划模式" onPress={()=>session.update({collaborationMode:'default'})} style={[styles.chip,{backgroundColor:d.surface2}]}><Icon name="listCheck" size={14} color={d.text2} accent={d.text2}/><Text style={[styles.caption,{color:d.text2}]}>计划</Text><Icon name="close" size={14} color={d.muted} accent={d.muted}/></Pressable>:null}
          {state.skills?.map(skill=><Pressable key={skillKey(skill)} accessibilityRole="button" accessibilityLabel={`移除临时聊天技能 ${skill.name}`} onPress={()=>session.update({skills:session.snapshot().skills?.filter(value=>skillKey(value)!==skillKey(skill))})} style={[styles.chip,{backgroundColor:d.surface2}]}><SkillReferenceLabel skill={skill}/><Icon name="close" size={14} color={d.muted} accent={d.muted}/></Pressable>)}
        </View>:null}
        {state.selection ? <ContextReferenceChips references={[state.selection]} onRemove={() => session.update({ selection: undefined })}/> : null}
        {state.images.length ? <View style={styles.images}>{state.images.map((image, index) => <View key={`${image.uri}:${index}`}><Image source={{ uri: image.uri }} style={styles.thumbnail}/><Pressable accessibilityRole="button" accessibilityLabel={`移除临时聊天图片 ${index + 1}`} onPress={() => session.update({ images: session.snapshot().images.filter((_, i) => i !== index) })} style={styles.remove}><View style={[styles.removeFace,{backgroundColor:d.surface}]}><Icon name="close" size={18} color={d.text} accent={d.text}/></View></Pressable></View>)}</View> : null}
        <SkillComposerInput mentions={[]} ref={input} accessibilityLabel="临时侧边聊天输入" value={state.draft} selection={inputSelection} onChangeText={draft => {setCaret(undefined);setRangeEnd(undefined);setInputSelection(undefined);session.update({ draft });}} onSelectionChange={event=>{setCaret(event.nativeEvent.selection.start);setRangeEnd(event.nativeEvent.selection.end);setInputSelection(undefined);}} placeholder="询问任何问题" placeholderTextColor={d.muted} multiline maxLength={4000}
          style={[styles.input, { color: d.text }]} onKeyPress={event => { const native = event.nativeEvent as unknown as { key?: string; shiftKey?: boolean; isComposing?: boolean };if(Platform.OS!=='web'||native.isComposing)return;
            if(slash&&['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(native.key??'')&&!native.shiftKey){event.preventDefault();if(native.key==='Escape')setSlashDismissed(slashKey);else if(native.key==='ArrowDown'||native.key==='ArrowUp')setSlashFocus(value=>(value+(native.key==='ArrowDown'?1:-1)+slashEntries.length)%Math.max(1,slashEntries.length));else submit();return;}
            if(native.key==='Enter'&&!native.shiftKey&&canSend){event.preventDefault();submit();}}}/>
        <View style={styles.toolbar}>
          <Pressable ref={attachmentAnchor} collapsable={false} accessibilityRole="button" accessibilityLabel="临时聊天添加附件" disabled={busy} onPress={() => openMenu('attachment')} style={styles.icon}><Icon name="plus" size={18} color={d.text2} accent={d.text2}/></Pressable>
          <MainComposerPermission anchorRef={permissionAnchor} accessibilityLabel="临时聊天权限" label={toolsMode?PERMISSION_LABEL.ask:'只读'} onPress={()=>openMenu('permission')}/>
          <View style={{ flex: 1 }}/>
          <MainComposerModelButton anchorRef={modelAnchor} accessibilityLabel="临时聊天模型" label={model||'默认'} disabled={busy||!inputOptions?.model} onPress={()=>openMenu('model')}/>
          {inputOptions?.effort?<MainEffortControl accessibilityLabel="临时聊天推理强度" levels={['',...levels]} value={state.effort&&levels.includes(state.effort)?state.effort:''} scopeKey={`${scopeKey}|${sessionKey}|${epoch}|${model}`} disabled={busy||!connected||!visible}
            open={visible&&menu==='effort'} onClose={()=>setMenu(current=>current==='effort'?null:current)} onSelect={value=>{if(current.current.visible&&scopeCurrent()&&!busy&&(!value||levels.includes(value))){session.update({effort:value});setMenu(null);}}}/>:null}
          <Pressable accessibilityRole="button" accessibilityLabel={canStopTools?'停止临时执行':slash?'选择临时聊天命令':'发送临时聊天'} accessibilityState={{ disabled: !canStopTools&&!(slash?canChooseSlash:canSend) }} disabled={!canStopTools&&!(slash?canChooseSlash:canSend)} onPress={canStopTools?()=>{void session.controlTools('stop');}:submit} style={styles.send}>
            <View style={[styles.sendFace,{backgroundColor:canSend||canStopTools?d.ink:d.surface3}]}>{canStopTools?<Icon name="stop" size={18} color={d.onInk} accent={d.onInk}/>:state.phase === 'sending' ? <ActivityIndicator size="small" color={d.muted}/> : <Icon name="arrowUp" size={18} color={canSend ? d.onInk : d.faint} accent={canSend ? d.onInk : d.faint}/>}</View></Pressable>
        </View>
      </View>
    </View>
    <ComposerOptionMenu visible={visible&&menu==='permission'} anchorRef={permissionAnchor} scopeKey={`${scopeKey}|${sessionKey}|${epoch}`} accessibilityLabel="临时聊天权限选项" value={state.permission}
      options={[{value:'read-only',label:'只读'},...(toolsAvailable?[{value:'workspace-write',label:PERMISSION_LABEL.ask}]:[])]}
      onSelect={value=>{if(current.current.visible&&scopeCurrent()&&(value==='read-only'||value==='workspace-write'&&toolsAvailable))void changePermission(value);}} onClose={()=>setMenu(null)}/>
    <CompactActionMenu visible={visible&&menu==='attachment'} anchorRef={attachmentAnchor} scopeKey={`${scopeKey}|${sessionKey}|${epoch}`}
      label="添加附件" onClose={()=>setMenu(null)} actions={[
        {id:'gallery',label:'选择图片',icon:'image',disabled:!imagesEnabled||!connected||busy||state.images.length>=4,onPress:()=>void pick('gallery')},
        ...(Platform.OS!=='web'?[{id:'camera',label:'拍照',icon:'camera' as const,disabled:!imagesEnabled||!connected||busy||state.images.length>=4,onPress:()=>void pick('camera')}]:[]),
      ]}/>
    <ModelPopover visible={visible&&menu==='model'} anchor={null} anchorRef={modelAnchor} value={state.model} fallback={inputOptions?.defaultModel||''}
      models={inputOptions?.model?state.models?.models??[]:[]} loading={modelsBusy} error={state.error||undefined} scopeKey={`${scopeKey}|${sessionKey}|${epoch}`}
      catalogOnly catalogReady={Boolean(state.models)} selectionEnabled={inputOptions?.model===true} interactionBlocked={busy||!connected}
      onRefresh={()=>void loadModels(true)} onClose={()=>setMenu(null)}
      onFollowComputer={()=>{if(current.current.visible&&scopeCurrent()&&!busy){session.update({model:'',effort:effortForModel(inputOptions?.defaultModel||'')});setMenu(null);}}}
      onSelect={value=>{if(current.current.visible&&scopeCurrent()&&!busy&&inputOptions?.model&&session.snapshot().models?.models.includes(value)){session.update({model:value,effort:effortForModel(value)});setMenu(null);}}}/>
  </View>;
}
const styles = StyleSheet.create({
  chip:{flexDirection:'row',alignItems:'center',gap:5,paddingHorizontal:8,paddingVertical:5,borderRadius:7},
  root: { flex: 1, minHeight: 0 }, top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 18, paddingRight: 10, height: 44 }, scroll: { flex: 1 }, transcript: { padding: 18, gap: 22 }, empty: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 28 }, emptyCopy: { alignItems: 'center', gap: 12, maxWidth: 340 }, title: { fontSize: 19, fontWeight: '600' }, description: { fontSize: 13, lineHeight: 21, textAlign: 'center' }, turn: { gap: 16 }, body: { fontSize: 14, lineHeight: 22 }, question: { alignSelf: 'flex-end', maxWidth: '95%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16 }, loading: { flexDirection: 'row', alignItems: 'center', gap: 8 }, caption: { fontSize: 12, lineHeight: 18 }, bottom: { padding: 12, paddingTop: 8, gap: 8 }, notice: { paddingHorizontal: 4, fontSize: 11, lineHeight: 17 }, retry: { alignSelf: 'flex-start', padding: 6 }, composer: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 7 }, input: { minHeight: 52, maxHeight: 180, paddingHorizontal: 4, paddingTop: 4, paddingBottom: 6, fontSize: 15, lineHeight: 22, textAlignVertical: 'top' }, toolbar: { flexDirection: 'row', alignItems: 'center', gap: 5 }, icon: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, option: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 3, paddingVertical: 5, flexShrink: 1 }, send: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center', marginLeft: 2 }, sendFace: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' }, images: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, paddingTop: 8, paddingBottom: 6 }, thumbnail: { width: 58, height: 58, borderRadius: 8 }, remove: { position: 'absolute', top: 0, right: 0, width: 44, height: 44, alignItems: 'flex-end', justifyContent: 'flex-start' }, removeFace: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
