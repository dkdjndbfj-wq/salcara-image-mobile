import React,{useEffect,useRef,useState} from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Icon, type IconName } from '../components/Icon';
import { PROMO } from '../promo';
import { themed, useDesk } from '../theme';
import type { RemoteFileTarget } from './RemoteFiles';
import type { RemoteToolPreviewTarget } from './RemoteToolPreview';
import type { FileEdit } from './blocks';
import { closeWorkspaceTab } from './wegent/workspace-tabs';
import { useWorkspaceTabScroll } from './useWorkspaceTabScroll';
import {useWorkspaceLayoutControls} from './WorkspaceLayoutContext';
import {workspaceAddressTarget} from './workspace-address';
import type {ConversationArtifactTarget} from './conversation-artifact-target';
import type { TerminalSelection } from './workspace-terminal';
import { WORKBENCH_CHROME } from './workbench-presentation';
import {ToolbarButton,ToolbarMenu,type ToolbarAction} from './WorkbenchToolbar';

export type WorkspacePageKind = 'terminal' | 'changes' | 'agents' | 'tools' | 'files' | 'preview' | 'diff' | 'side-chat' | 'side-history' | 'newtab' | 'git' | 'computer' | 'artifact' | 'project-preview';
export type WorkspacePage = { id: string; kind: WorkspacePageKind; title: string; file?: RemoteFileTarget; preview?: RemoteToolPreviewTarget; browserPageId?: string; browserScroll?:{x:number;y:number;url?:string}; browserHistory?: {urls: string[]; index: number}; restored?: boolean; diff?: FileEdit; changes?: FileEdit[]; artifact?:ConversationArtifactTarget; projectPreview?: {sourcePath:string;selection:TerminalSelection} };
export const WORKSPACE_PAGES: WorkspacePage[] = [
  { id: 'side-chat', kind: 'side-chat', title: '侧边聊天' },
  { id: 'newtab', kind: 'newtab', title: '新标签页' },
  { id: 'agents', kind: 'agents', title: '子智能体' },
  { id: 'changes', kind: 'changes', title: '变更' },
  { id: 'files', kind: 'files', title: '文件' },
  { id: 'terminal', kind: 'terminal', title: '终端' },
  { id: 'side-history', kind: 'side-history', title: '侧问历史' },
  { id: 'tools', kind: 'tools', title: '执行记录' },
  { id: 'preview', kind: 'preview', title: '浏览器' },
  { id: 'computer', kind: 'computer', title: '电脑操作' },
];
export const initialWorkspacePages = ():WorkspacePage[] => [{id:'newtab',kind:'newtab',title:'新标签页'}];
const icons: Record<WorkspacePageKind, IconName> = { 'project-preview':'code', artifact:'code', computer:'laptop', git:'code', terminal: 'terminal', changes: 'listCheck', agents: 'bot', tools: 'terminal', files: 'folder', preview: 'globe', diff: 'file', 'side-chat': 'chat', 'side-history':'history', newtab: 'globe' };
const labels: Partial<Record<WorkspacePageKind, string>> = { changes: '工具栏改动', agents: '工具栏子智能体', tools: '工具栏调用', files: '工具栏文件', preview: '工具栏预览' };
const primaryTools = [
  { kind: 'files', shortcut: 'Ctrl+P' },
  { kind: 'side-chat', shortcut: 'Ctrl+Alt+S' },
  { kind: 'terminal', shortcut: 'Ctrl+`' },
] as const;
const pageTitle = (page: WorkspacePage) => page.kind === 'files' && !page.file ? '打开文件'
  : page.kind === 'changes' && ['审查', '改动'].includes(page.title) ? '变更' : page.title;

/** Each page is independently closeable; closing the current page selects its neighbour. */
export function closeWorkspacePage(pages: WorkspacePage[], activeId: string, id: string) {
  const next = closeWorkspaceTab(pages, activeId, id, WORKSPACE_PAGES[1]);
  return { pages: next.tabs, activeId: next.activeTabId };
}

