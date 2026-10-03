import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, G, Line, Text as SvgText } from 'react-native-svg';

import { Icon } from '../components/Icon';
import { AppDialog, Chip, Sheet, showToast } from '../components/ui';
import { exportVault } from '../memorybox/export';
import { layoutGraph, type Point } from '../memorybox/layout';
import { reflectNow, usePipelineStatus } from '../memorybox/pipeline';
import { bm25, noteText, tokenize } from '../memorybox/search';
import { savePositions, useBox, useCharacters } from '../memorybox/store';
import { NOTE_TYPE_META, NOTE_TYPES, type MemNote, type NoteType } from '../memorybox/types';
import { NoteSheet } from './NoteSheet';
import { warm } from './theme';
import { themed } from '../theme';

type View3 = 'graph' | 'timeline' | 'list';
const MARGIN = 140;
/** Room kept free at the bottom of the graph for the type legend. */
const LEGEND_SPACE = 64;

function radiusOf(note: MemNote) { return 7 + note.importance * 1.3 + (note.type === 'episode' ? 3 : 0); }

/**
 * 记忆匣 canvas: every note of a character as a map (pan, pinch, tap), a
 * timeline and a searchable list. Opened from a reply, it highlights the
 * notes that reply drew on (记忆线路).
 */
export function MemoryCanvas({ visible, characterId, trail, onClose, onOpenConversation }: {
  visible: boolean; characterId: string | null; trail: string[] | null; onClose: () => void; onOpenConversation?: () => void;
}) {
  const styles = useStyles();
  const box = useBox(visible ? characterId : null);
  const character = useCharacters().find((item) => item.id === characterId) ?? null;
  const status = usePipelineStatus(characterId);
  const [view, setView] = useState<View3>('graph');
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const trailSet = useMemo(() => new Set(trail ?? []), [trail]);
  useEffect(() => { if (visible) { setView('graph'); setSelected(null); } }, [visible, characterId]);

  const notes = box.notes;
  const selectedNote = notes.find((note) => note.id === selected) ?? null;
  const live = notes.filter((note) => note.validTo === null && note.type !== 'episode').length;
  const episodes = notes.filter((note) => note.type === 'episode').length;

  const run = async (task: () => Promise<void>, done: string) => {
    setMenu(false);
    setBusy(true);
    try { await task(); showToast(done); } catch (error) { showToast(error instanceof Error ? error.message : '没有完成', 'alert'); } finally { setBusy(false); }
  };

  return <Sheet visible={visible} title={character ? `${character.name} 的记忆匣` : '记忆匣'}
    subtitle={status.state === 'working' ? status.detail : status.state === 'error' ? `整理失败：${status.detail ?? ''}` : `${live} 条记忆 · ${episodes} 段往事 · ${box.links.length} 条连线`}
    onClose={onClose} presentation="page" scroll={false} background={warm.background}
    headerRight={<Pressable accessibilityRole="button" accessibilityLabel="更多" hitSlop={8} onPress={() => setMenu(true)} style={styles.headerButton}><Icon name="more" size={20} color={warm.text} /></Pressable>}>
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.tabs}>
        {([['graph', '图谱'], ['timeline', '时间线'], ['list', '列表']] as const).map(([id, label]) => <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: view === id }}
          onPress={() => setView(id)} style={[styles.tab, view === id && styles.tabOn]}>
          <Text style={[styles.tabText, view === id && styles.tabTextOn]}>{label}</Text>
        </Pressable>)}
      </View>
      {notes.length === 0 ? <View style={styles.empty}>
        <Icon name="bookmark" size={30} color={warm.faint} />
        <Text style={styles.emptyTitle}>记忆匣还是空的</Text>
        <Text style={styles.emptyText}>多聊一会儿，TA 会把值得记住的事整理成卡片，并用线把它们串起来。</Text>
      </View>
        : view === 'graph' ? <Graph notes={notes} links={box.links} owner={characterId!} trail={trailSet} selected={selected} onSelect={setSelected} />
          : view === 'timeline' ? <Timeline notes={notes} trail={trailSet} onSelect={setSelected} />
            : <NoteList notes={notes} trail={trailSet} onSelect={setSelected} />}
      {trail?.length && view === 'graph' ? <View style={styles.trail}>
        <Text style={styles.trailTitle}>这次回答想起了</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.trailChips}>
          {trail.map((id) => notes.find((note) => note.id === id)).filter((note): note is MemNote => Boolean(note)).map((note) => <Pressable key={note.id} onPress={() => setSelected(note.id)} style={styles.trailChip}>
            <View style={[styles.dot, { backgroundColor: NOTE_TYPE_META[note.type].color }]} />
            <Text style={styles.trailChipText} numberOfLines={1}>{note.title}</Text>
          </Pressable>)}
        </ScrollView>
      </View> : null}
    </GestureHandlerRootView>
    <NoteSheet note={selectedNote} owner={characterId} notes={notes} links={box.links} onClose={() => setSelected(null)} onSelect={setSelected}
      onOpenConversation={onOpenConversation ? () => { setSelected(null); onClose(); onOpenConversation(); } : undefined} />
    <AppDialog visible={menu} title="记忆匣" icon="bookmark" onClose={() => setMenu(false)} actions={[
      { label: '整理感悟', tone: 'secondary', disabled: busy || !characterId, onPress: () => void run(() => reflectNow(characterId!), '整理完成') },
      { label: '导出到 Obsidian', tone: 'primary', disabled: busy || !character, onPress: () => void run(() => exportVault(character!), '已导出') },
    ]}>
      <Text style={styles.menuText}>“整理感悟”会让 TA 回顾最近的记忆，写下更高层的体会（会调用一次模型）。导出会生成一个 Obsidian 仓库压缩包，每条记忆一个 Markdown 文件，连线变成 [[双链]]。</Text>
    </AppDialog>
  </Sheet>;
}

