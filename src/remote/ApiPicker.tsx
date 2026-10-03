import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Icon } from '../components/Icon';
import { showToast } from '../components/ui';
import { colors, desk, themed, useDesk } from '../theme';
import type { AgentProfile, RemoteApiOption } from './client';
import { agentApiLabel } from './projection';
import { setAgentApi, useRemote } from './store';
import { ProgrammingAction, ProgrammingSheet } from './ProgrammingUi';

type ApiChoiceProps = {
  visible: boolean; deviceId: string; agent: AgentProfile; apis: RemoteApiOption[]; onClose: () => void;
  onChanged?: (profile?: AgentProfile) => void; sessionKey?: string; blocked?: string;
  externalBusy?: boolean; operationCurrent?: () => boolean;
};
let nextApiRequest = 0;

/** Connection-only confirmation; the conversation's Key arc remains unchanged. */
export function ApiPicker(props: ApiChoiceProps) {
  const styles = useStyles();
  const { agent, apis } = props;
  const { shown, choice, saving, unavailable, choose, save, close } = useApiChoice(props);
  return <ProgrammingSheet compact visible={shown} title="更换 API" subtitle="选择电脑保存的密钥" onClose={close} dismissible={!saving}
    footer={<ProgrammingAction label="使用这个设置" loading={saving} disabled={Boolean(unavailable) || saving || Boolean(choice && !apis.some((item) => item.id === choice))} onPress={() => void save()} />}>
    <View style={{ gap: 12 }}>
      {unavailable ? <Text style={styles.note}>{unavailable}</Text> : null}
      <View style={styles.choices}>
        <Row first title="跟随电脑" detail={agent.api.source === 'phone' ? '使用电脑设置' : agentApiLabel(agent)} selected={!choice} disabled={saving || Boolean(unavailable)} onPress={() => choose('')} />
        {apis.map((item) => <Row key={item.id} title={item.name} detail={item.models.length ? `${item.models.length} 个模型` : '电脑上还没读到模型列表，连接时会再检查'} selected={choice === item.id} disabled={saving || Boolean(unavailable)} onPress={() => choose(item.id)} />)}
      </View>
      {!apis.length ? <Text style={styles.note}>请先在电脑的 API 密钥库添加。</Text> : null}
    </View>
  </ProgrammingSheet>;
}

