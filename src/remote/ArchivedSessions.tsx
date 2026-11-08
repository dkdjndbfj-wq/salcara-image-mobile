import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import type { ToolId } from './client';
import { applyNativeSessionAction, nativeSessionActionScope, readArchivedSessions, readNativeSessionActions, useRemote, type ArchivedSessionsPage } from './store';
import { SkeletonGroup, SkeletonRows } from '../components/Skeleton';

export function ArchivedSessions({ deviceId, tool, onRestored }: { deviceId: string; tool: ToolId; onRestored: (key: string) => void }) {
  useRemote();
  const dk = useDesk(), [page, setPage] = useState<ArchivedSessionsPage>(), [error, setError] = useState(''), [loading, setLoading] = useState(true), [restoring, setRestoring] = useState('');
  let scope = '';
  try { scope = nativeSessionActionScope(deviceId, `${tool}:__salcara_archived_directory__`); } catch { /* Pairing removed. */ }
  const identity = `${deviceId}|${tool}|${scope}`, current = useRef(identity); current.current = identity;
  const mounted = useRef(false), loadOwner = useRef<object | null>(null), restoreOwner = useRef<object | null>(null);
  const stillCurrent = () => {
    try { return mounted.current && current.current === identity && scope === nativeSessionActionScope(deviceId, `${tool}:__salcara_archived_directory__`); }
    catch { return false; }
  };
  const load = (previous?: ArchivedSessionsPage, signal?: AbortSignal) => {
    if (!scope || loadOwner.current) return;
    const active = {}; loadOwner.current = active; setLoading(true); setError('');
    void readArchivedSessions(deviceId, tool, previous, signal).then(next => {
      if (!stillCurrent() || loadOwner.current !== active) return;
      const seen = new Set(previous?.sessions.map(item => item.sessionKey));
      setPage({ ...next, sessions: [...(previous?.sessions ?? []), ...next.sessions.filter(item => !item.parentSessionKey && !seen.has(item.sessionKey))] });
    }).catch((reason: Error) => { if (mounted.current && current.current === identity && loadOwner.current === active && !signal?.aborted) setError(reason.message); })
      .finally(() => { if (loadOwner.current === active) { loadOwner.current = null; if (mounted.current && current.current === identity) setLoading(false); } });
  };
  useEffect(() => {
    mounted.current = true; loadOwner.current = null; restoreOwner.current = null; setPage(undefined); setRestoring(''); setError('');
    const controller = new AbortController();
    if (scope) load(undefined, controller.signal); else { setLoading(false); setError('会话连接已改变'); }
    return () => { mounted.current = false; controller.abort(); loadOwner.current = null; restoreOwner.current = null; };
  }, [identity]);
  const restore = (sessionKey: string) => {
    if (!scope || restoreOwner.current || !stillCurrent()) return;
    const active = {}; restoreOwner.current = active; setRestoring(sessionKey); setError('');
    void (async () => {
      try {
        const reading = await readNativeSessionActions(deviceId, sessionKey);
        if (!stillCurrent() || restoreOwner.current !== active) return;
        if (!reading.value.archived || !reading.value.actions.includes('unarchive')) throw new Error(reading.value.unavailableReason || '此对话暂不能恢复');
        const result = await applyNativeSessionAction(deviceId, sessionKey, reading, 'unarchive');
        if (!stillCurrent() || restoreOwner.current !== active) return;
        if (result.state !== 'completed') throw new Error(result.error || '恢复结果未确认');
        setPage(previous => previous ? { ...previous, sessions: previous.sessions.filter(item => item.sessionKey !== sessionKey) } : previous);
        onRestored(sessionKey);
      } catch (reason) { if (mounted.current && current.current === identity && restoreOwner.current === active) setError(reason instanceof Error ? reason.message : '恢复失败'); }
      finally { if (restoreOwner.current === active) { restoreOwner.current = null; if (mounted.current && current.current === identity) setRestoring(''); } }
    })();
  };
  return <View style={styles.root}>
    {error ? <Text accessibilityRole="alert" style={[styles.error, { color: dk.bad }]}>{error}</Text> : null}
    <FlatList data={page?.sessions ?? []} keyExtractor={item => item.sessionKey} contentContainerStyle={styles.list}
      renderItem={({ item }) => <View style={[styles.row, { borderBottomColor: dk.line }]}>
        <Icon name="archive" size={15} color={dk.muted} /><Text numberOfLines={2} style={[styles.title, { color: dk.text }]}>{item.title || '无标题对话'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`恢复${item.title || '对话'}`} disabled={Boolean(restoring)} onPress={() => restore(item.sessionKey)} style={[styles.restore, restoring && styles.disabled]}>
          {restoring === item.sessionKey ? <ActivityIndicator size="small" color={dk.accentText} /> : <Text style={[styles.label, { color: dk.accentText }]}>恢复</Text>}
        </Pressable>
      </View>}
      ListEmptyComponent={!loading && !error ? <Text style={[styles.empty, { color: dk.muted }]}>没有已归档对话</Text> : loading ? <SkeletonGroup label="正在读取归档"><SkeletonRows rows={5} avatar={15} /></SkeletonGroup> : null}
      ListFooterComponent={loading && page?.sessions.length ? <ActivityIndicator style={styles.footer} size="small" color={dk.muted} />
        : page?.nextCursor || error ? <Pressable accessibilityRole="button" accessibilityLabel={error ? '重新读取归档' : '更多归档'} onPress={() => load(error ? undefined : page)} style={styles.footer}>
          <Text style={[styles.label, { color: dk.accentText }]}>{error ? '重新读取' : '更多'}</Text>
        </Pressable> : null} />
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1, minHeight: 0 }, list: { paddingHorizontal: 14, paddingBottom: 20 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17 }, restore: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 12 }, error: { fontSize: 12, lineHeight: 18, padding: 14 }, empty: { fontSize: 12, textAlign: 'center', paddingVertical: 30 },
  footer: { minHeight: 44, justifyContent: 'center', alignItems: 'center' }, disabled: { opacity: 0.5 } });
