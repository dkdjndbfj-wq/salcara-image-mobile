import React, { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { AppDialog } from '../components/ui';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import type { AgentProfile, RemoteApiOption } from './client';
import { ApiChoiceMenu } from './ApiPicker';
import { requestDirect } from './direct-api';
import { directConnectionGeneration, directDeliveryScope, getDirectConnectionState } from './direct-pairing';
import { directActionUncertain } from './direct-turn-actions';
import { agentApiFamily, parseAgentStatus, type AgentStatus } from './projection';
import { createDirectApiSelectionStore, verifiedDirectApiStatus, type DirectApiSelection } from './direct-api-selection';

const UNCERTAIN = 'API 切换结果待核对；确认电脑状态前暂停发送，不会自动重试。';

/** Owned by DirectExperience so directory/conversation navigation cannot discard an in-flight write. */
export function useDirectApiSelection({ pairing, generation, deviceId, connected, profile, agents, apis, sessionKey, blocked, lock, onStatus }: {
  pairing: string; generation: number; deviceId?: string; connected: boolean;
  profile?: AgentProfile; agents: AgentProfile[]; apis: RemoteApiOption[]; sessionKey?: string;
  blocked?: string; lock: MutableRefObject<boolean>; onStatus: (status: AgentStatus) => void;
}) {
  const d = useDesk(), anchor = useRef<View>(null);
  const family = profile ? agentApiFamily(profile) : '';
  const owner = JSON.stringify([pairing, generation, deviceId, profile?.id, sessionKey]);
  const source = JSON.stringify([owner, profile?.api, profile?.execution, apis]);
  const [shown, setShown] = useState(false);
  const [choice, setChoice] = useState<{ id: string; source: string }>();
  const choiceRef = useRef(choice); choiceRef.current = choice;
  const cancelChoice = () => { choiceRef.current = undefined; setChoice(undefined); };
  const [pending, setPending] = useState<DirectApiSelection>();
  const [ready, setReady] = useState('');
  const [flight, setFlight] = useState(false);
  const [error, setError] = useState('');
  const flightRef = useRef<object | undefined>(undefined);
  const mounted = useRef(true);
  const unavailable = blocked || (!connected ? '直连已断开' : !profile?.available ? '当前 Agent 不可用'
    : sessionKey && !profile.conversationApiSwitch ? '请先更新电脑端 Bridge 后切换会话 API'
    : profile.api.pending ? '电脑正在切换 API，请先核对状态' : '');
  const current = useRef({ owner, source, pairing, deviceId, family, unavailable, onStatus });
  current.current = { owner, source, pairing, deviceId, family, unavailable, onStatus };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = (identity = owner) => mounted.current && current.current.owner === identity
    && directDeliveryScope() === pairing && directConnectionGeneration() === generation
    && getDirectConnectionState().status === 'connected' && getDirectConnectionState().deviceId === deviceId;
  const store = useMemo(() => deviceId && family ? createDirectApiSelectionStore(pairing, deviceId, family,
    () => mounted.current && current.current.pairing === pairing && current.current.deviceId === deviceId && current.current.family === family
      && directDeliveryScope() === pairing && directConnectionGeneration() === generation && getDirectConnectionState().deviceId === deviceId) : undefined, [pairing, generation, deviceId, family]);

  useEffect(() => {
    let active = true;
    setShown(false); setChoice(undefined); setPending(undefined); setReady(''); setError('');
    flightRef.current = undefined; setFlight(false);
    if (!store || !connected) return;
    void store.read().then(value => {
      if (!active || !isCurrent()) return;
      setPending(value); setReady(owner); setError(value ? UNCERTAIN : '');
    }, reason => { if (active && isCurrent()) setError(reason instanceof Error ? reason.message : 'API 切换记录读取失败'); });
    return () => { active = false; };
  }, [store, owner, connected]);
  useEffect(() => { setChoice(previous => previous?.source === source ? previous : undefined); }, [source]);

  const readVerified = async (selection: DirectApiSelection) => {
    const raw = await requestDirect({ type: 'agents.status' });
    if (!isCurrent()) return false;
    const parsed = verifiedDirectApiStatus(raw, selection);
    // A nonmatching snapshot does not prove that a timed-out request was rejected.
    if (!parsed || !await store!.clear(selection.id)) throw new Error(UNCERTAIN);
    if (!isCurrent()) return false;
    current.current.onStatus(parsed); setPending(undefined); setError(''); return true;
  };
  const verify = async () => {
    if (!store || !isCurrent() || flightRef.current || lock.current) return;
    const token = {}; flightRef.current = token; setFlight(true); lock.current = true;
    try {
      const selection = await store.read();
      if (!isCurrent()) return;
      setReady(owner); setPending(selection);
      if (selection) await readVerified(selection);
      else {
        const parsed = parseAgentStatus(await requestDirect({ type: 'agents.status' }));
        if (isCurrent()) { current.current.onStatus(parsed); setError(''); }
      }
    } catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : '核对 API 状态失败'); }
    finally { if (flightRef.current === token) { flightRef.current = undefined; if (isCurrent()) { setFlight(false); lock.current = false; } } }
  };
  const submit = async () => {
    const staged = choiceRef.current;
    if (!staged || staged !== choice || staged.source !== current.current.source || !profile || !store || !isCurrent()
      || current.current.unavailable || ready !== owner || pending || flightRef.current || lock.current
      || staged.id && !apis.some(item => item.id === staged.id)) { cancelChoice(); return; }
    const selection: DirectApiSelection = { id: randomUUID(), agentId: profile.id, accountId: staged.id, ...(sessionKey ? { sessionKey } : {}) };
    const token = {}; flightRef.current = token; setFlight(true); lock.current = true; cancelChoice(); setError('');
    let marked = false, dispatched = false, accepted = false;
    try {
      await store.begin(selection); marked = true;
      if (!isCurrent() || staged.source !== current.current.source || current.current.unavailable) throw new Error('直连来源已变化，请重新选择 API');
      setPending(selection); dispatched = true;
      await requestDirect({ type: 'agents.api.set', agent: selection.agentId, accountId: selection.accountId,
        ...(selection.sessionKey ? { sessionKey: selection.sessionKey } : {}) });
      accepted = true;
      if (!isCurrent()) return;
      if (await readVerified(selection)) setShown(false);
    } catch (reason) {
      if (!isCurrent()) return;
      let uncertain = accepted || dispatched && directActionUncertain(reason);
      if (marked && !uncertain) try { if (!await store.clear(selection.id)) uncertain = true; } catch { uncertain = true; }
      if (!marked) try { const existing = await store.read(); if (existing) { setPending(existing); uncertain = true; } } catch { setReady(''); }
      if (marked) setPending(uncertain ? selection : undefined);
      setError(uncertain ? UNCERTAIN : reason instanceof Error ? reason.message : '切换 API 失败');
      setShown(true);
    } finally {
      if (flightRef.current === token) { flightRef.current = undefined; if (isCurrent()) { setFlight(false); lock.current = false; } }
    }
  };

  // Failure cards may retain their callback while a newer session/API revision renders.
  // Opening that old card must never reveal a picker for the replacement source.
  const open = () => {
    if (!profile || !isCurrent() || source !== current.current.source) return false;
    setShown(true); return true;
  };
  const locked = Boolean(profile && (ready !== owner || pending || flight || profile.api.pending));
  const currentId = profile?.api.source === 'phone' ? profile.api.accountId ?? '' : '';
  const defaultApiName = profile?.api.source !== 'phone' ? profile?.api.name : undefined;
  const selectedName = choice?.id ? apis.find(item => item.id === choice.id)?.name ?? '所选 API' : defaultApiName?.trim() || '默认 API';
  const label = profile?.api.name?.trim() || '选择 API';
  const sharedWith = agents.filter(item => item.id !== profile?.id && agentApiFamily(item) === family).map(item => item.name);
  const control = profile ? <View testID="direct-api-control" style={styles.control}>
    <View style={{ flex: 1, minWidth: 0 }}><Text style={{ color: d.muted, fontSize: 11 }}>API</Text>
      <Text numberOfLines={1} style={{ color: d.text2, fontSize: 12 }}>{pending ? '切换结果待核对' : `${label}${profile.api.model ? ` · ${profile.api.model}` : ''}`}</Text></View>
    <View ref={anchor} collapsable={false}><Pressable accessibilityRole="button" accessibilityLabel="选择直连 API" onPress={() => setShown(true)} style={[styles.button, { backgroundColor: d.surface2 }]}>
      {flight ? <ActivityIndicator size="small" color={d.muted}/> : <><Text style={{ color: d.text2, fontSize: 12 }}>切换</Text><Icon name="chevronDown" size={13} color={d.muted}/></>}
    </Pressable></View>
    <ApiChoiceMenu visible={shown && !choice} anchorRef={anchor} anchorRevision={owner} apis={apis} current={currentId} defaultApiName={defaultApiName}
      pending={flight ? pending?.accountId ?? currentId : undefined} sharedWith={sharedWith}
      blocked={pending ? UNCERTAIN : ready !== owner ? error || '正在读取 API 切换记录' : unavailable} error={error || (profile.api.pending ? '电脑正在切换 API，请核对状态' : '')}
      onClose={() => { if (!flightRef.current) setShown(false); }}
      onSelect={id => { if (!locked && !current.current.unavailable) { if (id === currentId) setShown(false); else setChoice({ id, source }); } }}
      onVerify={error || pending || profile.api.pending ? () => void verify() : undefined} verificationDisabled={flight || !connected}/>
    <AppDialog visible={Boolean(choice && choice.source === source)} title="切换直连 API" message={`将 ${profile.name}${sessionKey ? ' 当前会话' : ''}切换为「${selectedName}」${sharedWith.length ? `，与 ${sharedWith.join('、')} 共用配置` : ''}。后续任务会使用此配置。`}
      onClose={cancelChoice} actions={[{ label: '取消', tone: 'secondary', onPress: cancelChoice },
        { label: '确认切换', tone: 'primary', disabled: Boolean(unavailable || locked), onPress: () => void submit() }]}/>
  </View> : null;
  return { control, locked, busy: flight, verify, open };
}

const styles = StyleSheet.create({
  control: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, paddingHorizontal: 4 },
  button: { minHeight: 32, paddingHorizontal: 12, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 6 },
});