/** A shallow Key arc in the same model page; horizontal browsing never writes. */
export function InlineApiPicker(props: Omit<ApiChoiceProps, 'onClose'> & {
  onClose?: () => void; onBusyChange?: (busy: boolean, requestId?: string) => void; onLoadingChange?: (loading: boolean, requestId?: string) => void;
}) {
  const dk = useDesk();
  const styles = useStyles();
  const notifications = useRef({ onBusyChange: props.onBusyChange, onLoadingChange: props.onLoadingChange });
  notifications.current = { onBusyChange: props.onBusyChange, onLoadingChange: props.onLoadingChange };
  const notify = (busy: boolean, requestId: string) => {
    notifications.current.onBusyChange?.(busy, requestId);
    if (notifications.current.onLoadingChange !== notifications.current.onBusyChange) notifications.current.onLoadingChange?.(busy, requestId);
  };
  const { shown, current, choice, saving, unavailable, error, save } = useApiChoice({
    ...props, closeOnSuccess: false, skipCurrent: true, inlineErrors: true, onSubmitStart: (id) => notify(true, id), onSubmitEnd: (id) => notify(false, id),
  });
  const { width } = useWindowDimensions();
  const [viewportWidth, setViewportWidth] = useState(width);
  const entries = apiEntries(props.apis);
  const signature = JSON.stringify(entries.map((item) => item.id));
  const itemWidth = Math.max(104, Math.min(140, viewportWidth * 0.32));
  const [center, setCenter] = useState(() => Math.max(0, entries.findIndex((item) => item.id === current)));
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    if (!shown) return;
    const next = Math.max(0, entries.findIndex((item) => item.id === current));
    setCenter(next); scroll.current?.scrollTo({ x: next * itemWidth, animated: false });
  }, [current, signature, itemWidth, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown) return null;
  // One true circle drives the drawn arc and every label's drop + tangent rotation.
  const keyRadius = Math.max(260, viewportWidth * 0.92);
  const labelTop = 34, arcGap = 18;
  const arcY = (x: number) => labelTop + keyRadius - Math.sqrt(Math.max(0, (keyRadius - arcGap) ** 2 - (x - viewportWidth / 2) ** 2)) + arcGap;
  return <View testID="remote-inline-api-picker" style={styles.inline} onLayout={(event) => {
    const next = event.nativeEvent.layout.width; if (next > 0 && Math.abs(next - viewportWidth) > 0.5) setViewportWidth(next);
  }}>
    <Svg pointerEvents="none" width={viewportWidth} height={100} style={StyleSheet.absoluteFill}>
      <Path d={`M 0 ${arcY(0)} A ${keyRadius - arcGap} ${keyRadius - arcGap} 0 0 1 ${viewportWidth} ${arcY(viewportWidth)}`} fill="none" stroke={dk.accent} strokeOpacity="0.28" strokeWidth="1" />
    </Svg>
    <ScrollView ref={scroll} testID="remote-api-key-strip" horizontal style={styles.inlineScroll}
      contentContainerStyle={{ paddingHorizontal: Math.max(0, (viewportWidth - itemWidth) / 2), paddingTop: 10 }}
      snapToInterval={itemWidth} decelerationRate="fast" scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}
      onScroll={(event) => setCenter(Math.max(0, Math.min(entries.length - 1, event.nativeEvent.contentOffset.x / itemWidth)))}>
      {entries.map((item, index) => {
        const distance = Math.abs(index - center), interactive = distance <= 1.4;
        const tangent = Math.asin(Math.max(-0.9, Math.min(0.9, (index - center) * itemWidth / keyRadius)));
        const drop = keyRadius * (1 - Math.cos(tangent));
        const busy = saving && choice === item.id;
        return <Pressable key={item.id} testID={`remote-api-key-${index}`} accessibilityRole="radio" accessibilityLabel={item.label}
          accessible={interactive} importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
          accessibilityState={{ checked: current === item.id, busy, disabled: saving || Boolean(unavailable) || !interactive }}
          disabled={saving || Boolean(unavailable) || !interactive} onPress={() => void save(item.id)}
          style={[styles.keyNode, { width: itemWidth, opacity: interactive ? Math.max(0.3, 1 - distance * 0.42) : 0,
            transform: [{ translateY: drop }, { rotate: `${tangent}rad` }] }]}>
          <Text numberOfLines={1} ellipsizeMode="middle" maxFontSizeMultiplier={1.25}
            style={[styles.keyName, distance < 0.35 && styles.keyCenter, current === item.id && styles.keySelected]}>{item.label}</Text>
          {busy ? <ActivityIndicator testID="remote-api-switch-spinner" size="small" color={dk.muted} /> : null}
        </Pressable>;
      })}
    </ScrollView>
    {unavailable || error ? <Text accessibilityRole={error ? 'alert' : undefined} style={[styles.inlineNote, error && styles.inlineError]} numberOfLines={2}>{unavailable || error}</Text> : <Text pointerEvents="none" style={styles.keyFamily}>API</Text>}
  </View>;
}

