import React, { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';
import { RemoteDemoBrowser } from './RemoteDemoBrowser';
import { RemoteToolPreview, type RemoteToolPreviewTarget } from './RemoteToolPreview';
import { localServiceCanOpenOnPhone } from './remote-links';
import { RemoteComputerPreview } from './RemoteComputerPreview';
import { isComputerLoopbackURL } from './workspace-preview';
import type { TerminalSelection } from './workspace-terminal';
import { workspaceBrowserTarget } from './workspace-browser';
import {workspaceAddressTarget} from './workspace-address';
import {BrowserAnnotations} from './BrowserAnnotations';
import {ToolbarButton,ToolbarMenu,type ToolbarAction} from './WorkbenchToolbar';
import * as Clipboard from 'expo-clipboard';
import {PreviewLogPanel} from './PreviewLogPanel';
export { workspaceBrowserTarget } from './workspace-browser';

/** Mount one instance per tab. Draft, error, reload and history never cross tabs. */
export function RemoteBrowserPage({ target, onNavigate, onOpenNew, computer, active = true, initialHistory, onHistoryChange, initialScroll, onScrollChange, onCompose }: {
  onCompose?:(text:string)=>boolean|void;
  computer?: TerminalSelection; target?: RemoteToolPreviewTarget; active?: boolean; onNavigate: (target: RemoteToolPreviewTarget) => void;
  onOpenNew?: (target: RemoteToolPreviewTarget) => void;
  initialHistory?: { urls: string[]; index: number }; onHistoryChange?: (history: { urls: string[]; index: number }) => void;
  initialScroll?: { x: number; y: number }; onScrollChange?: (scroll: { x: number; y: number; url?:string }) => void;
}) {
  const dk = useDesk(), styles = useStyles();
  const [annotating,setAnnotating]=useState(false);
  const [wide,setWide]=useState(false),[menu,setMenu]=useState(false),menuAnchor=useRef<View>(null);
  const menuIdentity=JSON.stringify([active,target?.url,computer]);
  const menuOwner=useRef({identity:menuIdentity});
  if(menuOwner.current.identity!==menuIdentity)menuOwner.current={identity:menuIdentity};
  const owner=menuOwner.current;
  const currentMenu=()=>active&&menuOwner.current===owner;
  useEffect(()=>{setMenu(false);},[menuIdentity]);
  useEffect(()=>()=>{menuOwner.current={identity:''};},[]);
  const currentPage=useRef({active,url:target?.url,onCompose});currentPage.current={active,url:target?.url,onCompose};
  const appendAnnotation=onCompose?(text:string)=>{
    if(!currentPage.current.active||currentPage.current.url!==target?.url)return false;
    return currentPage.current.onCompose?.(text);
  }:undefined;
  const browserRoot=useRef<any>(null),addressInput=useRef<TextInput>(null);
  const [addressFocused,setAddressFocused]=useState(false);
  const [address, setAddress] = useState(target?.url ?? ''), [error, setError] = useState(''), [revision, refresh] = useState(0);
  // A page reporting its own navigation has already loaded that destination.
  // Keep the requested source separate so its address update does not reload it.
  const [sourceUrl, setSourceUrl] = useState(target?.url ?? '');
  const reportedUrl = useRef<string | null>(null);
  const [history, setHistory] = useState(() => initialHistory && Array.isArray(initialHistory.urls) && initialHistory.urls.length <= 100 && initialHistory.urls.every(url => Boolean(workspaceBrowserTarget(url))) && Number.isInteger(initialHistory.index) && initialHistory.index >= 0 && initialHistory.index < initialHistory.urls.length ? initialHistory : { urls: target ? [target.url] : [] as string[], index: target ? 0 : -1 });
  const historyChanged = useRef(onHistoryChange); historyChanged.current = onHistoryChange;
  useEffect(() => { historyChanged.current?.(history); }, [history]);
  const historyRef = useRef(history); historyRef.current = history;
  const remember = (url: string) => {
    if (historyRef.current.urls[historyRef.current.index] === url) return;
    const urls = [...historyRef.current.urls.slice(0, historyRef.current.index + 1), url].slice(-100);
    const next = { urls, index: urls.length - 1 };
    historyRef.current = next; setHistory(next);
  };
  useEffect(() => {
    setAddress(target?.url ?? ''); setError('');
    if (reportedUrl.current !== target?.url) setSourceUrl(target?.url ?? '');
    reportedUrl.current = null;
    if (target) remember(target.url);
  }, [target?.url]);
  const navigate = (value: string) => {
    const next = workspaceAddressTarget(value);
    if (!next) { setError('请输入完整的 HTTP 或 HTTPS 网址'); return; }
    reportedUrl.current = null; setSourceUrl(next.url);
    setAddress(next.url); setError('');setAddressFocused(false);setAnnotating(false); remember(next.url); onNavigate(next);
  };
  const move = (offset: number) => {
    const current = historyRef.current, index = current.index + offset;
    if (index < 0 || index >= current.urls.length) return;
    const next = workspaceBrowserTarget(current.urls[index]);
    if (!next) return;
    historyRef.current = { ...current, index }; setHistory(historyRef.current); setAddress(next.url); setError('');
    reportedUrl.current = null; setSourceUrl(next.url); onNavigate(next);
  };
  const browserActions=useRef({move,refresh:()=>{if(target){setSourceUrl(target.url);refresh(value=>value+1);}},copy:()=>{if(target)void Clipboard.setStringAsync(target.url);}});
  browserActions.current={move,refresh:()=>{if(target){setSourceUrl(target.url);refresh(value=>value+1);}},copy:()=>{if(target)void Clipboard.setStringAsync(target.url);}};
  useEffect(()=>{if(Platform.OS!=='web'||!active)return;const handle=(event:KeyboardEvent)=>{
    if(event.defaultPrevented||event.isComposing||!browserRoot.current?.contains?.(event.target))return;
    const command=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();let action:(()=>void)|undefined;
    if(command&&key==='l')action=()=>addressInput.current?.focus();
    else if(command&&key==='r')action=browserActions.current.refresh;
    else if(command&&event.shiftKey&&key==='c')action=browserActions.current.copy;
    else if(command&&event.shiftKey&&key==='.')action=()=>setAnnotating(value=>!value);
    else if((event.altKey||event.metaKey)&&key==='arrowleft')action=()=>browserActions.current.move(-1);
    else if((event.altKey||event.metaKey)&&key==='arrowright')action=()=>browserActions.current.move(1);
    if(action){event.preventDefault();event.stopPropagation();action();}
  };window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle);},[active]);
  const remotePreview = Boolean(computer && isComputerLoopbackURL(sourceUrl || target?.url || ''));
  const blockedLocal = target?.kind === 'local-service' && Platform.OS !== 'web' && !localServiceCanOpenOnPhone(target.url);
  const reload=()=>{if(!currentMenu()||!target)return;setError('');setSourceUrl(target.url);refresh(value=>value+1);};
  const menuActions:ToolbarAction[]=[
    ...(!wide?[{label:'前进',accessibilityLabel:'网页前进',icon:'chevronRight' as const,disabled:history.index>=history.urls.length-1,onPress:()=>{if(currentMenu())move(1);}},
      {label:'刷新',accessibilityLabel:'刷新网页',icon:'regenerate' as const,disabled:!target,onPress:reload}]:[]),
    ...(target?[
      {label:'复制地址',accessibilityLabel:'复制网页地址',icon:'copy' as const,onPress:()=>{if(currentMenu())void Clipboard.setStringAsync(target.url);}},
      ...(!annotating?[{label:'批注',accessibilityLabel:'批注网页',icon:'edit' as const,onPress:()=>{if(currentMenu())setAnnotating(true);}}]:[]),
      ...(!computer||!isComputerLoopbackURL(target.url)?[{label:'在系统浏览器打开',icon:'external' as const,onPress:()=>{if(!currentMenu())return;void Linking.openURL(target.url).catch(()=>{if(currentMenu())setError('系统浏览器未能打开此网址');});}}]:[]),
    ]:[]),
  ];
  return <View ref={browserRoot} testID="remote-browser-page" onLayout={event=>setWide(event.nativeEvent.layout.width>=680)} style={styles.root}>
    <View testID="browser-address-toolbar" style={styles.addressRow}>
      <ToolbarButton icon="chevronLeft" label="网页后退" disabled={!active||history.index<=0} onPress={()=>{if(currentMenu())move(-1);}}/>
      {wide?<ToolbarButton icon="chevronRight" label="网页前进" disabled={!active||history.index>=history.urls.length-1} onPress={()=>{if(currentMenu())move(1);}}/>:null}
      <TextInput ref={addressInput} accessibilityLabel="浏览器地址" value={address} onFocus={()=>setAddressFocused(true)} onBlur={()=>setTimeout(()=>setAddressFocused(false),180)} onChangeText={setAddress} onSubmitEditing={() => navigate(address)} placeholder="搜索或输入网址" placeholderTextColor={dk.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="go" style={styles.input} />
      {addressFocused||address!==(target?.url??'')?<ToolbarButton icon="arrowRight" label="打开网址" disabled={!active} onPress={()=>{if(currentMenu())navigate(address);}}/>:null}
      {wide&&target?<ToolbarButton icon="regenerate" label="刷新网页" disabled={!active} onPress={reload}/>:null}
      {target&&annotating?<ToolbarButton icon="check" label="退出网页批注" disabled={!active} selected onPress={()=>{if(currentMenu())setAnnotating(false);}}/>:null}
      <ToolbarButton icon="more" label="网页更多操作" disabled={!active} selected={menu} anchorRef={menuAnchor} onPress={()=>{if(currentMenu())setMenu(true);}}/>
    </View>
    <ToolbarMenu visible={menu&&active} anchorRef={menuAnchor} onClose={()=>setMenu(false)} label="网页操作" testID="browser-actions-menu" actions={menuActions}/>
    {addressFocused&&address.trim()?<View style={{paddingHorizontal:12}}>{Array.from(new Set(history.urls)).filter(url=>url.toLowerCase().includes(address.toLowerCase())).slice(-5).reverse().map(url=><Pressable key={url} accessibilityRole="button" accessibilityLabel={`打开历史网页 ${url}`} onPress={()=>navigate(url)} style={{paddingVertical:8}}><Text numberOfLines={1} style={styles.caption}>{url}</Text></Pressable>)}</View>:null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {remotePreview && computer && target ? <RemoteComputerPreview selection={computer} url={sourceUrl || target.url} active={active} revision={revision} initialScroll={initialScroll} onScrollChange={onScrollChange} annotating={annotating&&active} onAnnotationDone={()=>setAnnotating(false)} onCompose={appendAnnotation} onNavigate={url => {
      const next=workspaceBrowserTarget(url);if(!next || next.url===target.url)return;
      reportedUrl.current=next.url;setAddress(next.url);setError('');remember(next.url);onNavigate(next);
    }}/> : blockedLocal && target ? <RemoteToolPreview target={target} onBack={() => setAddress('')} /> : target ? <BrowserAnnotations url={target.url} enabled={annotating&&active} onDone={()=>setAnnotating(false)} onCompose={appendAnnotation}><View style={styles.web}>
      <RemoteDemoBrowser key={revision} uri={sourceUrl || target.url} onError={() => setError('网页未能加载，可重试或在系统浏览器打开')}
        onNavigate={url => {
          const next = workspaceBrowserTarget(url);
          if (!next || next.url === target.url) return;
          reportedUrl.current = next.url; setAddress(next.url); setError('');setAddressFocused(false);setAnnotating(false); remember(next.url); onNavigate(next);
        }}
        onOpenNew={url => { const next = workspaceBrowserTarget(url); if (next) onOpenNew?.(next); }} />
    </View></BrowserAnnotations> : <View testID="remote-tool-preview-empty" style={styles.empty}><Icon name="globe" size={28} color={dk.faint} /><Text style={styles.caption}>输入网址打开浏览器</Text></View>}
    {target&&!remotePreview?<PreviewLogPanel scopeKey={JSON.stringify([target.url,revision])} entries={[]} origin={target.url} supported={false} active={active} unavailableReason="此浏览器未开放控制台日志。电脑项目预览与交互预览可查看真实运行日志。"/>:null}
  </View>;
}

const useStyles = themed((_c, d) => StyleSheet.create({
  root: { flex: 1, minHeight: 0 }, addressRow: { minHeight:52,flexDirection: 'row', alignItems: 'center', paddingHorizontal:8,borderBottomWidth:StyleSheet.hairlineWidth,borderColor:d.line,gap:2 },
  input: { flex: 1, minWidth: 0, height: 44, color: d.text, fontSize: 13,paddingHorizontal:10,borderWidth:StyleSheet.hairlineWidth,borderColor:d.line,borderRadius:8,backgroundColor:d.surface2 },
  error: { color: d.bad, fontSize: 12, paddingHorizontal: 14, paddingBottom: 10 },
  caption: { color: d.muted, fontSize: 12 }, empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }, web: { flex: 1, minHeight: 0 },
}));
