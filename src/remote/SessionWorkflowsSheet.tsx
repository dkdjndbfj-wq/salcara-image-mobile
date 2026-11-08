import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppDialog, showToast, type DialogAction } from '../components/ui';
import { useDesk } from '../theme';
import { applySessionWorkflow, readSessionWorkflows, sessionWorkflowScope, timelineKey, useRemote } from './store';
import { goalStatusLabels, validWorkflowInput, type GoalAction, type ReviewTarget, type SessionWorkflowsReading, type WorkflowInput } from './session-workflows';

const targetLabels: Record<ReviewTarget['type'], string> = { uncommittedChanges: '未提交更改', baseBranch: '基准分支', commit: '指定提交', custom: '自定义' };
const goalLabels: Record<GoalAction, string> = { set: '设置目标', pause: '暂停目标', resume: '继续目标', clear: '清除目标' };
export function SessionWorkflowsSheet({ visible, deviceId, sessionKey, onClose }: { visible: boolean; deviceId: string; sessionKey: string; onClose: () => void }) {
  const dk = useDesk(), remote = useRemote(), signal = remote.timelines[timelineKey(deviceId, sessionKey)]?.workflowSignal ?? 0;
  const [reading, setReading] = useState<SessionWorkflowsReading>(), [error, setError] = useState(''), [page, setPage] = useState<'home' | 'review' | 'goal'>('home');
  const [targetType, setTargetType] = useState<ReviewTarget['type']>('uncommittedChanges'), [targetText, setTargetText] = useState('');
  const [objective, setObjective] = useState(''), [budget, setBudget] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [unknown, setUnknown] = useState(false), [reload, setReload] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState == null || AppState.currentState === 'active');
  let scope = ''; try { if (visible) scope = sessionWorkflowScope(deviceId, sessionKey); } catch { /* no current source */ }
  const identity = `${visible}|${deviceId}|${sessionKey}|${scope}`, owner = useRef({ identity, token: {} });
  if (owner.current.identity !== identity) owner.current = { identity, token: {} };
  const token = owner.current.token, mounted = useRef(true), mutation = useRef<object | null>(null), reader = useRef<AbortController | null>(null);
  const current = () => {
    try { return mounted.current && owner.current.token === token && scope !== '' && scope === sessionWorkflowScope(deviceId, sessionKey); } catch { return false; }
  };
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', value => setForeground(value === 'active'));
    return () => { mounted.current = false; reader.current?.abort(); subscription.remove(); };
  }, []);
  useEffect(() => {
    mutation.current = null; setReading(undefined); setPage('home'); setError(''); setBusy(false); setUnknown(false);
    setTargetType('uncommittedChanges'); setTargetText(''); setObjective(''); setBudget('');
  }, [identity]);
  useEffect(() => {
    if (!visible || !scope || !foreground || mutation.current) return;
    const controller = new AbortController(); reader.current?.abort(); reader.current = controller; setLoading(true);
    void readSessionWorkflows(deviceId, sessionKey, controller.signal).then(value => {
      if (!current() || controller.signal.aborted) return;
      setReading(value); setError('');
      if (value.value.canReview || value.value.goalActions.length > 0) setUnknown(false);
    }, reason => { if (current() && !controller.signal.aborted) { setReading(undefined); setError(reason instanceof Error ? reason.message : '会话任务读取失败'); } })
      .finally(() => { if (current() && !controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [identity, signal, reload, busy, foreground]);
  useEffect(() => {
    if (!visible || !foreground || busy || !unknown && reading?.value.goal?.status !== 'active') return;
    const timer = setTimeout(() => setReload(value => value + 1), 3000);
    return () => clearTimeout(timer);
  }, [identity, foreground, busy, unknown, reading, reload]);
  const close = () => { if (mounted.current && owner.current.token === token) onClose(); };
  const execute = (input: WorkflowInput) => {
    if (!current() || mutation.current || loading || !reading || reading.scope !== scope || !validWorkflowInput(input)) return;
    const flight = {}; mutation.current = flight; reader.current?.abort(); setBusy(true); setError('');
    void Promise.resolve().then(() => applySessionWorkflow(deviceId, sessionKey, reading, input)).then(result => {
      if (!current()) return;
      if (result.state === 'unconfirmed') { setReading(undefined); setUnknown(true); setError(result.error || '操作结果未确认'); return; }
      if (input.kind === 'review') { onClose(); showToast('审查已开始', 'checkCircle'); }
      else { setReading(undefined); setPage('home'); setReload(value => value + 1); showToast(input.kind === 'goal.set' ? '目标已设置' : input.kind === 'goal.pause' ? '目标已暂停' : input.kind === 'goal.resume' ? '目标已继续' : '目标已清除', 'checkCircle'); }
    }, reason => { if (current()) { setReading(undefined); setUnknown(true); setError(reason instanceof Error ? reason.message : '操作结果未确认'); } })
      .finally(() => { if (mutation.current === flight) mutation.current = null; if (current()) setBusy(false); });
  };
  const target: ReviewTarget = targetType === 'baseBranch' ? { type: targetType, branch: targetText.trim() }
    : targetType === 'commit' ? { type: targetType, sha: targetText.trim() } : targetType === 'custom' ? { type: targetType, instructions: targetText.trim() } : { type: targetType };
  const input: WorkflowInput = page === 'review' ? { kind: 'review', target } : { kind: 'goal.set', objective: objective.trim(), ...(budget.trim() ? { tokenBudget: /^\d+$/.test(budget.trim()) ? Number(budget) : NaN } : {}) };
  const actions: DialogAction[] = [
    ...(page !== 'home' ? [{ label: page === 'review' ? '开始审查' : '设置目标', tone: 'primary' as const,
      disabled: busy || loading || !reading || !validWorkflowInput(input) || (page === 'review' ? !reading.value.canReview : !reading.value.goalActions.includes('set')), onPress: () => execute(input) }] : []),
    { label: '关闭', tone: 'secondary', onPress: close },
  ];
  const goal = reading?.value.goal;
  const actionRow = (label: string, onPress: () => void) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} disabled={busy || loading}
    onPress={() => { if (current() && !mutation.current) onPress(); }} style={[styles.action, { borderColor: dk.line, opacity: busy || loading ? 0.45 : 1 }]}><Text style={[styles.label, { color: dk.text }]}>{label}</Text></Pressable>;
  return <AppDialog visible={visible} title={page === 'review' ? '代码审查' : page === 'goal' ? '设置目标' : '审查与目标'} icon="code" onClose={close} actions={actions}>
    {page === 'home' ? <View style={styles.content}>
      {goal ? <View style={styles.goal}><View style={styles.status}><Text style={[styles.label, { color: dk.accentText }]}>{goalStatusLabels[goal.status]}</Text>
        <Text style={[styles.detail, { color: dk.muted }]}>{goal.tokensUsed.toLocaleString()}{goal.tokenBudget == null ? '' : ` / ${goal.tokenBudget.toLocaleString()}`} tokens</Text></View>
        <Text selectable style={[styles.label, { color: dk.text }]}>{goal.objective}</Text></View> : null}
      {reading?.value.canReview ? actionRow('代码审查', () => setPage('review')) : null}
      {reading?.value.goalActions.map(action => actionRow(goalLabels[action], () => {
        if (action === 'set') { setObjective(goal?.objective ?? ''); setBudget(goal?.tokenBudget == null ? '' : String(goal.tokenBudget)); setPage('goal'); }
        else execute({ kind: `goal.${action}` });
      }))}
    </View> : page === 'review' ? <View style={styles.content}>
      <View style={styles.targets}>{(Object.keys(targetLabels) as ReviewTarget['type'][]).map(type => <Pressable key={type} accessibilityRole="button" accessibilityLabel={targetLabels[type]}
        accessibilityState={{ selected: targetType === type, disabled: busy }} disabled={busy} onPress={() => { if (current()) { setTargetType(type); setTargetText(''); } }}
        style={[styles.target, { backgroundColor: targetType === type ? dk.surface3 : dk.surface2 }]}><Text style={[styles.detail, { color: targetType === type ? dk.accentText : dk.text }]}>{targetLabels[type]}</Text></Pressable>)}</View>
      {targetType !== 'uncommittedChanges' ? <TextInput accessibilityLabel={targetLabels[targetType]} value={targetText} onChangeText={setTargetText} editable={!busy}
        multiline={targetType === 'custom'} placeholder={targetType === 'baseBranch' ? '分支名' : targetType === 'commit' ? '提交 SHA' : '审查要求'} placeholderTextColor={dk.muted}
        autoCapitalize="none" autoCorrect={false} maxLength={targetType === 'custom' ? 8000 : 256} style={[styles.input, targetType === 'custom' && styles.multiline, { color: dk.text, backgroundColor: dk.surface2 }]} /> : null}
    </View> : <View style={styles.content}>
      <TextInput accessibilityLabel="任务目标" value={objective} onChangeText={setObjective} multiline editable={!busy} maxLength={8000} placeholder="任务目标" placeholderTextColor={dk.muted}
        style={[styles.input, styles.multiline, { color: dk.text, backgroundColor: dk.surface2 }]} />
      <TextInput accessibilityLabel="Token 上限（选填）" value={budget} onChangeText={setBudget} editable={!busy} keyboardType="number-pad" maxLength={16} placeholder="Token 上限（选填）" placeholderTextColor={dk.muted}
        style={[styles.input, { color: dk.text, backgroundColor: dk.surface2 }]} />
    </View>}
    {busy || loading ? <View style={styles.status}><ActivityIndicator size="small" color={dk.muted} /><Text style={[styles.detail, { color: dk.muted }]}>{busy ? '处理中…' : '读取状态…'}</Text></View> : null}
    {error || !scope ? <Text accessibilityRole="alert" style={[styles.detail, { color: dk.bad }]}>{error || '会话连接已改变'}</Text>
      : reading?.value.unavailableReason ? <Text style={[styles.detail, { color: dk.muted }]}>{reading.value.unavailableReason}</Text> : null}
  </AppDialog>;
}
const styles = StyleSheet.create({ content: { gap: 8 }, goal: { gap: 5, paddingBottom: 5 }, status: { minHeight: 28, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  label: { fontSize: 13, lineHeight: 19 }, detail: { fontSize: 12, lineHeight: 18 }, action: { minHeight: 38, paddingVertical: 8, paddingHorizontal: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9 },
  targets: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, target: { minHeight: 34, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 9 },
  input: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, fontSize: 13 }, multiline: { minHeight: 80, maxHeight: 180, textAlignVertical: 'top' } });
