import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useBackAction, type RegisterBackAction } from './useBackAction';

import { Icon } from '../components/Icon';
import { getSetting, setSetting } from '../storage/database';
import { themed, useDesk } from '../theme';
import {WorkspaceLayoutContext,type WorkspaceView} from './WorkspaceLayoutContext';
import {ToolbarButton} from './WorkbenchToolbar';

const PREF_KEY = 'tablet_thread_columns_v1';
const SIDEBAR_MIN = 264;
const SIDEBAR_MAX = 420;
const SIDEBAR_RAIL = 56;
const CENTER_MIN = 400;
const WORKSPACE_MIN = 300;
const WORKSPACE_MAX_RATIO = 0.7;
const SPLITTER_WIDTH = 12;

type LayoutPrefs = { sidebar: number; workspace: number; sidebarCollapsed?: boolean; workspaceCollapsed?: boolean };

/** Leave the conversation room to read when both auxiliary panes are open. */
export function defaultTabletLayout(width: number): LayoutPrefs {
  return { sidebar: 264, workspace: Math.min(450, Math.max(WORKSPACE_MIN, width * 0.34)) };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(min, max), Math.max(min, value));
}

/** Opening one pane on a narrow tablet makes room by folding the other. */
export function revealTabletPane(width: number, prefs: LayoutPrefs, pane: 'navigation' | 'workspace'): LayoutPrefs {
  const next = { ...prefs, [pane === 'navigation' ? 'sidebarCollapsed' : 'workspaceCollapsed']: false };
  if (pane === 'workspace' && solveTabletColumns(width, next).workspaceCollapsed) next.sidebarCollapsed = true;
  if (pane === 'navigation' && solveTabletColumns(width, next).workspaceCollapsed) next.workspaceCollapsed = true;
  return next;
}

export function solveTabletColumns(width: number, prefs: LayoutPrefs) {
  const autoCollapsed = width <= 1024;
  const sidebarCollapsed = prefs.sidebarCollapsed ?? autoCollapsed;
  const sidebar = sidebarCollapsed ? SIDEBAR_RAIL : clamp(prefs.sidebar, SIDEBAR_MIN, SIDEBAR_MAX);
  const leftSplitter = Number(!sidebarCollapsed) * SPLITTER_WIDTH;
  const roomForWorkspace = width - sidebar - CENTER_MIN - leftSplitter - SPLITTER_WIDTH;
  const workspaceVisible = !prefs.workspaceCollapsed && roomForWorkspace >= WORKSPACE_MIN;
  const workspace = workspaceVisible
    ? clamp(prefs.workspace, WORKSPACE_MIN, Math.min(width * WORKSPACE_MAX_RATIO, roomForWorkspace))
    : 0;
  const splitters = Number(!sidebarCollapsed) + Number(workspaceVisible);
  return { sidebar, workspace, center: Math.max(0, width - sidebar - workspace - splitters * SPLITTER_WIDTH), sidebarCollapsed, workspaceCollapsed: !workspaceVisible };
}