function useApiChoice({ visible, deviceId, agent, apis, onClose, onChanged, sessionKey, blocked, externalBusy = false, operationCurrent, closeOnSuccess = true, skipCurrent = false, inlineErrors = false, onSubmitStart, onSubmitEnd }: Omit<ApiChoiceProps, 'onClose'> & {
  onClose?: () => void; closeOnSuccess?: boolean; skipCurrent?: boolean; inlineErrors?: boolean; onSubmitStart?: (id: string) => void; onSubmitEnd?: (id: string) => void;
}) {
  const remote = useRemote();
  const unavailable = blocked || (sessionKey && agent.conversationApiSwitch !== true ? '请先更新电脑端 Bridge' : '');
  const unavailableRef = useRef(unavailable); unavailableRef.current = unavailable;
  const externalBusyRef = useRef(externalBusy); externalBusyRef.current = externalBusy;
  const current = agent.api.source === 'phone' ? agent.api.accountId ?? '' : '';
  const currentRef = useRef(current); currentRef.current = current;
  const [choice, setChoice] = useState(current);
  const choiceRef = useRef(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ id: string; scope: string; selected: string } | null>(null);
  const [, refresh] = useState(0);
  const mounted = useRef(true);
  const dismissed = useRef(false);
  const scope = JSON.stringify([remote.connectionId, remote.selectedHubUrl, remote.serviceId, deviceId, agent.id, sessionKey ?? '']);
  const active = useRef({ scope, visible, revision: 0 });
  const scopeEpoch = useRef({ scope, revision: 0 });
  if (scopeEpoch.current.scope !== scope) scopeEpoch.current = { scope, revision: scopeEpoch.current.revision + 1 };
  const catalog = useRef(apis); catalog.current = apis;
  const inputs = useRef({ scope, visible });
  if (inputs.current.scope !== scope || inputs.current.visible !== visible) {
    inputs.current = { scope, visible };
    active.current = { scope, visible, revision: active.current.revision + 1 };
    dismissed.current = false;
    choiceRef.current = current;
  }
  const renderedInputs = inputs.current;
  const canOperate = () => active.current.visible && active.current.scope === scope && inputs.current === renderedInputs;
  useEffect(() => {
    setError('');
    if (visible) {
      const next = request.current?.scope === scope ? request.current.selected : current;
      choiceRef.current = next; setChoice(next);
    }
  }, [visible, scope, current]);
  useEffect(() => {
    mounted.current = true;
    active.current.visible = inputs.current.visible && !dismissed.current;
    return () => {
      mounted.current = false;
      active.current = { ...active.current, visible: false, revision: active.current.revision + 1 };
    };
  }, []);
  const dismiss = () => {
    dismissed.current = true;
    active.current = { ...active.current, visible: false, revision: active.current.revision + 1 };
    if (mounted.current) refresh((value) => value + 1);
  };
  const close = () => { dismiss(); onClose?.(); };
  const choose = (value: string) => {
    if (request.current || externalBusyRef.current || unavailableRef.current || !canOperate()) return;
    choiceRef.current = value; setChoice(value); setError('');
  };
  const save = async (selected = choiceRef.current) => {
    if (request.current || externalBusyRef.current || unavailableRef.current || !canOperate() || (selected && !catalog.current.some((item) => item.id === selected))) return;
    if (skipCurrent && selected === currentRef.current) return;
    const captured = active.current;
    const capturedScope = scopeEpoch.current;
    const stillActive = () => mounted.current && active.current.visible && active.current.scope === captured.scope && active.current.revision === captured.revision;
    const stillSameScope = () => scopeEpoch.current === capturedScope && (operationCurrent ? operationCurrent() : mounted.current);
    const token = { id: `api-switch-${++nextApiRequest}`, scope, selected };
    request.current = token;
    choiceRef.current = selected; setChoice(selected); setError(''); setSaving(true);
    onSubmitStart?.(token.id);
    try {
      const profile = sessionKey ? await setAgentApi(deviceId, agent.id, selected, '', sessionKey) : await setAgentApi(deviceId, agent.id, selected, '');
      if (!stillSameScope()) return;
      if (selected && !catalog.current.some((item) => item.id === selected)) {
        if (stillActive()) { if (inlineErrors) setError('API 已移除，请重新选择'); else showToast('API 已移除，请重新选择', 'alert'); } return;
      }
      onChanged?.(profile); if (closeOnSuccess && stillActive()) close();
    } catch (error) {
      if (stillActive()) {
        const message = error instanceof Error ? error.message : 'API 切换失败，请重试';
        if (inlineErrors) setError(message); else showToast(message, 'alert');
      }
    }
    finally {
      // Visibility only owns presentation, never the lifetime of a mutation.
      if (request.current === token) {
        request.current = null;
        if (mounted.current) setSaving(false);
      }
      onSubmitEnd?.(token.id);
    }
  };
  return { shown: visible && active.current.visible, current, choice, saving: saving || externalBusy, unavailable, error, choose, save, close };
}