// ——— Graph ———

function Graph({ notes, links, owner, trail, selected, onSelect }: {
  notes: MemNote[]; links: { source: string; target: string; relation: string }[]; owner: string; trail: Set<string>; selected: string | null; onSelect: (id: string) => void;
}) {
  const styles = useStyles();
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [allLabels, setAllLabels] = useState(false);
  const shown = useMemo(() => {
    // Very large boxes: the most important notes plus everything on the current trail.
    if (notes.length <= 900) return notes;
    return [...notes].sort((a, b) => Number(trail.has(b.id)) - Number(trail.has(a.id)) || b.importance - a.importance).slice(0, 900);
  }, [notes, trail]);
  const idKey = shown.map((note) => note.id).join(',');
  const positions = useMemo(() => layoutGraph(shown, links as never, shown.some((note) => note.x === null) ? 80 : 20), [idKey, links.length]);
  // Keep newly computed positions so the map stays stable next time.
  const savedKey = useRef('');
  useEffect(() => {
    if (savedKey.current === idKey) return;
    savedKey.current = idKey;
    const changed = new Map<string, Point>();
    for (const note of shown) { const point = positions.get(note.id); if (point && (note.x === null || Math.abs((note.x ?? 0) - point.x) > 2 || Math.abs((note.y ?? 0) - point.y) > 2)) changed.set(note.id, point); }
    void savePositions(owner, changed).catch(() => undefined);
  }, [idKey, positions, owner, shown]);

  const bounds = useMemo(() => {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const point of positions.values()) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 400, height: 400 };
    return { minX: minX - MARGIN, minY: minY - MARGIN, width: maxX - minX + MARGIN * 2, height: maxY - minY + MARGIN * 2 };
  }, [positions]);
  const local = (id: string) => { const point = positions.get(id); return point ? { x: point.x - bounds.minX, y: point.y - bounds.minY } : null; };

  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const saved = useSharedValue({ scale: 1, tx: 0, ty: 0 });
  const center = { x: bounds.width / 2, y: bounds.height / 2 };
  const cx = useSharedValue(center.x);
  const cy = useSharedValue(center.y);
  useEffect(() => { cx.value = center.x; cy.value = center.y; }, [center.x, center.y, cx, cy]);

  // Frame a set of notes (all of them by default), leaving room for labels, the controls and the legend.
  const frame = (ids?: Iterable<string>, maxZoom = 1.1) => {
    if (!stage.width) return;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const id of ids ?? positions.keys()) {
      const point = local(id);
      if (!point) continue;
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    if (!Number.isFinite(minX)) return;
    const viewWidth = stage.width - 72;
    const viewHeight = stage.height - LEGEND_SPACE;
    const zoom = Math.max(0.12, Math.min(maxZoom, viewWidth / (maxX - minX + 140), viewHeight / (maxY - minY + 110)));
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    scale.value = withTiming(zoom, { duration: 340 });
    tx.value = withTiming((stage.width - 72) / 2 + 8 - center.x - (midX - center.x) * zoom, { duration: 340 });
    ty.value = withTiming(viewHeight / 2 - center.y - (midY - center.y) * zoom, { duration: 340 });
  };
  const fit = () => frame();
  const focus = (id: string, zoom = 1.1) => {
    const point = local(id);
    if (!point || !stage.width) return;
    scale.value = withTiming(zoom, { duration: 380 });
    tx.value = withTiming(stage.width / 2 - center.x - (point.x - center.x) * zoom, { duration: 380 });
    ty.value = withTiming((stage.height - LEGEND_SPACE) / 2 - center.y - (point.y - center.y) * zoom, { duration: 380 });
  };
  useEffect(() => {
    if (!stage.width) return;
    const onTrail = [...trail].filter((id) => positions.has(id));
    if (onTrail.length) frame(onTrail, 1); else fit();
  }, [stage.width, stage.height, bounds.width, bounds.height]);
  useEffect(() => { if (selected && positions.has(selected)) focus(selected, Math.max(scale.value, 1)); }, [selected]);

  const pan = Gesture.Pan().averageTouches(true)
    .onStart(() => { saved.value = { scale: scale.value, tx: tx.value, ty: ty.value }; })
    .onUpdate((event) => { tx.value = saved.value.tx + event.translationX; ty.value = saved.value.ty + event.translationY; });
  const pinch = Gesture.Pinch()
    .onStart(() => { saved.value = { scale: scale.value, tx: tx.value, ty: ty.value }; })
    .onUpdate((event) => {
      const next = Math.max(0.08, Math.min(3.5, saved.value.scale * event.scale));
      // Keep the point under the fingers still.
      const px = (event.focalX - saved.value.tx - cx.value) / saved.value.scale + cx.value;
      const py = (event.focalY - saved.value.ty - cy.value) / saved.value.scale + cy.value;
      scale.value = next;
      tx.value = event.focalX - cx.value - (px - cx.value) * next;
      ty.value = event.focalY - cy.value - (py - cy.value) * next;
    });
  const hitTest = (x: number, y: number) => {
    const s = scale.value;
    const wx = (x - tx.value - center.x) / s + center.x;
    const wy = (y - ty.value - center.y) / s + center.y;
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const note of shown) {
      const point = local(note.id);
      if (!point) continue;
      const distance = Math.hypot(point.x - wx, point.y - wy);
      const reach = radiusOf(note) + 14 / s;
      if (distance < reach && distance < bestDistance) { best = note.id; bestDistance = distance; }
    }
    if (best) onSelect(best);
  };
  const tap = Gesture.Tap().runOnJS(true).maxDuration(260).onEnd((event, success) => { if (success) hitTest(event.x, event.y); });
  const doubleTap = Gesture.Tap().numberOfTaps(2).runOnJS(true).onEnd(() => fit());
  const gesture = Gesture.Race(Gesture.Simultaneous(pan, pinch), Gesture.Exclusive(doubleTap, tap));
  const worldStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }] }));

  const lit = useMemo(() => new Set([...trail, ...(selected ? [selected] : [])]), [trail, selected]);
  const byId = useMemo(() => new Map(shown.map((note) => [note.id, note])), [shown]);
  const showLabel = (note: MemNote) => allLabels || shown.length <= 60 || note.importance >= 6 || note.pinned || lit.has(note.id) || note.type === 'insight';

  return <View style={styles.stage} onLayout={(event) => setStage({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
    <GestureDetector gesture={gesture}>
      <Animated.View style={StyleSheet.absoluteFill} collapsable={false}>
        <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: bounds.width, height: bounds.height }, worldStyle]}>
          <Svg width={bounds.width} height={bounds.height}>
            <G>
              {links.map((link, index) => {
                const a = local(link.source); const b = local(link.target);
                if (!a || !b || !byId.has(link.source) || !byId.has(link.target)) return null;
                const hot = lit.has(link.source) && lit.has(link.target);
                const touching = lit.has(link.source) || lit.has(link.target);
                return <Line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={hot ? warm.accent : touching ? '#B8B4F4' : '#D8DDF0'} strokeWidth={hot ? 3 : 1.4}
                  strokeDasharray={link.relation === '取代' ? '5 4' : undefined} />;
              })}
            </G>
            <G>
              {shown.map((note) => {
                const point = local(note.id);
                if (!point) return null;
                const radius = radiusOf(note);
                const color = NOTE_TYPE_META[note.type].color;
                const on = lit.has(note.id);
                const faded = lit.size > 0 && !on;
                return <G key={note.id} opacity={note.validTo !== null ? 0.35 : faded ? 0.55 : 1}>
                  {on ? <Circle cx={point.x} cy={point.y} r={radius + 9} fill={warm.accent} opacity={0.18} /> : null}
                  {note.pinned ? <Circle cx={point.x} cy={point.y} r={radius + 4} fill="none" stroke={color} strokeWidth={1.5} /> : null}
                  <Circle cx={point.x} cy={point.y} r={radius} fill={note.type === 'episode' ? '#FFFFFF' : color} stroke={color} strokeWidth={note.type === 'episode' ? 2.5 : selected === note.id ? 3 : 0}
                    strokeDasharray={note.type === 'episode' ? '3 3' : undefined} />
                  {showLabel(note) ? <SvgText x={point.x} y={point.y + radius + 15} fontSize={12} fontWeight={on ? '700' : '500'} fill={warm.text} textAnchor="middle">
                    {note.title.length > 12 ? `${note.title.slice(0, 12)}…` : note.title}
                  </SvgText> : null}
                </G>;
              })}
            </G>
          </Svg>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
    <View style={styles.controls} pointerEvents="box-none">
      <Pressable accessibilityRole="button" accessibilityLabel="适合屏幕" onPress={fit} style={styles.control}><Icon name="scan" size={18} color={warm.text} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={allLabels ? '只显示重要标签' : '显示全部标签'} onPress={() => setAllLabels((value) => !value)} style={[styles.control, allLabels && { backgroundColor: warm.accentSoft }]}>
        <Icon name="edit" size={17} color={allLabels ? warm.accentDeep : warm.text} />
      </Pressable>
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.legendRow} contentContainerStyle={styles.legend} pointerEvents="box-none">
      {NOTE_TYPES.filter((type) => shown.some((note) => note.type === type)).map((type) => <View key={type} style={styles.legendItem}>
        <View style={[styles.dot, { backgroundColor: NOTE_TYPE_META[type].color }]} />
        <Text style={styles.legendText}>{NOTE_TYPE_META[type].label}</Text>
      </View>)}
    </ScrollView>
  </View>;
}

