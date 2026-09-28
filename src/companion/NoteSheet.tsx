import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import { AppDialog, Chip, Sheet, showToast } from '../components/ui';
import { neighbours } from '../memorybox/search';
import { deleteNote, updateNote } from '../memorybox/store';
import { NOTE_TYPE_META, NOTE_TYPES, type MemLink, type MemNote, type NoteType } from '../memorybox/types';
import { warm } from './theme';

function when(time: number | null | undefined) {
  if (!time) return '';
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** One memory card: read, follow its links, edit, pin, mark outdated, delete. */
export function NoteSheet({ note, owner, notes, links, onClose, onSelect, onOpenConversation }: {
  note: MemNote | null; owner: string | null; notes: MemNote[]; links: MemLink[]; onClose: () => void; onSelect: (id: string) => void; onOpenConversation?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [type, setType] = useState<NoteType>('fact');
  const [importance, setImportance] = useState(5);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    setEditing(false);
    if (note) { setTitle(note.title); setContent(note.content); setType(note.type); setImportance(note.importance); }
  }, [note?.id]);
  if (!note || !owner) return <Sheet visible={false} onClose={onClose}><View /></Sheet>;
  const meta = NOTE_TYPE_META[note.type];
  const related = neighbours(note.id, notes, links);
  const replacement = note.supersededBy ? notes.find((item) => item.id === note.supersededBy) : null;
  const patch = (value: Partial<MemNote>, toast: string) => void updateNote(owner, note.id, value).then(() => showToast(toast)).catch(() => showToast('没有保存', 'alert'));
  // Restoring a replaced fact retires the note that replaced it, so the two don't both count as current.
  const restore = () => void (async () => {
    if (replacement && replacement.validTo === null) await updateNote(owner, replacement.id, { validTo: Date.now(), supersededBy: note.id });
    await updateNote(owner, note.id, { validTo: null, supersededBy: null });
  })().then(() => showToast('已恢复')).catch(() => showToast('没有保存', 'alert'));
  const save = () => {
    if (!title.trim()) { showToast('标题不能为空', 'alert'); return; }
    // An edited note gets a fresh embedding on the next memory pass.
    patch({ title: title.trim().slice(0, 60), content: content.trim().slice(0, 800), type, importance, embedding: null, embeddingModel: null }, '已保存');
    setEditing(false);
  };
  return <Sheet visible={Boolean(note)} onClose={onClose} background={warm.background}>
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <View style={styles.head}>
        <View style={[styles.type, { backgroundColor: `${meta.color}22` }]}><Text style={[styles.typeText, { color: meta.color }]}>{meta.label}</Text></View>
        {note.pinned ? <View style={styles.flag}><Icon name="bookmark" size={12} color={warm.accentDeep} /><Text style={styles.flagText}>核心</Text></View> : null}
        {note.validTo !== null ? <View style={styles.flag}><Text style={styles.flagText}>已过时</Text></View> : null}
        {note.aboutUser ? <View style={styles.flag}><Text style={styles.flagText}>关于你</Text></View> : null}
      </View>
      {editing ? <>
        <TextInput value={title} onChangeText={setTitle} style={styles.titleInput} maxLength={60} placeholder="标题" placeholderTextColor={warm.faint} />
        <TextInput value={content} onChangeText={setContent} style={styles.contentInput} multiline textAlignVertical="top" maxLength={800} placeholder="内容" placeholderTextColor={warm.faint} />
        {note.type !== 'episode' ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {NOTE_TYPES.filter((item) => item !== 'episode').map((item) => <Chip key={item} label={NOTE_TYPE_META[item].label} selected={type === item} onPress={() => setType(item)} />)}
        </ScrollView> : null}
        <View style={styles.importance}>
          <Text style={styles.label}>重要度</Text>
          {[2, 4, 6, 8, 10].map((value) => <Chip key={value} label={String(value)} selected={Math.min(10, Math.max(2, Math.round(importance / 2) * 2)) === value} onPress={() => setImportance(value)} />)}
        </View>
        <View style={styles.buttons}>
          <Pressable onPress={() => setEditing(false)} style={styles.button}><Text style={styles.buttonText}>取消</Text></Pressable>
          <Pressable onPress={save} style={[styles.button, styles.primary]}><Text style={[styles.buttonText, { color: '#FFFFFF' }]}>保存</Text></Pressable>
        </View>
      </> : <>
        <Text selectable style={styles.title}>{note.title}</Text>
        {note.content ? <Text selectable style={styles.content}>{note.content}</Text> : null}
        <Text style={styles.meta}>
          {note.type === 'episode' ? `${when(note.rangeStart)} ~ ${when(note.rangeEnd)} · 第 ${note.level} 层概括` : `记于 ${when(note.createdAt)}`}
          {` · 重要度 ${note.importance}`}{note.accessCount ? ` · 想起过 ${note.accessCount} 次` : ''}
        </Text>
        {replacement ? <Pressable onPress={() => onSelect(replacement.id)} style={styles.replaced}><Text style={styles.replacedText}>已被“{replacement.title}”取代 ›</Text></Pressable> : null}
      </>}

      {related.length && !editing ? <>
        <Text style={styles.section}>连线</Text>
        {related.map(({ note: other, link, outgoing }) => <Pressable key={link.id} accessibilityRole="button" onPress={() => onSelect(other.id)} style={({ pressed }) => [styles.link, pressed && { backgroundColor: warm.surfaceStrong }]}>
          <View style={[styles.dot, { backgroundColor: NOTE_TYPE_META[other.type].color }]} />
          <Text style={styles.relation}>{outgoing ? link.relation : `← ${link.relation}`}</Text>
          <Text style={styles.linkTitle} numberOfLines={1}>{other.title}</Text>
          <Icon name="chevronRight" size={15} color={warm.faint} />
        </Pressable>)}
      </> : null}

      {!editing ? <View style={styles.actions}>
        <Action icon="edit" label="编辑" onPress={() => setEditing(true)} />
        <Action icon="bookmark" label={note.pinned ? '取消核心' : '设为核心'} onPress={() => patch({ pinned: !note.pinned }, note.pinned ? '已取消' : '已设为核心记忆，TA 会一直记得')} />
        {note.type !== 'episode' ? <Action icon="history" label={note.validTo === null ? '已过时' : '恢复'} onPress={() => (note.validTo === null ? patch({ validTo: Date.now() }, '已标记为过时') : restore())} /> : null}
        {onOpenConversation && note.sourceConversationId ? <Action icon="chat" label="回到聊天" onPress={onOpenConversation} /> : null}
        <Action icon="trash" label="删除" danger onPress={() => setConfirm(true)} />
      </View> : null}
    </ScrollView>
    <AppDialog visible={confirm} title="删除这条记忆？" message={`“${note.title}”和它的连线会被删除。`} icon="trash" onClose={() => setConfirm(false)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setConfirm(false) },
      { label: '删除', tone: 'danger', onPress: () => { setConfirm(false); onClose(); void deleteNote(owner, note.id).then(() => showToast('已删除')); } },
    ]} />
  </Sheet>;
}