/** API names are user labels, never model IDs or text to split into families. */
function apiEntries(apis: readonly RemoteApiOption[]): { id: string; label: string }[] {
  const seen = new Set<string>(['']);
  const list = [{ id: '', label: '跟随电脑' }, ...apis.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id); return true;
  }).map((item) => ({ id: item.id, label: item.name.trim() ? item.name : '未命名 API' }))];
  const identity = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
  const originalNames = new Set(list.map((item) => identity(item.label)));
  const used = new Set<string>();
  return list.map((item) => {
    let label = item.label, suffix = 2;
    while (used.has(identity(label))) {
      do { label = `${item.label} · ${suffix++}`; } while (originalNames.has(identity(label)) || used.has(identity(label)));
    }
    used.add(identity(label)); return { id: item.id, label };
  });
}

function Row({ title, detail, selected, onPress, first, disabled }: { title: string; detail?: string; selected: boolean; onPress: () => void; first?: boolean; disabled?: boolean }) {
  const dk = useDesk();
  const styles = useStyles();
  return <Pressable accessibilityRole="radio" accessibilityLabel={title} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && !disabled && !selected && styles.rowPressed, disabled && styles.rowDisabled]}>
    <View style={[styles.radio, selected && styles.radioOn]}>{selected ? <Icon name="check" size={11} color={dk.onInk} strokeWidth={2.6} /> : null}</View>
    <View style={styles.rowText}><Text style={[styles.title, selected && styles.titleSelected]} numberOfLines={2}>{title}</Text>{detail ? <Text style={styles.detail} numberOfLines={1}>{detail}</Text> : null}</View>
  </Pressable>;
}
const useStyles = themed((c, d) => StyleSheet.create({
  body: { paddingHorizontal: 18, paddingTop: 8, gap: 12 }, note: { fontSize: 12.5, color: d.muted, lineHeight: 19 },
  choices: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 14, backgroundColor: d.surface2, borderWidth: 1, borderColor: 'transparent' },
  rowSelected: { backgroundColor: d.surface, borderColor: d.ink }, rowPressed: { backgroundColor: d.surface3 }, rowDisabled: { opacity: 0.55 }, rowText: { flex: 1, gap: 2 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: d.faint, backgroundColor: d.surface, alignItems: 'center', justifyContent: 'center' }, radioOn: { borderColor: d.ink, backgroundColor: d.ink },
  title: { fontSize: 14.5, lineHeight: 20, color: d.text, fontWeight: '500' }, titleSelected: { color: d.text, fontWeight: '600' }, detail: { fontSize: 12, lineHeight: 16, color: d.muted },
  inline: { height: 100, overflow: 'hidden' }, inlineScroll: { height: 100 }, inlineNote: { position: 'absolute', bottom: 0, left: 14, right: 14, textAlign: 'center', color: d.muted, fontSize: 11, lineHeight: 16 },
  inlineError: { color: d.bad },
  keyNode: { height: 48, minHeight: 44, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  keyName: { flexShrink: 1, color: d.muted, fontSize: 13, lineHeight: 18, textAlign: 'center' }, keyCenter: { color: d.text2, fontSize: 14, fontWeight: '500' }, keySelected: { color: d.accentText },
  keyFamily: { position: 'absolute', bottom: 1, left: 14, right: 14, textAlign: 'center', fontSize: 10, lineHeight: 14, letterSpacing: 1, color: d.muted },
}));
