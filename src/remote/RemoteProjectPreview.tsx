import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { themed, useDesk } from '../theme';
import { Icon } from '../components/Icon';
import { mono } from './parts';
import { useWorkspaceRuntime } from './WorkspaceRuntimeContext';
import { remoteDeliveryScope, useRemote } from './store';
import type { TerminalSelection } from './workspace-terminal';
import { captureWorkspaceProjectPreview, type ProjectPreviewInspection, type ProjectPreviewRun, type ProjectPreviewStart, type WorkspaceProjectPreview } from './workspace-project-preview';
import { appendProjectPreviewLogs, clearProjectPreviewStart, loadProjectPreviewStart, saveProjectPreviewStart } from './project-preview-state';
import { RemoteBrowserPage } from './RemoteBrowserPage';
import type { RemoteToolPreviewTarget } from './RemoteToolPreview';
import { PreviewLogPanel } from './PreviewLogPanel';
import { projectRunLogEntries } from './preview-logs';

type Props = { selection: TerminalSelection; sourcePath: string; active: boolean; onCompose?: (text: string) => boolean | void };
type Owner = { service: WorkspaceProjectPreview; scope: string; busy: boolean; disposed: boolean; invalidated?: boolean; run?: ProjectPreviewRun; pending?: ProjectPreviewStart };
const alive = (run?: ProjectPreviewRun) => run?.status === 'starting' || run?.status === 'running';
const statusText = { starting: '正在启动', running: '运行中', exited: '已退出', failed: '启动失败', stopped: '已停止' };
const errorText = (error: unknown) => error instanceof Error ? error.message : '暂时无法连接电脑';

