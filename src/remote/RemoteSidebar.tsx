import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Modal, Pressable, ScrollView, SectionList, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import { AppDialog, useReducedMotion } from '../components/ui';
import { themed, useDesk } from '../theme';
import type { Space } from '../state/AppContext';
import type { AgentProfile, ClaudeDesktopScope, SessionInfo, ToolId, WorkspaceMode } from './client';
import { remoteDeviceConnected } from './connection-state';
import { agentSessions, agentSupports, groupSessionsByProject, sessionKeyAgentId, sessionWorkspaceMode, type SessionProjectGroup } from './projection';
import { loadClaudeDesktopHistory, loadMoreSessions, loadNativeSessions, loadSessions, remoteDeliveryScope, timelineKey, useRemote, type TimelineItem } from './store';
import {conversationReadScope} from './conversation-unread';
import {UnreadResultDot,useConversationResultIndex} from './ConversationUnread';
import { ToolBadge, relTime } from './parts';
import { boundedAgentLabel, childAgentTitle } from './conversation-metadata';
import type { ReferencePreview } from './ContextReferencePicker';
import { RemoteFiles, type RemoteFileTarget } from './RemoteFiles';
import { useThreadTitles } from './thread-titles';
import { ArchivedSessions } from './ArchivedSessions';
import { hubSupportsSessionActions } from './store';
import { SkeletonGroup, SkeletonRows } from '../components/Skeleton';
import { SessionQuickActionsSheet } from './SessionQuickActionsSheet';
import type { FileEdit } from './blocks';
import { DiffView } from './parts';
import { RemoteToolPreview, type RemoteToolPreviewTarget } from './RemoteToolPreview';
import { ToolbarButton } from './WorkbenchToolbar';
import { SidebarChevron, SidebarSessionRow, SidebarTaskIndicator } from './SidebarMotion';
import { sidebarSessionStatus } from './sidebar-session-status';
import { directorySessionActivities } from './directory-session-activity';
import { useSidebarPresence } from './useSidebarPresence';
import { closeWorkspacePage, initialWorkspacePages, WorkspaceNewPage, WorkspaceTabBar, type WorkspacePage, type WorkspacePageKind } from './WorkspaceTabs';
import { discardWorkspaceFileDraft, hasWorkspaceFileDraft } from './workspace-file-drafts';
import { RemoteTerminalPage } from './RemoteTerminalPage';
import { RemoteBrowserPage } from './RemoteBrowserPage';
import { browserPageTitle, matchingBrowserTab, useBrowserActivityEvents, workspaceBrowserTarget, type BrowserOpenRequest } from './workspace-browser';
import { useWorkspaceShortcuts } from './useWorkspaceShortcuts';
import {useWorkspaceLayoutControls} from './WorkspaceLayoutContext';
import { useWorkspaceLayout } from './workspace-layout';
import {RemoteReviewPage} from './RemoteReviewPage';
import {DiffAnnotationEditor} from './DiffAnnotationEditor';
import type {ContextReference} from './context-references';
import { SubagentManager } from './SubagentManager';
import { useWorkspaceRuntime } from './WorkspaceRuntimeContext';
import { ComputerUsePage } from './ComputerUsePage';
import {liveComputerActivityIds} from './computer-activity';
import { agentDisplayName } from './agent-catalog';
import type {AttachmentRef} from './client';
import type {ConversationArtifactTarget} from './conversation-artifact-target';
import {ConversationArtifactPreview} from './ConversationArtifactPreview';
import { RemoteProjectPreview } from './RemoteProjectPreview';

type SidebarSession = SessionInfo & { child?: boolean; parent?: boolean; unknown?: boolean; parentTitle?: string; childAccessibilityLabel?: string };
type SidebarSection = SessionProjectGroup & { data: SidebarSession[] };
const PER_PROJECT = 6;

function childToolLabel(tool: string): string {
  return agentDisplayName(tool);
}

/**
 * Unknown child handles have no server-provided title.  Keep the generic
 * title in the accessibility label for compatibility, while making the
 * visible row deterministic and distinct from the nested tool row in the
 * parent conversation.
 */
function childDisplayTitle(sessionKey: string, tool: string, title?: string): { title: string; accessibilityLabel: string } {
  const base = title?.trim() || '子智能体';
  const accessibilityLabel = `打开${base}`;
  if (base !== '子智能体') return { title: base, accessibilityLabel };
  const handle = sessionKey.split(':').slice(1).join(':').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 24);
  const suffix = [childToolLabel(tool), handle].filter(Boolean).join(' · ');
  return { title: `子智能体 · ${suffix}`, accessibilityLabel: '打开子智能体' };
}

export interface RemoteSidebarProps {
  visible: boolean;
  deviceId: string;
  agent: AgentProfile;
  activeSessionKey?: string | null;
  /** The open thread's sticky execution surface; never infer a fallback from a stale directory. */
  controlSurface?: 'cli' | 'desktop' | 'read-only';
  childSessionKeys?: string[];
  parentSessionKey?: string | null;
  focusSessionKey?: string | null;
  fileTarget?: RemoteFileTarget | null;
  previewTarget?: RemoteToolPreviewTarget | null;
  previewOpenNonce?: number;
  /** Only explicit conversation-card opens create an interface preview tab. */
  artifactScope?:string;
  artifactTarget?:{target:ConversationArtifactTarget;nonce:number}|null;
  diffTarget?: FileEdit | null;
  reviewTarget?: {files: FileEdit[]; nonce: number} | null;
  /** Changes on every explicit open so reopening the same file reselects Code. */
  diffOpenNonce?: number;
  onOpenDiffFullscreen?: () => void;
  onClose: () => void;
  onOpenSession: (sessionKey: string) => void;
  onNew?: (mode?: WorkspaceMode) => void;
  onOpenCommands?: () => void;
  onOpenModel?: () => void;
  onReference?: (value: ReferencePreview) => void;
  /** Tablet layout: the rail stays open beside the conversation, with no scrim or slide. */
  docked?: boolean;
  /** Let a resizable tablet frame own the docked column width. */
  dockedWidth?: ViewStyle['width'];
  /** Navigation lives left of the thread; tools and file changes live on the right. */
  mode?: 'navigation' | 'tools';
  side?: 'left' | 'right';
  fileEdits?: FileEdit[];
  toolActivities?: Extract<TimelineItem, { kind: 'tool' }>[];
  workspaceMode?: WorkspaceMode;
  onWorkspaceModeChange?: (mode: WorkspaceMode) => void;
  activeSpace?: Space;
  onSwitchSpace?: (space: Space) => void;
  /** Stateful side chat remains mounted; the render function receives whether
   * its tab is actually visible so a hidden drawer cannot read or send. */
  sideChat?: React.ReactNode | ((visible: boolean, tabId?:string) => React.ReactNode);
  sideChatHistory?: (visible:boolean)=>React.ReactNode;
  onCompose?: (text:string)=>boolean|void;
  onReviewReference?: (reference:ContextReference)=>boolean|void;
  sideChatOpenNonce?: number;
  onComputerUseStop?:()=>void;
  computerUseStopPending?:boolean;
  onComputerUseImage?:(uri:string)=>void;
  onComputerUseAttachment?:(ref:AttachmentRef)=>void;
}

/**
 * A compact Codex-style navigation rail for the phone. It is deliberately
 * read-only: opening it does not start a task or change the selected API.
 * The child section is built from the parent event's real session handles; an
 * unknown handle gets a neutral title and the official Agent icon inferred from
 * its protocol namespace, never from free-form text.
 */
