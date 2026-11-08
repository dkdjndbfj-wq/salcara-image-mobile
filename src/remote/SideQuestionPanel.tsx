import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { MessageContent } from '../components/MessageContent';
import { Icon } from '../components/Icon';
import { AppDialog } from '../components/ui';
import { useDesk } from '../theme';
import { ContextReferenceChips } from './ContextReferenceChips';
import { copyContextReferences, type ContextReference } from './context-references';
import { SideQuestionNotDispatchedError, validSideQuestionInput, type SideQuestionReading, type SideQuestionInput, type SideQuestionResult } from './side-question';
import { createSideQuestionConversation, deleteLocalSideQuestionConversation, deleteSideQuestionConversation, loadSideQuestionConversations, markSideQuestionOpening, reconcileSideQuestionConversation,
  sideQuestionConversationsSnapshot, subscribeSideQuestionConversations, submitSideQuestionConversation, updateSideQuestionDraft, updateSideQuestionPresentation,
  type SideQuestionConversations } from './side-question-conversations';

export interface SideQuestionTransport {
  isCurrent: () => boolean;
  read: (chainId: string, signal: AbortSignal, options?: { create?: boolean; cursor?: string }) => Promise<SideQuestionReading>;
  ask: (reading: SideQuestionReading, input: SideQuestionInput, operationId: string) => Promise<SideQuestionResult>;
  remove: (chainId: string, operationId: string) => Promise<void>;
}
/** Visibility never owns a dispatched request; the durable store records its
 * result even after folding this region or leaving the main conversation. */
