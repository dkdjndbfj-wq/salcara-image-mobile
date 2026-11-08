import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { compactSessionContext, readSessionContext, sessionContextScope, type SessionContextReading } from './store';
import { contextCompactionBusy } from './session-context';
import { ContextIndicator } from './ContextIndicator';

interface Props {
  deviceId: string; sessionKey: string; scopeKey: string; active: boolean; signalVersion: string;
  canCompact: boolean; busy: boolean; onBusyChange?: (busy: boolean) => void;
  transport?: {scope:()=>string;read:(signal?:AbortSignal)=>Promise<SessionContextReading>;compact:(reading:SessionContextReading)=>Promise<SessionContextReading>};
}
export interface ContextBarHandle { compact(): boolean }

/** The composer's live context indicator; never derived from billing totals. */
export const ContextBar = forwardRef<ContextBarHandle, Props>(function ContextBar({ deviceId, sessionKey, scopeKey, active, signalVersion, canCompact, busy, onBusyChange, transport }, ref) {
  const [state, setState] = useState<{ scope: string; reading?: SessionContextReading; error?: string; loading?: boolean }>({ scope: scopeKey });
  const [reload, setReload] = useState(0), [submitting, setSubmitting] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState == null || AppState.currentState === 'active');
  const owner = useRef(scopeKey); owner.current = scopeKey;
  const mounted = useRef(true), mutation = useRef(false), request = useRef(0), reader = useRef<AbortController | undefined>(undefined);
  const reading = state.scope === scopeKey ? state.reading : undefined;
  const value = reading?.value;
  const nativeBusy = contextCompactionBusy(value), blocked = submitting || nativeBusy;
  const callback = useRef(onBusyChange); callback.current = onBusyChange;
  useEffect(() => { callback.current?.(blocked); }, [blocked]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', next => setForeground(next === 'active'));
    return () => { mounted.current = false; ++request.current; reader.current?.abort(); subscription.remove(); callback.current?.(false); };
  }, []);
  useEffect(() => {
    if (!active || !foreground || mutation.current) return;
    const scope = scopeKey, sequence = ++request.current, controller = new AbortController();
    reader.current?.abort(); reader.current = controller;
    const timer = setTimeout(() => {
      if (controller.signal.aborted || mutation.current) return;
      setState(previous => ({ ...(previous.scope === scope ? previous : {}), scope, loading: true }));
      void (transport ? transport.read(controller.signal) : readSessionContext(deviceId, sessionKey, controller.signal)).then(result => {
        if (mounted.current && !controller.signal.aborted && owner.current === scope && request.current === sequence) setState({ scope, reading: result });
      }, error => {
        if (mounted.current && !controller.signal.aborted && owner.current === scope && request.current === sequence) setState(previous => ({ scope,
          ...(previous.scope === scope && previous.reading ? { reading: { ...previous.reading, value: { ...previous.reading.value, canCompact: false, snapshot: undefined } } } : {}),
          error: error instanceof Error ? error.message : '上下文读取失败' }));
      });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [deviceId, sessionKey, scopeKey, active, foreground, signalVersion, reload, submitting]);
  useEffect(() => {
    // Only status reads are repeated. A lost compact acknowledgement is never
    // retried as another mutation, including after this component remounts.
    if (!active || !foreground || !nativeBusy || submitting) return;
    const timer = setTimeout(() => setReload(current => current + 1), 3000);
    return () => clearTimeout(timer);
  }, [active, foreground, nativeBusy, submitting, reload, state]);
  const compact = (): boolean => {
    if (!mounted.current || mutation.current || !reading || !active || !foreground || busy || blocked || !canCompact || !value?.canCompact || state.error || state.loading) return false;
    const scope = scopeKey;
    try { if (reading.scope !== (transport ? transport.scope() : sessionContextScope(deviceId, sessionKey))) return false; } catch { return false; }
    mutation.current = true; ++request.current; reader.current?.abort(); setSubmitting(true); callback.current?.(true);
    void (async () => {
      try {
        const result = await (transport ? transport.compact(reading) : compactSessionContext(deviceId, sessionKey, reading));
        if (mounted.current && owner.current === scope) setState({ scope, reading: result });
      } catch (error) {
        if (mounted.current && owner.current === scope) setState({ scope, reading: { ...reading, value: { ...reading.value, canCompact: false, snapshot: undefined,
          compaction: { state: 'unconfirmed', blocking: true, startedAt: Date.now(), updatedAt: Date.now() } } }, error: error instanceof Error ? error.message : '压缩结果未确认' });
      } finally {
        mutation.current = false;
        if (mounted.current && owner.current === scope) setSubmitting(false);
      }
    })();
    return true;
  };
  useImperativeHandle(ref, () => ({ compact }));
  const error = state.scope === scopeKey ? state.error || value?.compaction?.error : undefined;
  const disabled = !active || !foreground || busy || blocked || !canCompact || !value?.canCompact || Boolean(state.error) || state.loading === true;
  return <ContextIndicator scopeKey={scopeKey} active={active && foreground} value={value} loading={state.scope === scopeKey && state.loading === true} submitting={submitting}
    error={error} canCompact={canCompact} compactDisabled={disabled} refreshDisabled={!active || !foreground || submitting}
    onRefresh={() => setReload(current => current + 1)} onCompact={() => void compact()} />;
});