// ——— Timeline and list ———

function dayLabel(time: number) {
  const date = new Date(time);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return `${date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
}

function NoteCard({ note, lit, onPress }: { note: MemNote; lit: boolean; onPress: () => void }) {
  const styles = useStyles();
  const meta = NOTE_TYPE_META[note.type];
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.card, lit && styles.cardLit, pressed && { opacity: 0.85 }, note.validTo !== null && { opacity: 0.55 }]}>
    <View style={styles.cardHead}>
      <View style={[styles.typeChip, { backgroundColor: `${meta.color}1F` }]}><Text style={[styles.typeText, { color: meta.color }]}>{meta.label}</Text></View>
      {note.pinned ? <Icon name="bookmark" size={13} color={meta.color} /> : null}
      {note.validTo !== null ? <Text style={styles.outdated}>已过时</Text> : null}
      <Text style={styles.cardMeta}>重要度 {note.importance}</Text>
    </View>
    <Text style={styles.cardTitle} numberOfLines={2}>{note.title}</Text>
    {note.content ? <Text style={styles.cardContent} numberOfLines={note.type === 'episode' ? 4 : 3}>{note.content}</Text> : null}
  </Pressable>;
}

function Timeline({ notes, trail, onSelect }: { notes: MemNote[]; trail: Set<string>; onSelect: (id: string) => void }) {
  const styles = useStyles();
  const sections = useMemo(() => {
    const groups = new Map<string, MemNote[]>();
    const sorted = [...notes].filter((note) => !note.rolledUp).sort((a, b) => (b.rangeEnd ?? b.validFrom ?? b.createdAt) - (a.rangeEnd ?? a.validFrom ?? a.createdAt));
    for (const note of sorted) {
      const label = dayLabel(note.rangeEnd ?? note.validFrom ?? note.createdAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(note);
    }
    return [...groups.entries()].map(([title, data]) => ({ title, data }));
  }, [notes]);
  return <SectionList sections={sections} keyExtractor={(item) => item.id} contentContainerStyle={styles.listContent} stickySectionHeadersEnabled={false}
    renderSectionHeader={({ section }) => <Text style={styles.sectionTitle}>{section.title}</Text>}
    renderItem={({ item }) => <NoteCard note={item} lit={trail.has(item.id)} onPress={() => onSelect(item.id)} />} />;
}

function NoteList({ notes, trail, onSelect }: { notes: MemNote[]; trail: Set<string>; onSelect: (id: string) => void }) {
  const styles = useStyles();
  const [query, setQuery] = useState('');
  const [type, setType] = useState<NoteType | null>(null);
  const items = useMemo(() => {
    const base = notes.filter((note) => !type || note.type === type);
    if (!query.trim() || !tokenize(query).length) return [...base].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.updatedAt - a.updatedAt);
    const scores = bm25(query, base.map((note) => tokenize(noteText(note))));
    return base.map((note, index) => ({ note, score: scores[index] })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).map((item) => item.note);
  }, [notes, query, type]);
  return <View style={{ flex: 1 }}>
    <View style={styles.search}>
      <Icon name="search" size={16} color={warm.muted} />
      <TextInput value={query} onChangeText={setQuery} placeholder="搜索记忆" placeholderTextColor={warm.faint} style={styles.searchInput} accessibilityLabel="搜索记忆" />
    </View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters} style={{ flexGrow: 0 }}>
      <Chip label="全部" selected={!type} onPress={() => setType(null)} />
      {NOTE_TYPES.map((item) => <Chip key={item} label={NOTE_TYPE_META[item].label} selected={type === item} onPress={() => setType(type === item ? null : item)} />)}
    </ScrollView>
    <FlatList data={items} keyExtractor={(item) => item.id} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled"
      ListEmptyComponent={<Text style={styles.noResult}>没有找到</Text>}
      renderItem={({ item }) => <NoteCard note={item} lit={trail.has(item.id)} onPress={() => onSelect(item.id)} />} />
  </View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  root: { flex: 1 },
  headerButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', alignSelf: 'center', gap: 4, padding: 3, borderRadius: 18, backgroundColor: warm.surfaceStrong, marginVertical: 8 },
  tab: { paddingHorizontal: 18, height: 30, borderRadius: 15, justifyContent: 'center' },
  tabOn: { backgroundColor: warm.card },
  tabText: { color: warm.muted, fontSize: 13.5, fontWeight: '600' },
  tabTextOn: { color: warm.accentDeep },
  stage: { flex: 1, overflow: 'hidden' },
  controls: { position: 'absolute', right: 14, top: 10, gap: 8 },
  control: { width: 38, height: 38, borderRadius: 19, backgroundColor: warm.card, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border },
  legendRow: { position: 'absolute', left: 0, right: 0, bottom: 8, flexGrow: 0 },
  legend: { gap: 12, paddingHorizontal: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.glass, paddingHorizontal: 8, height: 24, borderRadius: 12 },
  legendText: { color: warm.textSecondary, fontSize: 11.5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  trail: { paddingTop: 10, paddingBottom: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: warm.border, backgroundColor: warm.card },
  trailTitle: { color: warm.muted, fontSize: 12.5, marginLeft: 16, marginBottom: 8 },
  trailChips: { gap: 8, paddingHorizontal: 16 },
  trailChip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: warm.accentSoft, maxWidth: 200 },
  trailChipText: { color: warm.accentDeep, fontSize: 13, fontWeight: '500', flexShrink: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 10 },
  emptyTitle: { color: warm.text, fontSize: 17, fontWeight: '600' },
  emptyText: { color: warm.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  listContent: { paddingHorizontal: 16, paddingBottom: 30, gap: 10 },
  sectionTitle: { color: warm.muted, fontSize: 13, fontWeight: '600', marginTop: 14, marginBottom: 2 },
  card: { padding: 14, borderRadius: 18, backgroundColor: warm.card, borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border, gap: 6 },
  cardLit: { borderColor: warm.accent, borderWidth: 1.5 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeChip: { paddingHorizontal: 8, height: 20, borderRadius: 10, justifyContent: 'center' },
  typeText: { fontSize: 11, fontWeight: '700' },
  outdated: { color: warm.muted, fontSize: 11 },
  cardMeta: { marginLeft: 'auto', color: warm.faint, fontSize: 11 },
  cardTitle: { color: warm.text, fontSize: 15.5, fontWeight: '600' },
  cardContent: { color: warm.textSecondary, fontSize: 13.5, lineHeight: 20 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, height: 42, borderRadius: 21, paddingHorizontal: 14, backgroundColor: warm.card, borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border },
  searchInput: { flex: 1, color: warm.text, fontSize: 15, padding: 0 },
  filters: { gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  noResult: { color: warm.muted, textAlign: 'center', marginTop: 40 },
  menuText: { color: warm.muted, fontSize: 13.5, lineHeight: 20 },
}));
