import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useDesk } from '../theme';
import { confirmedMissingSession, type MissingSessionEvidence } from './composer-draft-origin';

export function MissingSessionDraftRecovery({ scopeKey, evidence, restored = false, hasDraft, disabled = false, undoDisabled = false, error, onRestore, onUndo }: {
  scopeKey: string; evidence?: MissingSessionEvidence; restored?: boolean; hasDraft: boolean; disabled?: boolean; undoDisabled?: boolean; error?: string;
  onRestore?: () => Promise<boolean | void> | boolean | void; onUndo?: () => Promise<boolean | void> | boolean | void;
}) {
  const d = useDesk(), token = useMemo(() => ({}), [scopeKey, restored, evidence?.kind, evidence?.deviceId, evidence?.sessionKey]);
  const [operation, setOperation] = useState<{ token: object; busy: boolean; error?: string }>();
  const current = useRef({ token, disabled, undoDisabled }); current.current = { token, disabled, undoDisabled };
  const flight = useRef<object | undefined>(undefined);
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const busy = operation?.token === token && operation.busy, problem = error || (operation?.token === token ? operation.error : undefined);
  if (!hasDraft || !restored && !confirmedMissingSession(evidence)) return null;
  const run = async () => {
    if (!mounted.current || current.current.token !== token || current.current.disabled || restored && current.current.undoDisabled || flight.current === token) return;
    const action = restored ? onUndo : onRestore; if (!action) return;
    flight.current = token; setOperation({ token, busy: true });
    try {
      const accepted = await action();
      if (mounted.current && current.current.token === token) setOperation({ token, busy: false, ...(accepted === false ? { error: restored ? '草稿已有新修改，未撤销' : '恢复未完成，原草稿已保留' } : {}) });
    } catch (reason) { if (mounted.current && current.current.token === token) setOperation({ token, busy: false, error: reason instanceof Error ? reason.message : '草稿操作失败，请重试' }); }
    finally { if (flight.current === token) flight.current = undefined; }
  };
  return <View testID="missing-session-draft-recovery" style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 5 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ flex: 1, color: d.muted, fontSize: 12, lineHeight: 18 }}>{restored ? '已恢复到新对话，原草稿仍保留' : '原会话已不存在，未发送的内容已保留'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={restored ? '撤销草稿恢复' : '恢复草稿到新对话'} disabled={disabled || busy || restored && undoDisabled || !(restored ? onUndo : onRestore)} onPress={() => void run()} style={{ minHeight: 36, justifyContent: 'center', opacity: disabled || restored && undoDisabled ? .5 : 1 }}>
        <Text style={{ color: d.text, fontSize: 12 }}>{busy ? '正在处理…' : restored ? '撤销' : '恢复到新对话'}</Text>
      </Pressable>
    </View>
    {restored && undoDisabled ? <Text style={{ color: d.muted, fontSize: 11 }}>已有后续修改，保留当前草稿。</Text> : null}
    {problem ? <Text accessibilityRole="alert" style={{ color: d.warn, fontSize: 12 }}>{problem}</Text> : null}
  </View>;
}
