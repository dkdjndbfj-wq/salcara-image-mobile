import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import { RadioRow, ToggleRow } from '../components/SettingsParts';
import { AppDialog, Chip, Group, MotionPressable, PrimaryButton, SectionLabel, Sheet, showToast } from '../components/ui';
import { BLANK_CHARACTER, CHARACTER_COLORS, CHARACTER_TEMPLATES, type CharacterDraft } from '../memorybox/characters';
import { clearBox, updateCharacter, useCharacters } from '../memorybox/store';
import type { Character, MemoryMode } from '../memorybox/types';
import { useApp } from '../state/AppContext';
import { colors } from '../theme';
import { deleteAvatar, pickAvatar } from './avatar';
import { CharacterAvatar } from './CharacterAvatar';
import { warm } from './theme';

const EMOJIS = ['🌙', '☀️', '🌸', '🍊', '🐱', '🐶', '🦊', '🐰', '🐻', '🐼', '🦄', '🐳', '🌈', '⭐', '🎧', '📚', '☕', '🎮', '🎨', '🌿', '😏', '😊', '🤖', '👻'];

const MEMORY_MODES: Array<{ id: MemoryMode; title: string; detail: string }> = [
  { id: 'auto', title: '自动记住', detail: '每次聊完，TA 会把值得记住的事整理进记忆匣' },
  { id: 'explicit', title: '只在我说“记住”时', detail: '只记录你明确要求记住的内容' },
  { id: 'off', title: '不记', detail: '不写入新记忆（聊天仍会自动概括，不会有长度上限）' },
];

function toDraft(character: Character): CharacterDraft {
  const { id, name, icon, avatarUri, color, persona, style, relationship, greeting, canDraw, canSearch, providerId, model, memoryMode } = character;
  return { id, name, icon, avatarUri, color, persona, style, relationship, greeting, canDraw, canSearch, providerId, model, memoryMode };
}