function Action({ icon, label, onPress, danger = false }: { icon: 'edit' | 'bookmark' | 'history' | 'chat' | 'trash'; label: string; onPress: () => void; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.action, pressed && { opacity: 0.7 }]}>
    <View style={[styles.actionIcon, danger && { backgroundColor: warm.accentSoft }]}><Icon name={icon} size={18} color={danger ? warm.accentDeep : warm.textSecondary} /></View>
    <Text style={[styles.actionLabel, danger && { color: warm.accentDeep }]}>{label}</Text>
  </Pressable>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingBottom: 24, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  type: { paddingHorizontal: 10, height: 24, borderRadius: 12, justifyContent: 'center' },
  typeText: { fontSize: 12, fontWeight: '700' },
  flag: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, height: 24, borderRadius: 12, backgroundColor: warm.surfaceStrong },
  flagText: { color: warm.textSecondary, fontSize: 11.5, fontWeight: '500' },
  title: { color: warm.text, fontSize: 20, fontWeight: '700', lineHeight: 28 },
  content: { color: warm.textSecondary, fontSize: 15.5, lineHeight: 24 },
  meta: { color: warm.muted, fontSize: 12.5 },
  replaced: { paddingVertical: 6 },
  replacedText: { color: warm.accentDeep, fontSize: 13.5, fontWeight: '500' },
  section: { color: warm.muted, fontSize: 12.5, fontWeight: '600', marginTop: 10 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 12, backgroundColor: warm.card },
  dot: { width: 8, height: 8, borderRadius: 4 },
  relation: { color: warm.muted, fontSize: 12.5, minWidth: 34 },
  linkTitle: { flex: 1, color: warm.text, fontSize: 14.5 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14, justifyContent: 'space-between' },
  action: { alignItems: 'center', gap: 6, width: 62 },
  actionIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: warm.card },
  actionLabel: { color: warm.textSecondary, fontSize: 12 },
  label: { color: warm.muted, fontSize: 13 },
  titleInput: { height: 46, borderRadius: 14, paddingHorizontal: 14, backgroundColor: warm.card, color: warm.text, fontSize: 17, fontWeight: '600' },
  contentInput: { minHeight: 120, borderRadius: 14, padding: 14, backgroundColor: warm.card, color: warm.text, fontSize: 15, lineHeight: 22 },
  chips: { gap: 8 },
  importance: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
  button: { minWidth: 76, height: 40, borderRadius: 20, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: warm.surfaceStrong },
  primary: { backgroundColor: warm.accent },
  buttonText: { color: warm.text, fontSize: 14.5, fontWeight: '600' },
});
