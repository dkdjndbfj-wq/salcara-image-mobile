import {WorkbenchReveal} from './ConversationMotion';
import React, { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, type TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { Sheet, showToast } from '../components/ui';
import { useDesk } from '../theme';
import { conversationFontFamily } from './conversation-typography';
import { SkillComposerInput, type SkillComposerInputProps } from './SkillComposerInput';
import { reconcileSkillMentions, type SkillMentionEdit } from './skill-mentions';
import { joinPastedText, largeInsertion, LARGE_PASTE_LENGTH, namedTextAttachment, nextPastedText, splitPastedText, type PastedText } from './pasted-text';
import { PromptHistorySheet, type PromptHistoryHandle } from './PromptHistorySheet';
import {promptHistoryIdentity,type PromptHistoryEntry} from './prompt-history';

export function TextAttachmentChips({ attachments, onRestore, onRemove, disabled = false, active = true }: {
  attachments: readonly PastedText[]; onRestore?: (index: number) => void; onRemove?: (index: number) => void; disabled?: boolean; active?: boolean;
}) {
  const d = useDesk(), [opened, setOpened] = useState<PastedText>();
  const selected = active ? attachments.find(item => item.name === opened?.name && item.text === opened.text) : undefined;
  useEffect(() => { if (!active) setOpened(undefined); }, [active]);
  if (!attachments.length) return null;
  return <View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} keyboardShouldPersistTaps="handled">
    {attachments.map((item, index) => <WorkbenchReveal key={item.name} style={[s.chip, { backgroundColor: d.surface2 }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`预览文本附件 ${item.name}`} onPress={() => setOpened(item)} style={s.open}>
        <Icon name="file" size={15} color={d.muted} /><Text style={[s.label, { color: d.text }]}>{item.name}</Text>
        <Text style={[s.size, { color: d.muted }]}>{Math.ceil(new TextEncoder().encode(item.text).length / 1024)} KB</Text>
      </Pressable>
      {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={`移除文本附件 ${item.name}`} disabled={disabled} onPress={() => onRemove(index)} style={s.remove}><Icon name="close" size={13} color={d.muted} /></Pressable> : null}
    </WorkbenchReveal>)}
  </ScrollView><Sheet visible={Boolean(selected)} title={selected?.name ?? '文本附件'} onClose={() => setOpened(undefined)}>
    {selected ? <View style={{ gap: 12, paddingHorizontal: 16, paddingBottom: 16 }}>
      {onRestore ? <Pressable accessibilityRole="button" accessibilityLabel="将文本附件转回正文" disabled={disabled} onPress={() => { const index = attachments.indexOf(selected); setOpened(undefined); onRestore(index); }} style={{ minHeight: 36, justifyContent: 'center' }}><Text style={[s.label, { color: d.text }]}>转回正文</Text></Pressable> : null}
      <ScrollView nestedScrollEnabled style={{ maxHeight: 360 }}><ScrollView horizontal nestedScrollEnabled><Text selectable style={[s.content, { color: d.text }]}>{selected.text}</Text></ScrollView></ScrollView>
    </View> : null}
  </Sheet></View>;
}

/** The input edits the instruction; attached snapshots remain in the existing
 * durable draft/queue transport, retaining all characters and offline recovery. */
export const AttachmentComposerInput = forwardRef<TextInput, SkillComposerInputProps & { scopeKey: string; active?: boolean; history?: readonly PromptHistoryEntry[]; historyRef?: React.MutableRefObject<PromptHistoryHandle | undefined>;onRestoreHistory?:(entry:PromptHistoryEntry,signal:AbortSignal)=>Promise<boolean> }>(function AttachmentComposerInput(props, ref) {
  const { scopeKey, active = true, history = [], historyRef, onRestoreHistory, value, mentions, onSkillEdit, onChangeText, maxLength = 100_000, ...input } = props;
  // Returning to an identical draft must not revive callbacks from its previous
  // visit. Sending locks keep the owner so a queued native keystroke is retained.
  const visit = useRef({ scopeKey, active, revision: 0 });
  if (visit.current.scopeKey !== scopeKey || visit.current.active !== active) visit.current = { scopeKey, active, revision: visit.current.revision + 1 };
  const owner = visit.current;
  const parts = splitPastedText(value), current = useRef({ owner, value, editable: props.editable !== false });
  current.current = { owner, value, editable: props.editable !== false };
  const [historyOpen, setHistoryOpen] = useState<typeof owner>();
  const recall = useRef<{ scope: string; value: string; index: number; entries: readonly PromptHistoryEntry[] } | undefined>(undefined);
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const owns = () => alive.current && current.current.owner === owner && owner.active;
  useEffect(() => { setHistoryOpen(undefined); recall.current = undefined; }, [owner]);
  useLayoutEffect(() => {
    const handle = { open: () => { if (owns() && current.current.editable) setHistoryOpen(owner); } };
    if (historyRef) historyRef.current = handle;
    return () => { if (historyRef?.current === handle) historyRef.current = undefined; };
  }, [owner, historyRef]);
  const valid = (nativeEdit = false) => owns() && current.current.value === value && (nativeEdit || current.current.editable);
  const publish = (edit: SkillMentionEdit, attachments = parts.attachments, nativeEdit = false) => {
    if (!valid(nativeEdit)) return;
    const text = joinPastedText(edit.text, attachments);
    if (text.length > maxLength) { showToast('内容超过输入限制，请缩短后再粘贴；原草稿已保留', 'alert'); return; }
    if (onSkillEdit) onSkillEdit({ ...edit, text }); else onChangeText?.(text);
  };
  const attach = (text: string, start: number, finish: number) => {
    if (!valid() || text.length <= LARGE_PASTE_LENGTH || parts.attachments.length >= 8) return false;
    const prompt = parts.prompt.slice(0, start) + parts.prompt.slice(finish);
    const attachments = [...parts.attachments, nextPastedText(text, parts.attachments)];
    if (joinPastedText(prompt, attachments).length > maxLength) return false;
    publish({ ...reconcileSkillMentions(parts.prompt, prompt, mentions), caret: start }, attachments);
    return true;
  };
  const edit = (next: SkillMentionEdit) => {
    if (!valid(true)) return;
    recall.current = undefined;
    const inserted = largeInsertion(parts.prompt, next.text);
    if (inserted && attach(inserted.text, inserted.start, inserted.end)) return;
    // A native keystroke already queued before the send lock still belongs to
    // this exact draft. Preserve it instead of silently dropping the user's edit.
    publish(next, parts.attachments, true);
  };
  const recallText = (text: string) => {
    if (!alive.current || !valid()) return false;
    if (text.length > maxLength) { showToast('这条输入超过当前限制，原草稿已保留', 'alert'); return false; }
    const edit = reconcileSkillMentions(value, text, mentions);
    if (onSkillEdit) onSkillEdit({ ...edit, caret: text.length }); else onChangeText?.(text);
    return true;
  };
  const historyKey: SkillComposerInputProps['onKeyPress'] = event => {
    if (!valid()) return;
    const key = event.nativeEvent as typeof event.nativeEvent & { isComposing?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };
    if (!key.isComposing && !key.shiftKey && !key.altKey && !key.metaKey && !key.ctrlKey && (key.key === 'ArrowUp' || key.key === 'ArrowDown')) {
      const previous = recall.current?.scope === scopeKey && recall.current.value === value ? recall.current : undefined;
      const entries = previous?.entries ?? history;
      if (entries.length && (previous || value === '' && key.key === 'ArrowUp')) {
        const index = Math.max(-1, Math.min(entries.length - 1, (previous?.index ?? -1) + (key.key === 'ArrowUp' ? 1 : -1)));
        const candidate=entries[index];
        if(candidate&&onRestoreHistory&&(candidate.hasImages||candidate.message?.skills?.length||candidate.message?.contextReferences?.length||candidate.message?.collaborationMode)){setHistoryOpen(owner);event.preventDefault?.();return;}
        const text = index < 0 ? '' : entries[index].text;
        if (recallText(text)) { recall.current = { scope: scopeKey, value: text, index, entries }; event.preventDefault?.(); return; }
      }
    }
    input.onKeyPress?.(event);
  };
  return <View>
    <PromptHistorySheet key={`history-${owner.revision}`} visible={active && historyOpen === owner} entries={history} disabled={props.editable === false} append={Boolean(value)}
      onRestore={onRestoreHistory?async(entry,signal)=>{if(!valid()||!history.some(item=>promptHistoryIdentity(item)===promptHistoryIdentity(entry)))return false;const restored=await onRestoreHistory(entry,signal);if(restored&&owns()&&!signal.aborted){recall.current=undefined;setHistoryOpen(undefined);}return restored;}:undefined}
      onClose={() => { if (owns()) setHistoryOpen(undefined); }} onPick={entry => {
        if(!history.some(item=>item.id===entry.id&&item.text===entry.text)||!valid())return;
        const incoming=splitPastedText(entry.text),attachments=[...parts.attachments];
        for(const item of incoming.attachments)attachments.push(namedTextAttachment(item.name,item.text,attachments));
        if(attachments.length>8){showToast('文本附件最多 8 个，原草稿已保留','alert');return;}
        const combined=joinPastedText([parts.prompt,incoming.prompt].filter(Boolean).join('\n\n'),attachments);
        if (recallText(combined)) { recall.current = undefined; setHistoryOpen(undefined); }
      }} />
    <TextAttachmentChips key={`attachments-${owner.revision}`} attachments={parts.attachments} active={active} disabled={props.editable === false}
      onRemove={index => publish({ text: parts.prompt, mentions }, parts.attachments.filter((_, i) => i !== index))}
      onRestore={index => { const attachment = parts.attachments[index]; if (attachment) publish({ text: parts.prompt + (parts.prompt ? '\n\n' : '') + attachment.text, mentions }, parts.attachments.filter((_, i) => i !== index)); }} />
    <SkillComposerInput {...input} key={`input-${owner.revision}`} editable={active && props.editable !== false} ref={ref} value={parts.prompt} mentions={mentions.filter(item => item.end <= parts.prompt.length)}
      maxLength={Math.max(0, maxLength - (value.length - parts.prompt.length))} onPasteText={attach} onKeyPress={historyKey}
      onChangeText={text => edit(reconcileSkillMentions(parts.prompt, text, mentions))} onSkillEdit={edit} />
  </View>;
});
const s = StyleSheet.create({ chips: { flexDirection: 'row', gap: 6, paddingHorizontal: 6, paddingVertical: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', borderRadius: 9 }, open: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingLeft: 9, paddingRight: 6 },
  remove: { width: 32, height: 34, alignItems: 'center', justifyContent: 'center' }, label: { fontSize: 12, fontFamily: conversationFontFamily }, size: { fontSize: 10 }, content: { fontSize: 13, lineHeight: 21, fontFamily: conversationFontFamily },
});
