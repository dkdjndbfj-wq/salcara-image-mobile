import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { colors, radius } from '../theme';
import { Icon } from './Icon';
import { Appear, MotionPressable } from './MotionPressable';

export interface InspirationItem {
  title: string;
  prompt: string;
  /** Three colours for the card's abstract artwork. */
  palette: [string, string, string];
  draw: boolean;
}

/** A varied pool so the home screen feels fresh every time it opens. */
export const INSPIRATIONS: InspirationItem[] = [
  { title: '雨夜霓虹街头的猫', prompt: '画一只站在雨夜霓虹街头的小猫，地面有倒影，电影感光影', palette: ['#1F2466', '#E1489A', '#43C6F0'], draw: true },
  { title: '云端上的漂浮岛屿', prompt: '画一座漂浮在云海之上的小岛，岛上有瀑布和树屋，日出暖光，吉卜力风格', palette: ['#8FD3FF', '#FFE2B8', '#9B8CF7'], draw: true },
  { title: '复古邮票里的城市', prompt: '把杭州西湖画成一张复古邮票，细腻线条，米色纸张质感', palette: ['#F3D9A4', '#D96A4A', '#3E7C8C'], draw: true },
  { title: '极简风格的产品海报', prompt: '设计一张极简风格的耳机产品海报，大面积留白，柔和渐变背景', palette: ['#F5F6FF', '#A7B7FF', '#3D7BFA'], draw: true },
  { title: '水彩画里的秋日森林', prompt: '用水彩画一片秋日森林，金黄和橙红的树叶，小路通向远方', palette: ['#F6B35A', '#D9573B', '#6E9B5A'], draw: true },
  { title: '宇航员在花海散步', prompt: '画一位宇航员在一望无际的花海里散步，梦幻粉紫色天空', palette: ['#F4A6CE', '#A68BF7', '#FFE7F2'], draw: true },
  { title: '可爱的 3D 小龙头像', prompt: '做一个可爱的 3D 小龙头像，圆润造型，柔和灯光，干净背景', palette: ['#7EE0B5', '#3DB8A0', '#FFF3C4'], draw: true },
  { title: '赛博朋克风格的书房', prompt: '画一间赛博朋克风格的书房，窗外是夜晚的未来城市，蓝紫色灯光', palette: ['#241A4F', '#6A5CFF', '#FF5FA2'], draw: true },
  { title: '清晨海边的灯塔', prompt: '画清晨海边的一座白色灯塔，薄雾，柔和的蓝色和金色光线', palette: ['#BFE3FF', '#FFD9A0', '#4A7BD0'], draw: true },
  { title: '中国风山水长卷', prompt: '画一幅中国风山水长卷，远山云雾，一叶小舟，水墨淡彩', palette: ['#E9EEF0', '#7A8F99', '#C7A56B'], draw: true },
  { title: '给我讲个睡前故事', prompt: '给我讲一个温暖的睡前小故事，主角是一只怕黑的小刺猬', palette: ['#2E3A78', '#F7D774', '#8C9EFF'], draw: false },
  { title: '帮我规划一次旅行', prompt: '帮我规划一个 3 天的京都旅行，节奏轻松，要有好吃的', palette: ['#FFCFB8', '#F07A6A', '#7CC6FF'], draw: false },
  { title: '解释一个有趣的知识', prompt: '用通俗有趣的方式讲讲：为什么天空是蓝色的，而晚霞是红色的？', palette: ['#6FB6FF', '#FF9E7A', '#FFE3A3'], draw: false },
  { title: '写一段走心的祝福', prompt: '帮我给好朋友写一段生日祝福，真诚、不肉麻，大概 80 字', palette: ['#FFC2D9', '#FFE8C2', '#B9A2FF'], draw: false },
];

