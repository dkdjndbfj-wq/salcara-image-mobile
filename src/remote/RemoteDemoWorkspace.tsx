import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardSafeView } from '../components/KeyboardSafeView';
import { useBackAction, type RegisterBackAction } from './useBackAction';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { Icon, type IconName } from '../components/Icon';
import { agentDisplayName } from './agent-catalog';
import { showToast, useReducedMotion } from '../components/ui';
import { buildBlocks, conversationBlocks, type FileEdit } from './blocks';
import { demoConversationTimeline, demoFileChanges, type DemoMessage as Message } from './demo-timeline';
import { BlockRow, ThreadUi } from './thread-rows';
import { quoteFor, turnStats } from './thread-stats';
import { resolveRemoteLink } from './remote-links';
import { DiffView } from './parts';
import { RemoteBrowserPage, workspaceBrowserTarget } from './RemoteBrowserPage';
import { browserPageTitle, matchingBrowserTab, useBrowserActivityEvents, type BrowserActivity } from './workspace-browser';
import { WegentActionMenu } from './WegentComposer';
import { MainComposerSurface, MainComposerToolbar, MainComposerPermission, MainComposerModelButton, MainComposerModelGroup, MainComposerAction, MainEffortControl } from './MainComposer';
import { ContextIndicator } from './ContextIndicator';
import { ComposerOptionMenu } from './ComposerPopover';
import { ModelPopover } from './ModelPopover';
import { isPermissionMode, PERMISSION_LABEL } from './permission-mode';
import type { ScrubLevel } from './EffortScrub';
import { closeWorkspaceTab } from './wegent/workspace-tabs';
import {useWorkspaceShortcuts} from './useWorkspaceShortcuts';
import {WorkspaceLayoutContext,type WorkspaceView} from './WorkspaceLayoutContext';
import {WorkspaceTabBar,WorkspaceNewPage,type WorkspacePage} from './WorkspaceTabs';
import {ToolbarButton} from './WorkbenchToolbar';
import {RemoteDemoReviewPage} from './RemoteDemoGitPage';
import {TemporarySideChat,type TemporarySideChatTransport} from './TemporarySideChat';
import {randomUUID} from 'expo-crypto';
import type {AgentId,ApprovalMode,PermissionMode,SessionInfo} from './client';
import {agentSessions,projectName,sessionWorkspaceMode} from './projection';
import {DemoProjectTree} from './DemoProjectTree';
import {SubagentList} from './SubagentList';
import {DemoWorkspaceFiles} from './DemoWorkspaceFiles';
import {ComputerUsePage} from './ComputerUsePage';
import {SlashCommandMenu} from './SlashCommandMenu';
import {applySlashCommand,buildSlashCommands,parseSlashQuery,type SlashCommandEntry} from './slash-commands';
import {composerSlashActions,initializationDraft} from './composer-slash-actions';
import {DEMO_AGENT_FEATURES} from './demo-agent-features';
import {skillKey,type SkillReference} from './agent-features';
import {SkillReferenceLabel} from './SkillReferenceLabel';
import {SkillComposerInput} from './SkillComposerInput';
import type {SideToolState} from './side-question-tools';

// Explicit local data with the same workspace tabs, review and side chat as real connections.
type PanelKind = 'side-chat' | 'newtab' | 'agents' | 'preview' | 'files' | 'terminal' | 'changes' | 'code' | 'browser' | 'diff' | 'git' | 'tools' | 'side-history' | 'computer';
type PanelTab = { id: string; kind: PanelKind; label: string; icon: IconName; file?: string; uri?: string; browserPageId?: string; browserHistory?:{urls:string[];index:number}; diff?: FileEdit };

const W = {
  bg: '#FFFFFF', surface: '#F7F7F8', surface2: '#F3F4F5', surface3: '#ECEDEF',
  text: '#1A1A1A', secondary: '#666666', muted: '#999999', border: '#E0E0E0',
  primary: '#14B8A6', primarySoft: 'rgba(20,184,166,0.10)', success: '#00A240',
  danger: '#DC2626', dangerSoft: 'rgba(220,38,38,0.08)', code: '#F7F7F8',
  codeText: '#272A2E',
};

const PINNED_PANELS: PanelTab[] = [
  { id: 'preview', kind: 'preview', label: '预览', icon: 'eye' },
  { id: 'files', kind: 'files', label: '文件', icon: 'file' },
  { id: 'terminal', kind: 'terminal', label: '终端', icon: 'terminal' },
  { id: 'changes', kind: 'changes', label: '审查', icon: 'listCheck' },
];
const ADD_OPTIONS: PanelTab[] = [
  { id: 'side-chat', kind: 'side-chat', label: '侧边聊天', icon: 'chat' },
  { id: 'newtab', kind: 'newtab', label: '新标签页', icon: 'plus' },
  { id: 'agents', kind: 'agents', label: '子智能体', icon: 'bot' },
  ...PINNED_PANELS,

];

const FILES: Record<string, string> = {
  'release/checklist.md': '- [x] 平板布局回归测试\n- [x] 远程会话检查\n- [ ] 发布说明与交接\n',
  'src/App.tsx': `import { LoginPage } from './auth/LoginPage';\n\nexport function App() {\n  return <LoginPage />;\n}`,
  'src/auth/LoginPage.tsx': `export function LoginPage() {\n  return (\n    <main className="auth-layout">\n      <section className="auth-form" aria-label="登录表单">\n        <h1>Welcome back</h1>\n        <LoginFields />\n      </section>\n    </main>\n  );\n}`,
  'src/auth/login.css': `.auth-layout {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);\n}\n\n@media (max-width: 760px) {\n  .auth-layout { grid-template-columns: 1fr; }\n}`,
  'src/components/LoginFields.tsx': `export function LoginFields() {\n  return (\n    <form>\n      <label>Email<input type="email" /></label>\n      <label>Password<input type="password" /></label>\n      <button>Continue</button>\n    </form>\n  );\n}`,
  'package.json': `{
  "scripts": {
    "dev": "vite",
    "test": "vitest run"
  }
}`,
};

const THREADS = [
  { id: 'responsive-login', title: '修复登录页平板布局', cwd: 'D:\\Projects\\salcara-web', status: 'idle' as const },
  { id: 'workbench-tabs', title: '整理工作区工具标签', cwd: 'D:\\Projects\\salcara-web', status: 'running' as const },
  { id: 'review-changes', title: '审查最近的代码变更', cwd: 'D:\\Projects\\remote-bridge', status: 'waiting_approval' as const },
  { id: 'sync-events', title: '补齐会话事件同步', cwd: 'D:\\Projects\\remote-bridge', status: 'idle' as const },
];

const WORK_THREADS = [
  { id: 'release-checklist', title: '准备平板发布检查清单', cwd: 'D:\\Work\\release-operations', status: 'idle' as const },
  { id: 'handoff-notes', title: '整理本周交接事项', cwd: 'D:\\Work\\product-planning', status: 'idle' as const },
  { id: 'qa-followup', title: '跟进测试反馈', cwd: 'D:\\Work\\release-operations', status: 'running' as const },
  { id: 'product-plan', title: '整理下一版产品计划', cwd: 'D:\\Work\\product-planning', status: 'waiting_approval' as const },
];

const START_MESSAGES = (id: string, workspaceMode: 'code' | 'work' = 'code'): Message[] => {
  const catalog = workspaceMode === 'work' ? WORK_THREADS : THREADS;
  const thread = catalog.find((item) => item.id === id) ?? catalog[0];
  const content = workspaceMode === 'work'
    ? id === 'handoff-notes' ? '把本周的开发进度整理成一份可以交接的任务清单。'
      : id === 'qa-followup' ? '跟进测试反馈，标记需要在下个版本处理的事项。'
        : '为平板版本准备发布前检查清单，并安排剩余任务。'
    : id === 'workbench-tabs'
      ? '把文件、终端和浏览器整理到独立工作区标签中。'
      : id === 'review-changes'
        ? '检查登录页布局改动，并确认窄屏下的表单显示正常。'
        : '检查登录页在平板上的布局，修复右侧表单溢出的问题。';
  return [
    { id: 1, role: 'user', text: content },
    {
      id: 2,
      role: 'assistant',
      text: workspaceMode === 'work' ? '我把这个 Work 任务拆成了可跟踪的步骤，并标记了已完成、进行中和待处理的交付项。' : '我检查了登录页组件和断点样式。固定的双栏宽度在窄视口下挤压了表单，应该让两列都能收缩，并在较窄宽度时切换为单列。',
      file: workspaceMode === 'work' ? 'release/checklist.md' : id === 'workbench-tabs' ? 'src/App.tsx' : 'src/auth/login.css',
      code: workspaceMode === 'work'
        ? '- [x] 平板布局回归测试\n- [x] 远程会话检查\n- [ ] 发布说明与交接\n'
        : '.auth-layout {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);\n}\n\n@media (max-width: 760px) {\n  .auth-layout { grid-template-columns: 1fr; }\n}',
    },
  ];
};

