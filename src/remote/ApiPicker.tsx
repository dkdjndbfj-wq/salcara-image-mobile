import React, { useEffect, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Icon } from '../components/Icon';
import { showToast } from '../components/ui';
import { themed, useDesk } from '../theme';
import type { AgentProfile, RemoteApiOption } from './client';
import { apiRemoteProblem, apiStationChoices, remoteDeliveryScope, setAgentApi, useRemote } from './store';
import { remoteApiProblem } from './api-eligibility';
import { ComposerPopover } from './ComposerPopover';
import { apiSwitchMessage } from './api-switch-message';
import { ApiSourceIcon } from './ApiSourceIcon';

type ApiChoiceProps = {
  visible: boolean; deviceId: string; agent: AgentProfile; apis: RemoteApiOption[]; onClose: () => void;
  onChanged?: (profile?: AgentProfile, selectedAccountId?: string) => void; onFailed?: (selectedAccountId: string) => void; sessionKey?: string; blocked?: string;
  externalBusy?: boolean; operationCurrent?: () => boolean;
  anchorRef?: RefObject<View | null>; onBusyChange?: (busy: boolean, requestId: string) => void;
  onSubmitted?: (selectedAccountId: string) => void;
  sharedWith?: string[];
  anchorRevision?: string | number;
};
let nextApiRequest = 0;

/** Agent configuration uses a direct choice; opening or dismissing never writes. */
export function ApiPicker(props: ApiChoiceProps) {
  const { shown, current, choice, saving, unavailable, error, save, close, problem, targets, openStations, stationPicker, stationVisible } = useApiChoice({
    ...props, skipCurrent: true, closeOnFailure: true,
    onSubmitStart: (id, selected) => { props.onSubmitted?.(selected); props.onBusyChange?.(true, id); }, onSubmitEnd: id => props.onBusyChange?.(false, id),
  });
  return <><ApiChoiceMenu visible={shown && !stationVisible} anchorRef={props.anchorRef} anchorRevision={props.anchorRevision} apis={props.apis} current={current} sharedWith={props.sharedWith}
    defaultApiName={props.agent.api.source !== 'phone' ? props.agent.api.name : undefined}
    pending={saving ? choice : undefined} blocked={unavailable} error={error} onClose={() => { if (!saving) close(); }}
    onSelect={id => { if (id === current && !saving) close(); else void save(id); }} problem={problem}
    stationAvailable={id => Boolean(targets(id).length)} onStation={openStations} />{stationPicker}</>;
}

/** Real and local-preview Agents share the same compact choice surface. */
export function ApiChoiceMenu({ visible, anchorRef, anchorRevision, apis, current, pending, blocked, error, onClose, onSelect, problem = () => '', stationAvailable = () => false, onStation, sharedWith, defaultApiName, onVerify, verificationDisabled }: {
  visible: boolean; anchorRef?: RefObject<View | null>; apis: RemoteApiOption[]; current: string; pending?: string;
  blocked?: string; error?: string; onClose: () => void; onSelect: (id: string) => void;
  problem?: (id: string) => string | null | undefined; stationAvailable?: (id: string) => boolean; onStation?: (id: string) => void;
  sharedWith?: string[];
  anchorRevision?: string | number;
  defaultApiName?: string; onVerify?: () => void; verificationDisabled?: boolean;
}) {
  const styles = useStyles();
  const entries = apiEntries(apis, defaultApiName);
  const renderEntry = (item: { id: string; label: string }) => <View key={item.id}>
        <Row title={item.label} detail={problem(item.id) || undefined} selected={current === item.id}
          sourceType={apis.find(api => api.id === item.id)?.sourceType} followComputer={!item.id}
          busy={pending === item.id} disabled={pending !== undefined || Boolean(blocked || problem(item.id))} onPress={() => onSelect(item.id)} />
        {problem(item.id) && stationAvailable(item.id) ? <Pressable accessibilityRole="button" accessibilityLabel={`为 ${item.label} 选择支持的中转站`}
          disabled={pending !== undefined || Boolean(blocked)} style={styles.stationAction} onPress={() => onStation?.(item.id)}><Text style={styles.note}>选择中转站</Text><Icon name="chevronRight" size={14} /></Pressable> : null}
      </View>;
  return <ComposerPopover visible={visible} anchorRef={anchorRef} anchorRevision={anchorRevision} onClose={onClose} width={224} maxHeight={320} placement="bottom" align="end" testID="agent-api-menu" accessibilityLabel="API 选择菜单"
    header={<View testID="agent-api-menu-default" style={[styles.choices, styles.pinnedDefault]}>{renderEntry(entries[0])}</View>}>
    <View style={styles.choices}>
      {entries.slice(1).map(renderEntry)}
      {blocked || error ? <Text accessibilityRole="alert" style={[styles.menuNote, error && styles.inlineError]}>{blocked || error}</Text> : null}
      {error && onVerify ? <View style={styles.recoveryActions}>
        {onVerify ? <Pressable accessibilityRole="button" accessibilityLabel="核对 API 状态" accessibilityState={{ disabled: Boolean(verificationDisabled) }}
          disabled={verificationDisabled} onPress={onVerify} style={({ pressed }) => [styles.recoveryAction, pressed && styles.rowPressed, verificationDisabled && styles.rowDisabled]}><Text style={styles.recoveryLabel}>核对状态</Text></Pressable> : null}
      </View> : null}
      {sharedWith?.length ? <Text style={styles.menuNote}>与 {sharedWith.join('、')} 共用 API</Text> : null}
      {!apis.length ? <Text style={styles.menuNote}>请先在电脑端添加 API</Text> : null}
    </View>
  </ComposerPopover>;
}