/** Opening/foregrounding only reads. A source file supplies the preview entry. */
export function RemoteProjectPreview({ selection, sourcePath, active, onCompose }: Props) {
  const styles = useStyles(), dk = useDesk(), runtime = useWorkspaceRuntime(), remote = useRemote();
  const data = runtime?.remote ?? remote, profile = data.agents[selection.deviceId]?.list.find(item => item.id === selection.agentId);
  const online = data.devices?.find(item => item.deviceId === selection.deviceId)?.online;
  const connection = data.connection;
  const scope = JSON.stringify([runtime?.scope ?? remoteDeliveryScope(), selection.deviceId, selection.agentId, profile?.api,
    profile?.execution, selection.surface, selection.sessionKey, selection.cwd, sourcePath]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const factory = useRef(runtime); factory.current = runtime;
  const owner = useRef<Owner | undefined>(undefined);
  const [inspection, setInspection] = useState<ProjectPreviewInspection>(), [run, setRun] = useState<ProjectPreviewRun>();
  const [script, setScript] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [connected, setConnected] = useState(false);
  const [revision, refresh] = useState(0), [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [lastPreview, setLastPreview] = useState<{ scope: string; target: RemoteToolPreviewTarget }>();
  const [showLogs, setShowLogs] = useState(false);
  const logEntries = useMemo(() => projectRunLogEntries(run?.logs ?? '', `项目 ${run?.projectPath || selection.cwd} · ${run?.script ?? '运行输出'}`, run?.error), [run?.logs, run?.error, run?.projectPath, run?.script, selection.cwd]);
  const logOwner = useRef({scope, active, foreground, onCompose}); logOwner.current = {scope, active, foreground, onCompose};
  const current = (context: Owner) => owner.current === context && !context.disposed && scopeRef.current === context.scope;
  const publish = (context: Owner, next: ProjectPreviewRun, incremental = false) => {
    if (!current(context)) return;
    const merged = appendProjectPreviewLogs(context.run, next, incremental); context.run = merged; setRun(merged);
    if (next.status === 'running' && next.url) setLastPreview(previous => previous?.scope === scope && previous.target.url === next.url ? previous
      : { scope: context.scope, target: { kind: 'local-service', url: next.url! } });
  };
  useEffect(() => { const listener = AppState.addEventListener('change', state => setForeground(state === 'active')); return () => listener.remove(); }, []);
  useEffect(() => {
    setInspection(undefined); setRun(undefined); setScript(''); setError(''); setNotice(''); setUncertain(false); setLastPreview(undefined);
  }, [scope]);
  useEffect(() => {
    if (!active || !foreground || online === false) { setConnected(false); setBusy(false); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const invalidated = () => { if (current(context)) { context.invalidated = true; setConnected(false); setError('连接已变化，重新连接后会核对原项目状态'); } };
    const service = factory.current ? factory.current.captureProjectPreview?.(selection, invalidated) : captureWorkspaceProjectPreview(selection, invalidated);
    if (!service) { setError('电脑端尚未开放项目预览，请更新电脑端'); setConnected(false); return; }
    const context: Owner = { service, scope, busy: true, disposed: false }; owner.current = context;
    setBusy(true); setConnected(false); setError(''); setInspection(undefined);
    const reconcilePending = async () => {
      const pending = context.pending;
      if (!pending) return;
      const recovered = await service.status({ projectPath: pending.projectPath, operationId: pending.operationId });
      if (!current(context)) return;
      if (recovered.run) publish(context, recovered.run);
      else setNotice('未找到上次启动的进程。请核对电脑后，再手动启动。');
      await clearProjectPreviewStart(scope, pending.operationId);
      if (!current(context)) return;
      context.pending = undefined; setUncertain(false); setConnected(true);
    };
    const poll = async () => {
      if (!current(context) || context.invalidated) return;
      if (!context.busy && (context.pending || alive(context.run))) {
        context.busy = true;
        try {
          if (context.pending) { await reconcilePending(); }
          else {
          const previous = context.run!;
          const result = await service.status({ projectPath: previous.projectPath, runId: previous.runId, operationId: previous.operationId, cursor: previous.cursor });
          if (!current(context)) return;
          if (result.run) { publish(context, result.run, true); setConnected(true); }
          else { context.run = undefined; setRun(undefined); setNotice('原预览进程已结束，可重新检查后启动'); }
          }
          failures = 0; if (current(context)) setError('');
        } catch (err) { failures += 1; if (current(context)) { setConnected(false); setError(errorText(err)); } }
        finally { context.busy = false; }
      }
      if (current(context) && !context.invalidated) timer = setTimeout(() => void poll(), failures ? Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)) : context.pending || context.run?.status === 'starting' ? 2000 : 5000);
    };
    void (async () => {
      try {
        context.pending = await loadProjectPreviewStart(scope);
        if (!current(context)) return;
        setUncertain(Boolean(context.pending));
        // An existing run remains recoverable even if its source or manifest
        // has since moved. Reconcile its original identity before discovery.
        if (context.pending) await reconcilePending();
        if (!current(context)) return;
        const result = await service.inspect(sourcePath);
        if (!current(context)) return;
        setInspection(result); setScript(value => result.scripts.some(item => item.name === value && item.supported) ? value : result.scripts.find(item => item.supported)?.name ?? '');
        if (!context.run && result.run) publish(context, result.run);
        else if (!context.run) setRun(undefined);
        setConnected(true);
      } catch (err) { if (current(context)) { setError(errorText(err)); setConnected(false); } }
      finally { context.busy = false; if (current(context)) { setBusy(false); timer = setTimeout(() => void poll(), 2000); } }
    })();
    return () => { context.disposed = true; if (timer) clearTimeout(timer); service.dispose(); if (owner.current === context) owner.current = undefined; };
  }, [scope, active, foreground, revision, online, connection, runtime?.captureProjectPreview]);

  const start = async () => {
    const context = owner.current;
    if (!context || !current(context) || context.busy || !connected || context.pending || !inspection?.ready || !script || alive(context.run)) return;
    context.busy = true; setBusy(true); setError(''); setNotice('');
    const input: ProjectPreviewStart = { projectPath: inspection.projectPath, script, manifestRevision: inspection.manifestRevision, operationId: Crypto.randomUUID() };
    let persisted = false;
    try {
      await saveProjectPreviewStart(scope, input); persisted = true;
      if (!current(context)) return;
      context.pending = input; setUncertain(true);
      const result = await context.service.start(input);
      if (!current(context)) return;
      if (!result.run) throw new Error('启动回执没有返回原进程');
      publish(context, result.run);
      await clearProjectPreviewStart(scope, input.operationId);
      if (!current(context)) return;
      context.pending = undefined; setUncertain(false);
    } catch (err) { if (current(context)) { setError(`${persisted ? '启动结果待确认，请查询原进程。' : ''}${errorText(err)}`); if (persisted) setUncertain(true); } }
    finally { context.busy = false; if (current(context)) setBusy(false); }
  };
  const stop = async () => {
    const context = owner.current, previous = context?.run;
    if (!context || !current(context) || context.busy || !previous || !alive(previous)) return;
    context.busy = true; setBusy(true); setError('');
    try {
      const result = await context.service.stop({ projectPath: previous.projectPath, runId: previous.runId, operationId: previous.operationId });
      if (!current(context)) return;
      if (result.run) publish(context, result.run); else { context.run = undefined; setRun(undefined); }
    } catch (err) { if (current(context)) setError(`停止结果待确认，请查询状态。${errorText(err)}`); }
    finally { context.busy = false; if (current(context)) setBusy(false); }
  };
  const canStart = active && foreground && connected && !busy && !uncertain && inspection?.ready && script && !alive(run);
  const preview = lastPreview?.scope === scope ? lastPreview.target : undefined;
  return <View style={styles.root} testID="project-preview">
    <View style={styles.header}>
      <View style={styles.titleRow}><Icon name="code" size={18} color={dk.muted}/><View style={styles.titleBody}><Text style={styles.title}>{inspection?.packageName || '项目预览'}</Text><Text style={styles.path} numberOfLines={1}>{inspection ? inspection.projectPath || '项目根目录' : sourcePath}</Text></View>
        {busy ? <ActivityIndicator size="small" color={dk.muted}/> : run ? <Text style={styles.status}>{statusText[run.status]}</Text> : null}
      </View>
      {inspection ? <View style={styles.scripts}>{inspection.scripts.filter(item => item.supported).map(item => <Pressable key={item.name} accessibilityRole="button" accessibilityLabel={`运行脚本 ${item.name}`} accessibilityState={{ selected: script === item.name }} disabled={busy || alive(run) || uncertain} onPress={() => setScript(item.name)} style={[styles.script, script === item.name && styles.selected]}><Text style={styles.scriptText}>{item.name}</Text></Pressable>)}</View> : null}
      {inspection?.scripts.find(item => item.name === script) ? <Text selectable style={styles.command}>{inspection.scripts.find(item => item.name === script)!.command}</Text> : null}
      <View style={styles.controls}>
        <Pressable accessibilityRole="button" accessibilityLabel="启动项目预览" disabled={!canStart} onPress={() => void start()} style={[styles.primary, !canStart && styles.disabled]}><Text style={styles.primaryText}>启动预览</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="停止项目预览" disabled={!active || busy || !alive(run)} onPress={() => void stop()} style={[styles.button, (busy || !alive(run)) && styles.disabled]}><Text style={styles.buttonText}>停止</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="查询项目运行状态" disabled={!active || busy} onPress={() => refresh(value => value + 1)} style={styles.button}><Text style={styles.buttonText}>{uncertain || !connected ? '重新连接' : '刷新状态'}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={showLogs ? '收起项目日志' : '展开项目日志'} onPress={() => setShowLogs(value => !value)} style={styles.button}><Text style={styles.buttonText}>日志</Text></Pressable>
      </View>
      {inspection?.reason && !inspection.ready ? <Text style={styles.hint}>{inspection.reason}</Text> : <Text style={styles.hint}>在电脑上运行已安装的项目；文件保存后由项目开发服务器热更新。</Text>}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.hint}>{notice}</Text> : null}
      {run?.error ? <Text style={styles.error}>{run.error}</Text> : null}
    </View>
    {showLogs ? <PreviewLogPanel key={`${scope}:${run?.runId ?? ''}`} scopeKey={`${scope}:${run?.runId ?? ''}`} entries={logEntries} origin={`项目 ${run?.projectPath || selection.cwd} · ${run?.script ?? '运行输出'}`} initiallyOpen active={active&&foreground} onCompose={onCompose?text=>{const owner=logOwner.current;if(owner.scope!==scope||!owner.active||!owner.foreground||!owner.onCompose)return false;return owner.onCompose(text);}:undefined}/> : null}
    {preview ? <View style={{flex:1,minHeight:0}}>
      {(!connected || run?.status !== 'running') ? <Text style={[styles.hint,{paddingHorizontal:14,paddingVertical:7}]}>显示上次预览 · {run?.status === 'stopped' || run?.status === 'exited' ? '运行已停止' : '等待运行状态恢复'}</Text> : null}
      <View style={{flex:1,minHeight:0}} pointerEvents={active && foreground && connected && run?.status === 'running' ? 'auto' : 'none'}>
        <RemoteBrowserPage computer={selection} target={preview} active={active && foreground && connected && run?.status === 'running'}
          onNavigate={target => setLastPreview({ scope, target })} onCompose={active && connected && run?.status === 'running' ? onCompose : undefined}/>
      </View>
    </View>
      : <View style={styles.empty}><Icon name="code" size={30} color={dk.faint}/><Text style={styles.hint}>{uncertain ? '正在等待确认上次启动结果' : alive(run) ? '开发服务器启动后将在这里显示' : '选择运行脚本，启动后查看页面'}</Text></View>}
  </View>;
}
const useStyles = themed((_c, d) => StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: d.surface }, header: { padding: 14, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 9 }, titleBody: { flex: 1 }, title: { fontSize: 15, color: d.text, fontWeight: '600' }, path: { fontSize: 11, color: d.muted, marginTop: 3 }, status: { fontSize: 12, color: d.muted },
  scripts: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, script: { paddingHorizontal: 10, paddingVertical: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: d.line, borderRadius: 7 }, selected: { backgroundColor: d.surface2, borderColor: d.accentText }, scriptText: { fontSize: 12, color: d.text }, command: { fontSize: 11, fontFamily: mono, color: d.muted },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, primary: { borderRadius: 8, backgroundColor: d.accentText, paddingHorizontal: 12, paddingVertical: 9 }, primaryText: { fontSize: 12, fontWeight: '600', color: d.surface }, button: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 9, backgroundColor: d.surface2 }, buttonText: { fontSize: 12, color: d.text }, disabled: { opacity: 0.4 },
  hint: { fontSize: 11, lineHeight: 17, color: d.muted }, error: { fontSize: 12, lineHeight: 18, color: d.bad }, logs: { maxHeight: 190, padding: 12, backgroundColor: d.surface2 }, logText: { fontFamily: mono, fontSize: 11, lineHeight: 17, color: d.text }, empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
}));