const normalizeUri = (value: string) => {
  const target = workspaceBrowserTarget(value);
  if (!target) throw new Error('请输入有效的 HTTP 或 HTTPS 链接');
  return target.url;
};

type DemoWorkspaceProps = {
  computerName?: string;
  agentName?: string;
  agentId?: AgentId;
  sessionKey?: string;
  projectPath?: string;
  sessions?: SessionInfo[];
  sessionTitle?: string;
  workspaceMode?: 'code' | 'work';
  onBack?: () => void;
  toolActivities?: BrowserActivity[];
  onMobileWorkspaceVisibilityChange?: (visible: boolean) => void;
  onRegisterBack?: RegisterBackAction;
};

export function RemoteDemoWorkspace(props: DemoWorkspaceProps = {}) {
  return <RemoteDemoWorkspaceContent key={JSON.stringify([props.computerName, props.agentId ?? props.agentName, props.workspaceMode, props.sessionKey ?? props.sessionTitle])} {...props} />;
}

function RemoteDemoWorkspaceContent({ computerName, agentName, agentId: providedAgentId, sessionKey, projectPath, sessions, sessionTitle, workspaceMode = 'code', onBack, toolActivities = [], onMobileWorkspaceVisibilityChange, onRegisterBack }: DemoWorkspaceProps) {
  const { width } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const sequence = useRef(0);
  const [createdThreads, setCreatedThreads] = useState<SessionInfo[]>([]);
  const threadSnapshots = useRef<Record<string, { messages: Message[]; draft: string }>>({});
  const tablet = width >= 1000;
  const panelWidth = tablet ? Math.min(430, Math.max(300, width * 0.37)) : width;
  const agentId = providedAgentId ?? (agentName?.toLowerCase().includes('claude') ? agentName.toLowerCase().includes('desktop') ? 'claude-desktop' : 'claude' : 'codex');
  const agentTool = agentId === 'claude-desktop' ? 'claude' : agentId;
  const displayAgentName = agentName ?? agentDisplayName(agentId);
  const extension = agentId === 'deepseek-harness' || agentId === 'hermes';
  const demoModels = agentId === 'deepseek-harness' ? ['deepseek-chat', 'deepseek-reasoner'] : agentId === 'hermes' ? ['示例模型'] : ['Claude Sonnet 4.5', 'GPT-5.2', 'Gemini 3 Pro'];
  const baseThreadCatalog = workspaceMode === 'work' ? WORK_THREADS : THREADS;
  const sourceThreads: SessionInfo[] = sessions === undefined
    ? baseThreadCatalog.map((thread,index) => ({sessionKey:thread.id, title:thread.title,cwd:thread.cwd,status:thread.status,tool:agentTool,client:agentName??'Codex App',workspaceMode,updatedAt:Date.now()-index*60_000,controllable:true}))
    : agentSessions(sessions,{id:agentId,tool:agentTool}).filter(thread=>sessionWorkspaceMode(thread)===workspaceMode&&!thread.parentSessionKey);
  const selectionMissing = sessions === undefined && Boolean((sessionKey || sessionTitle) && !sourceThreads.some(thread=>sessionKey ? thread.sessionKey===sessionKey : thread.title===sessionTitle));
  const selectedFallback: SessionInfo = {sessionKey:sessionKey??'selected-session',title:sessionTitle??'新建任务',cwd:projectPath??baseThreadCatalog[0].cwd,status:'idle',tool:agentTool,client:agentName??'Codex App',workspaceMode,updatedAt:Date.now(),controllable:true};
  const threadCatalog = [...createdThreads,...(selectionMissing?[selectedFallback]:[]),...sourceThreads];
  const initialThreadId = threadCatalog.find(thread=>sessionKey ? thread.sessionKey===sessionKey : thread.title===sessionTitle)?.sessionKey ?? threadCatalog[0]?.sessionKey ?? null;
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(tablet);
  const [panelFull,setPanelFull]=useState(false);
  const [closedTabs,setClosedTabs]=useState<PanelTab[]>([]);
  const [tabs, setTabs] = useState<PanelTab[]>([{id:'newtab',kind:'newtab',label:'新标签页',icon:'plus'}]);
  const [activeTab, setActiveTab] = useState('newtab');
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const [demoBrowserActivities, setDemoBrowserActivities] = useState<BrowserActivity[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreadId);
  const canChooseModel = agentId !== 'hermes' || activeThreadId === null;
  const [messages, setMessages] = useState<Message[]>(() => START_MESSAGES(initialThreadId??'', workspaceMode));
  const [draft, setDraft] = useState('');
  const [caret,setCaret]=useState<number>(),[forcedSelection,setForcedSelection]=useState<{start:number;end:number}>(),[slashDismissed,setSlashDismissed]=useState(''),[slashFocus,setSlashFocus]=useState(0),[skills,setSkills]=useState<SkillReference[]>([]);
  const composerInput=useRef<TextInput>(null);
  const modelAnchor=useRef<View>(null),permissionAnchor=useRef<View>(null);
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState('');
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const demoAgentTime = useRef(Date.now()).current;
  const [mode, setMode] = useState<'Code' | 'Plan'>('Code');
  const slashKey=JSON.stringify([activeThreadId,draft,caret??draft.length]);
  const slash=agentTool==='codex'&&slashDismissed!==slashKey?parseSlashQuery(draft,caret??draft.length):undefined;
  const slashActions=composerSlashActions({model:true,reasoning:true,permissions:true,newChat:true,sideChat:true,initialize:true});
  const slashEntries=useMemo(()=>slash?buildSlashCommands(DEMO_AGENT_FEATURES,slash,mode==='Plan'?'plan':'default',false,slashActions):[],[slash?.source,slash?.replaceEnd,mode]);
  useEffect(()=>{setSlashFocus(0);},[slashKey]);
  useEffect(()=>{setSkills([]);setMode('Code');setCaret(undefined);setForcedSelection(undefined);setSlashDismissed('');setComposerMenu(null);},[activeThreadId]);
  const chooseSlash=(entry:SlashCommandEntry)=>{
    if(!slash||!slashEntries.some(item=>item.id===entry.id))return;
    if(entry.kind==='action'){
      const edit=entry.action==='init'?initializationDraft(draft,slash):{text:applySlashCommand(draft,slash,entry),caret:slash.replaceStart};
      setDraft(edit.text);setCaret(edit.caret);setForcedSelection({start:edit.caret,end:edit.caret});
      if(entry.action==='model')setComposerMenu('model');
      else if(entry.action==='reasoning')setComposerMenu('effort');
      else if(entry.action==='permissions')setComposerMenu('permission');
      else if(entry.action==='new')startNewThread(undefined,edit.text);
      else if(entry.action==='side')addPanel(ADD_OPTIONS[0]);
      else if(entry.action==='init')composerInput.current?.focus();
      return;
    }
    if(entry.kind==='skill'&&entry.skill){if(skills.length>=8&&!skills.some(value=>skillKey(value)===skillKey(entry.skill!)))return;setSkills(current=>[...current.filter(value=>skillKey(value)!==skillKey(entry.skill!)),entry.skill!]);}
    if(entry.kind==='mode')setMode(entry.mode==='plan'?'Plan':'Code');
    const text=applySlashCommand(draft,slash,entry),position=slash.replaceStart+(entry.kind==='skills'?'/skills '.length:0);
    setDraft(text);setCaret(position);setForcedSelection({start:position,end:position});composerInput.current?.focus();
  };
  const [model, setModel] = useState(agentId === 'codex' ? 'GPT-5.2' : extension ? demoModels[0] : 'Claude Sonnet 4.5');
  const [effort, setEffort] = useState<ScrubLevel>('high');
  const [composerMenu, setComposerMenu] = useState<'model'|'permission'|'effort'|null>(null);
  const [permission, setPermission] = useState<PermissionMode|ApprovalMode>('ask');
  const permissionLabel=(value:PermissionMode|ApprovalMode)=>isPermissionMode(value)?PERMISSION_LABEL[value]:value==='auto_edits'?'自动批准编辑':'全部自动';
  const permissionOptions:Array<PermissionMode|ApprovalMode>=agentTool==='codex'?['ask','auto_review','full_access']:['ask','auto_edits','auto_all'];
  const [attachments, setAttachments] = useState<string[]>([]);
  const initialTerminalLines = [
    '$ npm run dev',
    'VITE v6.2.0 ready in 318 ms',
    '➜ Local: http://localhost:5173/',
    '$ npm run test -- Login',
    '✓ Login layout test passed',
    '1 test passed · 42 ms',
  ];
  const [terminals,setTerminals]=useState<Record<string,{draft:string;lines:string[]}>>({});
  const terminalDraft=terminals[activeTab]?.draft??'',terminalLines=terminals[activeTab]?.lines??initialTerminalLines;
  const setTerminalDraft=(value:string)=>setTerminals(current=>({...current,[activeTab]:{draft:value,lines:current[activeTab]?.lines??initialTerminalLines}}));
  const setTerminalLines=(value:string[]|((lines:string[])=>string[]))=>setTerminals(current=>({...current,[activeTab]:{draft:current[activeTab]?.draft??'',lines:typeof value==='function'?value(current[activeTab]?.lines??initialTerminalLines):value}}));
  const panelMotion = useRef(new Animated.Value(1)).current;
  const activePanel = tabs.find((tab) => tab.id === activeTab) ?? null;
  const activeThread = threadCatalog.find((thread) => thread.sessionKey === activeThreadId);
  const displaySessionTitle = activeThread?.title ?? '新建任务';
  const contextLabel = activeThread?.cwd ? projectName(activeThread.cwd) : '临时任务';
  const demoTool = agentTool === 'codex' ? 'codex' : 'claude';
  const demoScope = activeThreadId ?? 'new';
  const demoSideChat=useMemo<TemporarySideChatTransport>(()=>{let toolState:SideToolState|undefined;return {isCurrent:()=>true,
    read:async()=>({scope:`demo:${demoScope}`,value:{sessionKey:`demo:${demoScope}`,revision:'demo-1',available:true,contextScope:'loadedSnapshot',contextMessages:2,contextTruncated:false,inputOptions:{version:1,model:true,effort:true,images:true,readOnly:true,defaultModel:'示例模型',...(demoTool==='codex'?{tools:{version:1 as const,permissions:['workspace-write'] as ['workspace-write'],features:true as const}}:{})}}}),
    models:async()=>({models:['示例模型'],modelCapabilities:{'示例模型':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['low','medium','high'],inputModalities:['text','image']}}}),
    uploadImages:async images=>images.map(()=>`att_${randomUUID().replace(/-/g,'')}`),
    ask:async(reading,input,operationId)=>({sessionKey:reading.value.sessionKey,operationId,state:'completed',answer:`示例回复 · ${input.question}。${input.attachments?.length?`已附加 ${input.attachments.length} 张示例图片。`:''}这条回复来自本地演示，没有调用真实模型。`,contextScope:'loadedSnapshot',contextMessages:2,contextTruncated:false}),
    ...(demoTool==='codex'?{tools:(async(reading,request)=>{
      toolState={sessionKey:reading.value.sessionKey,chainId:request.chainId,revision:request.expectedRevision,permission:'workspace-write',state:'idle',canSend:true,expiresAt:Date.now()+45000,answer:'',events:[],approvals:[],...toolState,sequence:(toolState?.sequence??0)+1};
      if(request.action==='features')toolState={...toolState,features:DEMO_AGENT_FEATURES};
      if(request.action==='send')toolState={...toolState,state:'completed',lastOperationId:request.operationId,answer:`本地示例 · ${request.collaborationMode==='plan'?'计划模式 · ':''}${request.skills?.length?`技能：${request.skills.map(skill=>skill.displayName||skill.name).join('、')} · `:''}${request.question}。这条回复来自本地演示，没有调用真实模型。`};
      if(request.action==='close')toolState={...toolState,state:'closed',canSend:false};
      return {...toolState};
    }) as NonNullable<TemporarySideChatTransport['tools']>}:{})
  };},[demoScope,demoTool]);
  const timeline = useMemo(() => demoConversationTimeline(messages, workspaceMode, demoTool, demoScope), [messages, workspaceMode, demoTool, demoScope]);
  const blocks = useMemo(() => conversationBlocks(buildBlocks(timeline, false), demoTool), [timeline, demoTool]);
  const messageStats = useMemo(() => turnStats(timeline), [timeline]);
  const demoChanges = useMemo(() => demoFileChanges(workspaceMode), [workspaceMode]);
  const seededBrowserActivities = useMemo(() => timeline.flatMap(item => item.kind === 'tool' && item.browser
    ? [{ id: item.id, status: item.status, browser: item.browser }] : []), [timeline]);

  useEffect(() => { onMobileWorkspaceVisibilityChange?.(!tablet && panelOpen); return () => onMobileWorkspaceVisibilityChange?.(false); }, [onMobileWorkspaceVisibilityChange,tablet,panelOpen]);
  useBackAction(() => {
    if (navigationOpen) { setNavigationOpen(false); return true; }
    if (panelOpen) {
      if (tablet && panelFull) setPanelFull(false);
      else { setPanelOpen(false); setPanelFull(false); }
      return true;
    }
    if (slash) { setSlashDismissed(slashKey); return true; }
    if (!onBack) return false;
    onBack();
    return true;
  }, onRegisterBack);

  useEffect(() => {
    panelMotion.setValue(0);
    Animated.timing(panelMotion, {
      toValue: 1,
      duration: reducedMotion ? 0 : 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [activeTab, panelMotion, reducedMotion]);

  const openThread = (id: string) => {
    if (activeThreadId) threadSnapshots.current[activeThreadId] = { messages, draft };
    const saved = threadSnapshots.current[id];
    setActiveThreadId(id);
    setMessages(saved?.messages ?? START_MESSAGES(id, workspaceMode));
    setDraft(saved?.draft ?? '');
    setNavigationOpen(false);
    setDemoBrowserActivities([]);
    setTabs([{id:'newtab',kind:'newtab',label:'新标签页',icon:'plus'}]);setActiveTab('newtab');setClosedTabs([]);
  };

  const startNewThread = (cwd = activeThread?.cwd ?? projectPath ?? '', savedDraft = draft) => {
    if (activeThreadId) threadSnapshots.current[activeThreadId] = { messages, draft: savedDraft };
    const id = `new-task:${++sequence.current}`;
    setCreatedThreads(current => [{ sessionKey:id, title:'新建任务',cwd,workspaceMode,tool:agentTool,client:agentName??'Codex App',updatedAt:Date.now(),status:'idle',controllable:true }, ...current]);
    setActiveThreadId(id);
    setDraft('');
    setMessages([{ id: Date.now(), role: 'assistant', text: workspaceMode === 'work' ? '新的 Work 任务已准备好。描述目标后，我会把它拆成可跟踪的任务步骤。' : '新的 Code 任务已准备好。描述目标后，我会在当前项目里显示一段示例处理结果。' }]);
    setNavigationOpen(false);
    setDemoBrowserActivities([]);
    setTabs([{id:'newtab',kind:'newtab',label:'新标签页',icon:'plus'}]);setActiveTab('newtab');setClosedTabs([]);
  };

  const openPanel = useCallback((tab: PanelTab) => {
    setTabs(current => current.some(item => item.id === tab.id) ? current : [...current, tab]);
    setActiveTab(tab.id);
    setPanelOpen(true);
  }, []);

  const addPanel = (option: PanelTab) => {
    const tab = option.kind === 'newtab' || option.kind === 'side-chat' || option.kind === 'terminal'
      ? { ...option, id: `${option.kind}:${++sequence.current}` }
      : option;
    openPanel(tab);
  };

  const closePanel = (id: string) => {
    const next = closeWorkspaceTab(tabs, activeTab, id, ADD_OPTIONS[1]);
    setTabs(next.tabs);
    const closed=tabs.find(tab=>tab.id===id);if(closed)setClosedTabs(current=>[...current.filter(tab=>tab.id!==id),closed].slice(-20));
    setActiveTab(next.activeTabId);
  };

  const openFile = useCallback((file: string) => {
    const tab: PanelTab = { id: `code:${file}`, kind: 'code', label: file.split('/').pop() ?? file, icon: 'file', file };
    openPanel(tab);
  }, [openPanel]);

  const openBrowser = useCallback((value: string, tabId?: string, foreground = true, pageId?: string) => {
    try {
      const uri = normalizeUri(value);
      const current = tabsRef.current;
      const existing = matchingBrowserTab(current.filter(item => item.kind === 'browser').map(item => ({ id: item.id, url: item.uri, pageId: item.browserPageId })), { target: workspaceBrowserTarget(uri)!, pageId });
      const id = existing?.id ?? tabId ?? `browser:${++sequence.current}`;
      const previous = current.find(item => item.id === id);
      const tab: PanelTab = { ...previous, id, kind: 'browser', label: browserPageTitle(uri), icon: 'globe', uri, browserPageId: pageId ?? previous?.browserPageId };
      tabsRef.current = previous ? current.map(item => item.id === id ? tab : item) : [...current, tab];
      setTabs(tabsRef.current);
      if (foreground) {
        setActiveTab(id); setPanelOpen(true);
      }
    } catch { /* Only validated HTTP targets reach this internal navigation path. */ }
  }, [activeTab]);
  useBrowserActivityEvents([...toolActivities, ...seededBrowserActivities, ...demoBrowserActivities], demoScope, request => openBrowser(request.target.url, undefined, false, request.pageId));

  const threadUi = useMemo<React.ContextType<typeof ThreadUi>>(() => ({
    presentation: tablet ? 'tablet' : 'mobile',
    currentSessionKey: `${demoTool}:demo-${demoScope}`,
    childTitle: () => workspaceMode === 'work' ? '交付检查' : '界面检查',
    openDiff: file => openPanel({ id: `diff:${file.path}`, kind: 'diff', label: file.path.split('/').pop()!, icon: 'file', diff: file }),
    openDiffInToolPanel: true,
    openChanges: () => openPanel(PINNED_PANELS[3]),
    undoUnavailable: '示例变更；连接电脑后可撤销实际文件修改',
    openBrowser: navigation => openBrowser(navigation.url, undefined, true, navigation.pageId),
    openLink: target => {
      const link = resolveRemoteLink(target);
      if (link.kind === 'web' || link.kind === 'local-service') openBrowser(target);
      else if (link.kind === 'file' && FILES[link.path] !== undefined) openFile(link.path);
      else showToast('示例工作区中没有这个内容');
    },
    openImage: () => openPanel(PINNED_PANELS[0]),
    requestAttachment: () => showToast('示例数据不包含电脑上的附件'),
  }), [tablet, demoTool, demoScope, workspaceMode, openPanel, openBrowser, openFile]);
  const quoteReply = useCallback((text: string) => setDraft(quoteFor(text)), []);
  const openChild = useCallback(() => { setExpandedAgent('layout'); openPanel(ADD_OPTIONS[2]); }, [openPanel]);

  const sendMessage = () => {
    if(slash){if(slashEntries[slashFocus])chooseSlash(slashEntries[slashFocus]);return;}
    const text = draft.trim();
    if (!text) return;
    const id = Date.now();
    // The development workspace simulates this explicit browser instruction as a
    // structured Agent event, using the same background-tab path as the real bridge.
    const browserInstruction = text.match(/^打开\s+(https?:\/\/\S+)\s*$/i);
    const browserTarget = browserInstruction ? workspaceBrowserTarget(browserInstruction[1]) : undefined;
    if (browserTarget) setDemoBrowserActivities(current => [...current, { id: `demo-browser:${id}`, status: 'done', browser: { action: 'open', url: browserTarget.url } }]);
    if (activeThreadId?.startsWith('new-task:')) setCreatedThreads(current => current.map(thread => thread.sessionKey === activeThreadId && thread.title === '新建任务' ? { ...thread, title: text.slice(0, 28) } : thread));
    setMessages((current) => [...current,
      { id, role: 'user', text },
      {
        id: id + 1,
        role: 'assistant',
        text: browserTarget ? `示例 Agent 已在后台添加网页 ${browserTarget.url}。当前标签和侧栏保持不变，你可以自行切换到新网页。这是模拟浏览器操作。`
          : workspaceMode === 'work' ? '已记录这条 Work 任务要求。当前是示例数据，你可以继续查看任务清单和交接内容；不会向电脑下发操作。'
            : '已记录这条 Code 任务要求。当前是示例数据，你可以继续查看代码、变更和执行详情；不会在电脑上运行命令或写入文件。',
      },
    ]);
    setDraft('');setSkills([]);setCaret(undefined);setForcedSelection(undefined);
  };

  const setPanelView=(view:WorkspaceView)=>{setPanelFull(view==='full');setPanelOpen(view!=='hidden');};
  const restoreTab=()=>{const tab=closedTabs.at(-1);if(tab){openPanel(tab);setClosedTabs(current=>current.slice(0,-1));}};
  const closeOtherTabs=(id:string)=>{if(!tabs.some(tab=>tab.id===id))return;const removed=tabs.filter(tab=>tab.id!==id);setClosedTabs(current=>[...current.filter(tab=>!removed.some(item=>item.id===tab.id)),...removed].slice(-20));setTabs(tabs.filter(tab=>tab.id===id));setActiveTab(id);};
  const cycleTab=(offset:number)=>{const index=tabs.findIndex(tab=>tab.id===activeTab);setActiveTab(tabs[(index+offset+tabs.length)%tabs.length].id);};
  useWorkspaceShortcuts({active:true,visible:panelOpen,
    onBrowser:()=>addPanel(ADD_OPTIONS[1]),onReview:()=>openPanel(PINNED_PANELS[3]),onSideChat:()=>addPanel(ADD_OPTIONS[0]),onFiles:()=>openPanel(PINNED_PANELS[1]),onTerminal:()=>openPanel(PINNED_PANELS[2]),
    onClose:()=>closePanel(activeTab),onRestore:restoreTab,onPrevious:()=>cycleTab(-1),onNext:()=>cycleTab(1),onCloseOthers:()=>closeOtherTabs(activeTab),
    onCycleLayout:()=>setPanelView(!panelOpen?'split':panelFull?'hidden':'full'),onToggleFull:()=>setPanelView(panelFull?'split':'full'),onTogglePanel:()=>setPanelView(panelOpen?'hidden':'split'),
  });
  const openSharedPage=(page:WorkspacePage)=>{
    if(page.kind==='artifact'||page.kind==='project-preview')return; // Content previews require their actual source and runtime.
    if(page.kind==='preview'){if(page.preview)openBrowser(page.preview.url,activeTab);else openPanel({id:`browser:${++sequence.current}`,kind:'browser',label:'浏览器',icon:'globe'});return;}
    const option:PanelTab={id:page.id,kind:page.kind,label:page.title,icon:page.kind==='side-chat'?'chat':page.kind==='terminal'?'terminal':page.kind==='agents'?'user':page.kind==='files'?'file':'code'};
    addPanel(option);
  };
  const sharedPages:WorkspacePage[]=tabs.map(tab=>({id:tab.id,kind:tab.kind==='browser'?'preview':tab.kind==='code'?'files':tab.kind,title:tab.label,preview:tab.uri?workspaceBrowserTarget(tab.uri):undefined,diff:tab.diff,...(tab.file?{file:{path:tab.file,expectedCwd:'/example/project',sessionKey:`demo:${demoScope}`,surface:'cli' as const,nonce:1}}:{})}));
  const runCommand = () => {
    const command = terminalDraft.trim();
    if (!command) return;
    const result = command === 'pwd' ? '~/Projects/salcara-web'
      : command === 'git status' ? 'On branch main · 2 files changed'
        : command.startsWith('npm run test') ? '✓ 1 test passed · 42 ms'
          : command === 'npm run dev' ? 'VITE ready · http://localhost:5173/'
            : `已在演示终端中记录命令：${command}`;
    setTerminalLines((current) => [...current, `$ ${command}`, result]);
    setTerminalDraft('');
  };

  const renderPanelContent = () => {
    if (!activePanel) return <WorkspaceNewPage onOpen={openSharedPage}/>;

    if (activePanel.kind === 'git'||activePanel.kind==='changes'||activePanel.kind==='side-chat'||activePanel.kind==='files') return null;

    if (activePanel.kind === 'newtab') return <WorkspaceNewPage onOpen={openSharedPage}/>;
    if(activePanel.kind==='computer')return <ComputerUsePage active={panelOpen} connected sessionRunning={false} items={[
      {kind:'tool',id:'demo-computer-open',tool:'mcp',title:'打开测试页面',status:'done',ts:demoAgentTime-12_000,computer:{version:1,surface:'browser',action:'navigate',provider:'playwright'}},
      {kind:'tool',id:'demo-computer-click',tool:'mcp',title:'点击登录按钮',status:'done',ts:demoAgentTime-8_000,computer:{version:1,surface:'browser',action:'click',provider:'playwright'}},
    ]}/>;
    if(activePanel.kind==='tools')return <ScrollView contentContainerStyle={styles.pageContent}><Text style={styles.panelIntroTitle}>执行记录</Text><Text style={styles.panelIntroCopy}>示例数据 · 执行详情也可在主对话中展开</Text>{blocks.map(block=><ThreadUi.Provider key={block.id} value={threadUi}><BlockRow block={block} tool={demoTool} onOpenChild={openChild}/></ThreadUi.Provider>)}</ScrollView>;

    if (activePanel.kind === 'agents') return <SubagentList items={[
      {id:'layout',title:workspaceMode==='work'?'交付检查':'界面检查',group:'ended' as const,updatedAt:demoAgentTime-11*60_000,
        detail:expandedAgent==='layout'?<Text style={styles.agentDetail}>{workspaceMode==='work'?'发布清单遗漏项检查已完成':'平板断点与表单可访问性检查已完成'} · 本地示例</Text>:undefined},
      {id:'tests',title:workspaceMode==='work'?'清单检查':'测试检查',group:'ended' as const,updatedAt:demoAgentTime-15*60_000,
        detail:expandedAgent==='tests'?<Text style={styles.agentDetail}>{workspaceMode==='work'?'发布清单格式检查已通过':'登录布局测试已通过'} · 本地示例</Text>:undefined},
    ]} onOpen={id=>setExpandedAgent(current=>current===id?null:id)}/>;

    if (activePanel.kind === 'preview') return <View style={styles.previewPage}>
      <View style={styles.previewAddress}><Icon name="lock" size={13} color={W.secondary} /><Text style={styles.previewAddressText}>localhost:5173/login</Text><Pressable accessibilityRole="button" accessibilityLabel="在浏览器中打开预览" onPress={() => openBrowser('https://example.com')}><Icon name="external" size={14} color={W.secondary} /></Pressable></View>
      <ScrollView style={styles.previewCanvas} contentContainerStyle={styles.previewCanvasContent}>
        <View style={styles.previewNav}><View style={styles.previewBrand}><View style={styles.previewBrandMark} /><Text style={styles.previewBrandName}>mosaic</Text></View><Text style={styles.previewNavLink}>帮助</Text></View>
        <View style={styles.previewForm}><Text style={styles.previewEyebrow}>欢迎回来</Text><Text style={styles.previewHeadline}>让灵感继续生长</Text><Text style={styles.previewDescription}>登录你的工作空间，继续上次的创作。</Text>
          <Text style={styles.previewLabel}>邮箱地址</Text><View style={styles.previewField}><Text style={styles.previewPlaceholder}>name@example.com</Text></View>
          <Text style={styles.previewLabel}>密码</Text><View style={styles.previewField}><Text style={styles.previewPlaceholder}>••••••••</Text></View>
          <View style={styles.previewButton}><Text style={styles.previewButtonText}>继续</Text></View><Text style={styles.previewFootnote}>还没有账号？ <Text style={styles.previewLink}>创建账号</Text></Text>
        </View>
      </ScrollView>
    </View>;

    if (activePanel.kind === 'code') return <ScrollView horizontal contentContainerStyle={styles.codeScroll}>
      <View style={styles.codeGutter}>{(FILES[activePanel.file ?? ''] ?? '// 示例代码').split('\n').map((_, index) => <Text key={index} style={styles.codeLineNumber}>{index + 1}</Text>)}</View>
      <Text selectable style={styles.codeEditorText}>{FILES[activePanel.file ?? ''] ?? '// 示例代码'}</Text>
    </ScrollView>;

    if (activePanel.kind === 'browser') return null;

    if (activePanel.kind === 'terminal') return <View style={styles.terminalPage}>
      <View style={styles.terminalToolbar}><View style={styles.terminalDot} /><Text style={styles.terminalName}>终端</Text><Text style={styles.terminalState}>演示终端</Text><ToolbarButton label="清空终端" icon="eraser" color={W.secondary} onPress={() => setTerminalLines([])}/></View>
      <ScrollView style={styles.terminalOutput} contentContainerStyle={styles.terminalOutputContent}>
        {terminalLines.map((line, index) => <Text key={`${index}:${line}`} style={[styles.terminalLine, line.startsWith('$') && styles.terminalPrompt, line.startsWith('✓') && styles.terminalSuccess]}>{line}</Text>)}
      </ScrollView>
      <View style={styles.terminalInputRow}><Text style={styles.terminalPromptMark}>$</Text><TextInput accessibilityLabel="终端命令输入框" value={terminalDraft} onChangeText={setTerminalDraft} onSubmitEditing={runCommand} placeholder="输入命令" placeholderTextColor="#9298A3" style={styles.terminalInput} autoCapitalize="none" autoCorrect={false} returnKeyType="send" /><Pressable accessibilityRole="button" accessibilityLabel="运行命令" onPress={runCommand} style={styles.terminalRun}><Icon name="arrowUp" size={18} color={W.bg} accent={W.bg}/></Pressable></View>
      <Text style={styles.terminalDisclaimer}>命令仅写入本地演示记录，不会在电脑上运行</Text>
    </View>;

    if (activePanel.kind === 'diff' && activePanel.diff) return <ScrollView contentContainerStyle={styles.pageContent}><Text style={styles.panelIntroTitle}>{activePanel.diff.path}</Text><Text style={styles.panelIntroCopy}>示例变更</Text><DiffView diff={activePanel.diff.diff!} maxHeight={Number.MAX_SAFE_INTEGER}/></ScrollView>;
    return null;
  };

  return <KeyboardSafeView testID="demo-keyboard-safe" style={{flex:1,minHeight:0}}><WorkspaceLayoutContext.Provider value={{view:!panelOpen?'hidden':panelFull||!tablet?'full':'split',canSplit:tablet,setView:setPanelView}}><View nativeID="demo-workspace-root" style={styles.root}>
    <View testID="remote-workbench-pane" style={[styles.mainPane,(panelFull||!tablet)&&panelOpen&&{display:'none'}]}>
      <View style={styles.conversationHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel={navigationOpen ? '关闭会话侧栏' : '打开会话侧栏'} accessibilityState={{ expanded: navigationOpen }} onPress={() => setNavigationOpen((value) => !value)} style={styles.headerIcon}><Icon name="menu" size={19} color={W.secondary} /></Pressable>
        <View style={styles.conversationTitleGroup}><Text style={styles.conversationTitle} numberOfLines={1}>{displaySessionTitle}</Text><Text style={styles.projectCaption}>{computerName ? `${computerName} · ${contextLabel}` : contextLabel} <Text style={styles.captionMuted}>· {workspaceMode === 'work' ? 'Work' : 'main'}</Text></Text></View>
        <View style={styles.headerActions}><View accessibilityLabel="模拟电脑已连接" style={styles.localBadge}><View style={styles.localBadgeDot} /><Text style={styles.localBadgeText}>模拟电脑 · 已连接</Text></View>{!panelOpen?<ToolbarButton icon="panelRight" label="打开工作区面板" onPress={()=>setPanelOpen(true)}/>:null}</View>
      </View>

      <ScrollView style={styles.timeline} contentContainerStyle={styles.timelineContent} showsVerticalScrollIndicator={false}>
        <View style={styles.dateDivider}><View style={styles.dividerLine} /><Text style={styles.dateLabel}>示例数据 · {displayAgentName}</Text><View style={styles.dividerLine} /></View>
        <ThreadUi.Provider value={threadUi}>
          {blocks.map(block => <BlockRow key={block.id} block={block} tool={demoTool} stat={block.type === 'assistant' ? messageStats.get(block.item.id) : undefined} onQuote={quoteReply} onOpenChild={openChild} />)}
        </ThreadUi.Provider>
      </ScrollView>

      <View style={styles.composerWrap}>{slash?<SlashCommandMenu entries={slashEntries} selectedId={slashEntries[slashFocus]?.id} sourceLabel="示例" onSelect={chooseSlash} onClose={()=>setSlashDismissed(slashKey)} onReload={()=>setSlashFocus(0)}/>:null}<MainComposerSurface>
        {mode==='Plan'||skills.length?<View style={styles.attachmentList}>{mode==='Plan'?<Pressable accessibilityRole="button" accessibilityLabel="关闭演示计划模式" onPress={()=>setMode('Code')} style={styles.attachmentChip}><Text style={styles.attachmentText}>计划</Text><Icon name="close" size={12} color={W.muted}/></Pressable>:null}{skills.map(skill=><Pressable key={skillKey(skill)} accessibilityRole="button" accessibilityLabel={`移除演示技能 ${skill.name}`} style={styles.attachmentChip} onPress={()=>setSkills(current=>current.filter(value=>skillKey(value)!==skillKey(skill)))}><SkillReferenceLabel skill={skill}/><Icon name="close" size={12} color={W.muted}/></Pressable>)}</View>:null}
        <SkillComposerInput mentions={[]} ref={composerInput} testID="chat-message-input" accessibilityLabel="编程对话输入框" placeholder={`和 ${displayAgentName} 一起工作`} placeholderTextColor={W.muted} value={draft} selection={forcedSelection} onChangeText={value=>{setDraft(value);setCaret(undefined);setForcedSelection(undefined);}} onSelectionChange={event=>{setCaret(event.nativeEvent.selection.start);setForcedSelection(undefined);}} multiline style={styles.composerInput} textAlignVertical="top" onKeyPress={event=>{
          const native=event.nativeEvent as typeof event.nativeEvent&{shiftKey?:boolean;isComposing?:boolean};if(native.isComposing)return;
          if(slash&&['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(native.key)&&!native.shiftKey){event.preventDefault?.();if(native.key==='Escape')setSlashDismissed(slashKey);else if(native.key==='ArrowDown'||native.key==='ArrowUp')setSlashFocus(value=>(value+(native.key==='ArrowDown'?1:-1)+slashEntries.length)%Math.max(1,slashEntries.length));else sendMessage();return;}
          if(Platform.OS==='web'&&native.key==='Enter'&&!native.shiftKey){event.preventDefault?.();sendMessage();}
        }}/>
        {attachments.length ? <View style={styles.attachmentList}>{attachments.map((item) => <View key={item} style={styles.attachmentChip}><Icon name="file" size={12} color={W.secondary} /><Text style={styles.attachmentText}>{item}</Text><Pressable accessibilityRole="button" accessibilityLabel={`移除${item}`} onPress={() => setAttachments((current) => current.filter((name) => name !== item))}><Icon name="close" size={12} color={W.muted} /></Pressable></View>)}</View> : null}
        <MainComposerToolbar features={<>
            <WegentActionMenu label="打开工具菜单" icon="plus" items={[
              { id: 'wegent-context-files', label: '搜索代码', onSelect: () => openPanel(PINNED_PANELS[1]) },
              { id: 'wegent-context-terminal', label: '打开终端', onSelect: () => openPanel(PINNED_PANELS[2]) },
              ...(!extension ? [{ id: 'wegent-context-attachment', label: '附加示例文件', onSelect: () => setAttachments(current => current.includes('LoginPage.tsx') ? current : [...current, 'LoginPage.tsx']) },
              { id: 'main-plan', label: mode === 'Plan' ? '关闭计划模式' : '开启计划模式', checked: mode === 'Plan', onSelect: () => setMode(value => value === 'Plan' ? 'Code' : 'Plan') }] : []),
            ]} />
            {!extension ? <MainComposerPermission anchorRef={permissionAnchor} label={permissionLabel(permission)} danger={permission==='full_access'||permission==='auto_all'} onPress={()=>setComposerMenu('permission')}/> : null}
          </>} actions={<>
            <MainComposerModelGroup>
            {!extension ? <ContextIndicator scopeKey={`demo:${demoScope}:${activeThreadId}`} active={!((panelFull||!tablet)&&panelOpen)} unavailableReason="示例会话暂无上下文用量"/> : null}
            <MainComposerModelButton anchorRef={modelAnchor} label={model} disabled={!canChooseModel} onPress={()=>{if(canChooseModel)setComposerMenu('model');}}/>
            </MainComposerModelGroup>
            {!extension ? <MainEffortControl levels={['','low','medium','high']} value={effort} scopeKey={`demo:${demoScope}:${activeThreadId}`} open={composerMenu==='effort'} onClose={()=>setComposerMenu(current=>current==='effort'?null:current)} onSelect={setEffort}/> : null}
            <MainComposerAction icon="arrowUp" label={slash?'选择编程命令':'发送编程消息'} disabled={slash?!slashEntries.length:!draft.trim()} onPress={sendMessage}/>
        </>} />
      </MainComposerSurface></View>
      <ModelPopover visible={canChooseModel&&composerMenu==='model'} anchor={null} anchorRef={modelAnchor} scopeKey={`demo:${demoScope}:${activeThreadId}`} value={model} fallback="" models={demoModels} loading={false}
        onRefresh={()=>{}} onSelect={value=>{setModel(value);setComposerMenu(null);}} onClose={()=>setComposerMenu(null)}/>
      <ComposerOptionMenu visible={composerMenu==='permission'} anchorRef={permissionAnchor} scopeKey={`demo:${demoScope}:${activeThreadId}`} accessibilityLabel="批准权限" value={permission}
        options={permissionOptions.map(value=>({value,label:permissionLabel(value),danger:value==='full_access'||value==='auto_all'}))} onSelect={value=>{if(permissionOptions.includes(value)){setPermission(value);setComposerMenu(null);}}} onClose={()=>setComposerMenu(null)}/>
    </View>

    <View testID="demo-workspace-panel" style={[styles.workspacePanel, { width: panelFull||!tablet?'100%':panelWidth, display: panelOpen ? 'flex' : 'none' }]}>
      <WorkspaceTabBar pages={sharedPages} activeId={activeTab} onSelect={page=>setActiveTab(page.id)} onClose={closePanel} onAdd={()=>addPanel(ADD_OPTIONS[1])} onRestore={closedTabs.length?restoreTab:undefined} onCloseOthers={closeOtherTabs} labelFor={page=>page.title} closeLabelFor={page=>`关闭${page.title}`}/>
      <Animated.View style={[styles.panelContent, { opacity: panelMotion, transform: [{ translateY: panelMotion.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }]}>
        {tabs.filter(tab=>tab.kind==='git'||tab.kind==='changes').map(tab=><View key={tab.id} style={{flex:1,minHeight:0,display:activeTab===tab.id?'flex':'none'}}><RemoteDemoReviewPage active={panelOpen&&activeTab===tab.id} lastTurn={demoChanges} onOpenFile={openFile} initialScope={tab.kind==='changes'?'last-turn':'unstaged'} onCompose={text=>setDraft(current=>[current,text].filter(Boolean).join('\n\n'))} onReference={reference=>setDraft(current=>[current,`文件批注：${reference.path}\n${reference.text}\n${reference.annotation??''}`].filter(Boolean).join('\n\n'))}/></View>)}
        {tabs.filter(tab=>tab.kind==='files').map(tab=><View key={JSON.stringify([demoScope,activeThread?.cwd??projectPath,tab.id])} style={{flex:1,minHeight:0,display:activeTab===tab.id?'flex':'none'}}>
          <DemoWorkspaceFiles files={FILES} rootPath={activeThread?.cwd??projectPath??''} onOpenFile={openFile}/>
        </View>)}
        {tabs.filter(tab=>tab.kind==='side-chat').map(tab=><View key={tab.id} style={{flex:1,minHeight:0,display:activeTab===tab.id?'flex':'none'}}><TemporarySideChat visible={panelOpen&&activeTab===tab.id} scopeKey={`${computerName}|${agentName}|${workspaceMode}|${demoScope}|${tab.id}`} sessionKey={`demo:${demoScope}`} transport={demoSideChat}/></View>)}
        {tabs.filter(tab => tab.kind === 'browser').map(tab => <View key={tab.id} testID={`browser-tab-content:${tab.id}`} style={{ flex: 1, minHeight: 0, display: activeTab === tab.id ? 'flex' : 'none' }}>
          <RemoteBrowserPage onCompose={text=>setDraft(current=>[current,text].filter(Boolean).join('\n\n'))} target={tab.uri ? workspaceBrowserTarget(tab.uri) : undefined} active={panelOpen && activeTab === tab.id} initialHistory={tab.browserHistory} onHistoryChange={history=>setTabs(current=>current.map(item=>item.id===tab.id?{...item,browserHistory:history}:item))}
            onNavigate={target => setTabs(current => current.map(item => item.id === tab.id ? { ...item, uri: target.url, label: browserPageTitle(target.url) } : item))}
            onOpenNew={target => openBrowser(target.url)} />
        </View>)}
        {renderPanelContent()}
      </Animated.View>
      <View style={styles.panelFooter}><Text style={styles.panelFooterText}>{contextLabel}</Text><View style={styles.panelFooterDot} /><Text style={styles.panelFooterText}>模拟电脑已连接</Text></View>
    </View>

    {navigationOpen ? <>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭会话侧栏背景" onPress={() => setNavigationOpen(false)} style={styles.navigationScrim} />
      <View style={[styles.navigationPanel, { width: Math.min(320, width - 24) }]}>
        <View style={styles.navigationHeader}><Text style={styles.navigationTitle}>工作区</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭会话侧栏" onPress={() => setNavigationOpen(false)} style={styles.quietIcon}><Icon name="close" size={16} color={W.secondary} /></Pressable></View>
        <Pressable accessibilityRole="button" accessibilityLabel="新建任务" onPress={() => startNewThread()} style={styles.newTaskButton}><Icon name="compose" size={16} color={W.text} /><Text style={styles.newTaskLabel}>新建任务</Text><Text style={styles.newTaskShortcut}>⌘ N</Text></Pressable>
        <View style={styles.navigationSectionRow}>{threadSearchOpen ? <TextInput accessibilityLabel="搜索最近任务" value={threadQuery} onChangeText={setThreadQuery} placeholder="搜索项目或会话" placeholderTextColor={W.muted} style={styles.inlineSearch} autoFocus /> : <Text style={styles.navigationSection}>{workspaceMode === 'work' ? 'Work 项目' : 'Code 项目'}</Text>}<Pressable accessibilityRole="button" accessibilityLabel={threadSearchOpen ? '关闭任务搜索' : '搜索任务'} onPress={() => { setThreadSearchOpen((current) => !current); setThreadQuery(''); }}><Icon name={threadSearchOpen ? 'close' : 'search'} size={15} color={W.secondary} /></Pressable></View>
        <ScrollView style={styles.threadList} contentContainerStyle={styles.threadListContent} showsVerticalScrollIndicator={false}>
          <DemoProjectTree sessions={threadCatalog} selectedKey={activeThreadId} query={threadQuery} openLabel="切换任务 " onOpen={thread=>openThread(thread.sessionKey)} onNew={startNewThread} onCopy={thread=>{void Clipboard.setStringAsync(thread.title);}} />
        </ScrollView>
        <View style={styles.navigationAccount}><View style={styles.accountGlyph}><Icon name="user" size={16} color={W.secondary} /></View><View style={styles.projectInfo}><Text style={styles.projectTitle}>本地工作区</Text><Text style={styles.projectPath}>免费演示环境</Text></View><Icon name="settings" size={16} color={W.secondary} /></View>
      </View>
    </> : null}
  </View></WorkspaceLayoutContext.Provider></KeyboardSafeView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0, flexDirection: 'row', overflow: 'hidden', backgroundColor: W.bg },
  mainPane: { flex: 1, minWidth: 0, backgroundColor: W.bg },
  conversationHeader: { height: 62, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: W.border },
  headerIcon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  conversationTitleGroup: { flex: 1, minWidth: 0, gap: 3 }, conversationTitle: { color: W.text, fontSize: 14, fontWeight: '600' }, projectCaption: { color: W.secondary, fontSize: 11 }, captionMuted: { color: W.muted },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 }, localBadge: { height: 26, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, borderRadius: 6, backgroundColor: W.surface }, localBadgeDot: { width: 6, height: 6, borderRadius: 4, backgroundColor: W.primary }, localBadgeText: { color: W.secondary, fontSize: 10 },
  timeline: { flex: 1, minHeight: 0 }, timelineContent: { width: '100%', maxWidth: 748, alignSelf: 'center', paddingHorizontal: 24, paddingBottom: 26, gap: 20 },
  dateDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 22 }, dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: W.border }, dateLabel: { color: W.muted, fontSize: 10 },
  composerWrap: { position: 'relative', width: '100%', maxWidth: 748, alignSelf: 'center', paddingHorizontal: 10, paddingTop: 4, paddingBottom: 8 }, composerContextRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: W.border }, contextChip: { height: 26, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4 }, contextChipText: { color: W.secondary, fontSize: 10 }, contextDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: W.muted }, contextSpacer: { flex: 1 }, contextReadiness: { color: W.muted, fontSize: 9 }, composerInput: { minHeight: 52, maxHeight: 180, paddingHorizontal: 4, paddingTop: 2, paddingBottom: 6, color: W.text, fontSize: 15, lineHeight: 22 },
  attachmentList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingBottom: 7 }, attachmentChip: { height: 25, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 7, borderWidth: 1, borderColor: W.border, borderRadius: 5, backgroundColor: W.surface }, attachmentText: { color: W.secondary, fontSize: 9 },
  composerToolbar: { minHeight: 43, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 8, paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderColor: W.border }, toolbarGroup: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 3 }, toolbarIcon: { width: 29, height: 29, alignItems: 'center', justifyContent: 'center', borderRadius: 6 }, toolbarSeparator: { width: StyleSheet.hairlineWidth, height: 19, marginHorizontal: 4, backgroundColor: W.border }, selectorChip: { height: 29, maxWidth: 170, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 7, borderRadius: 6 }, selectorChipActive: { backgroundColor: W.primarySoft }, selectorText: { color: W.secondary, fontSize: 10 }, effortButton: { height: 29, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 }, effortText: { color: W.secondary, fontSize: 9 }, sendButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: W.text }, sendButtonDisabled: { opacity: 0.34 }, pressed: { opacity: 0.7 },
  toolMenu: { position: 'absolute', zIndex: 15, bottom: 49, left: 8, minWidth: 210, maxWidth: 290, padding: 5, borderWidth: 1, borderColor: W.border, borderRadius: 8, backgroundColor: W.bg, elevation: 7, shadowColor: '#000000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } }, menuOption: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 8, borderRadius: 5 }, menuOptionSelected: { backgroundColor: W.surface }, menuOptionCopy: { flex: 1, gap: 2 }, menuOptionTitle: { color: W.text, fontSize: 11 }, menuOptionDetail: { color: W.muted, fontSize: 9 },
  workspacePanel: { flexShrink: 0, minWidth: 0, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: W.border, backgroundColor: W.bg }, workspacePanelOverlay: { position: 'absolute', zIndex: 5, top: 8, right: 8, bottom: 8, borderWidth: 1, borderRadius: 10, overflow: 'hidden', elevation: 8, shadowColor: '#000000', shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } }, panelHeader: { position: 'relative', zIndex: 10, height: 44, flexDirection: 'row', alignItems: 'center', paddingRight: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: W.border }, panelTabs: { flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 6, paddingRight: 4 }, panelTab: { height: 31, flexDirection: 'row', alignItems: 'center', gap: 1, maxWidth: 160, paddingLeft: 6, paddingRight: 2, borderRadius: 5 }, panelTabSelected: { backgroundColor: W.surface }, panelTabSelect: { flex: 1, minWidth: 0, height: 29, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 3 }, panelTabText: { maxWidth: 108, color: W.secondary, fontSize: 10 }, panelTabTextSelected: { color: W.text, fontWeight: '500' }, panelTabClose: { width: 20, height: 26, alignItems: 'center', justifyContent: 'center' }, panelHeaderIcon: { width: 29, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 5 }, addMenu: { position: 'absolute', zIndex: 20, top: 38, right: 30, minWidth: 168, padding: 5, borderWidth: 1, borderColor: W.border, borderRadius: 7, backgroundColor: W.bg, elevation: 7, shadowColor: '#000000', shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } }, addMenuOption: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 8, borderRadius: 5 }, addMenuLabel: { color: W.text, fontSize: 10 }, panelContent: { flex: 1, minHeight: 0 }, panelFooter: { height: 26, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: W.border }, panelFooterText: { color: W.muted, fontSize: 9 }, panelFooterDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: W.muted },
  pageContent: { padding: 14, gap: 9 }, panelIntro: { paddingVertical: 4, gap: 3 }, panelIntroTitle: { color: W.text, fontSize: 13, fontWeight: '600' }, panelIntroCopy: { color: W.secondary, fontSize: 10 }, panelEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 9, padding: 20 }, emptyTitle: { color: W.text, fontSize: 12, fontWeight: '500' }, emptyCopy: { color: W.secondary, fontSize: 10, textAlign: 'center' }, actionButton: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 5, paddingHorizontal: 10, borderWidth: 1, borderColor: W.border, borderRadius: 6 }, actionButtonText: { color: W.text, fontSize: 10 },
  sideChat: { flex: 1, minHeight: 0 }, sideChatList: { flex: 1 }, sideChatContent: { padding: 13, gap: 16 }, sideUserBubble: { maxWidth: '91%', alignSelf: 'flex-end', paddingHorizontal: 9, paddingVertical: 8, borderRadius: 8, backgroundColor: W.surface }, sideUserText: { color: W.text, fontSize: 10, lineHeight: 15 }, sideAssistantMessage: { gap: 7 }, sideAssistantTitle: { flexDirection: 'row', alignItems: 'center', gap: 5 }, sideAssistantName: { color: W.text, fontSize: 10, fontWeight: '600' }, sideAssistantText: { color: W.secondary, fontSize: 10, lineHeight: 15 }, sideComposer: { minHeight: 50, flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginHorizontal: 9, marginBottom: 8, paddingLeft: 9, paddingRight: 5, paddingVertical: 5, borderWidth: 1, borderColor: W.border, borderRadius: 8, backgroundColor: W.bg }, sideComposerCompact: { minHeight: 45 }, sideComposerInput: { flex: 1, minWidth: 0, maxHeight: 75, padding: 3, color: W.text, fontSize: 10, lineHeight: 15 },
  newTabContent: { flexGrow: 1, alignItems: 'stretch', padding: 16, paddingTop: 38, gap: 12 }, newTabGlyph: { alignSelf: 'center', width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: W.border, borderRadius: 10 }, newTabTitle: { color: W.text, fontSize: 14, fontWeight: '600', textAlign: 'center', marginBottom: 5 }, sectionLabel: { marginTop: 14, color: W.secondary, fontSize: 10, fontWeight: '500' }, addressBar: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 9, borderWidth: 1, borderColor: W.border, borderRadius: 7, backgroundColor: W.bg }, addressInput: { flex: 1, minWidth: 0, height: 36, padding: 0, color: W.text, fontSize: 10 }, addressGo: { width: 25, height: 25, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: W.text }, browserError: { marginTop: 5, color: W.danger, fontSize: 9 }, quickLink: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: W.border }, quickLinkLabel: { flex: 1, color: W.text, fontSize: 10 }, quickLinkUri: { color: W.muted, fontSize: 9 },
  agentRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: W.border }, agentIcon: { width: 29, height: 29, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: W.border, borderRadius: 7 }, agentText: { flex: 1, minWidth: 0, gap: 3 }, agentTitle: { color: W.text, fontSize: 10.5, fontWeight: '500' }, agentDetail: { color: W.secondary, fontSize: 9 }, agentMeta: { marginTop: 3, color: W.muted, fontSize: 8.5 }, agentState: { color: W.muted, fontSize: 9 }, agentRunning: { color: W.primary },
  previewPage: { flex: 1, padding: 10, gap: 9 }, previewAddress: { height: 30, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, borderRadius: 5, backgroundColor: W.surface }, previewAddressText: { flex: 1, color: W.secondary, fontSize: 9 }, previewCanvas: { flex: 1, borderWidth: 1, borderColor: W.border, borderRadius: 7, backgroundColor: '#FBFCFE' }, previewCanvasContent: { minHeight: 390 }, previewNav: { height: 39, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: W.border }, previewBrand: { flexDirection: 'row', alignItems: 'center', gap: 6 }, previewBrandMark: { width: 11, height: 11, borderRadius: 4, backgroundColor: '#7388DB' }, previewBrandName: { color: '#31384A', fontSize: 10, fontWeight: '700' }, previewNavLink: { color: '#7B8394', fontSize: 9 }, previewForm: { maxWidth: 330, alignSelf: 'center', width: '100%', paddingHorizontal: 17, paddingTop: 28 }, previewEyebrow: { color: '#7A86A9', fontSize: 9, marginBottom: 8 }, previewHeadline: { color: '#252B39', fontSize: 19, lineHeight: 25, fontWeight: '700' }, previewDescription: { color: '#7A8291', fontSize: 10, lineHeight: 15, marginTop: 6, marginBottom: 17 }, previewLabel: { color: '#434A59', fontSize: 9, fontWeight: '600', marginTop: 9, marginBottom: 5 }, previewField: { height: 34, justifyContent: 'center', paddingHorizontal: 9, borderWidth: 1, borderColor: '#E4E8F0', borderRadius: 5, backgroundColor: W.bg }, previewPlaceholder: { color: '#A4AAB6', fontSize: 9 }, previewButton: { height: 35, alignItems: 'center', justifyContent: 'center', marginTop: 14, borderRadius: 5, backgroundColor: '#526DD0' }, previewButtonText: { color: W.bg, fontSize: 10, fontWeight: '600' }, previewFootnote: { marginTop: 12, color: '#848C9D', fontSize: 9, textAlign: 'center' }, previewLink: { color: '#526DD0', fontWeight: '600' },
  fileToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }, inlineSearch: { flex: 1, minWidth: 0, height: 30, paddingHorizontal: 7, color: W.text, fontSize: 10 }, quietIcon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 5 }, folderRow: { minHeight: 33, flexDirection: 'row', alignItems: 'center', gap: 6 }, folderName: { color: W.text, fontSize: 10, fontWeight: '500' }, fileRow: { minHeight: 31, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 5, borderRadius: 5 }, fileRowSelected: { backgroundColor: W.surface }, fileIndent: { width: 8 }, fileName: { flex: 1, color: W.secondary, fontSize: 9.5 }, fileNameSelected: { color: W.text, fontWeight: '500' }, fileFolder: { maxWidth: 100, color: W.muted, fontSize: 8, textAlign: 'right' }, workspaceStatus: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 13, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: W.border }, statusDot: { width: 6, height: 6, borderRadius: 4, backgroundColor: W.success }, workspaceStatusText: { color: W.secondary, fontSize: 9 },
  codeScroll: { minHeight: '100%', flexDirection: 'row', padding: 12, backgroundColor: W.bg }, codeGutter: { paddingRight: 14 }, codeLineNumber: { color: '#A6A9AE', fontFamily: 'monospace', fontSize: 10, lineHeight: 18, textAlign: 'right' }, codeEditorText: { color: '#29313D', fontFamily: 'monospace', fontSize: 10, lineHeight: 18 },
  browserPage: { flex: 1, padding: 9, gap: 8 }, browserEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 9 },
  terminalPage: { flex: 1, padding: 10 }, terminalToolbar: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: W.border }, terminalDot: { width: 7, height: 7, flexShrink: 0, borderRadius: 4, backgroundColor: W.success }, terminalName: { flex: 1, minWidth: 0, color: W.text, fontSize: 10, fontWeight: '500' }, terminalState: { color: W.muted, fontSize: 9 }, terminalOutput: { flex: 1, marginVertical: 8, borderRadius: 6, backgroundColor: '#F7F7F8' }, terminalOutputContent: { padding: 10, gap: 5 }, terminalLine: { color: '#555D69', fontFamily: 'monospace', fontSize: 9, lineHeight: 14 }, terminalPrompt: { color: '#252A31' }, terminalSuccess: { color: W.success }, terminalInputRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderWidth: 1, borderColor: W.border, borderRadius: 6 }, terminalPromptMark: { color: W.primary, fontFamily: 'monospace', fontSize: 11 }, terminalInput: { flex: 1, minWidth: 0, height: 44, padding: 0, color: W.text, fontFamily: 'monospace', fontSize: 9 }, terminalRun: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 5, backgroundColor: W.text }, terminalDisclaimer: { marginTop: 6, color: W.muted, fontSize: 8, textAlign: 'center' },
  reviewSummary: { minHeight: 57, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 9, borderWidth: 1, borderColor: W.border, borderRadius: 7 }, reviewIcon: { width: 27, height: 27, alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: W.surface }, reviewCopy: { flex: 1, gap: 3 }, reviewTitle: { color: W.text, fontSize: 10, fontWeight: '500' }, reviewSub: { color: W.secondary, fontSize: 9 }, reviewAccept: { height: 27, justifyContent: 'center', paddingHorizontal: 9, borderRadius: 5, backgroundColor: W.text }, reviewAcceptText: { color: W.bg, fontSize: 9, fontWeight: '500' }, diffFile: { overflow: 'hidden', borderWidth: 1, borderColor: W.border, borderRadius: 6 }, diffHeader: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8 }, diffFileName: { flex: 1, color: W.text, fontSize: 9 }, diffCount: { color: W.success, fontSize: 8.5 }, diffLines: { gap: 5, paddingHorizontal: 8, paddingVertical: 9, backgroundColor: '#F8F8F9' }, diffRemoved: { color: W.danger, fontFamily: 'monospace', fontSize: 8, lineHeight: 13 }, diffAdded: { color: W.success, fontFamily: 'monospace', fontSize: 8, lineHeight: 13 }, diffContext: { color: W.secondary, fontFamily: 'monospace', fontSize: 8, lineHeight: 13 }, reviewFooter: { gap: 7, paddingTop: 6 }, reviewFooterText: { color: W.secondary, fontSize: 9 }, reviewDiscuss: { color: W.primary, fontSize: 9, fontWeight: '500' },
  navigationScrim: { position: 'absolute', zIndex: 18, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.25)' }, navigationPanel: { position: 'absolute', zIndex: 19, top: 0, bottom: 0, left: 0, paddingHorizontal: 13, borderRightWidth: 1, borderColor: W.border, backgroundColor: W.bg, elevation: 12, shadowColor: '#000000', shadowOpacity: 0.13, shadowRadius: 16, shadowOffset: { width: 4, height: 0 } }, navigationHeader: { height: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, navigationTitle: { color: W.text, fontSize: 14, fontWeight: '600' }, newTaskButton: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 8, borderWidth: 1, borderColor: W.border, borderRadius: 6 }, newTaskLabel: { flex: 1, color: W.text, fontSize: 10 }, newTaskShortcut: { color: W.muted, fontSize: 9 }, navigationSection: { marginTop: 18, marginBottom: 7, color: W.muted, fontSize: 9, fontWeight: '600' }, projectItem: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }, projectGlyph: { width: 27, height: 27, alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: W.primarySoft }, projectInfo: { flex: 1, minWidth: 0, gap: 3 }, projectTitle: { color: W.text, fontSize: 10, fontWeight: '500' }, projectPath: { color: W.muted, fontSize: 8.5 }, navigationSectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, threadList: { flex: 1, minHeight: 0 }, threadListContent: { gap: 2 }, threadRow: { minHeight: 35, flexDirection: 'row', alignItems: 'center', gap: 1, paddingLeft: 7, paddingRight: 3, borderRadius: 5 }, threadOpenButton: { flex: 1, minWidth: 0, minHeight: 35, flexDirection: 'row', alignItems: 'center', gap: 8 }, threadMoreButton: { width: 26, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 4 }, threadRowSelected: { backgroundColor: W.surface }, threadRowText: { flex: 1, color: W.secondary, fontSize: 10 }, threadRowTextSelected: { color: W.text, fontWeight: '500' }, threadActionMenu: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 7, paddingBottom: 5 }, threadAction: { minHeight: 26, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 6, borderWidth: 1, borderColor: W.border, borderRadius: 4 }, threadActionText: { color: W.secondary, fontSize: 8 }, navigationAccount: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: W.border }, accountGlyph: { width: 27, height: 27, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: W.surface },
  scrim: { position: 'absolute', zIndex: 4, top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.24)' },
});
