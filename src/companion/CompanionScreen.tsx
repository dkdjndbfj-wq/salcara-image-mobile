import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardSafeView } from '../components/KeyboardSafeView';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Composer } from '../components/Composer';
import { Icon } from '../components/Icon';
import { ImagePreview } from '../components/ImagePreview';
import { Appear, AppDialog, dismissKeyboardAndBlur, MotionPressable, PrimaryButton, Sheet, showToast, ToastHost, type DialogAction, type IconName } from '../components/ui';
import { VoiceSettingsSheet } from '../components/VoiceSettingsSheet';
import type { ChatMessage, ReferenceImage } from '../domain';
import { pickFromGallery, takePhoto } from '../image-inputs';
import { CHARACTER_TEMPLATES } from '../memorybox/characters';
import { forgetTurnsFrom, usePipelineStatus } from '../memorybox/pipeline';
import { useCharacters } from '../memorybox/store';
import type { Character } from '../memorybox/types';
import { useApp, useElapsedSeconds } from '../state/AppContext';
import { getSetting, listRecentMessages, setSetting } from '../storage/database';
import { deleteLocalFile, saveToGallery, shareImage } from '../storage/files';
import { useDictation } from '../voice/useDictation';
import { CharacterAvatar } from './CharacterAvatar';
import { CompanionLive } from './CompanionLive';
import { AmbientLight, EmojiRain, MessageMenu, type MenuAction } from './Fun';
import { isPoke, POKE_PREFIX, pokeText, rainFor, setReaction, useReactions } from './reactions';
import { CharacterSheet } from './CharacterSheet';
import { CompanionMessage, useTaps } from './CompanionMessage';
import { MemoryBoxSettingsSheet } from './MemoryBoxSettingsSheet';
import { SettingsCenter } from '../components/SettingsCenter';
import { MemoryCanvas } from './MemoryCanvas';
import { SpaceSwitch } from './SpaceSwitch';
import { warm } from './theme';
import { themed } from '../theme';

type Dialog = { title: string; message?: string; actions?: DialogAction[]; icon?: IconName };

/** The chat space: a list of characters, and each character's endless thread. */
export function CompanionScreen() {
  const styles = useStyles();
  const app = useApp();
  const characters = useCharacters();
  const character = characters.find((item) => item.id === app.activeCharacterId) ?? null;
  const [sheet, setSheet] = useState<{ id: string | null } | null>(null);
  const [boxSettings, setBoxSettings] = useState(false);
  const [settings, setSettings] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const report = useCallback((title: string, error: unknown) => setDialog({ title, message: error instanceof Error ? error.message : '请稍后再试', icon: 'alert' }), []);
  const open = useCallback((id: string) => { void app.openCharacter(id).catch((error) => report('打不开这个聊天', error)); }, [app, report]);
  // Android back: thread → character list → assistant space (sheets and dialogs handle back themselves).
  const { closeCharacter, switchSpace } = app;
  const inThread = Boolean(character);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (inThread) closeCharacter(); else switchSpace('assistant');
      return true;
    });
    return () => subscription.remove();
  }, [inThread, closeCharacter, switchSpace]);

  return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
    {character
      ? <Thread key={character.id} character={character} covered={Boolean(sheet || boxSettings || dialog || settings)} onEdit={() => setSheet({ id: character.id })} report={report} />
      : <CharacterList characters={characters} onOpen={open} onCreate={() => setSheet({ id: null })} onSettings={() => setBoxSettings(true)} onAppSettings={() => setSettings(true)} />}
    <CharacterSheet visible={Boolean(sheet)} characterId={sheet?.id ?? null} onClose={() => setSheet(null)} onCreated={(created) => open(created.id)} />
    <MemoryBoxSettingsSheet visible={boxSettings} onClose={() => setBoxSettings(false)} />
    <SettingsCenter visible={settings} onClose={() => setSettings(false)} />
    <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} icon={dialog?.icon} actions={dialog?.actions} onClose={() => setDialog(null)} />
    <ToastHost />
  </SafeAreaView>;
}

// ——— Character list ———

