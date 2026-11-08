import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, Text, View } from 'react-native';
import { useDesk } from '../theme';
import { conversationFontFamily } from './conversation-typography';

type Failure = { id: string; errorCode?: string; retryAt?: number };
export function limitRetryTime(failure?: Failure | null): number | undefined {
  if (!failure || !['usage_limit', 'upstream_rate_limit'].includes(failure.errorCode ?? '')) return;
  const at = failure.retryAt;
  return typeof at === 'number' && Number.isSafeInteger(at) && at > 0 && at <= Date.now() + 7 * 86400_000 ? at : undefined;
}
const foreground = () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive'
  && (Platform.OS !== 'web' || typeof document === 'undefined' || document.visibilityState !== 'hidden');
const remaining = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时 ${Math.ceil(seconds % 3600 / 60)} 分钟`
    : seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
};
/** An explicit foreground-only, one-shot action. No persistence or retry loop. */
export function LimitRetryNotice({ failure, scopeKey, cancelKey, enabled, onRetry }: {
  failure?: Failure | null; scopeKey: string; cancelKey: string; enabled: boolean; onRetry: () => void;
}) {
  const d = useDesk(), retryAt = limitRetryTime(failure);
  const key = JSON.stringify([scopeKey, failure?.id, retryAt, cancelKey]);
  const [armed, setArmed] = useState<string>(), [now, setNow] = useState(Date.now);
  const current = useRef({ key, enabled, onRetry }); current.current = { key, enabled, onRetry };
  const schedule = useRef<string | undefined>(undefined);
  const active = armed === key && enabled;
  useEffect(() => {
    if (!active || !retryAt || !foreground()) { schedule.current = undefined; setArmed(undefined); return; }
    schedule.current = key;
    const cancel = () => { schedule.current = undefined; setArmed(undefined); };
    const tick = () => {
      if (schedule.current !== key || current.current.key !== key || !current.current.enabled || !foreground()) { cancel(); return; }
      const time = Date.now(); setNow(time);
      if (time >= retryAt) { cancel(); current.current.onRetry(); }
    };
    const timer = setInterval(tick, 1000);
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') cancel(); });
    const visibility = () => { if (!foreground()) cancel(); };
    if (Platform.OS === 'web' && typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); schedule.current = undefined; subscription.remove();
      if (Platform.OS === 'web' && typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); };
  }, [active, key, retryAt]);
  if (!retryAt) return null;
  const future = retryAt > (active ? now : Date.now());
  const label = new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const textStyle = { fontFamily: conversationFontFamily, fontSize: 12, lineHeight: 18, color: d.muted };
  return <View testID="limit-retry-notice" style={{ paddingHorizontal: 12, paddingVertical: 6, gap: 3 }}>
    <Text style={textStyle}>{active ? `将在 ${remaining(retryAt - now)} 后重试一次` : future ? `额度预计于 ${label} 恢复` : '额度恢复时间已到，可手动重试'}</Text>
    {active ? <Pressable accessibilityRole="button" accessibilityLabel="取消到时重试" onPress={() => { schedule.current = undefined; setArmed(undefined); }} style={{ minHeight: 30, justifyContent: 'center', alignSelf: 'flex-start' }}>
      <Text style={[textStyle, { color: d.text }]}>取消重试</Text>
    </Pressable> : future && enabled ? <Pressable accessibilityRole="button" accessibilityLabel="额度恢复后重试一次" onPress={() => { if (current.current.key === key && current.current.enabled && foreground() && retryAt > Date.now()) { setNow(Date.now()); setArmed(key); } }} style={{ minHeight: 30, justifyContent: 'center', alignSelf: 'flex-start' }}>
      <Text style={[textStyle, { color: d.text }]}>到时重试一次</Text>
    </Pressable> : null}
  </View>;
}