export function RemoteSidebar({ docked = false, dockedWidth, mode = 'navigation', side = 'right', fileEdits = [], toolActivities = [], visible, deviceId, agent, activeSessionKey, controlSurface, childSessionKeys = [], parentSessionKey, focusSessionKey, fileTarget, previewTarget, previewOpenNonce, artifactScope, artifactTarget, diffTarget, diffOpenNonce, reviewTarget, onOpenDiffFullscreen, onClose, onOpenSession, onNew, onOpenCommands, onOpenModel, onReference, workspaceMode = 'code', onWorkspaceModeChange, sideChat, sideChatHistory, onCompose, onReviewReference, sideChatOpenNonce, onComputerUseStop, computerUseStopPending, onComputerUseImage, onComputerUseAttachment }: RemoteSidebarProps) {
  const dk = useDesk();
  const insets = useSafeAreaInsets();
  const layoutControls=useWorkspaceLayoutControls();
  const styles = useStyles();
  const hubRemote = useRemote();
  const workspaceRuntime = useWorkspaceRuntime();
  const remote = workspaceRuntime?.remote ?? hubRemote;
  const hubTitleOf = useThreadTitles();
  const titleOf = workspaceRuntime ? (_device: string | null | undefined, _key: string | null | undefined, fallback: string) => fallback : hubTitleOf;
  const pairingScope = workspaceRuntime?.scope ?? (typeof remoteDeliveryScope === 'function' ? remoteDeliveryScope() : '');
  const reduced = useReducedMotion();
  const directoryMode = workspaceMode;
  const [selectedTab, setTab] = useState<'sessions' | 'archived' | WorkspacePageKind>('sessions');
  const pageSequence = useRef(0);
  const dirtyPages = useRef(new Set<string>());
  const dirtyPageFiles=useRef(new Map<string,{path:string;cwd:string}>());
  const [discardPage, setDiscardPage] = useState<{scope: string; id: string} | null>(null);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [selectedEdit, setSelectedEdit] = useState<FileEdit | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [actionSession, setActionSession] = useState<{ session: SidebarSession; connectionId: string | null } | null>(null);
  const [retryOwner, setRetryOwner] = useState<object | null>(null);
  const [, updateLeaseClock] = useState(0);
  const entry = remote.sessions[deviceId];
  const device = remote.devices.find(item => item.deviceId === deviceId);
  const online = remoteDeviceConnected(remote, device);
  // A previously fetched native directory must not hijack a CLI thread's
  // sidebar. Conversely, an expired native lease must not turn its thread
  // into CLI control. Select the surface from this exact conversation.
  const activeTimeline = activeSessionKey ? remote.timelines[timelineKey(deviceId, activeSessionKey)] : undefined;
  const activeInfo = activeSessionKey ? activeTimeline?.session
    ?? Object.values(entry?.readOnly ?? {}).flatMap(directory => directory?.list ?? []).find(item => item.sessionKey === activeSessionKey)
    ?? entry?.native?.list.find(item => item.sessionKey === activeSessionKey)
    ?? entry?.list.find(item => item.sessionKey === activeSessionKey) : undefined;
  const native = agent.id === 'codex' && (controlSurface !== undefined ? controlSurface === 'desktop' : Boolean(activeInfo?.controlSurface === 'desktop'
    || (activeSessionKey && agent.desktopLive?.sessionKeys?.includes(activeSessionKey))));
  const nativeLeaseValid = !native || Boolean(agent.desktopLive && agent.desktopLive.expiresAt > Date.now() && agent.desktopLive.capabilities?.list);
  const readOnly = controlSurface === 'read-only' || activeInfo?.controlSurface === 'read-only' || Boolean(activeSessionKey?.startsWith('claude-desktop:'));
  const readOnlyScope: ClaudeDesktopScope | undefined = readOnly && (activeInfo?.sessionScope === 'desktop-chat' || activeInfo?.sessionScope === 'desktop-cowork') ? activeInfo.sessionScope : undefined;
  const history = agent.id === 'claude-desktop' ? agent.desktopHistory : undefined;
  // Array props can be recreated by parents (and the default value is also
  // freshly allocated on each render). Keep tab-reset logic tied to whether
  // the child tab should be the default, rather than the array reference;
  // otherwise opening Files can immediately reset the user's selection.
  const preferAgentsTab = childSessionKeys.length > 0 || Boolean(focusSessionKey && childSessionKeys.includes(focusSessionKey));
  const historyValid = Boolean(readOnlyScope && history?.available && history.identity && history.scopes.includes(readOnlyScope));
  const savedHistory = readOnlyScope ? entry?.readOnly?.[readOnlyScope] : undefined;
  const validHistory = savedHistory?.identity === history?.identity ? savedHistory : undefined;
  const selectedDirectory = readOnly ? validHistory : native ? entry?.native : entry;
  const page = readOnly ? validHistory : native ? entry?.native : entry?.pages?.[agent.id];
  const directoryError = page?.error ?? (!native && !readOnly && !page ? entry?.error : undefined);
  const errorPage = page?.errorPage ?? (!native && !readOnly && !page ? entry?.errorPage : undefined);
  const retryHead = Boolean(directoryError && (errorPage === 'head' || !page?.nextCursor));
  const canList = readOnly ? historyValid : native ? nativeLeaseValid : agentSupports(agent, agent.id, 'list');
  const archivesAllowed = !workspaceRuntime && !native && !readOnly && online && typeof hubSupportsSessionActions === 'function' && hubSupportsSessionActions() && agentSupports(agent, agent.id, 'archivedSessions');
  // An explicit retry may check a temporarily disconnected paired computer.
  // It is still a single read, not an automatic presence loop or task send.
  const canReadDirectory = online || Boolean(directoryError && remote.connection === 'error' && device?.online === true
    && remote.connections?.some(item => item.id === remote.connectionId && item.deviceId === deviceId && item.hubUrl === remote.selectedHubUrl));
  const filesAllowed = Boolean(!readOnly && activeSessionKey && activeInfo?.cwd && online && device?.capabilities?.includes('workspace.files.v1')
    && (!native || nativeLeaseValid && agent.desktopLive?.capabilities?.read && agent.desktopLive.sessionKeys.includes(activeSessionKey)));
  const operationIdentity = JSON.stringify([pairingScope, remote.connectionId, remote.selectedHubUrl, deviceId, agent.id, activeSessionKey, native, readOnly, readOnlyScope, artifactScope,
    history?.identity, history?.available, history?.scopes, agent.available, agent.capabilities?.list, agent.desktopLive?.expiresAt, agent.desktopLive?.capabilities?.list, agent.desktopLive?.capabilities?.read, agent.desktopLive?.sessionKeys]);
  const operationOwner = useRef({ visible, identity: operationIdentity });
  if (operationOwner.current.visible !== visible || operationOwner.current.identity !== operationIdentity) operationOwner.current = { visible, identity: operationIdentity };
  const renderedOwner = operationOwner.current;
  const pageScope = JSON.stringify([pairingScope, remote.connectionId, remote.selectedHubUrl, deviceId, agent.id, activeSessionKey, workspaceMode, native, readOnly]);
  const {present,progress}=useSidebarPresence({visible,docked,scopeKey:pageScope,reduced});
  const [pageState, setPageState, layoutError, layoutReady, retryLayout] = useWorkspaceLayout(pageScope, mode === 'tools');
  const scopedPages = pageState.scope === pageScope ? pageState.pages : initialWorkspacePages();
  const pages = scopedPages.filter(page=>page.kind!=='artifact'||Boolean(artifactScope&&page.artifact?.scopeKey===artifactScope));
  const requestedPageId = pageState.scope === pageScope ? pageState.activeId : 'newtab';
  const activePageId = pages.some(page=>page.id===requestedPageId)?requestedPageId:pages[0]?.id??'newtab';
  const activePage = pages.find(page => page.id === activePageId);
  const artifactOwner=useRef({scope:artifactScope,activeId:activePageId});artifactOwner.current={scope:artifactScope,activeId:activePageId};
  const observedArtifact=useRef('');
  const tabbedTools = mode === 'tools';
  const tab = tabbedTools ? activePage?.kind ?? 'newtab' : selectedTab;
  const liveComputerIds=useMemo(()=>activeTimeline?.cachedAt||activeTimeline?.loading||activeTimeline?.error?new Set<string>():liveComputerActivityIds(toolActivities,activeTimeline?.items??[],activeInfo),[toolActivities,activeTimeline,activeInfo]);
  const observedComputer=useRef<{scope:string;ids:Set<string>}>({scope:pageScope,ids:new Set()});
  useEffect(()=>{
    if(!tabbedTools||!layoutReady||!online)return;
    if(observedComputer.current.scope!==pageScope)observedComputer.current={scope:pageScope,ids:new Set()};
    const running=toolActivities.filter(item=>liveComputerIds.has(item.id));
    const fresh=running.some(item=>!observedComputer.current.ids.has(item.id));
    for(const item of running)observedComputer.current.ids.add(item.id);
    if(observedComputer.current.ids.size>512)observedComputer.current.ids=new Set(running.map(item=>item.id));
    if(fresh)setPageState(current=>current.scope!==pageScope||current.pages.length>=48||current.pages.some(page=>page.kind==='computer')?current:{...current,pages:[...current.pages,{id:'computer',kind:'computer',title:'电脑操作'}]});
  },[tabbedTools,layoutReady,online,pageScope,toolActivities,liveComputerIds,setPageState]);
  const selectPage = (page: WorkspacePage) => { setPageState(current => ({ scope: pageScope, pages: current.scope === pageScope ? current.pages : initialWorkspacePages(), activeId: page.id })); setTab(page.kind); };
  const openPage = (page: WorkspacePage) => {
    setPageState(current => {
      const currentPages = current.scope === pageScope ? current.pages : initialWorkspacePages();
      return { scope: pageScope, pages: currentPages.some(item => item.id === page.id) ? currentPages.map(item => item.id === page.id ? page : item) : [...currentPages, page], activeId: page.id };
    });
    setTab(page.kind);
  };
  const closePage = (id: string, discard = false) => {
    if (!stillWanted()) return;
    if (!discard && dirtyPages.current.has(`${pageScope}:${id}`)) { setDiscardPage({scope:pageScope,id}); return; }
    const targetFile = pages.find(page => page.id === id)?.file;
    const closingFile=dirtyPageFiles.current.get(`${pageScope}:${id}`)??(targetFile?{path:targetFile.path,cwd:targetFile.expectedCwd}:undefined);
    const anotherDirtyOwner=closingFile&&pages.some(page=>{
      if(page.id===id||!dirtyPages.current.has(`${pageScope}:${page.id}`))return false;
      const file=dirtyPageFiles.current.get(`${pageScope}:${page.id}`);
      return file?.cwd===closingFile.cwd&&file.path===closingFile.path;
    });
    // A hidden preview and an independent tab share one durable file draft.
    if (discard && closingFile && activeSessionKey && !anotherDirtyOwner) discardWorkspaceFileDraft({scope:pairingScope,deviceId,agentId:agent.id,sessionKey:activeSessionKey,surface:native?'desktop':'cli',cwd:closingFile.cwd,path:closingFile.path});
    dirtyPages.current.delete(`${pageScope}:${id}`);
    dirtyPageFiles.current.delete(`${pageScope}:${id}`);
    const next = closeWorkspacePage(pages, activePageId, id); const closed=pages.find(page=>page.id===id); setPageState(current=>({...current,...next,closedPages:closed?[...(current.closedPages??[]).filter(page=>page.id!==closed.id),closed].slice(-20):current.closedPages}));
  };
  useEffect(() => { for (const key of dirtyPages.current) if (!key.startsWith(`${pageScope}:`)) {dirtyPages.current.delete(key);dirtyPageFiles.current.delete(key);} }, [pageScope]);
  const openFilePage = (target: RemoteFileTarget) => openPage({ id: `file:${target.path}`, kind: 'files', title: target.path.split(/[\\/]/).pop() || target.path, file: target });
  const openDiffPage = (file: FileEdit) => openPage({ id: `diff:${file.path}`, kind: 'diff', title: file.path.split(/[\\/]/).pop() || file.path, diff: file });
  const openBrowserPage = (request: BrowserOpenRequest, foreground: boolean, replaceId?: string) => {
    const proposedId = replaceId ?? `browser:${++pageSequence.current}`;
    setPageState(current => {
      const currentPages = current.scope === pageScope ? current.pages : initialWorkspacePages();
      const existing = matchingBrowserTab(currentPages.filter(page => page.kind === 'preview').map(page => ({ id: page.id, url: page.preview?.url, pageId: page.browserPageId })), request);
      const id = replaceId ?? existing?.id ?? proposedId;
      const previous = currentPages.find(page => page.id === id);
      const page: WorkspacePage = { ...(previous?.kind === 'preview' ? previous : {}), id, kind: 'preview', title: browserPageTitle(request.target.url), preview: request.target, browserPageId: request.pageId ?? previous?.browserPageId };
      return { scope: pageScope, pages: previous ? currentPages.map(item => item.id === id ? page : item) : [...currentPages, page],
        activeId: foreground ? id : current.scope === pageScope ? current.activeId : 'newtab' };
    });
  };
  const navigateBrowserPage = (pageId: string, target: RemoteToolPreviewTarget) => {
    setPageState(current => current.scope !== pageScope ? current : { ...current,
      pages: current.pages.map(page => page.id === pageId ? { ...page, title: browserPageTitle(target.url), preview: target } : page) });
  };
  const directoryRetry = useRef<{ owner: typeof renderedOwner } | null>(null);
  const initialDirectoryRead = useRef<object | null>(null);
  const retryActive = retryOwner === renderedOwner;
  const directoryLoading = Boolean(page?.loading || selectedDirectory?.loading || retryActive);
  const mounted = useRef(true);
  const stillWanted = () => mounted.current && operationOwner.current === renderedOwner && renderedOwner.visible && (!tabbedTools || layoutReady);
  const revealPage=(page:WorkspacePage)=>{if(!mounted.current||!layoutReady)return;layoutControls?.setView('split');openPage(page);};
  const restorePage=()=>{const page=pageState.closedPages?.at(-1);if(!page||!layoutReady)return;setPageState(current=>({...current,pages:current.pages.some(item=>item.id===page.id)?current.pages:[...current.pages,{...page,...(page.kind==='terminal'?{restored:true}:{})}],activeId:page.id,closedPages:current.closedPages?.slice(0,-1)}));layoutControls?.setView('split');};
  const closeOthers=(id:string)=>{if(!stillWanted())return;setPageState(current=>{if(!current.pages.some(page=>page.id===id))return current;const removed=current.pages.filter(page=>page.id!==id&&!dirtyPages.current.has(`${pageScope}:${page.id}`));return {...current,pages:current.pages.filter(page=>!removed.includes(page)),activeId:id,closedPages:[...(current.closedPages??[]).filter(page=>!removed.some(item=>item.id===page.id)),...removed].slice(-20)};});};
  const cyclePage=(offset:number)=>{const index=pages.findIndex(page=>page.id===activePageId);const next=pages[(index+offset+pages.length)%pages.length];if(next)selectPage(next);};
  useWorkspaceShortcuts({active:tabbedTools&&layoutReady,visible,
    onBrowser:()=>revealPage({id:`newtab:${++pageSequence.current}`,kind:'newtab',title:'新标签页'}),
    onReview:()=>revealPage({id:'changes',kind:'changes',title:'审查'}),
    onSideChat:()=>revealPage({id:`side-chat:${++pageSequence.current}`,kind:'side-chat',title:'侧边聊天'}),
    onFiles:()=>revealPage({id:'files',kind:'files',title:'文件'}),
    onTerminal:()=>revealPage({id:`terminal:${++pageSequence.current}`,kind:'terminal',title:'终端'}),
    onClose:()=>closePage(activePageId),onRestore:restorePage,onPrevious:()=>cyclePage(-1),onNext:()=>cyclePage(1),onCloseOthers:()=>closeOthers(activePageId),
    onCycleLayout:()=>layoutControls?.setView(layoutControls.view==='hidden'?'split':layoutControls.view==='split'?'full':'hidden'),
    onToggleFull:()=>layoutControls?.setView(layoutControls.view==='full'?'split':'full'),
    onTogglePanel:()=>layoutControls?.setView(layoutControls.view==='hidden'?'split':'hidden'),
  });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!visible || !native || !agent.desktopLive) return;
    const remaining = agent.desktopLive.expiresAt - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => updateLeaseClock(value => value + 1), Math.min(remaining + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [visible, native, agent.desktopLive?.expiresAt]);

  useEffect(() => { setExpandedProjects({}); setCollapsedProjects({}); setActionSession(null); }, [deviceId, agent.id, pairingScope,workspaceMode]);
  useEffect(() => {
    setSelectedEdit(null); setSelectedToolId(null);
  }, [pageScope]);
  useEffect(() => { for (const page of [...pages,...(pageState.closedPages??[])]) { const suffix = Number(page.id.split(':').pop()); if (Number.isSafeInteger(suffix)) pageSequence.current = Math.max(pageSequence.current, suffix); } }, [pages,pageState.closedPages]);
  useBrowserActivityEvents(tabbedTools ? toolActivities : [], pageScope, request => openBrowserPage(request, false), {
    ready: layoutReady, seen: pageState.browserEvents, onSeen: keys => setPageState(current => ({ ...current, browserEvents: keys })),
  });
  useEffect(() => {
    if (!tabbedTools || !layoutReady || !previewTarget) return;
    const target = workspaceBrowserTarget(previewTarget.url);
    if (target) openBrowserPage({ target, pageId: previewTarget.pageId }, true);
  }, [pageScope, tabbedTools, layoutReady, previewTarget?.url, previewTarget?.pageId, previewOpenNonce]);
  useEffect(() => {
    if (tabbedTools && layoutReady && reviewTarget) openPage({id: `review:${reviewTarget.nonce}`, kind: 'changes', title: '本组变更', changes: reviewTarget.files});
  }, [pageScope, tabbedTools, layoutReady, reviewTarget?.nonce]);
  useEffect(() => {
    if (!tabbedTools) { setTab(previewTarget ? 'preview' : diffTarget ? 'diff' : fileTarget && filesAllowed ? 'files' : preferAgentsTab ? 'agents' : 'sessions'); return; }
    if (!layoutReady) return;
    if (diffTarget) openDiffPage(diffTarget);
    else if (fileTarget && filesAllowed) openFilePage(fileTarget);
    else setTab('changes');
  }, [pageScope, layoutReady, fileTarget?.nonce, diffTarget?.path, diffOpenNonce, preferAgentsTab, filesAllowed, mode, tabbedTools]);
  useEffect(() => {
    if (tabbedTools && layoutReady && sideChatOpenNonce) openPage({ id: `side-chat:${++pageSequence.current}`, kind: 'side-chat', title: '侧边聊天' });
  }, [tabbedTools, layoutReady, pageScope, sideChatOpenNonce]);
  useEffect(()=>{
    if(!tabbedTools||!artifactTarget)return;
    const {target,nonce}=artifactTarget;
    const request=JSON.stringify([target.scopeKey,target.messageId,target.index,target.revision,nonce]);
    if(observedArtifact.current===request)return;
    if(!artifactScope||target.scopeKey!==artifactScope){observedArtifact.current=request;return;}
    if(!layoutReady)return;
    observedArtifact.current=request;
    const id=`artifact:${JSON.stringify([target.scopeKey,target.messageId,target.index,target.revision])}`;
    openPage({id,kind:'artifact',title:target.title,artifact:target});
    layoutControls?.setView('split');
  },[tabbedTools,layoutReady,artifactScope,artifactTarget?.nonce,artifactTarget?.target.scopeKey,artifactTarget?.target.messageId,artifactTarget?.target.index,artifactTarget?.target.revision]);
  useEffect(()=>{
    if(!tabbedTools||!layoutReady)return;
    setPageState(current=>{
      const belongs=(page:WorkspacePage)=>page.kind!=='artifact'||Boolean(artifactScope&&page.artifact?.scopeKey===artifactScope);
      const next=current.pages.filter(belongs),closed=current.closedPages?.filter(belongs);
      if(next.length===current.pages.length&&closed?.length===current.closedPages?.length)return current;
      const kept=next.length?next:initialWorkspacePages();
      return {...current,pages:kept,closedPages:closed,activeId:kept.some(page=>page.id===current.activeId)?current.activeId:kept[0].id};
    });
  },[tabbedTools,layoutReady,artifactScope,pageScope,setPageState]);

  useEffect(() => {
    const missing = readOnly ? !selectedDirectory?.loaded : native ? !entry?.native?.loaded : !page;
    if (workspaceRuntime || !visible || !online || !canList || !missing || initialDirectoryRead.current === renderedOwner) return;
    initialDirectoryRead.current = renderedOwner;
    // Another Agent's directory does not satisfy this Agent's first read.
    // A current page records success, failure or an in-flight read; failure is
    // retried only by the footer, never by an automatic effect loop.
    if (readOnly && readOnlyScope && typeof loadClaudeDesktopHistory === 'function') void loadClaudeDesktopHistory(deviceId, readOnlyScope).catch(() => undefined);
    else if (native && typeof loadNativeSessions === 'function') void loadNativeSessions(deviceId).catch(() => undefined);
    else if (!readOnly && !native && typeof loadSessions === 'function') void loadSessions(deviceId, agent.id).catch(() => undefined);
  }, [visible, readOnly, readOnlyScope, native, online, canList, deviceId, agent.id, selectedDirectory?.loaded, entry?.native?.loaded, Boolean(page), renderedOwner]);

  const childKeySet = useMemo(() => new Set(childSessionKeys.filter(Boolean)), [childSessionKeys]);
  const directory = useMemo(() => {
    const source = selectedDirectory?.list ?? [];
    return agentSessions(source, agent).filter(item => !item.parentSessionKey && !childKeySet.has(item.sessionKey)
      && (readOnly ? item.controlSurface === 'read-only' && item.sessionScope === readOnlyScope : item.controlSurface !== 'read-only'));
  }, [agent, childKeySet, selectedDirectory?.list, readOnly, readOnlyScope]);
  const allDirectory = useMemo(() => {
    const source = [
      ...[...childSessionKeys, ...(parentSessionKey ? [parentSessionKey] : []), ...(focusSessionKey ? [focusSessionKey] : [])].flatMap(key => {
        const observed = remote.timelines[timelineKey(deviceId, key)]?.session;
        return observed && !readOnly && (native ? observed.controlSurface === 'desktop' : observed.controlSurface !== 'desktop' && observed.controlSurface !== 'read-only') ? [observed] : [];
      }),
      ...(selectedDirectory?.list ?? []),
    ];
    const seen = new Set<string>();
    return source.filter(item => { if (seen.has(item.sessionKey)) return false; seen.add(item.sessionKey); return true; });
  }, [selectedDirectory?.list, childSessionKeys, parentSessionKey, focusSessionKey, deviceId, remote.timelines, native, readOnly]);
  const childRows = useMemo<SidebarSession[]>(() => [...new Set(childSessionKeys)].filter(Boolean).map((key) => {
    const known = allDirectory.find(item => item.sessionKey === key);
    const tool = known?.tool ?? key.split(':', 1)[0] as ToolId;
    if (known) {
      const display = childDisplayTitle(key, tool, childAgentTitle(known));
      return { ...known, title: display.title, childAccessibilityLabel: display.accessibilityLabel, child: true, parentTitle: '当前任务' };
    }
    const display = childDisplayTitle(key, tool);
    return { sessionKey: key, tool, client: childToolLabel(tool), title: display.title, childAccessibilityLabel: display.accessibilityLabel, cwd: '', updatedAt: 0, status: 'idle', controllable: false, child: true, unknown: true, parentTitle: '当前任务' };
  }), [allDirectory, childSessionKeys]);
  const parentRow = useMemo<SidebarSession | undefined>(() => {
    if (!parentSessionKey || parentSessionKey === activeSessionKey || !/^[A-Za-z0-9._-]{1,64}:[^|\u0000-\u001f\u007f]{1,160}$/.test(parentSessionKey)) return;
    const known = allDirectory.find(item => item.sessionKey === parentSessionKey);
    if (known) return { ...known, parent: true };
    const tool = parentSessionKey.split(':', 1)[0] as ToolId;
    return { sessionKey: parentSessionKey, tool, client: childToolLabel(tool), title: '主任务', cwd: '', updatedAt: 0, status: 'idle', controllable: false, parent: true, unknown: true };
  }, [parentSessionKey, activeSessionKey, allDirectory]);
  // Chat/Cowork history belongs to Work and is separated by its read-only scope.
  // Older Bridge sessions use the shared path-based Code/Work fallback.
  const modeDirectory = useMemo(() => directory.filter(item => sessionWorkspaceMode(item) === directoryMode), [directory, directoryMode]);
  useConversationResultIndex(modeDirectory.map(session=>({scope:conversationReadScope(pairingScope,deviceId,agent,directoryMode),session,timeline:remote.timelines[timelineKey(deviceId,session.sessionKey)],active:mode==='navigation'&&online&&canReadDirectory})));
  const navigationActivities = useMemo(() => mode === 'navigation' ? directorySessionActivities(allDirectory, agent, directoryMode, {
    pending:new Set(Object.values(remote.approvals ?? {}).filter(item=>item.deviceId===deviceId).map(item=>item.sessionKey)),
    statusFor:row=>sidebarSessionStatus(row,remote.timelines[timelineKey(deviceId,row.sessionKey)]),
  }) : new Map(), [mode,allDirectory,agent.id,agent.tool,directoryMode,remote.approvals,remote.timelines,deviceId]);
  const groups = useMemo(() => groupSessionsByProject(modeDirectory, { nativeOrder: native, nativeSessionOrder: native ? modeDirectory.map(item => item.sessionKey) : undefined,
    caseSensitivePaths: device?.os !== 'windows' }).map(group => ({ ...group, data: group.sessions as SidebarSession[] })), [modeDirectory, native, device?.os]);
  const parentSections: SidebarSection[] = parentRow ? [{ key: '__parent', name: '主任务', path: '', updatedAt: parentRow.updatedAt, sessions: [parentRow], data: [parentRow] }, ...groups.map(section => ({ ...section, data: section.data.filter(row => row.sessionKey !== parentRow.sessionKey) })).filter(section => section.data.length)] : groups;
  const focused = !readOnly && focusSessionKey && /^codex:[A-Za-z0-9_-]{1,160}$/.test(focusSessionKey) && !parentSections.some(section => section.data.some(row => row.sessionKey === focusSessionKey))
    ? allDirectory.find(row => row.sessionKey === focusSessionKey) ?? { sessionKey: focusSessionKey, tool: 'codex' as ToolId, client: 'Codex', title: '关联任务', cwd: '', updatedAt: 0, status: 'idle' as const, controllable: false, unknown: true } : undefined;
  const sections: SidebarSection[] = focused ? [{ key: '__linked', name: '关联任务', path: '', updatedAt: focused.updatedAt, sessions: [focused], data: [focused] }, ...parentSections] : parentSections;
  const activeProject=sections.find(section=>section.data.some(item=>item.sessionKey===activeSessionKey));
  useEffect(()=>{
    const group=activeProject;
    if(!group)return;
    setCollapsedProjects(current=>({...current,[group.key]:false}));
    if(group.data.findIndex(item=>item.sessionKey===activeSessionKey)>=PER_PROJECT)setExpandedProjects(current=>({...current,[group.key]:true}));
  },[activeSessionKey,deviceId,agent.id,workspaceMode,activeProject?.key]);
  const childSections: SidebarSection[] = childRows.length ? [{ key: '__children', name: '当前任务的子智能体', path: '', updatedAt: 0, sessions: childRows, data: childRows }] : [];
  const visibleSections = (tab === 'agents' ? childSections : sections).map(section => {
    const project = section.key === '__temporary' || section.key.startsWith('project:') || section.key === '__children';
    if (!project) return section;
    const collapsed = mode !== 'navigation' && collapsedProjects[section.key] === true;
    const all = expandedProjects[section.key] === true;
    return { ...section, data: collapsed ? [] : all ? section.data : section.data.slice(0, PER_PROJECT) };
  });
  const translate = progress.interpolate({ inputRange: [0, 1], outputRange: [side === 'left' ? -320 : 320, 0] });
  const panelOpacity = progress.interpolate({ inputRange: [0, 1], outputRange: [0, mode === 'navigation' ? 0.18 : 0.42] });
  // Browser contexts survive closing the drawer; display:none keeps it out of hit testing.
  if (!visible && !tabbedTools && !present) return null;
  const reviewFiles = activePage?.changes ?? fileEdits;
  const activeDiff = tabbedTools ? activePage?.diff ?? null : diffTarget ?? selectedEdit;
  const activeFileTarget = tabbedTools ? activePage?.file : fileTarget;
  const selectedToolActivity = toolActivities.find(item => item.id === selectedToolId);
  const content = <>
      {mode === 'navigation' ? <View style={styles.dockedNavTop}>
        <View testID="remote-navigation-header" style={styles.navigationHeader}>
          <View style={styles.navigationAvatar}><ToolBadge tool={agent.tool} client={agent.id === 'claude-desktop' ? 'Claude Desktop' : undefined} size={24} /></View>
          <View style={styles.navigationIdentity}><Text numberOfLines={1} style={styles.navigationTitle}>{agent.name}</Text><Text numberOfLines={1} style={styles.navigationSubtitle}>{device?.name || '电脑'} · {directoryMode === 'code' ? 'Code' : 'Work'}</Text></View>
          {!native && !readOnly && agent.remoteSendSupported && onNew ? <View><View pointerEvents="none" style={styles.navigationCreateSurface}/><ToolbarButton icon="compose" label={`新建 ${directoryMode === 'code' ? 'Code' : 'Work'} 对话`} disabled={!online || !agent.available}
            onPress={() => { if (!stillWanted() || !online || !agent.available) return; if (!docked) onClose(); onNew(directoryMode); }} /></View> : null}
          {!docked ? <ToolbarButton icon="close" label="关闭侧边栏" onPress={onClose}/> : null}
        </View>
        {docked && (onOpenCommands || onOpenModel) ? <View style={styles.dockedActionList}>
          {onOpenCommands ? <Pressable accessibilityRole="button" accessibilityLabel="打开技能与命令" onPress={() => { if (stillWanted()) onOpenCommands(); }} style={({ pressed }) => [styles.dockedAction, pressed && styles.pressed]}>
            <Text style={styles.dockedSlash}>/</Text><Text style={styles.dockedActionText}>技能与工作流</Text>
          </Pressable> : null}
          {onOpenModel ? <Pressable accessibilityRole="button" accessibilityLabel="打开 API 与模型设置" onPress={() => { if (stillWanted()) onOpenModel(); }} style={({ pressed }) => [styles.dockedAction, pressed && styles.pressed]}>
            <Icon name="sparkle" size={15} color={dk.muted} /><Text style={styles.dockedActionText}>API 与模型</Text>
          </Pressable> : null}
        </View> : null}
      </View> : docked ? null : <View style={styles.header}>
        <View style={styles.headerTitle}>
          <ToolBadge tool={agent.tool} client={agent.id === 'claude-desktop' ? 'Claude Desktop' : undefined} size={28} />
          <View style={{ flex: 1, minWidth: 0 }}><Text style={styles.title} numberOfLines={1}>{agent.name}</Text><Text style={styles.subtitle} numberOfLines={1}>{device?.name || '电脑会话'}</Text></View>
        </View>
        {!docked ? <Pressable accessibilityRole="button" accessibilityLabel="关闭侧边栏" hitSlop={10} onPress={onClose} style={styles.close}><Icon name="close" size={18} color={dk.muted} /></Pressable> : null}
      </View>}
      {tabbedTools && layoutError ? <View><Text accessibilityRole="alert" style={styles.toolHint}>{layoutError}</Text><Pressable accessibilityRole="button" accessibilityLabel="重试工作区恢复" onPress={retryLayout}><Text style={styles.toolHint}>重试</Text></Pressable></View> : null}
      {tabbedTools ? <WorkspaceTabBar pages={pages} activeId={activePageId}
        onSelect={page => { if (stillWanted()) { setSelectedToolId(null); selectPage(page); } }}
        onClose={id => closePage(id)} onCloseOthers={closeOthers} onRestore={pageState.closedPages?.length?restorePage:undefined}
        onAdd={() => { if (stillWanted()) openPage({ id: `newtab:${++pageSequence.current}`, kind: 'newtab', title: '新标签页' }); }} /> : mode === 'navigation' && !childRows.length && !archivesAllowed && !filesAllowed && !diffTarget && !previewTarget ? null : mode === 'navigation' || childRows.length || filesAllowed || archivesAllowed || diffTarget || previewTarget ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsContent}>{(mode === 'navigation' ? ['sessions', ...(childRows.length ? ['agents' as const] : []), ...(diffTarget ? ['diff' as const] : []), ...(filesAllowed ? ['files' as const] : []), ...(previewTarget ? ['preview' as const] : []), ...(archivesAllowed ? ['archived' as const] : [])] as const : ['sessions', ...(childRows.length ? ['agents' as const] : []), ...(diffTarget ? ['diff' as const] : []), ...(filesAllowed ? ['files' as const] : []), ...(previewTarget ? ['preview' as const] : []), ...(archivesAllowed ? ['archived' as const] : [])] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={value === 'sessions' ? '侧边栏对话' : value === 'agents' ? '侧边栏子智能体' : value === 'files' ? '侧边栏文件' : value === 'archived' ? '侧边栏归档' : value === 'diff' ? '侧边栏代码差异' : '侧边栏链接'} accessibilityState={{ selected: tab === value }}
        onPress={() => { if (stillWanted()) { setActionSession(null); setTab(value); } }} style={[styles.tab, tab === value && styles.selected]}><Text style={styles.tabText}>{value === 'sessions' ? '对话' : value === 'agents' ? `子智能体 ${childRows.length}` : value === 'files' ? '文件' : value === 'archived' ? '归档' : value === 'diff' ? '代码' : '链接'}</Text></Pressable>)}</ScrollView> : null}
      {discardPage?.scope === pageScope ? <AppDialog visible title="关闭未保存的文件？" message="文件有尚未保存的修改。关闭后会丢弃这个标签中的草稿。" onClose={() => setDiscardPage(null)} actions={[
        {label:'保留草稿',onPress:()=>setDiscardPage(null)},
        {label:'丢弃并关闭',tone:'danger',onPress:()=>{if(discardPage?.scope===pageScope)closePage(discardPage.id,true);setDiscardPage(null);}},
      ]}/> : null}
      {tabbedTools && layoutReady && activeSessionKey && !readOnly ? pages.filter(page => page.kind === 'files').map(page => <View key={`${pageScope}:${page.id}`} style={{flex:1,minHeight:0,display:tab === 'files' && activePageId===page.id?'flex':'none'}}>
        <RemoteFiles deviceId={deviceId} sessionKey={activeSessionKey} agentId={agent.id} surface={native?'desktop':'cli'} target={page.file}
          canMutatePath={path => !activeInfo?.cwd || !hasWorkspaceFileDraft({scope:pairingScope,deviceId,cwd:activeInfo.cwd,path})}
          onFileMutation={change => {
            if (!stillWanted() || change.action === 'create') return;
            setPageState(current => {
              const matched = current.pages.filter(item => item.file?.path === change.path);
              if (change.action === 'delete') {
                let next = { pages: current.pages, activeId: current.activeId };
                for (const item of matched) next = closeWorkspacePage(next.pages, next.activeId, item.id);
                return {...current,...next};
              }
              if (!change.destination) return current;
              return {...current,pages:current.pages.map(item => item.file?.path === change.path ? {...item,title:change.destination!.split('/').pop()!,file:{...item.file,path:change.destination!,nonce:++pageSequence.current}} : item)};
            });
          }}
          visible={visible && tab==='files' && activePageId===page.id} onDirtyChange={(dirty,file)=>{if(!stillWanted())return;const key=`${pageScope}:${page.id}`;if(dirty){dirtyPages.current.add(key);if(file)dirtyPageFiles.current.set(key,file);}else{dirtyPages.current.delete(key);dirtyPageFiles.current.delete(key);}}}
          onOpenFile={path=>{if(stillWanted()&&activeInfo?.cwd)openFilePage({path,nonce:++pageSequence.current,expectedCwd:activeInfo.cwd,sessionKey:activeSessionKey,surface:native?'desktop':'cli'});}}
          onOpenProjectPreview={!readOnly && device?.capabilities?.includes('workspace.project.preview.v1') ? sourcePath => {
            if (!stillWanted() || !activeInfo?.cwd) return;
            openPage({id:`project-preview:${sourcePath}`,kind:'project-preview',title:`预览 ${sourcePath.split('/').pop()}`,projectPreview:{sourcePath,
              selection:{deviceId,agentId:agent.id,sessionKey:activeSessionKey,surface:native?'desktop':'cli',cwd:activeInfo.cwd}}});
          } : undefined}
          onReference={!native && onReference?value=>{if(stillWanted())onReference(value);}:undefined}/>
      </View>):null}
      {tabbedTools && activeSessionKey ? pages.filter(page => page.kind === 'terminal').map(page => <View key={`${pageScope}:${page.id}`} style={{flex:1,minHeight:0,display:tab === 'terminal' && activePageId===page.id?'flex':'none'}}>
        {!readOnly && activeInfo?.cwd && device?.capabilities?.includes('workspace.terminal.v1') ? <RemoteTerminalPage deviceId={deviceId} sessionKey={activeSessionKey} agentId={agent.id} surface={native?'desktop':'cli'} cwd={activeInfo.cwd} active={visible && activePageId===page.id} connectOnMount={!page.restored}/>
          : <Text style={styles.toolHint}>当前电脑尚未开放交互终端，请更新电脑端并授权项目。</Text>}
      </View>):null}
      {tabbedTools && layoutReady ? pages.filter(page => page.kind === 'project-preview' && page.projectPreview).map(page => <View key={`${pageScope}:${page.id}`} style={{flex:1,minHeight:0,display:activePageId===page.id?'flex':'none'}}>
        {!readOnly && page.projectPreview!.selection.deviceId===deviceId && page.projectPreview!.selection.agentId===agent.id
          && page.projectPreview!.selection.sessionKey===activeSessionKey && page.projectPreview!.selection.cwd===activeInfo?.cwd
          && page.projectPreview!.selection.surface===(native?'desktop':'cli')
          ? <RemoteProjectPreview selection={page.projectPreview!.selection} sourcePath={page.projectPreview!.sourcePath} active={visible&&activePageId===page.id}
            onCompose={onCompose?text=>{if(!stillWanted()||activePageId!==page.id)return false;return onCompose(text);}:undefined}/>
          : <Text style={styles.toolHint}>项目来源已变化，请从当前源文件重新打开预览</Text>}
      </View>):null}
      {tabbedTools && layoutReady ? pages.filter(page => page.kind === 'preview').map(page => <View key={`${pageScope}:${page.id}`} testID={`browser-tab-content:${page.id}`}
        style={{ flex: 1, minHeight: 0, display: tab === 'preview' && activePageId === page.id ? 'flex' : 'none' }}>
        <RemoteBrowserPage onCompose={onCompose?text=>{if(!stillWanted())return false;return onCompose(text);}:undefined} target={page.preview} active={visible && activePageId === page.id}
          initialScroll={!page.browserScroll?.url || page.browserScroll.url===page.preview?.url ? page.browserScroll : undefined} onScrollChange={scroll=>setPageState(current=>{
            const previous=current.pages.find(item=>item.id===page.id)?.browserScroll;
            return previous?.x===scroll.x&&previous.y===scroll.y&&previous.url===scroll.url?current:{...current,pages:current.pages.map(item=>item.id===page.id?{...item,browserScroll:scroll}:item)};
          })}
          initialHistory={page.browserHistory} onHistoryChange={history => setPageState(current => ({...current,pages:current.pages.map(item=>item.id===page.id?{...item,browserHistory:history}:item)}))}
          computer={!readOnly && activeSessionKey && activeInfo?.cwd ? {deviceId,sessionKey:activeSessionKey,agentId:agent.id,surface:native?'desktop':'cli',cwd:activeInfo.cwd}:undefined}
          onNavigate={target => navigateBrowserPage(page.id, target)} onOpenNew={target => { if (stillWanted()) openBrowserPage({ target }, true); }} />
      </View>) : null}
      {tabbedTools&&layoutReady?pages.filter(page=>page.kind==='artifact'&&page.artifact?.scopeKey===artifactScope).map(page=><View key={`${pageScope}:${page.id}`} testID={`artifact-tab-content:${page.id}`} style={{flex:1,minHeight:0,display:tab==='artifact'&&activePageId===page.id?'flex':'none'}}>
        <ConversationArtifactPreview target={page.artifact!} active={visible&&activePageId===page.id} onCompose={onCompose?text=>{
          if(!stillWanted()||artifactOwner.current.scope!==page.artifact!.scopeKey||artifactOwner.current.activeId!==page.id)return false;
          return onCompose(text);
        }:undefined}/>
      </View>):null}
      {tabbedTools && layoutReady ? pages.filter(page=>page.kind==='git'||page.kind==='changes').map(page=><View key={`${pageScope}:${page.id}`} style={{flex:1,minHeight:0,display:activePageId===page.id?'flex':'none'}}>
        {activeSessionKey?<RemoteReviewPage active={visible&&activePageId===page.id} selection={{deviceId,agentId:agent.id,sessionKey:activeSessionKey,surface:native?'desktop':'cli',cwd:activeInfo?.cwd??''}} lastTurn={page.changes??fileEdits} initialScope={page.changes?'last-turn':'unstaged'} readOnlyLastTurn={readOnly||!activeInfo?.cwd||!device?.capabilities?.includes('workspace.git.review.v1')} onOpenFile={activeInfo?.cwd?path=>{if(stillWanted())openFilePage({path,nonce:++pageSequence.current,expectedCwd:activeInfo.cwd,sessionKey:activeSessionKey,surface:native?'desktop':'cli'});}:undefined} onReference={onReviewReference?value=>{if(stillWanted())return onReviewReference(value);return false;}:undefined} onCompose={onCompose?text=>{if(!stillWanted())return false;return onCompose(text);}:undefined}/>:<Text style={styles.toolHint}>进入会话后可查看审查内容</Text>}
      </View>):null}
      {tabbedTools && layoutReady ? pages.filter(page => page.kind === 'side-chat').map(page => {
        const pageVisible = visible && tab === 'side-chat' && activePageId === page.id;
        return <View key={`${pageScope}:${page.id}`} testID="remote-side-chat-tab" style={{ flex: 1, minHeight: 0, display: pageVisible ? 'flex' : 'none' }}>
          {typeof sideChat === 'function' ? sideChat(pageVisible,page.id) : sideChat ?? <Text style={styles.toolHint}>当前 Agent 暂不支持侧边聊天</Text>}
        </View>;
      }) : null}
      {tabbedTools&&layoutReady&&pages.some(page=>page.kind==='side-history')?<View style={{flex:1,minHeight:0,display:tab==='side-history'?'flex':'none'}}>{sideChatHistory?.(visible&&tab==='side-history')??<Text style={styles.toolHint}>没有可用的侧问历史</Text>}</View>:null}
      {tabbedTools&&layoutReady&&pages.some(page=>page.kind==='computer')?<View key={`computer:${pageScope}`} style={{flex:1,minHeight:0,display:tab==='computer'?'flex':'none'}}><ComputerUsePage items={toolActivities} active={visible&&tab==='computer'} connected={online} sessionRunning={activeInfo?.status==='running'||activeInfo?.status==='waiting_approval'} liveActivityIds={liveComputerIds} waitingApproval={activeInfo?.status==='waiting_approval'} onStop={onComputerUseStop?()=>{if(stillWanted())onComputerUseStop();}:undefined} stopPending={computerUseStopPending} onImage={onComputerUseImage?uri=>{if(stillWanted())onComputerUseImage(uri);}:undefined} onAttachment={onComputerUseAttachment?ref=>{if(stillWanted())onComputerUseAttachment(ref);}:undefined}/></View>:null}
      {tabbedTools && !layoutReady ? <Text style={styles.toolHint}>{layoutError ? '恢复失败，请重试' : '正在恢复工作区…'}</Text> : tabbedTools && tab === 'newtab' ? <WorkspaceNewPage historyAvailable={Boolean(sideChatHistory)} onOpen={page => {
        if (!stillWanted()) return;
        if(page.kind==='preview'&&page.preview){openBrowserPage({target:page.preview},true,activePageId);return;}
        openPage(page.kind === 'terminal'||page.kind==='side-chat' ? {...page,id:`${page.kind}:${++pageSequence.current}`} : page.kind === 'preview' ? { id: `browser:${++pageSequence.current}`, kind: 'preview', title: '浏览器' } : page);
      }} />
        : tabbedTools && (tab === 'artifact' || tab === 'computer' || tab === 'side-chat' || tab === 'side-history' || tab === 'preview' || tab === 'terminal' || tab === 'files' && !readOnly && Boolean(activeSessionKey)) ? null
        : mode === 'tools' && (tab === 'git'||tab==='changes') ? null
        : mode === 'tools' && tab === 'agents' && activeSessionKey ? <SubagentManager key={pageScope} visible={visible} selection={{deviceId,parentSessionKey:activeSessionKey,agent,surface:readOnly?'read-only':native?'desktop':'cli',children:childSessionKeys}} onOpenSession={key=>{if(stillWanted()){onClose();onOpenSession(key);}}}/>
        : mode === 'tools' && tab === 'tools' ? <View testID="remote-tool-activity" style={styles.toolPane}>
          {selectedToolActivity ? <>
            <View style={styles.toolHead}>
              <Pressable accessibilityRole="button" accessibilityLabel="返回工具调用列表" onPress={() => { if (stillWanted()) setSelectedToolId(null); }} style={styles.toolBack}><Icon name="chevronLeft" size={16} color={dk.muted} /></Pressable>
              <View style={styles.toolTitle}><Text style={styles.sectionTitle} numberOfLines={1}>{selectedToolActivity.title}</Text><Text style={styles.sectionPath} numberOfLines={1}>{selectedToolActivity.detail || selectedToolActivity.tool}</Text></View>
              <Text style={[styles.toolStatus, { color: selectedToolActivity.status === 'running' ? dk.accentText : selectedToolActivity.status === 'failed' ? dk.bad : selectedToolActivity.status === 'interrupted' ? dk.warn : dk.ok }]}>{selectedToolActivity.status === 'running' ? '运行中' : selectedToolActivity.status === 'failed' ? '失败' : selectedToolActivity.status === 'interrupted' ? '已中断' : '已完成'}</Text>
            </View>
            <ScrollView style={styles.toolContent} contentContainerStyle={styles.toolDetailContent} showsVerticalScrollIndicator={false}>
              {selectedToolActivity.output ? <Text selectable style={styles.toolOutput}>{selectedToolActivity.output}</Text> : <Text style={styles.toolHint}>{selectedToolActivity.detail || '此调用没有返回额外内容'}</Text>}
              {typeof selectedToolActivity.exitCode === 'number' ? <Text style={[styles.toolExit, { color: selectedToolActivity.exitCode === 0 ? dk.ok : dk.bad }]}>退出码 {selectedToolActivity.exitCode}</Text> : null}
              {selectedToolActivity.durationMs ? <Text style={styles.toolHint}>用时 {Math.max(1, Math.round(selectedToolActivity.durationMs / 1000))} 秒</Text> : null}
            </ScrollView>
          </> : <>
            <View style={styles.toolHead}><View style={styles.toolTitle}><Text style={styles.sectionTitle}>工具调用</Text><Text style={styles.sectionPath} numberOfLines={1}>{toolActivities.length ? `${toolActivities.length} 条记录` : '暂无工具调用'}</Text></View></View>
            <ScrollView style={styles.toolContent} showsVerticalScrollIndicator={false}>
              {[...toolActivities].reverse().map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`查看工具调用：${item.title}`} onPress={() => { if (stillWanted()) setSelectedToolId(item.id); }} style={styles.toolActivityRow}>
                <View style={[styles.toolActivityIcon, { backgroundColor: item.status === 'failed' ? dk.badSoft : item.status === 'running' ? dk.accentSoft : dk.surface3 }]}><Icon name={item.tool === 'command' ? 'terminal' : item.tool === 'plan' ? 'listCheck' : item.tool === 'read' ? 'file' : item.tool === 'skill' ? 'sparkle' : 'code'} size={14} color={item.status === 'failed' ? dk.bad : item.status === 'running' ? dk.accentText : dk.muted} /></View>
                <View style={styles.changeBody}><Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text><Text style={styles.rowMeta} numberOfLines={1}>{item.detail || item.tool}</Text></View>
                <View style={styles.toolActivityMeta}><Text style={[styles.toolActivityStatus, { color: item.status === 'running' ? dk.accentText : item.status === 'failed' ? dk.bad : item.status === 'interrupted' ? dk.warn : dk.muted }]}>{item.status === 'running' ? '运行中' : item.status === 'failed' ? '失败' : item.status === 'interrupted' ? '中断' : '完成'}</Text><Text style={styles.sectionPath}>{relTime(item.ts)}</Text></View>
              </Pressable>)}
              {!toolActivities.length ? <Text style={styles.toolHint}>暂无工具调用</Text> : null}
            </ScrollView>
          </>}
        </View>
        : mode === 'tools' && tab === 'changes' && !activeDiff ? <View testID="remote-tool-changes" style={styles.toolPane}>
          <View style={styles.toolHead}><View style={styles.toolTitle}><Text style={styles.sectionTitle}>本次改动</Text><Text style={styles.sectionPath} numberOfLines={1}>{reviewFiles.length ? `${new Set(reviewFiles.map(file => file.path)).size} 个文件` : '暂无文件改动'}</Text></View></View>
          <ScrollView style={styles.toolContent} showsVerticalScrollIndicator={false}>
            {reviewFiles.map(file => <Pressable key={file.id} accessibilityRole="button" accessibilityLabel={`查看 ${file.path} 的改动`} onPress={() => { if (stillWanted()) { if (tabbedTools) openDiffPage(file); else { setSelectedEdit(file); setTab('diff'); } } }} style={styles.changeRow}>
              <Icon name="code" size={15} color={dk.accentText} /><View style={styles.changeBody}><Text style={styles.rowTitle} numberOfLines={1}>{file.path.split(/[\\/]/).pop()}</Text><Text style={styles.rowMeta} numberOfLines={1}>{file.path}</Text></View>
              <Text style={[styles.toolStat, { color: dk.ok }]}>+{file.add}</Text><Text style={[styles.toolStat, { color: dk.bad }]}>−{file.del}</Text>
            </Pressable>)}
          </ScrollView>
        </View>
        : tab === 'diff' && activeDiff ? <View testID="remote-diff-tool" style={styles.toolPane}>
          <View style={styles.toolHead}><Pressable accessibilityRole="button" accessibilityLabel="返回工具栏" onPress={() => { if (stillWanted()) { setSelectedEdit(null); if (tabbedTools) openPage({ id: 'changes', kind: 'changes', title: '改动' }); else setTab('sessions'); } }} style={styles.toolBack}><Icon name="chevronLeft" size={16} color={dk.muted} /></Pressable>
            <View style={styles.toolTitle}><Text style={styles.sectionTitle}>代码差异</Text><Text style={styles.sectionPath} numberOfLines={1}>{activeDiff.path}</Text></View>
            {activeDiff.add ? <Text style={[styles.toolStat, { color: dk.ok }]}>+{activeDiff.add}</Text> : null}{activeDiff.del ? <Text style={[styles.toolStat, { color: dk.bad }]}>−{activeDiff.del}</Text> : null}</View>
          <ScrollView style={styles.toolContent} showsVerticalScrollIndicator={false}>
            {activeDiff.diff ? <DiffAnnotationEditor path={activeDiff.path} diff={activeDiff.diff} sessionKey={activeSessionKey??''} onAdd={value=>{if(!stillWanted()||!onReviewReference)return false;return onReviewReference(value)!==false;}} unavailableReason={!onReviewReference?'当前会话暂不支持添加批注':undefined}/> : <Text style={styles.toolHint}>暂无可查看的差异内容</Text>}
            {activeDiff.diff && onOpenDiffFullscreen && (!tabbedTools || activeDiff.path === diffTarget?.path) ? <Pressable accessibilityRole="button" accessibilityLabel={`全屏查看 ${activeDiff.path} 的改动`} onPress={() => { if (stillWanted()) onOpenDiffFullscreen(); }} style={styles.toolAction}><Text style={styles.toolActionText}>全屏查看</Text></Pressable> : null}
          </ScrollView>
        </View>
        : mode === 'tools' && tab === 'changes' ? <View testID="remote-tool-empty" style={styles.toolPane}><Text style={styles.toolHint}>暂无文件改动</Text></View>
        : tab === 'preview' && previewTarget ? <RemoteToolPreview target={previewTarget} onBack={() => { if (stillWanted()) setTab('sessions'); }} />
        : mode === 'tools' && tab === 'preview' ? <View testID="remote-tool-preview-empty" style={styles.toolPane}><Text style={styles.toolHint}>当前没有可用网页预览</Text></View>
        : mode === 'tools' && tab === 'files' && !filesAllowed ? <View testID="remote-tool-files-unavailable" style={styles.toolPane}><Text style={styles.toolHint}>当前会话暂不支持查看项目文件</Text></View>
        : tab === 'archived' && archivesAllowed ? <ArchivedSessions key={operationIdentity} deviceId={deviceId} tool={agent.tool} onRestored={key => { if (stillWanted()) { onClose(); onOpenSession(key); } }} />
        : tab === 'files' && filesAllowed && activeSessionKey ? <RemoteFiles key={`${operationIdentity}:${activeFileTarget?.nonce ?? 0}:${activeFileTarget?.path ?? ''}`} deviceId={deviceId} sessionKey={activeSessionKey} agentId={agent.id} surface={native ? 'desktop' : 'cli'} target={activeFileTarget} onOpenFile={tabbedTools ? path => { if (stillWanted() && activeInfo?.cwd) openFilePage({ path, nonce: ++pageSequence.current, expectedCwd: activeInfo.cwd, sessionKey: activeSessionKey, surface: native ? 'desktop' : 'cli' }); } : undefined} onReference={!native && !readOnly && onReference ? value => { if (stillWanted()) onReference(value); } : undefined} /> : <>
      {!online ? <View style={styles.offline}><Icon name="laptop" size={14} color={dk.warn} /><Text style={styles.offlineText}>电脑离线，显示已保存的目录</Text></View>
        : readOnly && !historyValid ? <View style={styles.offline}><Icon name="lock" size={14} color={dk.warn} /><Text style={styles.offlineText}>桌面历史不可用</Text></View>
          : native && !nativeLeaseValid ? <View style={styles.offline}><Icon name="lock" size={14} color={dk.warn} /><Text style={styles.offlineText}>Codex 桌面授权已断开，显示上次目录</Text></View> : null}
      {selectedDirectory?.loading && !selectedDirectory.loaded ? <SkeletonGroup label="读取会话" style={{ paddingHorizontal: 12 }}><SkeletonRows rows={6} avatar={0} /></SkeletonGroup> : null}
      <SectionList<SidebarSession, SidebarSection> testID={tab === 'agents' ? 'remote-sidebar-agents' : 'remote-sidebar-sessions'} sections={visibleSections} keyExtractor={(item) => item.sessionKey} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} style={styles.sectionList} contentContainerStyle={[styles.list, docked && styles.dockedList]}
        extraData={focusSessionKey || activeSessionKey} stickySectionHeadersEnabled={false} renderSectionHeader={({ section }) => {
          const collapsible = mode !== 'navigation' && (section.key.startsWith('project:') || section.key === '__temporary' || section.key === '__children');
          const collapsed = collapsedProjects[section.key] === true;
          const toggle = () => { if (stillWanted() && collapsible) setCollapsedProjects(current => ({ ...current, [section.key]: !current[section.key] })); };
          const sameName=sections.some(other=>other.key!==section.key&&other.name===section.name);
          const header = <><Icon name={section.key === '__children' ? 'code' : section.key === '__temporary' ? 'chat' : 'folder'} size={15} color={dk.muted} accent={dk.muted} />
            <View style={styles.sectionLabels}><Text style={[styles.sectionTitle, docked && styles.dockedSectionTitle, mode === 'navigation' && styles.navigationSectionTitle]}>{section.name}</Text>{section.path&&sameName ? <Text style={styles.sectionPath} numberOfLines={1}>{section.path}</Text> : null}</View>
            {collapsible ? <SidebarChevron collapsed={collapsed} reduced={reduced} color={dk.faint}/> : null}</>;
          return collapsible ? <Pressable accessibilityRole="button" accessibilityLabel={`${collapsed ? '展开' : '折叠'}${section.name}`} accessibilityHint={section.path} accessibilityState={{expanded:!collapsed}} aria-expanded={!collapsed} onPress={toggle} style={({pressed})=>[styles.sectionHead, docked && styles.dockedSectionHead,pressed&&styles.pressed]}>{header}</Pressable>
            : <View accessible accessibilityRole="header" accessibilityLabel={section.key.startsWith('project:')?`项目 ${section.name}`:`${section.name}分组`} accessibilityHint={section.path} style={[styles.sectionHead, docked && styles.dockedSectionHead, mode==='navigation'&&styles.navigationSectionHead]}>{header}</View>;
        }}
        renderItem={({ item,index }) => {
          const title = titleOf(deviceId, item.sessionKey, item.title || '无标题对话');
          const selected = item.sessionKey === (focusSessionKey || activeSessionKey);
          const activity = mode === 'navigation' && !item.child ? navigationActivities.get(item.sessionKey) : undefined;
          const status = activity?.status ?? sidebarSessionStatus(item, remote.timelines[timelineKey(deviceId,item.sessionKey)]);
          // Being named by a collaboration tool is not permission to access
          // that child through the native host. Never fall back to CLI here.
          const disabled = item.tool !== agent.tool || (readOnly && (!historyValid || !selectedDirectory?.list.some(row => row.sessionKey === item.sessionKey && row.controlSurface === 'read-only' && row.sessionScope === readOnlyScope)))
            || (native && (!nativeLeaseValid || !agent.desktopLive?.capabilities?.read || !agent.desktopLive?.sessionKeys?.includes(item.sessionKey)));
          return <SidebarSessionRow motion={mode==='navigation'} selected={selected} reduced={reduced} index={index} accessibilityRole="button" accessibilityLabel={item.child ? title !== item.title ? `打开${title}` : (item.childAccessibilityLabel ?? `打开${title}`) : title} accessibilityState={{ selected, disabled }} aria-selected={selected} aria-disabled={disabled} onLongPress={() => { if (!workspaceRuntime && stillWanted()) setActionSession({ session: item, connectionId: remote.connectionId }); }} onPress={() => {
            // The lease can expire between render and this tap. Recheck now;
            // neither a cached label nor a collaboration handle authorizes read.
            if (!stillWanted() || disabled || native && (!agent.desktopLive || agent.desktopLive.expiresAt <= Date.now() || !agent.desktopLive.capabilities?.list || !agent.desktopLive.capabilities?.read || !agent.desktopLive.sessionKeys.includes(item.sessionKey))) return;
            onClose(); onOpenSession(item.sessionKey);
          }} style={({ pressed }) => [styles.row, styles.dockedRow, mode === 'navigation' && styles.navigationRow, selected && mode!=='navigation' && styles.dockedSelected, disabled && styles.disabled, pressed && styles.pressed]}>
            {item.child?<ToolBadge tool={item.tool} client={item.client} size={24}/>:<View style={{width:16}}/>}
            <View style={styles.rowBody}><Text style={[styles.rowTitle, docked && styles.dockedRowTitle, mode === 'navigation' && styles.navigationRowTitle,mode==='navigation'&&selected&&styles.navigationActiveTitle]} numberOfLines={1}>{title}</Text>{item.child?<Text style={[styles.rowMeta, docked && styles.dockedRowMeta]} numberOfLines={1}>{boundedAgentLabel(item.agentRole)||childToolLabel(item.tool)}</Text>:null}</View>
            {status==='running'?<SidebarTaskIndicator active={visible&&online&&!disabled} reduced={reduced} label={`${title}${activity?.includesChildren?'及其子任务':''}${online?'运行中':'上次运行中'}`}/>:status==='waiting_approval'?<View accessible accessibilityLabel={`${title}${activity?.includesChildren?'及其子任务':''}待回复`}><Icon name="clock" size={14} color={dk.muted}/></View>:null}
            {mode==='navigation'&&!item.child?<UnreadResultDot source={{scope:conversationReadScope(pairingScope,deviceId,agent,workspaceMode),session:item,timeline:remote.timelines[timelineKey(deviceId,item.sessionKey)],active:online&&!disabled}} title={title} status={status}/>:null}
            {item.unknown||status==='waiting_approval'?<Text style={styles.rowTime}>{item.unknown?'状态未知':'待回复'}</Text>:null}
          </SidebarSessionRow>;
        }} renderSectionFooter={({ section }) => {
          const project = section.key.startsWith('project:') || section.key === '__temporary' || section.key === '__children';
          if (!project || mode !== 'navigation' && collapsedProjects[section.key] || section.sessions.length <= PER_PROJECT) return null;
          const expanded = expandedProjects[section.key] === true;
          return <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? '收起' : '显示全部'} ${section.name} 的对话`}
            onPress={() => { if (stillWanted()) setExpandedProjects(current => ({ ...current, [section.key]: !current[section.key] })); }} style={styles.projectMore}>
            <Text style={styles.moreText}>{expanded ? '收起' : `显示全部 ${section.sessions.length} 个`}</Text>
          </Pressable>;
        }} ListEmptyComponent={!visibleSections.length && !directoryError && !directoryLoading ? <View style={styles.empty}><Icon name={tab === 'agents' ? 'code' : 'chat'} size={22} color={dk.faint} /><Text style={styles.emptyText}>{tab === 'agents' ? '还没有子智能体' : '还没有对话'}</Text></View> : null}
        ListFooterComponent={!workspaceRuntime && (page?.nextCursor || directoryError || retryActive) ? <View style={styles.pagination}>
          {directoryError ? <Text style={styles.errorText}>{retryHead ? '没有读到对话' : '没有读到更多对话'}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={directoryError ? retryHead ? '重试' : '重试更多对话' : '加载更多对话'} disabled={!canReadDirectory || !canList || directoryLoading} onPress={() => {
            if (!stillWanted() || !canReadDirectory || !canList || directoryLoading || directoryRetry.current?.owner === renderedOwner
              || native && (!agent.desktopLive || agent.desktopLive.expiresAt <= Date.now() || !agent.desktopLive.capabilities?.list) || readOnly && !historyValid) return;
            const retry = { owner: renderedOwner };
            directoryRetry.current = retry;
            setRetryOwner(renderedOwner);
            const more = !retryHead;
            const options = retryHead ? { preservePages: true } : undefined;
            const request = readOnly && readOnlyScope ? more ? loadClaudeDesktopHistory(deviceId, readOnlyScope, true) : loadClaudeDesktopHistory(deviceId, readOnlyScope, false, options)
              : native ? more ? loadNativeSessions(deviceId, true) : loadNativeSessions(deviceId, false, options)
                : more ? loadMoreSessions(deviceId, agent.id) : loadSessions(deviceId, agent.id, options);
            void request.catch(() => undefined).finally(() => {
              if (directoryRetry.current === retry) directoryRetry.current = null;
              if (mounted.current && operationOwner.current === retry.owner) setRetryOwner(null);
            });
        }} style={({ pressed }) => [styles.more, pressed && styles.pressed, (directoryLoading || !canReadDirectory || !canList) && styles.disabled]}>
            {directoryLoading ? <ActivityIndicator size="small" color={dk.muted} /> : <Text style={styles.moreText}>{directoryError ? retryHead ? '重试' : '重试更多对话' : '更多对话'}</Text>}
          </Pressable>
        </View> : null} />
      </>}
      {actionSession ? <SessionQuickActionsSheet visible deviceId={deviceId} connectionId={actionSession.connectionId} deviceName={device?.name} agent={agent} session={actionSession.session}
        onClose={() => { setActionSession(null); }} onArchive={() => { setActionSession(null); }} onOpenSession={key => {
          if (!stillWanted()) return;
          const currentRow = allDirectory.find(row => row.sessionKey === key);
          if (!currentRow || currentRow.tool !== agent.tool || readOnly && (!historyValid || !selectedDirectory?.list.some(row => row.sessionKey === key && row.controlSurface === 'read-only' && row.sessionScope === readOnlyScope))
            || native && (!nativeLeaseValid || !agent.desktopLive?.capabilities?.read || !agent.desktopLive.sessionKeys.includes(key))) return;
          onClose(); onOpenSession(key);
        }} onOpenFork={key => {
          if (!stillWanted() || native || readOnly || !actionSession.session.controllable || actionSession.session.controlSurface === 'desktop' || actionSession.session.controlSurface === 'read-only'
            || sessionKeyAgentId(key) !== agent.tool || !agentSupports(agent, agent.id, 'read')) return;
          onClose(); onOpenSession(key);
        }} /> : null}
  </>;
  if (docked) return <View testID={mode === 'navigation' ? 'remote-sidebar-navigation' : 'remote-sidebar'} style={[styles.docked, mode === 'navigation' ? styles.dockedNavigation : styles.dockedTools, dockedWidth != null && { width: dockedWidth }, !visible && { display: 'none' }]}>{content}</View>;
  const drawer = <View testID="remote-sidebar" pointerEvents={visible ? 'auto' : 'none'} aria-hidden={!visible} accessibilityElementsHidden={!visible} importantForAccessibility={visible?'auto':'no-hide-descendants'} style={[StyleSheet.absoluteFill, !(mode==='navigation'?present:visible) && { display: 'none' }]}>
    <Animated.View style={[styles.scrim, { opacity: panelOpacity }]} pointerEvents="box-none">
      <Pressable testID="remote-sidebar-backdrop" accessibilityRole="button" accessibilityLabel="关闭侧边栏背景" onPress={onClose} style={StyleSheet.absoluteFill} />
    </Animated.View>
    <Animated.View testID={mode === 'navigation' ? 'remote-navigation-panel' : 'remote-tools-panel'} style={[styles.panel, mode === 'navigation' && styles.navigationPanel, side === 'left' ? styles.panelLeft : styles.panelRight, mode === 'navigation' && {paddingTop:Math.max(4,insets.top),paddingBottom:insets.bottom}, { transform: [{ translateX: translate }] }]}>
      {content}
    </Animated.View>
  </View>;
  // Navigation covers the page header as well as its content; tools keep their existing host.
  return mode === 'navigation' ? <Modal visible={present} transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>{drawer}</Modal> : drawer;
}

const useStyles = themed((c, d, scheme) => StyleSheet.create({
  docked: { flex: 1, minHeight: 0, backgroundColor: d.surface, paddingTop: 0 }, dockedNavigation: { width: 284, backgroundColor: scheme === 'light' ? '#F7F7F8' : d.bg, borderRightWidth: StyleSheet.hairlineWidth, borderColor: d.line }, dockedTools: { width: 360, backgroundColor: d.surface, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: d.line },
  navigationPanel: { width: '88%', maxWidth: 320, backgroundColor: scheme === 'light' ? '#F7F7F8' : d.bg },
  navigationHeader: { minHeight: 68, paddingLeft: 14, paddingRight: 8, flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom:6 },
  navigationAvatar: { width:34,height:34,borderRadius:11,alignItems:'center',justifyContent:'center',backgroundColor:scheme==='light'?'#FFFFFF':d.surface,borderWidth:StyleSheet.hairlineWidth,borderColor:scheme==='light'?'#EBE8F1':d.line },
  navigationCreateSurface: { position:'absolute',top:5,left:5,width:34,height:34,borderRadius:10,backgroundColor:scheme==='light'?'#EFEDF5':'#302B3B' },
  navigationIdentity: { flex: 1, minWidth: 0, gap: 3 }, navigationTitle: { color: d.text, fontSize: 14, lineHeight: 20, fontWeight: '600' }, navigationSubtitle: { color: d.muted, fontSize: 11, lineHeight: 16 },
  navigationSectionHead: { minHeight:44,paddingTop:6,paddingBottom:6,paddingHorizontal:10,gap:8 }, navigationSectionTitle: { color: d.text2, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  navigationRow: { minHeight: 44, borderRadius: 10,marginVertical:1 }, navigationRowTitle: { fontSize: 13, lineHeight: 20 }, navigationActiveTitle:{fontWeight:'500'},
  dockedNavTop: { flexShrink: 0 }, dockedSpace: { alignSelf: 'center', flexDirection: 'row', gap: 1, marginTop: 12, marginBottom: 9, padding: 3, borderRadius: 10, backgroundColor: d.surface2 },
  dockedSpaceOption: { minWidth: 61, height: 30, paddingHorizontal: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, dockedSpaceOptionSelected: { backgroundColor: d.surface, shadowColor: d.shadow, shadowOpacity: 0.08, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  dockedSpaceText: { color: d.muted, fontSize: 12.5, fontWeight: '500' }, dockedSpaceTextSelected: { color: d.text, fontWeight: '700' },
  dockedActionList: { paddingHorizontal: 8, paddingBottom: 6, gap: 1 }, dockedAction: { minHeight: 36, paddingHorizontal: 10, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 9 }, dockedActionText: { color: d.text2, fontSize: 13, fontWeight: '500' }, dockedSlash: { width: 15, textAlign: 'center', color: d.muted, fontSize: 18, lineHeight: 21 },
  dockedWorkspaceTab: { minHeight: 27 },
  dockedToolTabs: { flexGrow: 0, height: 48, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line, backgroundColor: d.surface }, dockedToolTabsContent: { flexGrow: 1, flexDirection: 'row', alignItems: 'stretch', paddingHorizontal: 8, gap: 3 },
  dockedToolTab: { height: 47, minWidth: 0, flexGrow: 1, flexBasis: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 1, borderBottomWidth: 2, borderBottomColor: 'transparent' }, dockedToolTabSelected: { backgroundColor: 'transparent', borderColor: 'transparent', borderBottomColor: d.accentText }, dockedToolTabText: { color: d.muted, fontSize: 10.5, fontWeight: '500', flexShrink: 1 }, dockedToolTabTextSelected: { color: d.text, fontWeight: '600' },
  dockedList: { paddingHorizontal: 10, paddingBottom: 24 }, dockedSectionHead: { minHeight: 42, paddingHorizontal: 10, paddingTop: 10, gap: 8 }, dockedSectionTitle: { color: d.text2, fontSize: 14,fontWeight:'500' },
  dockedRow: { minHeight: 40, borderRadius: 10, paddingHorizontal: 8, gap: 8 }, dockedSelected: { backgroundColor: d.surface2, shadowOpacity: 0, shadowRadius: 0, elevation: 0 }, dockedRowTitle: { fontSize: 14, lineHeight: 20, fontWeight: '400' }, dockedRowMeta: { color: d.muted, fontSize: 11 },
  scrim: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: '#000' },
  panel: { position: 'absolute', top: 0, bottom: 0, width: '86%', maxWidth: 380, backgroundColor: d.bg, overflow: 'hidden', paddingTop: 4, borderColor: d.line }, panelLeft: { left: 0, borderTopRightRadius: 16, borderBottomRightRadius: 16, borderRightWidth: StyleSheet.hairlineWidth }, panelRight: { right: 0, borderTopLeftRadius: 16, borderBottomLeftRadius: 16, borderLeftWidth: StyleSheet.hairlineWidth }, sectionList: { flex: 1 },
  header: { minHeight: 62, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 10 }, headerTitle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 }, title: { color: d.text, fontSize: 16, fontWeight: '600' }, subtitle: { color: d.muted, fontSize: 11.5, marginTop: 2 }, close: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  workspaceTabs: { flexDirection: 'row', gap: 4, marginHorizontal: 10, marginBottom: 6, padding: 3, borderRadius: 10, backgroundColor: d.surface3 }, workspaceTab: { flex: 1, minHeight: 29, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, workspaceTabSelected: { backgroundColor: d.surface }, workspaceTabText: { color: d.muted, fontSize: 12, fontWeight: '500' }, workspaceTabTextSelected: { color: d.accentText, fontWeight: '700' },
  tabs: { maxHeight: 38, marginHorizontal: 12, marginBottom: 8, padding: 3, borderRadius: 11, backgroundColor: d.surface3 }, tabsContent: { flexDirection: 'row', alignItems: 'center', gap: 2 }, tab: { minWidth: 54, minHeight: 30, paddingHorizontal: 8, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, tabText: { color: d.text, fontSize: 12, fontWeight: '500' },
  toolTabs: { flexDirection: 'row', gap: 2, marginHorizontal: 8, marginBottom: 8, padding: 3, borderRadius: 10, backgroundColor: d.surface3 }, toolTab: { flex: 1, minWidth: 0, minHeight: 31, alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingHorizontal: 3 }, toolTabSelected: { backgroundColor: d.surface }, toolTabText: { color: d.muted, fontSize: 10.5, fontWeight: '500' }, toolTabTextSelected: { color: d.accentText, fontWeight: '700' },
  changeRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line }, changeBody: { flex: 1, minWidth: 0, gap: 2 }, toolActivityRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line }, toolActivityIcon: { width: 26, height: 26, borderRadius: 7, alignItems: 'center', justifyContent: 'center' }, toolActivityMeta: { alignItems: 'flex-end', gap: 3 }, toolActivityStatus: { fontSize: 10.5, fontWeight: '600' }, toolStatus: { fontSize: 10.5, fontWeight: '600' }, toolDetailContent: { gap: 8, paddingVertical: 10 }, toolOutput: { color: d.codeText, backgroundColor: d.code, borderRadius: 8, padding: 10, fontFamily: 'monospace', fontSize: 10.5, lineHeight: 16, overflow: 'hidden' }, toolExit: { fontSize: 10.5, fontWeight: '600' },
  offline: { marginHorizontal: 16, marginTop: 10, minHeight: 30, borderRadius: 9, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: d.warnSoft }, offlineText: { color: d.warn, fontSize: 11.5 }, loading: { minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, loadingText: { color: d.muted, fontSize: 11.5 }, list: { paddingHorizontal: 10, paddingBottom: 24 }, sectionHead: { minHeight: 35, paddingHorizontal: 8, paddingTop: 15, flexDirection: 'row', alignItems: 'center', gap: 7 }, sectionLabels: { flex: 1, minWidth: 0, gap: 2 }, sectionTitle: { color: d.muted, fontSize: 11.5, fontWeight: '600' }, sectionPath: { color: d.faint, fontSize: 9.5, lineHeight: 13 }, toolPane: { flex: 1, minHeight: 0, paddingHorizontal: 14 }, toolHead: { minHeight: 52, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line }, toolBack: { width: 32, height: 36, alignItems: 'center', justifyContent: 'center' }, toolTitle: { flex: 1, minWidth: 0, gap: 2 }, toolStat: { fontFamily: 'monospace', fontSize: 11, fontWeight: '600' }, toolContent: { flex: 1 }, toolHint: { color: d.muted, fontSize: 12, paddingVertical: 14 }, toolAction: { minHeight: 38, alignItems: 'center', justifyContent: 'center', marginTop: 8, borderRadius: 10, backgroundColor: d.surface2 }, toolActionText: { color: d.accentText, fontSize: 12 }, projectMore: { minHeight: 36, justifyContent: 'center', paddingLeft: 42 }, row: { minHeight: 46, borderRadius: 11, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 9 }, selected: { backgroundColor: d.surface, shadowColor: '#1E2846', shadowOpacity: 0.06, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 }, pressed: { backgroundColor: d.surface2 }, disabled: { opacity: 0.55 }, rowBody: { flex: 1, minWidth: 0, gap: 3 }, rowTitle: { color: d.text, fontSize: 14, lineHeight: 19 }, rowMeta: { color: d.muted, fontSize: 11.5 }, rowTime: { color: d.muted, fontSize: 11.5 }, empty: { alignItems: 'center', gap: 8, paddingVertical: 40 }, emptyText: { color: d.muted, fontSize: 13 }, pagination: { paddingTop: 12, paddingBottom: 24, gap: 8 }, more: { minHeight: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface2 }, moreText: { color: d.accentText, fontSize: 12, fontWeight: '600' }, errorText: { color: d.bad, fontSize: 11.5, textAlign: 'center' },
}));