export function WorkspaceTabBar({ pages, activeId, onSelect, onClose, onAdd,onRestore,onCloseOthers,labelFor,closeLabelFor }: {
  pages: WorkspacePage[]; activeId: string; onSelect: (page: WorkspacePage) => void; onClose: (id: string) => void; onAdd: () => void;
  onRestore?:()=>void;onCloseOthers?:(id:string)=>void;labelFor?:(page:WorkspacePage)=>string;closeLabelFor?:(page:WorkspacePage)=>string;
}) {
  const dk = useDesk(), styles = useStyles();
  const layout=useWorkspaceLayoutControls();
  const [menu,setMenu]=useState<string|null>(null);
  const [wide,setWide]=useState(false);
  const [width,setWidth]=useState(320);
  const menuAnchor=useRef<View>(null);
  const phone=layout?.canSplit===false;
  useEffect(()=>{if(menu&&!pages.some(page=>page.id===menu))setMenu(null);},[pages,menu]);
  const scroll = useWorkspaceTabScroll(activeId);
  const menuPage=pages.find(page=>page.id===menu);
  const actions:ToolbarAction[]=[
    ...(menuPage?[{label:closeLabelFor?.(menuPage)??`关闭标签 ${menuPage.title}`,icon:'close' as const,onPress:()=>onClose(menuPage.id)}]:[]),
    ...(onCloseOthers&&menuPage&&pages.length>1?[{label:'关闭其他标签',icon:'closeOthers' as const,onPress:()=>onCloseOthers(menuPage.id)}]:[]),
    ...(onRestore?[{label:'恢复关闭的标签',icon:'history' as const,onPress:onRestore}]:[]),
    ...(layout&&layout.canSplit!==false?[{label:layout.view==='full'?'返回分屏':'全页查看',icon:layout.view==='full'?'minimize' as const:'maximize' as const,onPress:()=>layout.setView(layout.view==='full'?'split':'full')}]:[]),
  ];
  return <View onLayout={event=>{setWidth(event.nativeEvent.layout.width);setWide(event.nativeEvent.layout.width>=600);}}><View style={[styles.bar,wide&&styles.wideBar]}>
    {phone?<ToolbarButton icon="arrowLeft" label="返回聊天" onPress={()=>layout.setView('hidden')}/>:null}
    <ScrollView ref={scroll.ref} onLayout={scroll.onLayout} onContentSizeChange={scroll.onContentSizeChange} onScroll={scroll.onScroll} scrollEventThrottle={16} horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabContent} accessibilityRole="tablist">
      {pages.map(page => <View key={page.id} onLayout={event=>scroll.tabLayout(page.id,event)} style={[styles.tab,{maxWidth:Math.max(120,Math.min(260,width-(layout?154:108)))},activeId === page.id && styles.selected]}>
        <Pressable accessibilityRole="tab" accessibilityLabel={labelFor?.(page) ?? (page.file || page.diff ? `工具栏文件 ${page.title}` : page.preview ? `网页 ${page.title}` : labels[page.kind] ?? page.title)} accessibilityHint={page.file?.path??page.diff?.path??page.preview?.url}
          accessibilityState={{ selected: activeId === page.id }} onLongPress={()=>setMenu(page.id)} onPress={() => {setMenu(null);onSelect(page);}} style={styles.select}>
          <Icon name={page.kind==='files'?'file':icons[page.kind]} size={17} color={dk.muted} /><Text numberOfLines={1} style={[styles.title,wide&&styles.wideTitle]}>{pageTitle(page)}{(page.file||page.diff)&&pages.some(other=>other.id!==page.id&&other.title===page.title&&(other.file?.path??other.diff?.path)!==(page.file?.path??page.diff?.path))?<Text style={{color:dk.muted}}> · {(page.file?.path??page.diff?.path??'').split(/[\\/]/).slice(0,-1).join('/')||'/'}</Text>:null}</Text>
        </Pressable>
        <ToolbarButton icon="close" label={closeLabelFor?.(page)??`关闭标签 ${page.title}`} onPress={() => {setMenu(null);onClose(page.id);}}/>
      </View>)}
    </ScrollView>
    <ToolbarButton icon="plus" label="添加工具标签" onPress={()=>{setMenu(null);onAdd();}}/>
    <ToolbarButton icon="more" label="标签页更多" selected={Boolean(menu)} anchorRef={menuAnchor} onPress={()=>setMenu(value=>value?null:activeId)}/>
    {layout&&!phone?<ToolbarButton icon="panelRight" label="隐藏右侧面板" onPress={()=>layout.setView('hidden')}/>:null}
  </View><ToolbarMenu visible={Boolean(menu)} anchorRef={menuAnchor} onClose={()=>setMenu(null)} actions={actions} label="标签菜单" testID="workspace-tab-menu"/></View>;
}

