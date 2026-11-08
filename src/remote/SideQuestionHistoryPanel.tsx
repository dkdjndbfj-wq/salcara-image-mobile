import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useDesk } from '../theme';
import { SideQuestionPanel } from './SideQuestionPanel';
import { createSideQuestionConversation, loadSideQuestionConversations, rememberSideQuestionViewScope, restoreSideQuestionViewScope,
  sideQuestionConversationsSnapshot, subscribeSideQuestionConversations, updateSideQuestionPresentation, type SideQuestionConversations } from './side-question-conversations';

type Props = React.ComponentProps<typeof SideQuestionPanel> & { loadHistoryScopes?: () => Promise<string[]> };
/** Presents old local text in the existing tabs. The live transport belongs
 * exclusively to scopeKey, even when a previous pairing's tab is selected. */
export function SideQuestionHistoryPanel(props: Props) {
  const dk = useDesk(), { scopeKey, loadHistoryScopes } = props;
  const identity = useRef({ scope: scopeKey, token: {} });
  const mounted = useRef(true);
  const selectionSequence = useRef(0);
  if (identity.current.scope !== scopeKey) identity.current = { scope: scopeKey, token: {} };
  const token = identity.current.token;
  const [loaded, setLoaded] = useState<{ token: object; scopes: string[]; groups: Record<string, SideQuestionConversations> }>();
  const [selected, setSelected] = useState<{ token: object; scope: string }>();
  const [failure, setFailure] = useState<{ token: object; text: string }>();
  const current = () => mounted.current && identity.current.token === token;
  const report = (error: unknown) => { if (current()) setFailure({ token, text: error instanceof Error ? error.message : '侧问历史暂时无法读取' }); };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false; const unsubscribes: Array<() => void> = [];
    void (async () => {
      const scopes = [...new Set([scopeKey, ...await (loadHistoryScopes?.() ?? Promise.resolve([]))])];
      if (cancelled || !current()) return;
      const groups: Record<string, SideQuestionConversations> = {};
      for (const scope of scopes) {
        unsubscribes.push(subscribeSideQuestionConversations(scope, () => {
          if (cancelled || !current()) return;
          const value = sideQuestionConversationsSnapshot(scope); if (!value) return;
          setLoaded(previous => previous?.token === token ? { ...previous, groups: { ...previous.groups, [scope]: value } } : previous);
        }));
        groups[scope] = await loadSideQuestionConversations(scope);
        if (cancelled || !current()) return;
      }
      const saved = await restoreSideQuestionViewScope(scopeKey);
      if (cancelled || !current()) return;
      // Re-read snapshots after awaited loads so a late answer cannot disappear.
      for (const scope of scopes) groups[scope] = sideQuestionConversationsSnapshot(scope) ?? groups[scope];
      setLoaded({ token, scopes, groups });
      const chosen = saved && scopes.includes(saved) && groups[saved]?.conversations.length ? saved
        : groups[scopeKey]?.conversations.length ? scopeKey : scopes.find(scope => groups[scope]?.conversations.length) ?? scopeKey;
      setSelected(previous => previous?.token === token ? previous : { token, scope: props.selection ? scopeKey : chosen });
    })().catch(report);
    return () => { cancelled = true; mounted.current = false; unsubscribes.forEach(unsubscribe => unsubscribe()); };
  }, [scopeKey]);
  const data = loaded?.token === token ? loaded : undefined;
  const requested = selected?.token === token ? selected.scope : scopeKey;
  const viewScope = props.selection && props.selectionNonce !== undefined ? scopeKey : data && !data.groups[requested]?.conversations.length
    ? data.scopes.find(scope => data.groups[scope]?.conversations.length) ?? scopeKey : requested;
  useEffect(() => { if (props.selection && props.selectionNonce !== undefined) setSelected({ token, scope: scopeKey }); }, [scopeKey, props.selectionNonce]);
  const select = async (scope: string, id?: string, sequence = ++selectionSequence.current) => {
    await updateSideQuestionPresentation(scope, { ...(id ? { activeId: id } : {}), expanded: true });
    const latest = () => current() && sequence === selectionSequence.current;
    if (!latest()) return;
    await rememberSideQuestionViewScope(scopeKey, scope, latest);
    if (latest()) { setSelected({ token, scope }); setFailure(undefined); }
  };
  const create = () => {
    if (!props.transport.isCurrent()) return;
    const sequence = ++selectionSequence.current;
    void createSideQuestionConversation(scopeKey, props.sessionKey).then(value => {
      if (current() && sequence === selectionSequence.current) return select(scopeKey, value.activeId, sequence);
    }).catch(report);
  };
  const tabs = data?.scopes.flatMap(scope => data.groups[scope]?.conversations.map(conversation => ({ scope, conversation })) ?? []) ?? [];
  const activeId = data?.groups[viewScope]?.activeId;
  const navigation = tabs.length > 1 ? <ScrollView horizontal keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, flexShrink: 0, height: 36 }} contentContainerStyle={{ paddingHorizontal: 10, gap: 8, alignItems: 'center' }}>
    {tabs.map(({ scope, conversation }, index) => <Pressable key={`${scope}|${conversation.id}`} accessibilityRole="button" accessibilityLabel={`打开侧问 ${index + 1}`}
      accessibilityState={{ selected: scope === viewScope && conversation.id === activeId }} onPress={() => { void select(scope, conversation.id).catch(report); }}
      style={{ padding: 7, borderRadius: 7, backgroundColor: scope === viewScope && conversation.id === activeId ? dk.surface2 : dk.surface }}>
      <Text numberOfLines={1} style={{ color: dk.text2, maxWidth: 150, fontSize: 12 }}>{conversation.exchanges[0]?.question || conversation.selection?.text || `侧问 ${index + 1}`}{conversation.unread ? ' · 新' : ''}</Text>
    </Pressable>)}
  </ScrollView> : undefined;
  return <View style={props.compactComposer && viewScope === scopeKey ? { flex: 1, minHeight: 0 } : undefined}>
    <SideQuestionPanel {...props} key={viewScope} scopeKey={viewScope} historyOnly={viewScope !== scopeKey} navigation={navigation} onNewConversation={create} />
    {props.visible && failure?.token === token ? <Text accessibilityRole="alert" style={{ color: dk.bad, padding: 10 }}>{failure.text}</Text> : null}
  </View>;
}