export function SideQuestionPanel({ visible, scopeKey, authorizationScope, sessionKey, selection, selectionNonce, onSelectionConsumed, transport, availableHeight = 720, compactComposer: compact = false, showHistory = false, onEditingChange, historyOnly = false, navigation, onNewConversation }: {
  visible: boolean; scopeKey: string; authorizationScope: string; sessionKey: string; selection?: ContextReference; selectionNonce?: number;
  onSelectionConsumed?: () => void; transport: SideQuestionTransport; availableHeight?: number;
  compactComposer?: boolean; onEditingChange?: (editing: boolean) => void;
  /** Standalone sidebar keeps the transcript visible above its compact input. */
  showHistory?: boolean;
  historyOnly?: boolean; navigation?: React.ReactNode; onNewConversation?: () => void;
}) {
  const dk = useDesk();
  const compactComposer = compact && !historyOnly;
  const [stored, setStored] = useState<SideQuestionConversations>(), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState(''), [reload, setReload] = useState(0), [deleting, setDeleting] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
  const [reading, setReading] = useState<{ id: string; authorizationScope: string; value: SideQuestionReading }>();
  const [foreground, setForeground] = useState(AppState.currentState == null || AppState.currentState === 'active');
  const state = stored?.scope === scopeKey ? stored : undefined, conversation = state?.conversations.find(item => item.id === state.activeId);
  useEffect(() => { if (historyOnly || !visible || !state?.expanded || !conversation) onEditingChange?.(false); }, [historyOnly, visible, state?.expanded, Boolean(conversation), onEditingChange]);
  const connected = !historyOnly && transport.isCurrent();
  const snapshot = useRef({ scopeKey, authorizationScope, visible, activeId: conversation?.id, expanded: state?.expanded });
  snapshot.current = { scopeKey, authorizationScope, visible, activeId: conversation?.id, expanded: state?.expanded };
  const mounted = useRef(true), readSequence = useRef(0), submitted = useRef(new Set<string>()), consumedSelection = useRef<string | undefined>(undefined), scroll = useRef<ScrollView>(null);
  const readCurrent = (scope: string, authorization: string, id: string) => !historyOnly && mounted.current && snapshot.current.visible && snapshot.current.scopeKey === scope
    && snapshot.current.authorizationScope === authorization && snapshot.current.activeId === id && transport.isCurrent();
  const report = (reason: unknown) => { if (mounted.current && snapshot.current.scopeKey === scopeKey) setError(reason instanceof Error ? reason.message : '侧问记录暂时不可用'); };
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', next => setForeground(next === 'active'));
    return () => { mounted.current = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    setStored(undefined); setReading(undefined); setError(''); setConfirmDelete(false);
    const accept = () => { if (mounted.current && snapshot.current.scopeKey === scopeKey) setStored(sideQuestionConversationsSnapshot(scopeKey)); };
    const unsubscribe = subscribeSideQuestionConversations(scopeKey, accept);
    void loadSideQuestionConversations(scopeKey).then(accept, report);
    return unsubscribe;
  }, [scopeKey]);
  useEffect(() => { setDraft(conversation?.draft ?? ''); setConfirmDelete(false); }, [scopeKey, conversation?.id]);
  useEffect(() => {
    if (historyOnly || !state || !selection || selectionNonce === undefined || !visible || !transport.isCurrent()) return;
    const event = `${scopeKey}|${selectionNonce}`; if (consumedSelection.current === event) return; consumedSelection.current = event;
    void createSideQuestionConversation(scopeKey, sessionKey, selection).then(() => onSelectionConsumed?.(), report);
  }, [scopeKey, Boolean(state), selectionNonce, visible]);
  useEffect(() => {
    setReading(undefined); const sequence = ++readSequence.current;
    if (!conversation || !state?.expanded || !visible || !foreground || !connected || conversation.deletedOnComputer) { setLoading(false); return; }
    const controller = new AbortController(), id = conversation.id, create = !conversation.opened;
    setLoading(true); setError('');
    void (async () => {
      if (create) await markSideQuestionOpening(scopeKey, id);
      if (!readCurrent(scopeKey, authorizationScope, id) || controller.signal.aborted) return;
      const value = await transport.read(id, controller.signal, { create });
      if (!value.conversation || value.conversation.chainId !== id) throw new Error('电脑未返回持久侧问记录，请更新电脑端和中转站');
      await reconcileSideQuestionConversation(scopeKey, id, value.conversation);
      if (sideQuestionConversationsSnapshot(scopeKey)?.conversations.find(item => item.id === id)?.lastOperationId !== value.conversation.lastOperationId) throw new Error('侧问刚收到新回答，请刷新结果');
      if (readCurrent(scopeKey, authorizationScope, id) && !controller.signal.aborted && readSequence.current === sequence) {
        setReading({ id, authorizationScope, value });
        const restored = sideQuestionConversationsSnapshot(scopeKey)?.conversations.find(item => item.id === id);
        if (conversation.pending && !restored?.pending) setDraft(restored?.draft ?? '');
      }
    })().catch(reason => { if (!controller.signal.aborted && readSequence.current === sequence) report(reason); })
      .finally(() => { if (!controller.signal.aborted && readSequence.current === sequence) setLoading(false); });
    return () => controller.abort();
  }, [scopeKey, authorizationScope, conversation?.id, state?.expanded, visible, foreground, connected, reload]);
  const authorized = reading?.id === conversation?.id && reading?.authorizationScope === authorizationScope ? reading.value : undefined;
  const busy = !historyOnly && conversation?.pending?.state === 'sending';
  const enabled = Boolean(!historyOnly && authorized?.value.available && !loading && !busy && !conversation?.pending && !conversation?.deleteOperationId
    && !conversation?.deletedOnComputer && !deleting && foreground && visible && transport.isCurrent());
  const submit = () => {
    if (!enabled || !snapshot.current.visible || !conversation || !authorized || submitted.current.has(conversation.id) || AppState.currentState != null && AppState.currentState !== 'active') return;
    const id = conversation.id, question = draft.trim(), selected = !conversation.lastOperationId ? copyContextReferences(conversation.selection ? [conversation.selection] : [])?.[0] : undefined;
    const input: SideQuestionInput = { question, ...(selected ? { selection: selected } : {}), ...(conversation.lastOperationId ? { previousOperationId: conversation.lastOperationId } : {}) };
    if (!validSideQuestionInput(sessionKey, input)) { setError('问题最多 4000 字，请检查所选内容'); return; }
    submitted.current.add(id); setError('');
    void submitSideQuestionConversation(scopeKey, id, input, async operationId => {
      if (!readCurrent(scopeKey, authorizationScope, id) || AppState.currentState != null && AppState.currentState !== 'active') throw new SideQuestionNotDispatchedError('来源或页面已改变');
      const result = await transport.ask(authorized, input, operationId);
      if (result.conversation && readCurrent(scopeKey, authorizationScope, id)) setReading({ id, authorizationScope, value: { ...authorized, value: result.conversation, conversation: result.conversation } });
      return result;
    }, () => mounted.current && snapshot.current.scopeKey === scopeKey && snapshot.current.visible && snapshot.current.expanded === true && snapshot.current.activeId === id)
      .then(() => { if (mounted.current && snapshot.current.scopeKey === scopeKey && snapshot.current.activeId === id) setDraft(sideQuestionConversationsSnapshot(scopeKey)?.conversations.find(item => item.id === id)?.draft ?? ''); }, report)
      .finally(() => { submitted.current.delete(id); });
  };
  const loadEarlier = () => {
    if (historyOnly || !conversation || !authorized?.conversation?.nextCursor || loading || !transport.isCurrent()) return;
    const id = conversation.id, controller = new AbortController(); setLoading(true); setError('');
    void transport.read(id, controller.signal, { cursor: authorized.conversation.nextCursor }).then(async value => {
      if (!value.conversation) throw new Error('侧问历史无效');
      await reconcileSideQuestionConversation(scopeKey, id, value.conversation, true);
      if (readCurrent(scopeKey, authorizationScope, id)) {
        if (value.conversation.lastOperationId !== authorized.conversation?.lastOperationId) { setReading(undefined); throw new Error('侧问有新的进展，请刷新结果后继续'); }
        setReading({ id, authorizationScope, value: { ...authorized, conversation: { ...authorized.conversation!, nextCursor: value.conversation.nextCursor } } });
      }
    }).catch(report).finally(() => { if (readCurrent(scopeKey, authorizationScope, id)) setLoading(false); });
  };
  const remove = () => {
    if (!conversation || deleting) return;
    const id = conversation.id; setDeleting(true); setConfirmDelete(false); setError('');
    if (historyOnly) {
      void deleteLocalSideQuestionConversation(scopeKey, id).catch(report).finally(() => { if (mounted.current) setDeleting(false); });
      return;
    }
    void deleteSideQuestionConversation(scopeKey, id, operationId => {
      if (!transport.isCurrent()) throw new Error('请连接原来的电脑与 API，再确认删除');
      return transport.remove(id, operationId);
    }).catch(report).finally(() => { if (mounted.current && snapshot.current.scopeKey === scopeKey) setDeleting(false); });
  };
  const removePhoneOnly = () => {
    if (!conversation || deleting) return;
    setConfirmDelete(false); void deleteLocalSideQuestionConversation(scopeKey, conversation.id).catch(report);
  };
  const fold = () => { if (state?.expanded) { onEditingChange?.(false); Keyboard.dismiss(); } void updateSideQuestionPresentation(scopeKey, { expanded: !state?.expanded }).catch(report); };
  const makeNew = () => { if (!transport.isCurrent()) return; if (onNewConversation) onNewConversation(); else if (!historyOnly) void createSideQuestionConversation(scopeKey, sessionKey).catch(report); };
  if (!visible || !state && !error || !state?.conversations.length && !transport.isCurrent() && !error) return null;
  return <View testID="remote-side-question-inline" style={[styles.panel, { borderColor: dk.line, backgroundColor: dk.surface }, compactComposer && { flex: 1, minHeight: 0, flexShrink: 1 }]}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={state?.expanded ? '收起侧问' : '展开侧问'} accessibilityState={{ expanded: state?.expanded }} onPress={fold} style={{ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 }}>
        <Text numberOfLines={1} style={{ color: dk.text, fontSize: 14, fontWeight: '600', flexShrink: 1 }}>侧问{state?.conversations.length ? ` · ${state.conversations.length}` : ''}{state?.conversations.some(item => item.unread) ? ' · 新回答' : ''}</Text>
        <Icon name={state?.expanded ? 'chevronDown' : 'chevronRight'} size={18} color={dk.muted} accent={dk.muted} />
      </Pressable>
      {compactComposer ? <Pressable accessibilityRole="button" accessibilityLabel="刷新侧问结果" disabled={loading || busy || !transport.isCurrent()} onPress={() => setReload(value => value + 1)} style={styles.button}><Text style={{ color: dk.accentText, fontSize: 12 }}>刷新</Text></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="新建侧问" disabled={!transport.isCurrent()} onPress={makeNew} style={styles.button}><Text style={{ color: dk.accentText }}>新建</Text></Pressable>
    </View>
    {state?.expanded && conversation ? <View style={compactComposer ? { flex: 1, minHeight: 0 } : { height: Math.max(160, Math.min(380, availableHeight * 0.48)) }}>
      {navigation ?? (state.conversations.length > 1 ? <ScrollView horizontal keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, flexShrink: 0, height: 36 }} contentContainerStyle={{ paddingHorizontal: 10, gap: 8, alignItems: 'center' }}>
        {state.conversations.map((item, index) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`打开侧问 ${index + 1}`} accessibilityState={{ selected: item.id === conversation.id }}
          onPress={() => { void updateSideQuestionPresentation(scopeKey, { activeId: item.id, expanded: true }).catch(report); }} style={[styles.tab, { backgroundColor: item.id === conversation.id ? dk.surface2 : dk.surface }]}>
          <Text numberOfLines={1} style={{ color: dk.text2, maxWidth: 150, fontSize: 12 }}>{item.exchanges[0]?.question || item.selection?.text || `侧问 ${index + 1}`}{item.unread ? ' · 新' : ''}</Text>
        </Pressable>)}
      </ScrollView> : null)}
      <ScrollView ref={scroll} style={[{ flex: 1, minHeight: 0 }, compactComposer && !showHistory && { display: 'none' }]} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.history} onContentSizeChange={() => { if (!authorized?.conversation?.nextCursor) scroll.current?.scrollToEnd({ animated: false }); }}>
        <Text style={{ color: dk.muted, fontSize: 11 }}>独立保存的对话 · 基于打开时已加载的主聊文字</Text>
        {historyOnly ? <Text style={{ color: dk.muted, fontSize: 11 }}>重新配对前的侧问 · 历史和草稿仅供查看</Text> : null}
        {authorized ? <Text style={{ color: dk.muted, fontSize: 11 }}>初始上下文 {authorized.value.contextMessages} 条。{authorized.value.contextTruncated ? '本次请求未包含部分较早内容，已保存的历史仍可查看。' : ''}</Text> : null}
        {authorized?.conversation?.nextCursor ? <Pressable accessibilityRole="button" accessibilityLabel="加载更早侧问" onPress={loadEarlier}><Text style={{ color: dk.accentText }}>加载更早记录</Text></Pressable> : null}
        {conversation.exchanges.map((exchange, index) => <View key={exchange.operationId} style={{ gap: 8 }}>
          <View style={[styles.question, { backgroundColor: dk.surface2 }]}>{exchange.selection ? <ContextReferenceChips references={[exchange.selection]} /> : null}<Text selectable style={{ color: dk.text, fontSize: 14 }}>{exchange.question}</Text></View>
          <View accessibilityLabel={`侧问回答 ${index + 1}`}><MessageContent text={exchange.answer} /></View>
        </View>)}
        {conversation.pending ? <View style={[styles.question, { backgroundColor: dk.surface2 }]}>
          {conversation.pending.input.selection ? <ContextReferenceChips references={[conversation.pending.input.selection]} /> : null}
          <Text selectable style={{ color: dk.text, fontSize: 14 }}>{conversation.pending.input.question}</Text>
          <Text style={{ color: dk.muted, fontSize: 11 }}>{busy ? '已提交，等待回答' : '结果待确认，不会自动重发'}</Text>
        </View> : null}
        {busy || loading ? <View style={styles.status}><ActivityIndicator size="small" color={dk.muted} /><Text style={{ color: dk.muted, fontSize: 12 }}>{busy ? '正在回答，收起后仍会保存…' : '同步侧问记录…'}</Text></View> : null}
        {error || conversation.error || conversation.deletedOnComputer || !transport.isCurrent() || authorized && !authorized.value.available ? <Text accessibilityRole="alert" style={{ color: dk.bad, fontSize: 12 }}>{error || conversation.error || (conversation.deletedOnComputer ? '电脑端已删除此侧问，本地记录保留到你主动删除' : !transport.isCurrent() ? '已保存的历史可查看，连接原来源后可继续' : authorized?.value.unavailableReason || '当前来源暂不能继续侧问')}</Text> : null}
      </ScrollView>
      <View style={[styles.composer, { borderTopColor: dk.line }]}>
        {!conversation.exchanges.length && conversation.selection ? compactComposer ? <Text numberOfLines={1} style={{ color: dk.muted, fontSize: 11 }}>已附带所选文字</Text> : <ContextReferenceChips references={[conversation.selection]} /> : null}
        <View style={compactComposer ? { flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingBottom: 5 } : undefined}>
        <TextInput accessibilityLabel="侧问问题" placeholder="在这里继续侧问…" placeholderTextColor={dk.muted} value={draft}
          onFocus={() => onEditingChange?.(true)}
          onChangeText={text => { if (!historyOnly) { setDraft(text); void updateSideQuestionDraft(scopeKey, conversation.id, text).catch(report); } }} multiline maxLength={8000} editable={!historyOnly && !busy && !deleting}
          style={[styles.input, { color: dk.text, backgroundColor: dk.surface2 }, compactComposer && { flex: 1, maxHeight: 62 }]} />
        {compactComposer ? <Pressable accessibilityRole="button" accessibilityLabel="发送侧问" disabled={!enabled || !draft.trim()} onPress={submit} style={[styles.send, { minHeight: 40, justifyContent: 'center', backgroundColor: dk.accentText, opacity: enabled && draft.trim() ? 1 : 0.4 }]}><Text style={{ color: dk.surface }}>发送</Text></Pressable> : null}
        </View>
        {!compactComposer ?
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel="删除侧问" disabled={deleting} onPress={() => setConfirmDelete(true)} style={styles.button}><Text style={{ color: dk.muted, fontSize: 12 }}>删除</Text></Pressable>
          {!historyOnly ? <Pressable accessibilityRole="button" accessibilityLabel="刷新侧问结果" disabled={loading || busy || !transport.isCurrent()} onPress={() => setReload(value => value + 1)} style={styles.button}><Text style={{ color: dk.accentText, fontSize: 12 }}>刷新结果</Text></Pressable> : null}
          <View style={{ flex: 1 }} />
          <Pressable accessibilityRole="button" accessibilityLabel="发送侧问" disabled={!enabled || !draft.trim()} onPress={submit} style={[styles.send, { backgroundColor: dk.accentText, opacity: enabled && draft.trim() ? 1 : 0.4 }]}><Text style={{ color: dk.surface }}>发送</Text></Pressable>
        </View> : null}
      </View>
    </View> : null}
    {error && !state?.expanded ? <Text accessibilityRole="alert" style={{ color: dk.bad, padding: 10 }}>{error}</Text> : null}
    <AppDialog visible={confirmDelete} title="删除这条侧问？" message={historyOnly ? '删除手机保存的这条历史和草稿，主聊天不受影响。' : '删除历史和草稿需要你确认。仅删除手机记录会保留电脑副本，需连接原来源后处理。主聊天不受影响。'} icon="trash" onClose={() => setConfirmDelete(false)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setConfirmDelete(false) }, { label: '删除侧问', tone: 'danger', onPress: remove },
      ...(!historyOnly && (conversation?.opened || conversation?.openAttempted) ? [{ label: '仅删除手机记录', tone: 'danger' as const, onPress: removePhoneOnly }] : []),
    ]} />
  </View>;
}
const styles = StyleSheet.create({
  panel: { borderTopWidth: StyleSheet.hairlineWidth, flexShrink: 0 }, header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, minHeight: 38 },
  history: { padding: 10, gap: 12 }, question: { padding: 9, borderRadius: 8, gap: 6 }, tab: { padding: 7, borderRadius: 7 },
  button: { padding: 7 }, status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 5, flexShrink: 0 }, input: { minHeight: 38, maxHeight: 78, padding: 8, borderRadius: 8, fontSize: 14, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', alignItems: 'center' }, send: { paddingVertical: 7, paddingHorizontal: 15, borderRadius: 8 },
});
