import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { MotionPressable } from '../components/MotionPressable';
import { useDesk } from '../theme';
import { AttachmentComposerInput } from './AttachmentComposerInput';
import { WorkbenchReveal } from './ConversationMotion';
import { conversationFontFamily } from './conversation-typography';
import { canReviseSentMessage, sentMessageRevisionIdentity, type SentMessageRevisionHandler, type SentUserMessage } from './sent-message-revision';
import { useInlineEditDraft } from './useInlineEditDraft';

/** The parent owns revert + resend and its durable receipt. Closing this local
 * editor cannot undo a request already accepted by the remote computer. */
export function InlineSentMessageEditor({ message, scopeKey, draftScope, draftDeviceId, disabledReason, onSubmit, onClose }: {
  message: SentUserMessage; scopeKey: string; draftScope?: string; draftDeviceId?: string; disabledReason?: string;
  onSubmit: SentMessageRevisionHandler; onClose: () => void;
}) {
  const d = useDesk(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const identity = JSON.stringify([scopeKey,draftScope,draftDeviceId,sentMessageRevisionIdentity(message)]);
  const source = useRef({ identity, epoch: 0 });
  if (source.current.identity !== identity) source.current = { identity, epoch: source.current.epoch + 1 };
  const original = useRef({ identity, epoch: source.current.epoch });
  const valid = original.current.identity === identity && original.current.epoch === source.current.epoch && canReviseSentMessage(message);
  const draft = useInlineEditDraft(message.text, identity, draftScope, draftDeviceId, valid), text = draft.text;
  const latest = useRef({ message, disabledReason, onSubmit, onClose, valid });latest.current = { message, disabledReason, onSubmit, onClose, valid };
  const alive = useRef(true), flight = useRef<AbortController | undefined>(undefined), closing = useRef(false);
  useLayoutEffect(() => { alive.current = true;return () => { alive.current = false;flight.current?.abort(); }; }, []);
  useEffect(() => { if (!valid) flight.current?.abort(); }, [valid]);
  const current = () => alive.current && latest.current.valid && source.current.identity === original.current.identity && source.current.epoch === original.current.epoch;
  const close = async () => {
    if (!current() || flight.current || closing.current) return;
    if (!draft.ready) { latest.current.onClose(); return; }
    closing.current=true;setBusy(true); setError('');
    try { await draft.discard(); if (current()) latest.current.onClose(); }
    catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : '编辑草稿未清除，请重试'); }
    finally { closing.current=false;if (current()) setBusy(false); }
  };
  const submit = async () => {
    if (!current() || flight.current || closing.current || !draft.ready || latest.current.disabledReason) return;
    if (!text.trim() && !latest.current.message.images?.length && !latest.current.message.attachments?.length) { setError('请输入消息内容');return; }
    const controller = new AbortController();flight.current = controller;setBusy(true);setError('');
    try {
      const saved = await draft.flush();
      if (!current() || controller.signal.aborted || latest.current.disabledReason) return;
      const accepted = await latest.current.onSubmit(latest.current.message, text, controller.signal);
      // A successful native revert removes this bubble. Acceptance still owns
      // only the flushed draft revision, so cleanup remains safe after unmount.
      if (accepted) await saved.draft?.consume(saved.receipt);
      if (!current() || controller.signal.aborted) return;
      if (!accepted) throw new Error('暂时无法发送修改，请核对连接和待确认消息后重试');
      latest.current.onClose();
    } catch (reason) { if (current() && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : '修改未完成，请核对会话后重试'); }
    finally { if (flight.current === controller) { flight.current = undefined;if (current()) setBusy(false); } }
  };
  if (!valid) return null;
  const label = { fontFamily: conversationFontFamily, fontSize: 12, lineHeight: 18, color: d.text };
  return <WorkbenchReveal testID="inline-sent-message-editor" style={{ gap: 8, minWidth: 0 }}>
    <AttachmentComposerInput scopeKey={identity} value={text} onChangeText={draft.change} mentions={[]} multiline maxLength={100_000}
      editable={draft.ready && !busy && !disabledReason} accessibilityLabel="编辑最新消息正文" placeholder="编辑消息…"
      style={{ minHeight: 80, maxHeight: 240, padding: 0, fontSize: 13, lineHeight: 21, color: d.text, fontFamily: conversationFontFamily, textAlignVertical: 'top' }} />
    <Text style={[label, { color: d.muted, fontSize: 11 }]}>发送后将替换这条消息及后续回复，已进行的文件更改会保留。</Text>
    {error || draft.error || disabledReason ? <Text accessibilityRole="alert" style={[label, { color: d.warn }]}>{error || draft.error || disabledReason}</Text> : null}
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
      <MotionPressable scaleTo={0.98} accessibilityRole="button" accessibilityLabel="取消编辑最新消息" disabled={busy} onPress={() => void close()}
        style={{ minHeight: 32, paddingHorizontal: 10, justifyContent: 'center', opacity: busy ? .45 : 1 }}><Text style={label}>取消</Text></MotionPressable>
      <MotionPressable scaleTo={0.98} accessibilityRole="button" accessibilityLabel="发送修改后的消息" disabled={busy || !draft.ready || Boolean(disabledReason)} onPress={() => void submit()}
        style={{ minHeight: 32, paddingHorizontal: 12, borderRadius: 8, backgroundColor: d.surface2, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: disabledReason ? .45 : 1 }}>
        {busy ? <ActivityIndicator size="small" color={d.muted} /> : null}<Text style={label}>{busy ? '发送中…' : '发送'}</Text>
      </MotionPressable>
    </View>
  </WorkbenchReveal>;
}