/** Compact API tabs; horizontal browsing never writes. */
export function InlineApiPicker(props: Omit<ApiChoiceProps, 'onClose'> & {
  onClose?: () => void; onBusyChange?: (busy: boolean, requestId: string) => void; onLoadingChange?: (loading: boolean, requestId: string) => void;
}) {
  const dk = useDesk();
  const styles = useStyles();
  const notifications = useRef({ onBusyChange: props.onBusyChange, onLoadingChange: props.onLoadingChange });
  notifications.current = { onBusyChange: props.onBusyChange, onLoadingChange: props.onLoadingChange };
  const notify = (busy: boolean, requestId: string) => {
    notifications.current.onBusyChange?.(busy, requestId);
    if (notifications.current.onLoadingChange !== notifications.current.onBusyChange) notifications.current.onLoadingChange?.(busy, requestId);
  };
  const { shown, current, choice, saving, unavailable, error, save, problem, targets, openStations, stationPicker } = useApiChoice({
    ...props, closeOnSuccess: false, skipCurrent: true, inlineErrors: true, onSubmitStart: (id) => notify(true, id), onSubmitEnd: (id) => notify(false, id),
  });
  const { width } = useWindowDimensions();
  const [viewportWidth, setViewportWidth] = useState(width);
  const entries = apiEntries(props.apis, props.agent.api.source !== 'phone' ? props.agent.api.name : undefined);
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
  const centered = entries[Math.max(0, Math.min(entries.length - 1, Math.round(center)))];
  const centeredProblem = problem(centered?.id ?? '');
  const canChangeStation = Boolean(centeredProblem && centered?.id && targets(centered.id).length);
  return <><View testID="remote-inline-api-picker" style={styles.inline} onLayout={(event) => {
    const next = event.nativeEvent.layout.width; if (next > 0 && Math.abs(next - viewportWidth) > 0.5) setViewportWidth(next);
  }}>
    <ScrollView ref={scroll} testID="remote-api-key-strip" horizontal style={styles.inlineScroll}
      contentContainerStyle={{ paddingHorizontal: 2 }} snapToInterval={itemWidth} decelerationRate="fast" scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}
      onScroll={(event) => setCenter(Math.max(0, Math.min(entries.length - 1, event.nativeEvent.contentOffset.x / itemWidth)))}>
      {entries.map((item, index) => {
        const busy = saving && choice === item.id, disabled = saving || Boolean(unavailable || problem(item.id));
        return <Pressable key={item.id} testID={`remote-api-key-${index}`} accessibilityRole="radio" accessibilityLabel={item.label}
          accessibilityState={{ checked: current === item.id, busy, disabled }} disabled={disabled} onPress={() => void save(item.id)}
          style={[styles.keyNode, { width: itemWidth }, current === item.id && styles.keyNodeSelected, disabled && styles.rowDisabled]}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.keyName, current === item.id && styles.keySelected]}>{item.label}</Text>
          {busy ? <ActivityIndicator testID="remote-api-switch-spinner" size="small" color={dk.muted} /> : null}
        </Pressable>;
      })}
    </ScrollView>
    {unavailable || error ? <Text accessibilityRole={error ? 'alert' : undefined} style={[styles.inlineNote, error && styles.inlineError]} numberOfLines={2}>{unavailable || error}</Text>
      : centeredProblem ? <Pressable style={styles.inlineNote} accessibilityRole={canChangeStation ? 'button' : undefined} disabled={!canChangeStation || saving}
        onPress={() => openStations(centered!.id)}><Text style={styles.note} numberOfLines={2}>{centeredProblem}{canChangeStation ? ' · 换中转站 ›' : ''}</Text></Pressable> : null}
  </View>{stationPicker}</>;

}