function relativeTime(time: number) {
  if (!time) return '';
  const date = new Date(time);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function CharacterList({ characters, onOpen, onCreate, onSettings, onAppSettings }: { characters: Character[]; onOpen: (id: string) => void; onCreate: () => void; onSettings: () => void; onAppSettings: () => void }) {
  const styles = useStyles();
  const app = useApp();
  const [previews, setPreviews] = useState<Record<string, string>>({});
  // Reload only when a thread actually changed, not on every character update (memory work touches them often).
  const threads = characters.map((item) => `${item.id}:${item.conversationId ?? ''}:${item.lastMessageAt}`).join('|');
  const threadsRef = React.useRef(characters);
  threadsRef.current = characters;
  useEffect(() => {
    let alive = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const item of threadsRef.current) {
        if (!item.conversationId) continue;
        const [last] = await listRecentMessages(item.conversationId, 1).catch(() => []);
        if (!last) continue;
        const text = last.role === 'user'
          ? (isPoke(last.prompt) ? last.prompt.slice(POKE_PREFIX.length) : `你：${last.prompt}`)
          : (last.text || (last.imageUri ? '[图片]' : ''));
        // Leave nothing (not '') so the card falls back to the relationship line.
        if (text) next[item.id] = text;
      }
      if (alive) setPreviews(next);
    })();
    return () => { alive = false; };
  }, [threads]);
  // A second tap while the first is still creating must not make a second character.
  const starting = React.useRef(false);
  const quickStart = async (index: number) => {
    if (starting.current) return;
    starting.current = true;
    try {
      const created = await app.createCharacter({ ...CHARACTER_TEMPLATES[index] });
      onOpen(created.id);
    } catch (error) { showToast(error instanceof Error ? error.message : '没有创建成功', 'alert'); } finally { starting.current = false; }
  };
  return <View style={{ flex: 1 }}>
    <View style={styles.listHeader}>
      <View pointerEvents="box-none" style={styles.headerCenter}><SpaceSwitch space="companion" onSwitch={app.switchSpace} /></View>
      <Pressable accessibilityRole="button" accessibilityLabel="设置" hitSlop={6} onPress={onAppSettings} style={styles.headerIcon}><Icon name="settings" size={21} color={warm.text} /></Pressable>
      <View style={{ flex: 1 }} />
      <Pressable accessibilityRole="button" accessibilityLabel="记忆匣设置" hitSlop={6} onPress={onSettings} style={styles.headerIcon}><Icon name="memory" size={21} color={warm.text} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="新的聊天伙伴" hitSlop={6} onPress={onCreate} style={styles.headerIcon}><Icon name="plus" size={22} color={warm.text} /></Pressable>
    </View>
    <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
      <Appear distance={10}><Text style={styles.bigTitle}>聊天</Text></Appear>
      <Appear delay={60} distance={10}><Text style={styles.subtitle}>和记得你的伙伴聊聊。每个角色都有自己的记忆匣，聊多久都不会忘。</Text></Appear>
      {!app.chatProvider ? <View style={styles.notice}>
        <Icon name="info" size={16} color={warm.accentDeep} />
        <Text style={styles.noticeText} onPress={onAppSettings}>先点右上角“设置 → API 管理”添加一个 API，就可以开始聊天了。</Text>
      </View> : null}
      {characters.map((item, index) => <Appear key={item.id} delay={100 + Math.min(index, 8) * 40} distance={8}>
        <MotionPressable scaleTo={0.98} accessibilityRole="button" accessibilityLabel={`和 ${item.name} 聊天`} onPress={() => onOpen(item.id)} style={styles.card}>
          <CharacterAvatar character={item} size={54} ring={index === 0} />
          <View style={{ flex: 1, gap: 3 }}>
            <View style={styles.cardTop}>
              <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.cardTime}>{relativeTime(item.lastMessageAt)}</Text>
            </View>
            <Text style={styles.cardPreview} numberOfLines={1}>{previews[item.id] ?? (item.relationship || item.greeting)}</Text>
          </View>
        </MotionPressable>
      </Appear>)}
      {!characters.length ? <>
        <Text style={styles.section}>选一个开始</Text>
        <View style={styles.templates}>
          {CHARACTER_TEMPLATES.map((template, index) => <MotionPressable key={template.name} scaleTo={0.97} wrapperStyle={styles.templateWrap} accessibilityRole="button" accessibilityLabel={`和 ${template.name} 聊天`}
            onPress={() => void quickStart(index)} style={styles.template}>
            <CharacterAvatar character={template} size={46} />
            <Text style={styles.templateName}>{template.name}</Text>
            <Text style={styles.templateLine}>{template.tagline}</Text>
          </MotionPressable>)}
        </View>
        <PrimaryButton label="自己创建一个" tone="secondary" icon="plus" onPress={onCreate} style={{ marginTop: 14 }} />
      </> : null}
    </ScrollView>
  </View>;
}