export function WorkspaceNewPage({ onOpen,historyAvailable=false }: { onOpen: (page: WorkspacePage) => void;historyAvailable?:boolean }) {
  const dk = useDesk(), styles = useStyles();
  const phone=useWindowDimensions().width<1000;
  const [address,setAddress]=useState('');
  const [moreOpen,setMoreOpen]=useState(false);
  const [wide,setWide]=useState(false);
  const menuAnchor=useRef<View>(null);
  const openPage=(page:WorkspacePage)=>{setMoreOpen(false);onOpen(page);};
  const navigate=(value=address)=>{const target=workspaceAddressTarget(value);if(target)openPage({id:'browser',kind:'preview',title:new URL(target.url).hostname,preview:target});};
  const extraTools=WORKSPACE_PAGES.filter(page=>page.kind!=='newtab'&&!primaryTools.some(tool=>tool.kind===page.kind)&&(historyAvailable||page.kind!=='side-history'));
  return <View testID="remote-new-tab" onLayout={event=>setWide(event.nativeEvent.layout.width>=600)} style={styles.newPage}>
    <View testID="new-tab-browser-toolbar" style={[styles.browserToolbar,phone&&styles.phoneBrowserToolbar]}>
      <View style={[styles.address,phone&&styles.phoneAddress]}>
        <TextInput accessibilityLabel="新标签页地址或搜索" value={address} onChangeText={setAddress} onSubmitEditing={()=>navigate()} placeholder="搜索或输入网址" placeholderTextColor={dk.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="go" style={styles.addressInput}/>
        {address.trim()?<ToolbarButton icon="arrowRight" label="打开地址或搜索" onPress={()=>navigate()}/>:null}
      </View>
      <ToolbarButton icon="more" label="新标签页更多" selected={moreOpen} anchorRef={menuAnchor} onPress={()=>setMoreOpen(open=>!open)}/>
    </View>
    <ScrollView style={styles.newPageScroll} contentContainerStyle={[styles.newPageContent,wide&&styles.widePageContent]} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={[styles.heading,wide&&styles.wideHeading]}>工具</Text>
      <View style={styles.primaryTools}>
        {primaryTools.map(tool=>{
          const page=WORKSPACE_PAGES.find(item=>item.kind===tool.kind)!;
          return <Pressable key={page.id} accessibilityRole="button" accessibilityLabel={`打开${page.title}标签`} onPress={()=>openPage(page)} style={[styles.toolCard,wide&&styles.wideToolCard]}>
            <Icon name={icons[page.kind]} size={18} color={dk.muted}/><Text style={[styles.toolTitle,wide&&styles.wideToolText]}>{page.title}</Text>{!phone?<Text style={[styles.shortcut,wide&&styles.wideShortcut]}>{tool.shortcut}</Text>:null}
          </Pressable>;
        })}
      </View>
      <Text accessibilityRole="header" style={[styles.heading,styles.recommendationHeading,wide&&styles.wideHeading,wide&&styles.wideRecommendationHeading]}>推荐</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="打开 Salcara AI 官网" accessibilityHint={PROMO.url} onPress={()=>navigate(PROMO.url)} style={[styles.recommendationCard,wide&&styles.wideRecommendationCard]}>
        <Image source={require('../../assets/brand-logo.png')} style={[styles.brandLogo,wide&&styles.wideBrandLogo]} resizeMode="contain" accessible={false}/>
        <Text style={[styles.brandTitle,wide&&styles.wideToolText]}>Salcara AI</Text>
      </Pressable>
    </ScrollView>
    <ToolbarMenu visible={moreOpen} anchorRef={menuAnchor} onClose={()=>setMoreOpen(false)} actions={extraTools.map(page=>({label:page.title,accessibilityLabel:`打开${page.title}标签`,icon:icons[page.kind],onPress:()=>openPage(page)}))} label="新标签页更多" testID="workspace-new-page-menu"/>
  </View>;
}

const useStyles = themed((c, d, scheme) => StyleSheet.create({
  bar: { flexDirection: 'row', height: 52, alignItems:'center',paddingHorizontal:8,gap:2,borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line, backgroundColor: d.surface },
  wideBar:{height:52},wideTitle:{fontSize:WORKBENCH_CHROME.wideTab},
  tabs: { flex: 1,minWidth:0 }, tabContent: { alignItems: 'center',gap:5 }, tab: { flexDirection: 'row', alignItems: 'center',borderRadius:8,maxWidth:260 },
  selected: { backgroundColor: d.surface2 }, select: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 11, paddingRight: 6, height: 44,flexShrink:1,minWidth:0 },
  title: { color: d.text2, fontSize: WORKBENCH_CHROME.tab, maxWidth: 170,flexShrink:1 },
  newPage: { flex: 1, minHeight:0, backgroundColor:scheme==='light'?'#FAFAFA':c.surface }, newPageScroll:{flex:1}, newPageContent:{padding:24,paddingTop:40},
  heading: { color: d.text, fontSize: WORKBENCH_CHROME.tool, lineHeight:22, marginBottom:16,fontWeight:'500' },
  widePageContent:{padding:30,paddingTop:40},wideHeading:{fontSize:WORKBENCH_CHROME.tool,lineHeight:22,marginBottom:16},wideToolText:{fontSize:WORKBENCH_CHROME.tool},wideToolCard:{minHeight:48,paddingHorizontal:16,borderRadius:12},wideShortcut:{fontSize:WORKBENCH_CHROME.caption,lineHeight:18},
  primaryTools:{gap:6}, toolCard:{flexDirection:'row',alignItems:'center',gap:12,minHeight:48,paddingHorizontal:14,paddingVertical:10,borderRadius:11,backgroundColor:c.card},
  toolTitle:{flex:1,color:d.text,fontSize:WORKBENCH_CHROME.tool}, shortcut:{fontSize:WORKBENCH_CHROME.caption,lineHeight:18,color:d.muted,backgroundColor:c.surfaceStrong,borderRadius:10,paddingHorizontal:8,overflow:'hidden'},
  recommendationHeading:{marginTop:32}, recommendationCard:{minHeight:126,alignItems:'center',justifyContent:'center',gap:24,borderRadius:14,padding:20,backgroundColor:scheme==='light'?'#EDEEEE':c.surfaceStrong}, brandLogo:{width:40,height:40},brandTitle:{color:d.text,fontSize:WORKBENCH_CHROME.tool,fontWeight:'500'},
  wideRecommendationHeading:{marginTop:40},wideRecommendationCard:{minHeight:126,gap:24,borderRadius:18},wideBrandLogo:{width:40,height:40},
  browserToolbar:{height:52,flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:8,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:c.border,backgroundColor:c.background},
  phoneBrowserToolbar:{height:52},
  address:{flex:1,minWidth:0,height:44,flexDirection:'row',alignItems:'center',borderWidth:StyleSheet.hairlineWidth,borderColor:c.border,borderRadius:8,backgroundColor:scheme==='light'?'#F2F3F3':c.surfaceStrong},phoneAddress:{height:44},addressInput:{flex:1,minWidth:0,height:'100%',color:d.text,fontSize:13,paddingHorizontal:12,paddingVertical:0},
}));