/** Create a character (from a template or blank) or edit one, including its core memory. */
export function CharacterSheet({ visible, characterId, onClose, onCreated }: {
  visible: boolean; characterId: string | null; onClose: () => void; onCreated?: (character: Character) => void;
}) {
  const app = useApp();
  const characters = useCharacters();
  const existing = characters.find((item) => item.id === characterId) ?? null;
  const [draft, setDraft] = useState<CharacterDraft | null>(null);
  const [core, setCore] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<'clear' | 'delete' | null>(null);
  const [avatarMenu, setAvatarMenu] = useState(false);
  // Pictures picked in this session that may not end up saved; unused ones are removed on close.
  const picked = useRef<string[]>([]);
  // Core memory as the sheet opened: the pipeline may rewrite it meanwhile, and only a real edit should overwrite that.
  const initialCore = useRef('');

  useEffect(() => {
    if (!visible) return;
    setDraft(existing ? toDraft(existing) : null);
    initialCore.current = existing?.coreMemory ?? '';
    setCore(initialCore.current);
  }, [visible, existing?.id]);

  const set = (patch: Partial<CharacterDraft>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const cleanupPicked = (keep: string | null | undefined) => {
    for (const uri of picked.current) if (uri !== keep) deleteAvatar(uri);
    picked.current = [];
  };
  const close = () => { cleanupPicked(null); onClose(); };
  const choosePicture = async (source: 'library' | 'camera') => {
    setAvatarMenu(false);
    try {
      const uri = await pickAvatar(source);
      if (!uri) return;
      picked.current.push(uri);
      set({ avatarUri: uri });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '没有选到图片', 'alert');
    }
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const previous = existing?.avatarUri ?? null;
      if (existing) {
        await app.editCharacter(existing.id, draft);
        if (previous && previous !== draft.avatarUri) deleteAvatar(previous);
        cleanupPicked(draft.avatarUri);
        if (core !== initialCore.current) await updateCharacter(existing.id, { coreMemory: core.trim().slice(0, 1500) });
        showToast('已保存');
        onClose();
      } else {
        const created = await app.createCharacter(draft);
        cleanupPicked(draft.avatarUri);
        onClose();
        onCreated?.(created);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'alert');
    } finally {
      setSaving(false);
    }
  };

  return <Sheet visible={visible} title={existing ? `${existing.name} 的设定` : draft ? '新的聊天伙伴' : '选一个聊天伙伴'} onClose={close} presentation="page" background={warm.background}
    footer={draft ? <PrimaryButton label={existing ? '保存' : '开始聊天'} loading={saving} disabled={!draft.name.trim()} onPress={() => void save()} /> : undefined}>
    <View style={styles.body}>
      {!draft ? <>
        <Text style={styles.lead}>每个角色都有自己的性格和独立的记忆匣，会一直记得和你聊过的事。</Text>
        <View style={styles.templates}>
          {CHARACTER_TEMPLATES.map((template) => <MotionPressable key={template.name} scaleTo={0.97} wrapperStyle={styles.templateWrap} accessibilityRole="button" accessibilityLabel={`选择 ${template.name}`}
            onPress={() => setDraft({ ...template })} style={styles.template}>
            <CharacterAvatar character={template} size={44} />
            <Text style={styles.templateName}>{template.name}</Text>
            <Text style={styles.templateLine}>{template.tagline}</Text>
          </MotionPressable>)}
        </View>
        <PrimaryButton label="自己创建" tone="secondary" icon="plus" onPress={() => setDraft({ ...BLANK_CHARACTER })} style={{ marginTop: 16 }} />
      </> : <>
        <View style={styles.identity}>
          <MotionPressable scaleTo={0.94} accessibilityRole="button" accessibilityLabel="更换头像" onPress={() => setAvatarMenu(true)}>
            <CharacterAvatar character={{ icon: draft.icon, color: draft.color, name: draft.name || '？', avatarUri: draft.avatarUri }} size={96} ring />
            <View style={styles.cameraBadge}><Icon name="camera" size={15} color="#FFFFFF" /></View>
          </MotionPressable>
          <Text style={styles.avatarHint}>点头像更换</Text>
          <TextInput value={draft.name} onChangeText={(name) => set({ name })} placeholder="给 TA 起个名字" placeholderTextColor={warm.faint} maxLength={20} style={styles.name} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.colors}>
            {CHARACTER_COLORS.map((color) => <Pressable key={color} accessibilityRole="radio" accessibilityState={{ selected: draft.color === color }} accessibilityLabel="主题色"
              hitSlop={6} onPress={() => set({ color })} style={[styles.swatch, { backgroundColor: color }, draft.color === color && [styles.swatchOn, { borderColor: color }]]}>
              {draft.color === color ? <Icon name="check" size={14} color="#FFFFFF" strokeWidth={2.4} /> : null}
            </Pressable>)}
          </ScrollView>
        </View>

        <Field label="性格与背景" value={draft.persona} onChange={(persona) => set({ persona })} lines={4} placeholder="TA 是谁、多大、在做什么、喜欢什么、是什么性格" />
        <Field label="说话方式" value={draft.style} onChange={(style) => set({ style })} lines={3} placeholder="语气、口头禅、会不会开玩笑、爱不爱用表情" />
        <Field label="你们的关系" value={draft.relationship} onChange={(relationship) => set({ relationship })} lines={1} placeholder="如：认识多年的好朋友" />
        <Field label="开场白" value={draft.greeting} onChange={(greeting) => set({ greeting })} lines={2} placeholder="第一次聊天时 TA 说的第一句话" />

        {existing ? <>
          <SectionLabel>核心记忆</SectionLabel>
          <TextInput value={core} onChangeText={setCore} multiline textAlignVertical="top" maxLength={1500} placeholder="TA 永远记得的最重要的事（聊天中也会自动更新）"
            placeholderTextColor={warm.faint} style={[styles.input, { minHeight: 120 }]} />
        </> : null}

        <SectionLabel>记忆</SectionLabel>
        <Group style={styles.group}>
          {MEMORY_MODES.map((mode, index) => <RadioRow key={mode.id} first={index === 0} title={mode.title} detail={mode.detail} selected={draft.memoryMode === mode.id} onPress={() => set({ memoryMode: mode.id })} />)}
        </Group>

        <SectionLabel>能力</SectionLabel>
        <Group style={styles.group}>
          <ToggleRow first icon="palette" title="会画画" detail="聊着聊着可以让 TA 画一张图" value={draft.canDraw} onChange={(canDraw) => set({ canDraw })} />
          <ToggleRow icon="globe" title="会查资料" detail="聊到新闻、天气、时事时可以上网看看" value={draft.canSearch} onChange={(canSearch) => set({ canSearch })} />
        </Group>

        <Text style={styles.modelNote}>对话模型和助手通用，在“设置 → 模型”里切换。</Text>

        {existing ? <View style={styles.danger}>
          <Pressable accessibilityRole="button" onPress={() => setConfirm('clear')} style={styles.dangerRow}><Icon name="memory" size={18} color={colors.danger} /><Text style={styles.dangerText}>清空记忆匣</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => setConfirm('delete')} style={styles.dangerRow}><Icon name="trash" size={18} color={colors.danger} /><Text style={styles.dangerText}>删除 {existing.name} 和全部聊天</Text></Pressable>
        </View> : null}
      </>}
    </View>
    <Sheet visible={avatarMenu} title="更换头像" onClose={() => setAvatarMenu(false)} background={warm.background}>
      <View style={styles.menuBody}>
        <View style={styles.menuRow}>
          <MenuTile icon="image" label="从相册选择" onPress={() => void choosePicture('library')} />
          <MenuTile icon="camera" label="拍一张" onPress={() => void choosePicture('camera')} />
          {draft?.avatarUri ? <MenuTile icon="trash" label="移除图片" onPress={() => { setAvatarMenu(false); set({ avatarUri: null }); }} /> : null}
        </View>
        <SectionLabel>或者用一个表情</SectionLabel>
        <View style={styles.emojiGrid}>
          {EMOJIS.map((emoji) => <MotionPressable key={emoji} scaleTo={0.85} accessibilityRole="button" accessibilityLabel={`头像 ${emoji}`}
            onPress={() => { setAvatarMenu(false); set({ icon: emoji, avatarUri: null }); }}
            style={[styles.emoji, draft?.icon === emoji && !draft?.avatarUri && { borderColor: draft.color, backgroundColor: `${draft.color}1A` }]}>
            <Text style={styles.emojiText}>{emoji}</Text>
          </MotionPressable>)}
        </View>
        <TextInput value={draft?.icon ?? ''} onChangeText={(icon) => set({ icon, avatarUri: null })} placeholder="也可以输入任意表情或一个字" placeholderTextColor={warm.faint} maxLength={8} style={[styles.input, { marginTop: 12, textAlign: 'center' }]} />
      </View>
    </Sheet>
    <AppDialog visible={confirm === 'clear'} title="清空记忆匣？" message="TA 会忘记记住的所有事和往事摘要，聊天记录本身会保留。无法恢复。" icon="trash" onClose={() => setConfirm(null)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setConfirm(null) },
      { label: '清空', tone: 'danger', onPress: () => {
        setConfirm(null);
        if (existing) void clearBox(existing.id).then(() => updateCharacter(existing.id, { coreMemory: '', notesSinceReflection: 0 }))
          .then(() => { initialCore.current = ''; setCore(''); showToast('记忆匣已清空'); });
      } },
    ]} />
    <AppDialog visible={confirm === 'delete'} title={`删除 ${existing?.name ?? ''}？`} message="聊天记录、图片和记忆匣都会从这台手机上删除，无法恢复。" icon="trash" onClose={() => setConfirm(null)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setConfirm(null) },
      { label: '删除', tone: 'danger', onPress: () => { setConfirm(null); const id = existing?.id; cleanupPicked(null); onClose(); if (id) void app.deleteCharacter(id).catch((error) => showToast(error instanceof Error ? error.message : '删除失败', 'alert')); } },
    ]} />
  </Sheet>;
}

