import {WorkbenchReveal} from './ConversationMotion';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Icon } from '../components/Icon';
import { AppDialog, showToast } from '../components/ui';
import { useDesk } from '../theme';
import { conversationFontFamily } from './conversation-typography';
import { executionErrorDetail } from './api-errors';
import { executionRecovery, type ExecutionRecoveryAction } from './execution-recovery';

export function ExecutionFailureActions({ id, scopeKey, error = '', code, meta, onRetry, onResolve }: {
  id: string; scopeKey: string; error?: string; code?: string; meta?: string; onRetry?: () => void;
  onResolve?: (action: ExecutionRecoveryAction) => void;
}) {
  const d = useDesk(), failure = executionRecovery(error, code), [details, setDetails] = useState<string>();
  const identity = JSON.stringify([scopeKey, id, error, code]);
  const latest=useRef(identity),alive=useRef(true);latest.current=identity;
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const current=()=>alive.current&&latest.current===identity;
  const label = { fontFamily: conversationFontFamily, fontSize: 12, lineHeight: 18, color: d.muted };
  return <WorkbenchReveal transitionKey={identity} testID="execution-failure-actions" style={{ paddingVertical: 8, gap: 4 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}><Icon name="alert" size={14} color={d.bad} /><Text style={[label, { flex: 1, color: d.text }]}>{failure.label}{meta ? ` · ${meta}` : ''}</Text></View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginLeft: 20 }}>
      {failure.action && onResolve ? <Pressable accessibilityRole="button" accessibilityLabel={failure.actionLabel} onPress={() => {if(current())onResolve(failure.action!);}} style={{ minHeight: 34, justifyContent: 'center' }}><Text style={[label, { color: d.text }]}>{failure.actionLabel}</Text></Pressable> : null}
      {onRetry && failure.retry ? <Pressable accessibilityRole="button" accessibilityLabel="重试上一条消息" onPress={()=>{if(current())onRetry();}} style={{ minHeight: 34, justifyContent: 'center' }}><Text style={label}>重试</Text></Pressable> : null}
      {error ? <Pressable accessibilityRole="button" accessibilityLabel="查看错误详情" onPress={() => setDetails(identity)} style={{ minHeight: 34, justifyContent: 'center' }}><Text style={label}>详情</Text></Pressable> : null}
    </View>
    <AppDialog visible={details === identity} title="错误详情" message={executionErrorDetail(error)} icon="alert" onClose={() => setDetails(undefined)} actions={[
      { label: '复制错误详情', tone: 'secondary', onPress: () => { if(!current())return;void Clipboard.setStringAsync(`${failure.label}\n${code ? `代码：${code}\n` : ''}${executionErrorDetail(error)}`).then(() => {if(current())showToast('已复制', 'check');}, () => {if(current())showToast('复制失败，请重试', 'alert');}); } },
    ]} />
  </WorkbenchReveal>;
}