function shuffled(items: InspirationItem[], count: number, canDraw: boolean): InspirationItem[] {
  const pool = items.filter((item) => canDraw || !item.draw);
  const pick = [...pool].sort(() => Math.random() - 0.5);
  // Mostly drawing ideas when drawing is available, with a chat idea mixed in.
  if (canDraw) {
    const draws = pick.filter((item) => item.draw).slice(0, count - 1);
    const chat = pick.find((item) => !item.draw);
    return (chat ? [...draws, chat] : pick.slice(0, count)).sort(() => Math.random() - 0.5);
  }
  return pick.slice(0, count);
}

/** Abstract artwork generated from the palette: layered soft light, no two cards alike. */
function CardArt({ palette, width, height, seed, id }: { palette: [string, string, string]; width: number; height: number; seed: number; id: string }) {
  const [a, b, c] = palette;
  const x = 25 + ((seed * 37) % 50);
  const y = 30 + ((seed * 53) % 40);
  return <Svg width={width} height={height} viewBox="0 0 100 60" preserveAspectRatio="xMidYMid slice">
    <Defs>
      <LinearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={a} /><Stop offset="1" stopColor={b} /></LinearGradient>
      <RadialGradient id={`${id}r`} cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor={c} stopOpacity={0.95} /><Stop offset="1" stopColor={c} stopOpacity={0} /></RadialGradient>
      <RadialGradient id={`${id}w`} cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.55} /><Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} /></RadialGradient>
    </Defs>
    <Rect x="0" y="0" width="100" height="60" fill={`url(#${id}l)`} />
    <Circle cx={x} cy={y} r="34" fill={`url(#${id}r)`} />
    <Circle cx={100 - x * 0.6} cy={12} r="22" fill={`url(#${id}w)`} />
  </Svg>;
}

export function InspirationGrid({ canDraw, onPick }: { canDraw: boolean; onPick: (item: InspirationItem) => void }) {
  const { width } = useWindowDimensions();
  const [round, setRound] = useState(0);
  const items = useMemo(() => shuffled(INSPIRATIONS, 4, canDraw), [canDraw, round]);
  const cardWidth = Math.floor((Math.min(width, 520) - 20 * 2 - 12) / 2);
  const artHeight = Math.round(cardWidth * 0.56);
  return <View style={styles.wrap}>
    <View style={styles.header}>
      <Text style={styles.title}>来点灵感</Text>
      <MotionPressable accessibilityRole="button" accessibilityLabel="换一批灵感" scaleTo={0.9} hitSlop={8} onPress={() => setRound((value) => value + 1)} style={styles.shuffle}>
        <Icon name="regenerate" size={15} color={colors.textMuted} />
        <Text style={styles.shuffleText}>换一批</Text>
      </MotionPressable>
    </View>
    <View style={styles.grid}>
      {items.map((item, index) => <Appear key={`${round}-${item.title}`} delay={index * 55} distance={10} style={{ width: cardWidth }}>
        <MotionPressable accessibilityRole="button" accessibilityLabel={item.title} scaleTo={0.96} onPress={() => onPick(item)} style={styles.card}>
          <View style={[styles.art, { height: artHeight }]}>
            <CardArt palette={item.palette} width={cardWidth} height={artHeight} seed={index + round * 4 + item.title.length} id={`ins${round}x${index}`} />
            <View style={styles.kind}><Icon name={item.draw ? 'sparkles' : 'chat'} size={12} color="#FFFFFF" strokeWidth={2} /></View>
          </View>
          <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
        </MotionPressable>
      </Appear>)}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { marginTop: 28 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  shuffle: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: colors.surface },
  shuffleText: { color: colors.textMuted, fontSize: 12.5, fontWeight: '500' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: { borderRadius: 18, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: 'hidden' },
  art: { overflow: 'hidden' },
  kind: { position: 'absolute', right: 8, top: 8, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(14,19,37,0.28)' },
  cardTitle: { color: colors.text, fontSize: 13.5, lineHeight: 19, fontWeight: '500', paddingHorizontal: 11, paddingTop: 9, paddingBottom: 11 },
});