export function TabletThreadFrame({ enabled = true, navigation, header, workspace, workspaceHasTabBar = false, workspaceOpenNonce, mobileWorkspaceOpen = false, onCloseWorkspace, onWorkspaceVisibilityChange, onRegisterBack, children }: {
  enabled?: boolean;
  navigation: React.ReactNode;
  header: React.ReactNode;
  workspace: React.ReactNode;
  workspaceHasTabBar?: boolean;
  workspaceOpenNonce?: string | number;
  mobileWorkspaceOpen?: boolean;
  onCloseWorkspace?: () => void;
  onWorkspaceVisibilityChange?: (visible: boolean) => void;
  onRegisterBack?: RegisterBackAction;
  children: React.ReactNode;
}) {
  const windowWidth = useWindowDimensions().width;
  const dk = useDesk();
  const styles = useTabletThreadStyles();
  const initial = useMemo<LayoutPrefs>(() => defaultTabletLayout(windowWidth), []);
  const [prefs, setPrefs] = useState<LayoutPrefs>(initial);
  const [full,setFull]=useState(false);
  const [mobileOverride,setMobileOverride]=useState<boolean|null>(null);
  useEffect(()=>setMobileOverride(null),[mobileWorkspaceOpen]);
  const [ready, setReady] = useState(true);
  const frameWidth = useRef(windowWidth);
  const prefsRef = useRef(prefs);
  const dragOrigin = useRef({ sidebar: prefs.sidebar, workspace: prefs.workspace });
  frameWidth.current = windowWidth;
  prefsRef.current = prefs;
  const columns = solveTabletColumns(windowWidth, prefs);
  const workspaceVisible = enabled ? full || !columns.workspaceCollapsed : mobileOverride ?? mobileWorkspaceOpen;
  useEffect(() => { onWorkspaceVisibilityChange?.(workspaceVisible); }, [workspaceVisible, onWorkspaceVisibilityChange]);

  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    setReady(true);
    void getSetting(PREF_KEY).then(raw => {
      if (!current || !raw) return;
      try {
        const parsed = JSON.parse(raw) as Partial<LayoutPrefs>;
        setPrefs(value => ({
          ...value,
          ...(Number.isFinite(parsed.sidebar) ? { sidebar: clamp(parsed.sidebar!, SIDEBAR_MIN, SIDEBAR_MAX) } : {}),
          ...(Number.isFinite(parsed.workspace) ? { workspace: Math.max(WORKSPACE_MIN, parsed.workspace!) } : {}),
          ...(typeof parsed.sidebarCollapsed === 'boolean' ? { sidebarCollapsed: parsed.sidebarCollapsed } : {}),
          ...(typeof parsed.workspaceCollapsed === 'boolean' ? { workspaceCollapsed: parsed.workspaceCollapsed } : {}),
        }));
      } catch { /* invalid layout preferences are ignored */ }
    }).catch(() => undefined).finally(() => { if (current) setReady(true); });
    return () => { current = false; };
  }, [enabled]);

  const persist = (next: LayoutPrefs) => {
    prefsRef.current = next;
    setPrefs(next);
    void setSetting(PREF_KEY, JSON.stringify(next)).catch(() => undefined);
  };
  const setWorkspaceView=(view:WorkspaceView)=>{
    setFull(view==='full');
    if(!enabled)setMobileOverride(view!=='hidden');
    if(view==='hidden') {if(enabled)persist({...prefsRef.current,workspaceCollapsed:true});onCloseWorkspace?.();}
    else persist(revealTabletPane(windowWidth,prefsRef.current,'workspace'));
  };
  useBackAction(() => {
    if (!workspaceVisible) return false;
    setWorkspaceView(enabled && full ? 'split' : 'hidden');
    return true;
  }, onRegisterBack);
  // A phone's overlay close must not overwrite the tablet layout preference.
  // Explicitly reopening the phone pane also carries visibility back to tablet.
  useEffect(()=>{
    if(!enabled&&(mobileOverride??mobileWorkspaceOpen)&&prefsRef.current.workspaceCollapsed)
      persist({...prefsRef.current,workspaceCollapsed:false});
  },[enabled,mobileWorkspaceOpen,mobileOverride]);
  useEffect(() => {
    if (enabled && workspaceOpenNonce) persist(revealTabletPane(windowWidth, prefsRef.current, 'workspace'));
  }, [enabled, workspaceOpenNonce]);
  const sidebarPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { dragOrigin.current = { sidebar: prefsRef.current.sidebar, workspace: prefsRef.current.workspace }; },
    onPanResponderMove: (_event, gesture) => {
      const available = frameWidth.current - WORKSPACE_MIN - CENTER_MIN - SPLITTER_WIDTH * 2;
      const nextSidebar = clamp(dragOrigin.current.sidebar + gesture.dx, SIDEBAR_MIN, Math.min(SIDEBAR_MAX, available));
      setPrefs(value => ({ ...value, sidebar: nextSidebar, sidebarCollapsed: false }));
    },
    onPanResponderRelease: (_event, gesture) => {
      const available = frameWidth.current - WORKSPACE_MIN - CENTER_MIN - SPLITTER_WIDTH * 2;
      persist({ ...prefsRef.current, sidebar: clamp(dragOrigin.current.sidebar + gesture.dx, SIDEBAR_MIN, Math.min(SIDEBAR_MAX, available)), sidebarCollapsed: false });
    },
    onPanResponderTerminate: () => persist(prefsRef.current),
  }), []);
  const workspacePan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { dragOrigin.current = { sidebar: prefsRef.current.sidebar, workspace: prefsRef.current.workspace }; },
    onPanResponderMove: (_event, gesture) => {
      const available = frameWidth.current - columns.sidebar - CENTER_MIN - SPLITTER_WIDTH * (Number(!columns.sidebarCollapsed) + 1);
      const nextWorkspace = clamp(dragOrigin.current.workspace - gesture.dx, WORKSPACE_MIN, Math.min(frameWidth.current * WORKSPACE_MAX_RATIO, available));
      setPrefs(value => ({ ...value, workspace: nextWorkspace, workspaceCollapsed: false }));
    },
    onPanResponderRelease: (_event, gesture) => {
      const available = frameWidth.current - columns.sidebar - CENTER_MIN - SPLITTER_WIDTH * (Number(!columns.sidebarCollapsed) + 1);
      persist({ ...prefsRef.current, workspace: clamp(dragOrigin.current.workspace - gesture.dx, WORKSPACE_MIN, Math.min(frameWidth.current * WORKSPACE_MAX_RATIO, available)), workspaceCollapsed: false });
    },
    onPanResponderTerminate: () => persist(prefsRef.current),
  }), [columns.sidebar]);

  // Keep the same center/workspace parent chain across responsive layouts. A
  // different mobile subtree would recreate every iframe and replay old opens.
  return <WorkspaceLayoutContext.Provider value={{view:!workspaceVisible?'hidden':full||!enabled?'full':'split',canSplit:enabled,setView:setWorkspaceView}}><View nativeID="remote-workspace-root" testID="tablet-thread-frame" style={[styles.frame, { backgroundColor: dk.bg }]}>
    <View key="navigation" style={!enabled || full ? { display: 'none' } : undefined}>{columns.sidebarCollapsed
      ? <View style={[styles.rail, { backgroundColor: dk.surface2, borderRightColor: dk.line }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="展开会话导航" onPress={() => persist(revealTabletPane(windowWidth, prefsRef.current, 'navigation'))} style={styles.railButton}>
            <Icon name="menu" size={18} color={dk.muted} />
          </Pressable>
        </View>
      : <View style={[styles.navigation, { width: columns.sidebar }]}>{navigation}</View>}</View>
    <View key="navigation-splitter" style={[styles.splitter, (!enabled || full || columns.sidebarCollapsed) && { display: 'none' }]} {...sidebarPan.panHandlers}><View style={[styles.splitterGrip, { backgroundColor: dk.lineStrong }]} /></View>
    <View key="center" testID="tablet-thread-center" style={[styles.center, !enabled && { minWidth: 0 }, { backgroundColor: dk.surface },(full||!enabled)&&workspaceVisible&&{display:'none'}]}>
      <View style={[styles.header, !enabled && { display: 'none' }, { borderBottomColor: dk.line, backgroundColor: dk.surface }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={columns.sidebarCollapsed ? '打开会话导航' : '折叠会话导航'} onPress={() => persist(columns.sidebarCollapsed ? revealTabletPane(windowWidth, prefsRef.current, 'navigation') : { ...prefsRef.current, sidebarCollapsed: true })} style={styles.headerButton}>
          <Icon name="menu" size={18} color={dk.muted} />
        </Pressable>
        <View style={styles.headerContent}>{header}</View>
        {columns.workspaceCollapsed?<ToolbarButton icon="panelRight" label="展开工具栏" onPress={()=>persist(revealTabletPane(windowWidth,prefsRef.current,'workspace'))}/>:!workspaceHasTabBar?<ToolbarButton icon="panelRight" label="折叠工具栏" onPress={()=>persist({...prefsRef.current,workspaceCollapsed:true})}/>:null}
      </View>
      <View style={styles.content}>{children}</View>
    </View>
    <View key="workspace-splitter" style={[styles.splitter, (!enabled || full || columns.workspace <= 0) && { display: 'none' }]} {...workspacePan.panHandlers}><View style={[styles.splitterGrip, { backgroundColor: dk.lineStrong }]} /></View>
    <View key="workspace" pointerEvents={workspaceVisible ? 'auto' : 'none'}
      style={enabled ? [styles.workspace, { width: full?windowWidth:columns.workspace, display: ready && workspaceVisible ? 'flex' : 'none' }]
        : [StyleSheet.absoluteFill, styles.mobileWorkspace, !workspaceVisible && { display: 'none' }]}>
      <Pressable key="backdrop" testID="remote-sidebar-backdrop" accessibilityRole="button" accessibilityLabel="关闭侧边栏背景" onPress={()=>setWorkspaceView('hidden')}
        style={[StyleSheet.absoluteFill, styles.mobileScrim, { display: 'none' }]} />
      <View key="workspace-surface" style={enabled ? styles.workspaceSurface : [styles.workspaceSurface, styles.mobileWorkspaceSurface,full&&{width:'100%',maxWidth:undefined}]}>
        <View key="close" style={[styles.mobileWorkspaceHeader, (enabled || workspaceHasTabBar) && { display: 'none' }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="返回聊天" onPress={()=>setWorkspaceView('hidden')} style={{minHeight:44,paddingHorizontal:12,flexDirection:'row',alignItems:'center',gap:6}}><Icon name="arrowLeft" size={18} color={dk.muted} /><Text style={{fontSize:13,color:dk.text}}>返回聊天</Text></Pressable>
        </View>
        {workspace}
      </View>
    </View>
  </View></WorkspaceLayoutContext.Provider>;
}

const useTabletThreadStyles = themed((_c, d) => StyleSheet.create({
  frame: { flex: 1, minWidth: 0, flexDirection: 'row', overflow: 'hidden' },
  navigation: { flexShrink: 0, height: '100%', overflow: 'hidden' },
  center: { flex: 1, minWidth: 400, height: '100%', overflow: 'hidden' },
  header: { height: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
  headerButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  headerContent: { flex: 1, minWidth: 0, height: '100%', justifyContent: 'center' },
  content: { flex: 1, minHeight: 0, minWidth: 0 },
  workspace: { flexShrink: 0, height: '100%', overflow: 'hidden' },
  workspaceSurface: { flex: 1, minHeight: 0, backgroundColor: d.surface },
  mobileWorkspace: { zIndex: 20, alignItems: 'flex-end' },
  mobileScrim: { backgroundColor: 'rgba(0,0,0,0.18)' },
  mobileWorkspaceSurface: { width: '100%', height: '100%' },
  mobileWorkspaceHeader: { height: 44, flexShrink:0, alignItems: 'flex-start', justifyContent: 'center', paddingHorizontal: 4,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line },
  rail: { width: 56, height: '100%', alignItems: 'center', paddingTop: 12, borderRightWidth: StyleSheet.hairlineWidth },
  railButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
  splitter: { width: SPLITTER_WIDTH, height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent', zIndex: 2 },
  splitterGrip: { width: 2, height: 40, borderRadius: 1, opacity: 0.8 },
}));