function useApiChoice({ visible, deviceId, agent, apis, onClose, onChanged, onFailed, sessionKey, blocked, externalBusy = false, operationCurrent, closeOnSuccess = true, closeOnFailure = false, skipCurrent = false, inlineErrors = false, onSubmitStart, onSubmitEnd, anchorRef, anchorRevision }: Omit<ApiChoiceProps, 'onClose'> & {
  onClose?: () => void; closeOnSuccess?: boolean; closeOnFailure?: boolean; skipCurrent?: boolean; inlineErrors?: boolean; onSubmitStart?: (id: string, selected: string) => void; onSubmitEnd?: (id: string) => void;
}) {
  const remote = useRemote();
  const styles = useStyles();
  const unavailable = blocked || (agent.api.pending ? 'API 正在切换，请稍候' : sessionKey && agent.conversationApiSwitch !== true ? '请先更新电脑端 Bridge' : '');
  const unavailableRef = useRef(unavailable); unavailableRef.current = unavailable;
  const externalBusyRef = useRef(externalBusy); externalBusyRef.current = externalBusy;
  const current = agent.api.source === 'phone' ? agent.api.accountId ?? '' : '';
  const currentRef = useRef(current); currentRef.current = current;
  const [choice, setChoice] = useState(current);
  const choiceRef = useRef(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [stationChoice, setStationChoice] = useState<{ accountId: string; scope: string; revision: number } | null>(null);
  const request = useRef<{ id: string; scope: string; selected: string } | null>(null);
  const [, refresh] = useState(0);
  const mounted = useRef(true);
  const dismissed = useRef(false);
  const scope = JSON.stringify([remote.connectionId, remote.selectedHubUrl, remote.serviceId, deviceId, agent.id, sessionKey ?? '', remoteDeliveryScope?.()]);
  const active = useRef({ scope, visible, revision: 0 });
  const scopeEpoch = useRef({ scope, revision: 0 });
  if (scopeEpoch.current.scope !== scope) scopeEpoch.current = { scope, revision: scopeEpoch.current.revision + 1 };
  const catalog = useRef(apis); catalog.current = apis;
  const problem = (value: string) => apiRemoteProblem?.(deviceId, agent.id, value)
    ?? remoteApiProblem(catalog.current.find(item => item.id === (value || (agent.api.source !== 'phone' ? agent.api.accountId : undefined))));
  const targets = (value: string) => apiStationChoices?.(deviceId, value) ?? [];
  const inputs = useRef({ scope, visible });
  if (inputs.current.scope !== scope || inputs.current.visible !== visible) {
    inputs.current = { scope, visible };
    active.current = { scope, visible, revision: active.current.revision + 1 };
    dismissed.current = false;
    choiceRef.current = current;
  }
  const renderedInputs = inputs.current;
  const canOperate = () => active.current.visible && active.current.scope === scope && inputs.current === renderedInputs && AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
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
  const close = () => { if (mounted.current && canOperate()) { dismiss(); onClose?.(); } };
  const save = async (selected = choiceRef.current, targetConnectionId?: string) => {
    if (request.current || externalBusyRef.current || unavailableRef.current || !canOperate() || (selected && !catalog.current.some((item) => item.id === selected))) return;
    if (targetConnectionId ? !targets(selected).some(item => item.id === targetConnectionId) : Boolean(problem(selected))) return;
    if (skipCurrent && selected === currentRef.current && !targetConnectionId) return;
    const captured = active.current;
    const capturedScope = scopeEpoch.current;
    const stillActive = () => mounted.current && active.current.visible && active.current.scope === captured.scope && active.current.revision === captured.revision;
    const stillSameScope = () => scopeEpoch.current === capturedScope && (operationCurrent ? operationCurrent() : mounted.current);
    const token = { id: `api-switch-${++nextApiRequest}`, scope, selected };
    request.current = token;
    choiceRef.current = selected; setChoice(selected); setError(''); setSaving(true);
    onSubmitStart?.(token.id, selected);
    try {
      const profile = targetConnectionId ? await setAgentApi(deviceId, agent.id, selected, '', sessionKey, targetConnectionId)
        : sessionKey ? await setAgentApi(deviceId, agent.id, selected, '', sessionKey) : await setAgentApi(deviceId, agent.id, selected, '');
      if (!stillSameScope()) return;
      if (selected && !catalog.current.some((item) => item.id === selected)) {
        if (stillActive()) { if (inlineErrors) setError('API 已移除，请重新选择'); else showToast('API 已移除，请重新选择', 'alert'); } return;
      }
      onChanged?.(profile, selected); if (closeOnSuccess && stillActive()) close();
    } catch (error) {
      if (stillActive()) {
        onFailed?.(selected);
        const message = apiSwitchMessage(error);
        if (inlineErrors) setError(message); else showToast(message, 'alert');
        if (closeOnFailure) close();
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
  const openStations = (accountId: string) => {
    if (!canOperate() || request.current || externalBusyRef.current || unavailableRef.current || !targets(accountId).length) return;
    setStationChoice({ accountId, scope: active.current.scope, revision: active.current.revision });
  };
  const stationVisible = Boolean(stationChoice && canOperate() && stationChoice.scope === active.current.scope && stationChoice.revision === active.current.revision);
  const stationPicker = <ComposerPopover visible={stationVisible} anchorRef={anchorRef} anchorRevision={anchorRevision} width={224} placement="bottom" align="end"
    accessibilityLabel="中转站选择菜单" onClose={() => setStationChoice(null)}>
    <View style={styles.choices}><Text style={styles.menuNote}>切换这台电脑的远程连接</Text>
      {(stationChoice && stationVisible ? targets(stationChoice.accountId) : []).map(item => <Pressable key={item.id} accessibilityRole="button"
        accessibilityLabel={new URL(item.hubUrl).host} style={styles.row} onPress={() => {
          if (!stationVisible || !stationChoice) return;
          const accountId = stationChoice.accountId; setStationChoice(null); void save(accountId, item.id);
        }}><Text style={styles.title} numberOfLines={2}>{new URL(item.hubUrl).host}</Text></Pressable>)}
    </View>
  </ComposerPopover>;
  return { shown: visible && active.current.visible, current, choice, saving: saving || externalBusy, unavailable, error, save, close, problem, targets, openStations, stationPicker, stationVisible };
}

/** API names are user labels, never model IDs or text to split into families. */
function apiEntries(apis: readonly RemoteApiOption[], defaultApiName?: string): { id: string; label: string }[] {
  const seen = new Set<string>(['']);
  const list = [{ id: '', label: defaultApiName?.trim() || '默认 API' }, ...apis.filter((item) => {
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

function Row({ title, detail, selected, onPress, busy, disabled, sourceType, followComputer }: { title: string; detail?: string; selected: boolean; onPress: () => void; busy?: boolean; disabled?: boolean; sourceType?: RemoteApiOption['sourceType']; followComputer?: boolean }) {
  const dk = useDesk();
  const styles = useStyles();
  return <Pressable accessibilityRole="radio" accessibilityLabel={title} accessibilityState={{ checked: selected, disabled, busy }} aria-checked={selected} aria-busy={busy} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && !disabled && !selected && styles.rowPressed, disabled && styles.rowDisabled]}>
    <ApiSourceIcon sourceType={sourceType} followComputer={followComputer} size={16} color={selected ? dk.text : dk.muted} />
    <View style={styles.rowText}><Text style={[styles.title, selected && styles.titleSelected]} numberOfLines={2}>{title}</Text>{detail ? <Text style={styles.detail} numberOfLines={2}>{detail}</Text> : null}</View>
    {busy ? <ActivityIndicator testID="remote-api-switch-spinner" size="small" color={dk.muted} /> : selected ? <Icon name="check" size={16} color={dk.text} strokeWidth={1.6} /> : <View style={{ width: 16 }} />}
  </Pressable>;
}
const useStyles = themed((c, d) => StyleSheet.create({
  note: { fontSize: 12.5, color: d.muted, lineHeight: 19 },
  choices: { padding: 5, gap: 2 },
  pinnedDefault: { flexShrink: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  menuNote: { marginHorizontal: 9, marginVertical: 6, color: d.muted, fontSize: 12, lineHeight: 18 },
  recoveryActions: { flexDirection: 'row', gap: 6, paddingHorizontal: 4, paddingBottom: 3 },
  recoveryAction: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: d.surface2, paddingHorizontal: 4 },
  recoveryLabel: { color: d.text, fontSize: 12, lineHeight: 18, fontWeight: '500' },
  stationAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, paddingHorizontal: 9 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 9, paddingVertical: 8, borderRadius: 8 },
  rowSelected: { backgroundColor: d.surface2 }, rowPressed: { backgroundColor: d.surface3 }, rowDisabled: { opacity: 0.55 }, rowText: { flex: 1, gap: 2 },
  title: { fontSize: 13.5, lineHeight: 20, color: d.text, fontWeight: '500' }, titleSelected: { color: d.text, fontWeight: '600' }, detail: { fontSize: 12, lineHeight: 16, color: d.muted },
  inline: { paddingHorizontal: 3, paddingBottom: 5 }, inlineScroll: { flexGrow: 0 }, inlineNote: { paddingHorizontal: 6, paddingTop: 5, color: d.muted, fontSize: 11, lineHeight: 16 },
  inlineError: { color: d.bad },
  keyNode: { minHeight: 32, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, borderRadius: 7 }, keyNodeSelected: { backgroundColor: d.surface2 },
  keyName: { flexShrink: 1, color: d.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' }, keySelected: { color: d.text, fontWeight: '500' },
}));