function MenuTile({ icon, label, onPress }: { icon: 'image' | 'camera' | 'trash'; label: string; onPress: () => void }) {
  return <MotionPressable scaleTo={0.94} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} wrapperStyle={{ flex: 1 }} style={styles.menuTile}>
    <View style={[styles.menuIcon, icon === 'trash' && { backgroundColor: colors.dangerSurface }]}><Icon name={icon} size={22} color={icon === 'trash' ? colors.danger : warm.accent} /></View>
    <Text style={styles.menuLabel}>{label}</Text>
  </MotionPressable>;
}

function Field({ label, value, onChange, lines, placeholder }: { label: string; value: string; onChange: (value: string) => void; lines: number; placeholder: string }) {
  return <View>
    <SectionLabel>{label}</SectionLabel>
    <TextInput value={value} onChangeText={onChange} multiline={lines > 1} textAlignVertical={lines > 1 ? 'top' : 'center'} placeholder={placeholder} placeholderTextColor={warm.faint}
      style={[styles.input, lines > 1 && { minHeight: 24 * lines + 22 }]} />
  </View>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  lead: { color: warm.muted, fontSize: 14.5, lineHeight: 22, marginTop: 8, marginBottom: 16, marginHorizontal: 4 },
  templates: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  templateWrap: { width: '48%', flexGrow: 1 },
  template: { padding: 16, borderRadius: 22, backgroundColor: warm.card, borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border, gap: 4 },
  templateName: { color: warm.text, fontSize: 16, fontWeight: '700', marginTop: 8 },
  templateLine: { color: warm.muted, fontSize: 13 },
  identity: { alignItems: 'center', gap: 10, marginTop: 16 },
  cameraBadge: { position: 'absolute', right: 0, bottom: 2, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: warm.accent, borderWidth: 2.5, borderColor: warm.background },
  avatarHint: { color: warm.muted, fontSize: 12 },
  name: { alignSelf: 'stretch', height: 50, borderRadius: 16, paddingHorizontal: 14, backgroundColor: warm.card, color: warm.text, fontSize: 18, fontWeight: '700', textAlign: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border },
  colors: { gap: 10, alignItems: 'center', paddingHorizontal: 4, paddingVertical: 4 },
  swatch: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  swatchOn: { transform: [{ scale: 1.12 }], borderWidth: 3, shadowOpacity: 0.3, shadowRadius: 6, elevation: 3 },
  menuBody: { paddingHorizontal: 18, paddingBottom: 12 },
  menuRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  menuTile: { alignItems: 'center', gap: 8, paddingVertical: 16, borderRadius: 20, backgroundColor: warm.card, borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border },
  menuIcon: { width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: warm.accentSoft },
  menuLabel: { color: warm.text, fontSize: 13.5, fontWeight: '600' },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emoji: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: warm.card, borderWidth: 1.5, borderColor: 'transparent' },
  emojiText: { fontSize: 24 },
  input: { minHeight: 46, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: warm.card, color: warm.text, fontSize: 15, lineHeight: 21, borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border },
  group: { backgroundColor: warm.card },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  danger: { marginTop: 28, gap: 4 },
  dangerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 6 },
  modelNote: { color: warm.muted, fontSize: 12.5, lineHeight: 18, marginTop: 18, marginHorizontal: 6 },
  dangerText: { color: colors.danger, fontSize: 15, fontWeight: '500' },
});
