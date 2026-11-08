import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ToolbarButton } from './WorkbenchToolbar';
import { TerminalSurface } from './TerminalSurface';
import type { TerminalSurfaceHandle } from './TerminalSurface.types';
import { captureWorkspaceTerminal, terminalDimensions, type TerminalOutput, type TerminalSelection, type WorkspaceTerminal } from './workspace-terminal';
import { useWorkspaceRuntime } from './WorkspaceRuntimeContext';

/** Keep this component mounted while its tab is in the background. Removing
 * the tab disposes the PTY; changing tabs only changes `active`. */
export function RemoteTerminalPage({ active = true, connectOnMount = true, ...selection }: TerminalSelection & { active?: boolean; connectOnMount?: boolean }) {
  const runtime = useWorkspaceRuntime();
  const surface = useRef<TerminalSurfaceHandle>(null), connection = useRef<WorkspaceTerminal | null>(null);
  const dimensions = useRef({ cols: 80, rows: 24 }), connected = useRef(false), activeRef = useRef(active); activeRef.current = active;
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), pendingInput = useRef(''), sendingInput = useRef(false);
  const [ready, setReady] = useState(false), [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'exited' | 'error'>(connectOnMount ? 'connecting' : 'exited');
  const [error, setError] = useState(connectOnMount ? '' : '终端会话需要重新打开');
  const fail = useCallback((reason: unknown) => { connected.current = false; surface.current?.setEnabled(false); setStatus('error'); setError(reason instanceof Error ? reason.message : '终端连接中断，请重新打开'); }, []);
  useEffect(() => {
    if (!ready || !connectOnMount && generation === 0) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined, cursor = 0;
    connected.current = false; pendingInput.current = ''; sendingInput.current = false; setStatus('connecting'); setError('');
    const terminal = (runtime?.captureTerminal ?? captureWorkspaceTerminal)(selection, () => { if (!cancelled) fail(new Error('电脑、会话或授权已变化，终端已停止')); });
    connection.current = terminal;
    const output = (reply: TerminalOutput) => {
      if (cancelled) return;
      if (reply.truncated) surface.current?.writeText('\r\n[较早输出已超出缓冲区]\r\n');
      surface.current?.writeBase64(reply.dataBase64); cursor = reply.cursor;
      if (reply.exited) { connected.current = false; setStatus('exited'); surface.current?.writeText(`\r\n[终端已退出，代码 ${reply.exitCode}]\r\n`); }
    };
    const read = async () => {
      if (!connected.current) return;
      try {
        const reply = await terminal.read(cursor); if (cancelled || !connected.current) return; output(reply);
        if (!reply.exited) timer = setTimeout(() => { void read(); }, reply.dataBase64.length ? 60 : activeRef.current ? 250 : 750);
      } catch (reason) { if (!cancelled && connected.current) fail(reason); }
    };
    void terminal.open(dimensions.current.cols, dimensions.current.rows).then(reply => {
      if (cancelled) return;
      connected.current = !reply.exited; surface.current?.setEnabled(!reply.exited); setStatus(reply.exited ? 'exited' : 'connected'); output(reply);
      if (activeRef.current) surface.current?.focus();
      if (!reply.exited) void read();
    }).catch(reason => { if (!cancelled) fail(reason); });
    return () => { cancelled = true; connected.current = false; pendingInput.current = ''; if (timer) clearTimeout(timer); if (resizeTimer.current) clearTimeout(resizeTimer.current); if (inputTimer.current) clearTimeout(inputTimer.current); terminal.dispose(); if (connection.current === terminal) connection.current = null; };
  }, [ready, generation, connectOnMount, selection.deviceId, selection.sessionKey, selection.agentId, selection.surface, selection.cwd, fail, runtime?.scope, runtime?.captureTerminal]);
  const input = useCallback((data: string) => {
    if (!connected.current || !data) return;
    if (pendingInput.current.length + data.length > 256 * 1024) { fail(new Error('粘贴内容过长，终端输入已暂停')); return; }
    pendingInput.current += data;
    const flush = async () => {
      if (sendingInput.current || !connected.current || !pendingInput.current || !connection.current) return;
      const owner = connection.current;
      let chunk = pendingInput.current.slice(0, 4096);
      // Keep a UTF-16 surrogate pair together at a pasted-input boundary.
      if (/[\uD800-\uDBFF]$/.test(chunk)) chunk = chunk.slice(0, -1);
      pendingInput.current = pendingInput.current.slice(chunk.length); sendingInput.current = true;
      try { await owner.input(chunk); }
      catch (reason) { if (connection.current === owner) { pendingInput.current = ''; fail(reason); } }
      finally { if (connection.current === owner) { sendingInput.current = false; if (pendingInput.current && connected.current) void flush(); } }
    };
    if (inputTimer.current) clearTimeout(inputTimer.current);
    inputTimer.current = setTimeout(() => { void flush(); }, 16);
  }, [fail]);
  const resize = useCallback((cols: number, rows: number) => {
    dimensions.current = terminalDimensions(cols, rows);
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      const owner = connection.current;
      if (connected.current && owner) void owner.resize(dimensions.current.cols, dimensions.current.rows).catch(reason => {
        if (connection.current === owner) fail(reason);
      });
    }, 120);
  }, [fail]);
  const close = useCallback(() => {
    const owner = connection.current;
    if (!connected.current || !owner) return;
    connected.current = false; surface.current?.setEnabled(false);
    void owner.close().then(() => { if (connection.current === owner) setStatus('exited'); })
      .catch(reason => { if (connection.current === owner) fail(reason); });
  }, [fail]);
  return <View style={styles.page}>
    <View style={styles.toolbar}>
      {status === 'connecting' ? <ActivityIndicator size="small" color="#777C83" /> : <View style={[styles.dot, { backgroundColor: status === 'connected' ? '#34A46F' : '#A0A4AB' }]} />}
      <Text style={styles.title}>电脑终端</Text><Text numberOfLines={1} style={styles.path}>{selection.cwd}</Text>
      <ToolbarButton label="清空终端显示" icon="eraser" onPress={() => surface.current?.clear()} color="#777C83"/>
    </View>
    {error ? <View style={styles.notice}><Text style={styles.error}>{error}</Text></View> : null}
    <View style={styles.surface}><TerminalSurface key={generation} ref={surface} active={active} enabled={status === 'connected'} onInput={input} onResize={resize} onReady={() => setReady(true)} onError={fail} /></View>
    <View style={styles.keys}>
      {[['Ctrl+C', '\x03'], ['Tab', '\t'], ['Esc', '\x1b'], ['↑', '\x1b[A'], ['↓', '\x1b[B']].map(([label, data]) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={`终端 ${label}`} disabled={status !== 'connected'} onPress={() => { input(data); surface.current?.focus(); }} style={[styles.key, status !== 'connected' && styles.disabled]}><Text style={styles.keyText}>{label}</Text></Pressable>)}
      <View style={styles.spacer} />
      {status === 'error' || status === 'exited' ? <Pressable accessibilityRole="button" accessibilityLabel="新建电脑终端" onPress={() => { setReady(false); setGeneration(value => value + 1); }} style={styles.key}><Text style={styles.keyText}>重新打开</Text></Pressable>
        : <Pressable accessibilityRole="button" accessibilityLabel="结束电脑终端" disabled={status !== 'connected'} onPress={close} style={styles.key}><Text style={styles.keyText}>结束</Text></Pressable>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFFFFF', minHeight: 0 }, toolbar: { minHeight: 52, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#E6E7E9' },
  dot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 }, title: { color: '#252A31', fontSize: 12, fontWeight: '500', flexShrink: 0 }, path: { flex: 1, minWidth: 0, fontSize: 10, color: '#777C83' },
  surface: { flex: 1, minHeight: 0 }, notice: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#F7F7F8' }, error: { fontSize: 11, color: '#646970', lineHeight: 17 },
  keys: { minHeight: 52, flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 10, paddingVertical: 4, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#E6E7E9' },
  key: { minWidth: 44, minHeight: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 5, backgroundColor: '#F4F4F5' }, keyText: { color: '#646970', fontSize: 11 }, disabled: { opacity: 0.4 }, spacer: { flex: 1, minWidth: 0 },
});