// ——— Thread ———

function timeLabel(message: ChatMessage, previous: ChatMessage | undefined): string | null {
  if (previous && message.createdAt - previous.createdAt < 10 * 60_000) return null;
  const date = new Date(message.createdAt);
  const now = new Date();
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === now.toDateString()) return clock;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;
  return `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

function Thread({ character, covered, onEdit, report }: { character: Character; covered: boolean; onEdit: () => void; report: (title: string, error: unknown) => void }) {
  const styles = useStyles();
  const app = useApp();
  const elapsedSeconds = useElapsedSeconds();
  const status = usePipelineStatus(character.id);
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<ReferenceImage[]>([]);
  const [attach, setAttach] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<{ trail: string[] | null } | null>(null);
  const [live, setLive] = useState(false);
  const [voice, setVoice] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** Editing a sent message: `stash` is the unsent draft it pushed aside. */
  const [editing, setEditing] = useState<{ message: ChatMessage; stash: { prompt: string; images: ReferenceImage[] } } | null>(null);
  const inputRef = React.useRef<TextInput>(null);
  // The unsent text survives a restart (photos don't: unsent files are swept on start).
  const draftKey = `draft.companion.${character.id}`;
  const draftLoaded = React.useRef(false);
  useEffect(() => {
    let alive = true;
    void getSetting(draftKey).then((saved) => { if (alive && saved) setPrompt((current) => current || saved); })
      .catch(() => undefined).finally(() => { if (alive) draftLoaded.current = true; });
    return () => { alive = false; };
  }, [draftKey]);
  useEffect(() => {
    if (editing || !draftLoaded.current) return;
    const timer = setTimeout(() => void setSetting(draftKey, prompt.trim() ? prompt : null).catch(() => undefined), 700);
    return () => clearTimeout(timer);
  }, [prompt, editing, draftKey]);
  const dictation = useDictation({ providers: app.providers, chatProvider: app.chatProvider, onText: setPrompt, onError: (error) => report('语音输入没有完成', error) });
  const data = useMemo(() => [...app.messages].reverse(), [app.messages]);
  const lastId = app.messages[app.messages.length - 1]?.id;
  const { retry, stop } = app;
  const messagesRef = React.useRef(app.messages);
  messagesRef.current = app.messages;
  const onRetry = useCallback((message: ChatMessage) => {
    // The regenerated reply keeps its old time, which memory may already have read past. What memory took
    // from the old reply is forgotten and the turn is read again from its question.
    const all = messagesRef.current;
    const question = all[all.findIndex((item) => item.id === message.id) - 1];
    const since = question?.createdAt ?? message.createdAt;
    void retry(message).catch((error) => report('没有重新回复', error))
      .finally(() => { void forgetTurnsFrom(character.id, message.conversationId, since).catch(() => undefined); });
  }, [retry, report, character.id]);
  const { deleteMessage: removeMessage } = app;
  const confirmDelete = useCallback((message: ChatMessage) => setDialog({
    title: message.role === 'user' ? '删除这条消息？' : '删除这条回复？',
    message: message.role === 'user' ? '这条消息和 TA 的回复会一起删除，记忆匣里由它们记下的内容也会一起忘掉。' : '记忆匣里由这条回复记下的内容也会一起忘掉。',
    icon: 'trash',
    actions: [
      { label: '取消', tone: 'secondary', onPress: () => setDialog(null) },
      { label: '删除', tone: 'danger', onPress: () => { setDialog(null); void removeMessage(message.id).then(() => showToast('已删除')).catch((error) => report('没有删除', error)); } },
    ],
  }), [removeMessage, report]);
  const promptRef = React.useRef({ prompt, images });
  promptRef.current = { prompt, images };
  const startEditing = useCallback((message: ChatMessage) => {
    if (appRef.current.busy) { showToast('等 TA 回复完再编辑', 'hourglass'); return; }
    setEditing((current) => current ?? { message, stash: promptRef.current });
    setPrompt(message.prompt);
    setImages(message.references ?? []);
    setTimeout(() => inputRef.current?.focus(), 80);
  }, []);
  const onTrail = useCallback((message: ChatMessage) => setCanvas({ trail: message.agent?.recalled?.map((item) => item.id) ?? null }), []);
  const reactions = useReactions(character.conversationId);
  const [menu, setMenu] = useState<{ message: ChatMessage; y: number } | null>(null);
  const [rain, setRain] = useState<{ id: number; emoji: string[] } | null>(null);
  const mountedAt = React.useRef(Date.now()).current;
  const lastPoke = React.useRef(0);
  const conversationId = character.conversationId;
  const onReact = useCallback((message: ChatMessage, emoji: string | null) => {
    if (!conversationId) return;
    void setReaction(conversationId, message.id, emoji).catch(() => showToast('没有保存这个回应', 'alert'));
  }, [conversationId]);
  const onLongPress = useCallback((message: ChatMessage, y: number) => { dismissKeyboardAndBlur(); setMenu({ message, y }); }, []);
  const menuActions = useMemo<MenuAction[]>(() => {
    if (!menu) return [];
    const { message } = menu;
    const body = message.role === 'user' ? message.prompt : (message.text ?? '');
    const copy: MenuAction = { icon: 'copy', label: '复制', onPress: () => { setMenu(null); void Clipboard.setStringAsync(body).then(() => showToast('已复制')); } };
    return message.role === 'user'
      ? [copy, { icon: 'edit', label: '编辑后重发', onPress: () => { setMenu(null); if (!editing) startEditing(message); } }, { icon: 'trash', label: '删除', onPress: () => { setMenu(null); confirmDelete(message); } }]
      : [copy, { icon: 'regenerate', label: '重新回复', onPress: () => { setMenu(null); onRetry(message); } }, { icon: 'trash', label: '删除', onPress: () => { setMenu(null); confirmDelete(message); } }];
  }, [menu, onRetry, editing, startEditing, confirmDelete]);
  const letItRain = useCallback((text: string | null | undefined) => {
    const emoji = rainFor(text);
    if (emoji) setRain({ id: Date.now(), emoji });
  }, []);
  // TA's reply can make it rain too, once it has finished.
  const lastMessage = app.messages[app.messages.length - 1];
  const rainedFor = React.useRef<string | null>(null);
  useEffect(() => {
    if (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.status !== 'complete' || lastMessage.createdAt < mountedAt) return;
    if (rainedFor.current === lastMessage.id) return;
    rainedFor.current = lastMessage.id;
    letItRain(lastMessage.text);
  }, [lastMessage, mountedAt, letItRain]);
  // Stable across renders (it is passed to every memoized message): changing values come from refs.
  const appRef = React.useRef(app);
  appRef.current = app;
  const nameRef = React.useRef(character.name);
  nameRef.current = character.name;
  const poke = useCallback(() => {
    const now = Date.now();
    const name = nameRef.current;
    if (appRef.current.busy || now - lastPoke.current < 4000) { showToast(`${name} 感觉到了～`, 'sparkle'); return; }
    lastPoke.current = now;
    void appRef.current.send({ text: pokeText(name) }).catch((error) => report('没有拍到', error));
  }, [report]);
  const headerTap = useTaps(poke, onEdit);

  const ownedByEdit = (uri: string | null | undefined) => Boolean(uri && editing?.message.references.some((item) => item.uri === uri));
  const send = () => {
    const text = prompt.trim();
    if (!text && !images.length) return;
    const sent = { text, images };
    letItRain(text);
    const edit = editing;
    if (edit) {
      setEditing(null);
      setPrompt(edit.stash.prompt); setImages(edit.stash.images);
      void app.editAndResend(edit.message.id, sent).catch((error) => {
        if (!promptRef.current.prompt) { setPrompt(text); setImages(sent.images); }
        report('没有发出去', error);
      });
      return;
    }
    setPrompt(''); setImages([]);
    void setSetting(draftKey, null).catch(() => undefined);
    void app.send(sent).catch((error) => { setPrompt(text); setImages(sent.images); report('没有发出去', error); });
  };
  const cancelEditing = () => {
    const edit = editing;
    if (!edit) return;
    images.forEach((item) => { if (!ownedByEdit(item.uri)) deleteLocalFile(item.uri); });
    setEditing(null);
    setPrompt(edit.stash.prompt); setImages(edit.stash.images);
  };
  const addImages = async (source: 'gallery' | 'camera') => {
    setAttach(false);
    try {
      const remaining = 4 - images.length;
      if (remaining <= 0) throw new Error('一次最多 4 张图片');
      const picked = source === 'gallery' ? await pickFromGallery(remaining) : await takePhoto();
      setImages((current) => [...current, ...picked].slice(0, 4));
    } catch (error) { report('没有添加图片', error); }
  };
  const openLive = () => {
    dismissKeyboardAndBlur();
    if (app.busy) { showToast('等 TA 说完再开始 Live', 'hourglass'); return; }
    if (!app.chatProvider) { report('Live 需要对话模型', new Error('请先在“设置 → API 管理”添加一个能对话的 API。')); return; }
    setLive(true);
  };
  const subtitle = status.state === 'working' ? '正在整理记忆…' : app.busy ? '正在输入…' : character.relationship || '在线';

  return <View style={{ flex: 1 }}>
    <View style={styles.threadHeader}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回聊天列表" hitSlop={8} onPress={() => { dismissKeyboardAndBlur(); app.closeCharacter(); }} style={styles.headerIcon}>
        <Icon name="chevronLeft" size={24} color={warm.text} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`${character.name} 的设定，双击拍一拍`} onPress={headerTap} style={styles.who}>
        <CharacterAvatar character={character} size={38} ring online={!app.busy} />
        <View style={{ flexShrink: 1 }}>
          <Text style={styles.whoName} numberOfLines={1}>{character.name}</Text>
          <Text style={styles.whoStatus} numberOfLines={1}>{subtitle}</Text>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="记忆匣" hitSlop={6} onPress={() => setCanvas({ trail: null })} style={styles.headerIcon}>
        <Icon name="memory" size={22} color={warm.text} />
      </Pressable>
      <MotionPressable scaleTo={0.9} accessibilityRole="button" accessibilityLabel="Live 语音聊天" onPress={openLive} style={styles.livePill}>
        <Icon name="waveform" size={16} color={warm.accentDeep} strokeWidth={2.1} />
        <Text style={styles.liveText}>Live</Text>
      </MotionPressable>
    </View>
    <KeyboardSafeView style={{ flex: 1 }}>
      <AmbientLight color={character.color} paused={Boolean(covered || canvas || live || voice || preview || attach || menu || dialog)} />
      <FlatList
        inverted
        data={data}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messages}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
        onEndReachedThreshold={0.4}
        onEndReached={() => { if (app.hasOlderMessages) void app.loadOlderMessages(); }}
        ListFooterComponent={app.hasOlderMessages ? <Text style={styles.older}>正在加载更早的聊天…</Text> : <Text style={styles.older}>这是你们聊天的开始</Text>}
        renderItem={({ item, index }) => <CompanionMessage message={item} character={character}
          phase={item.id === lastId ? app.phase : 'idle'} elapsedSeconds={item.id === lastId ? elapsedSeconds : 0} isLast={item.id === lastId}
          fresh={item.createdAt >= mountedAt} reaction={reactions.get(item.id)} onReact={onReact} onPoke={poke}
          timeLabel={timeLabel(item, data[index + 1])} onStop={stop} onRetry={onRetry} onPreview={setPreview} onLongPress={onLongPress} onOpenTrail={onTrail} />}
      />
      <Composer
        inputRef={inputRef}
        value={prompt}
        onChangeText={setPrompt}
        images={images}
        documents={[]}
        hasMask={false}
        busy={app.busy}
        onSend={send}
        onStop={stop}
        onOpenAttach={() => { dismissKeyboardAndBlur(); setAttach(true); }}
        editing={editing ? { onCancel: cancelEditing } : null}
        onRemoveImage={(id) => { const target = images.find((item) => item.id === id); if (!ownedByEdit(target?.uri)) deleteLocalFile(target?.uri); setImages((current) => current.filter((item) => item.id !== id)); }}
        onRemoveDocument={() => undefined}
        onEditMask={() => undefined}
        placeholder={dictation.state !== 'idle' ? '正在听…' : `给 ${character.name} 发消息`}
        dictation={{ state: dictation.state, level: dictation.level, startedAt: dictation.startedAt, onStart: () => { void dictation.start(prompt); }, onStop: () => { void dictation.stop(); }, onCancel: dictation.cancel }}
        onOpenLive={openLive}
        tone="warm"
      />
    </KeyboardSafeView>
    <Sheet visible={attach} onClose={() => setAttach(false)} background={warm.background}>
      <View style={styles.attachRow}>
        {([['camera', '相机', 'camera'], ['gallery', '照片', 'image']] as const).map(([source, label, icon]) => <MotionPressable key={source} wrapperStyle={{ flex: 1 }} scaleTo={0.94} accessibilityRole="button" accessibilityLabel={label}
          onPress={() => void addImages(source)} style={styles.attachTile}>
          <Icon name={icon} size={26} color={warm.text} />
          <Text style={styles.attachLabel}>{label}</Text>
        </MotionPressable>)}
      </View>
    </Sheet>
    <MemoryCanvas visible={Boolean(canvas)} characterId={character.id} trail={canvas?.trail ?? null} onClose={() => setCanvas(null)} />
    <CompanionLive visible={live} character={character} paused={voice} onClose={() => setLive(false)} onOpenSettings={() => setVoice(true)} />
    <VoiceSettingsSheet visible={voice} onClose={() => setVoice(false)} />
    <ImagePreview uri={preview} onClose={() => setPreview(null)}
      onSave={(uri) => void saveToGallery(uri).then(() => showToast('已保存到相册')).catch((error) => report('保存失败', error))}
      onShare={(uri) => void shareImage(uri).catch((error) => report('分享失败', error))} />
    <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} icon={dialog?.icon} actions={dialog?.actions} onClose={() => setDialog(null)} />
    <MessageMenu visible={Boolean(menu)} y={menu?.y ?? 0} current={menu ? reactions.get(menu.message.id) : undefined} actions={menuActions}
      onReact={(emoji) => { if (menu) onReact(menu.message, emoji); setMenu(null); }} onClose={() => setMenu(null)} />
    {rain ? <EmojiRain key={rain.id} emoji={rain.emoji} onDone={() => setRain(null)} /> : null}
  </View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: warm.background },
  listHeader: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 0 },
  headerCenter: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  headerIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  bigTitle: { color: warm.text, fontSize: 24, lineHeight: 31, fontWeight: '700', letterSpacing: -0.5, marginTop: 6, marginLeft: 4 },
  subtitle: { color: warm.muted, fontSize: 12.5, lineHeight: 18, marginLeft: 4, marginTop: 2, marginBottom: 10 },
  notice: { flexDirection: 'row', gap: 8, padding: 12, borderRadius: 16, backgroundColor: warm.accentSoft, alignItems: 'flex-start' },
  noticeText: { flex: 1, color: warm.textSecondary, fontSize: 13.5, lineHeight: 19 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 22, backgroundColor: warm.card, borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardName: { flex: 1, color: warm.text, fontSize: 16.5, fontWeight: '600' },
  cardTime: { color: warm.faint, fontSize: 12 },
  cardPreview: { color: warm.muted, fontSize: 14 },
  section: { color: warm.muted, fontSize: 13, fontWeight: '600', marginTop: 10, marginLeft: 4 },
  templates: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  templateWrap: { width: '48%', flexGrow: 1 },
  template: { padding: 16, borderRadius: 22, backgroundColor: warm.card, borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border, gap: 4 },
  templateName: { color: warm.text, fontSize: 16, fontWeight: '700', marginTop: 8 },
  templateLine: { color: warm.muted, fontSize: 13 },
  threadHeader: { height: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: warm.border },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  whoName: { color: warm.text, fontSize: 16.5, fontWeight: '600' },
  whoStatus: { color: warm.muted, fontSize: 12 },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: warm.accentSoft, marginRight: 4 },
  liveText: { color: warm.accentDeep, fontSize: 14, fontWeight: '700' },
  messages: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, gap: 16 },
  older: { alignSelf: 'center', color: warm.faint, fontSize: 12, paddingVertical: 14 },
  attachRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12 },
  attachTile: { height: 96, borderRadius: 22, backgroundColor: warm.card, alignItems: 'center', justifyContent: 'center', gap: 10 },
  attachLabel: { color: warm.text, fontSize: 14, fontWeight: '500' },
}));
