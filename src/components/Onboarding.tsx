import React, { useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import type { ProviderProfile } from '../domain';
import { openPromo, PROMO } from '../promo';
import { colors, prettyModel, themed, useScheme } from '../theme';
import { BrandMark, GradientText } from './Brand';
import { Icon, type IconName } from './Icon';
import { Appear, MotionPressable } from './MotionPressable';
import { PrimaryButton, slopFor } from './ui';

/**
 * First run, three calm pages: what Salcara is → its three spaces → connect an AI.
 * The last page stays open while the user connects services, and can be left
 * for later; nothing here is required to look around.
 */
export interface OnboardingProps {
  chatProvider: ProviderProfile | null;
  imageProvider: ProviderProfile | null;
  voiceReady: boolean;
  onConnect: () => void;
  onVoice: () => void;
  onFinish: () => void;
}

const PAGES = 3;

export function Onboarding({ chatProvider, imageProvider, voiceReady, onConnect, onVoice, onFinish }: OnboardingProps) {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const scroll = useRef<ScrollView | null>(null);
  const x = useRef(new Animated.Value(0)).current;
  const [page, setPage] = useState(0);
  const go = (next: number) => { scroll.current?.scrollTo({ x: next * width, animated: true }); setPage(next); };
  const last = page === PAGES - 1;
  const connected = Boolean(chatProvider || imageProvider);

  return <View style={styles.root}>
    <Glow />
    <View style={styles.header}>
      <View style={styles.dots} accessibilityLabel={`第 ${page + 1} 页，共 ${PAGES} 页`}>
        {Array.from({ length: PAGES }, (_, index) => {
          const range = [(index - 1) * width, index * width, (index + 1) * width];
          return <Animated.View key={index} style={[styles.dot, {
            opacity: x.interpolate({ inputRange: range, outputRange: [0.3, 1, 0.3], extrapolate: 'clamp' }),
            transform: [{ scaleX: x.interpolate({ inputRange: range, outputRange: [1, 2.4, 1], extrapolate: 'clamp' }) }],
          }]} />;
        })}
      </View>
      {!last ? <MotionPressable accessibilityRole="button" accessibilityLabel="跳过介绍" hitSlop={slopFor(30)} onPress={() => go(PAGES - 1)} style={styles.skip}>
        <Text style={styles.skipText}>跳过</Text>
      </MotionPressable> : null}
    </View>

    <Animated.ScrollView ref={scroll as never} horizontal pagingEnabled bounces={false} showsHorizontalScrollIndicator={false} scrollEventThrottle={16}
      onMomentumScrollEnd={(event) => setPage(Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width)))}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { x } } }], { useNativeDriver: true })}
      style={styles.pager}>
      <Page width={width} index={0} x={x}><Welcome width={width} /></Page>
      <Page width={width} index={1} x={x}><Spaces /></Page>
      <Page width={width} index={2} x={x}><Connect chatProvider={chatProvider} imageProvider={imageProvider} voiceReady={voiceReady} onConnect={onConnect} onVoice={onVoice} /></Page>
    </Animated.ScrollView>

    <View style={styles.bottom}>
      {last
        ? <>
          <PrimaryButton label={connected ? '开始使用' : '连接对话服务'} icon={connected ? 'sparkles' : 'plus'} onPress={connected ? onFinish : onConnect} />
          {!connected ? <Pressable accessibilityRole="button" accessibilityLabel="稍后再说" hitSlop={8} onPress={onFinish} style={styles.later}><Text style={styles.laterText}>稍后再说</Text></Pressable> : null}
        </>
        : <PrimaryButton label={page === 0 ? '开始' : '下一步'} onPress={() => go(page + 1)} />}
    </View>
  </View>;
}

function Page({ width, index, x, children }: { width: number; index: number; x: Animated.Value; children: React.ReactNode }) {
  const styles = useStyles();
  const range = [(index - 1) * width, index * width, (index + 1) * width];
  return <View style={{ width }}>
    <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
      <Animated.View style={{ flex: 1, opacity: x.interpolate({ inputRange: range, outputRange: [0, 1, 0], extrapolate: 'clamp' }),
        transform: [{ translateX: x.interpolate({ inputRange: range, outputRange: [width * 0.18, 0, -width * 0.18], extrapolate: 'clamp' }) }] }}>{children}</Animated.View>
    </ScrollView>
  </View>;
}

/** One soft light near the top; the rest of the page stays white. */
function Glow() {
  const dark = useScheme() === 'dark';
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <Svg width="100%" height="58%">
      <Defs><RadialGradient id="onboardGlow" cx="50%" cy="34%" rx="70%" ry="58%">
        <Stop offset="0" stopColor={dark ? '#2B3A6B' : '#DCE8FF'} stopOpacity={dark ? 0.55 : 0.9} /><Stop offset="0.55" stopColor={dark ? '#2E2858' : '#ECE6FF'} stopOpacity={dark ? 0.3 : 0.45} /><Stop offset="1" stopColor={dark ? '#0F1116' : '#FFFFFF'} stopOpacity="0" />
      </RadialGradient></Defs>
      <Rect width="100%" height="100%" fill="url(#onboardGlow)" />
    </Svg>
  </View>;
}

function Heading({ title, text }: { title: string; text: string }) {
  const styles = useStyles();
  return <View style={styles.heading}>
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    <Text style={styles.text}>{text}</Text>
  </View>;
}

function Welcome({ width }: { width: number }) {
  const styles = useStyles();
  const { height } = useWindowDimensions();
  return <View style={[styles.welcome, { minHeight: Math.max(320, height * 0.62) }]}>
    <Appear distance={8}><View style={styles.markHalo}><BrandMark size={64} /></View></Appear>
    <Appear delay={80} distance={8}><GradientText text="Salcara" fontSize={34} width={Math.min(142, width - 48)} weight="700" /></Appear>
    <Appear delay={140} distance={8}><Text style={styles.welcomeText}>助手、聊天、编程{'\n'}都在一个 App 里</Text></Appear>
  </View>;
}

const SPACES: Array<{ icon: IconName; name: string; detail: string; tint: string }> = [
  { icon: 'sparkles', name: '助手', detail: '搜索、读文件、画图、深度研究', tint: '#EEF3FF' },
  { icon: 'heart', name: '聊天', detail: '会记住你的角色，支持 Live 语音', tint: '#FDEFF5' },
  { icon: 'code', name: '编程', detail: '在手机上使用电脑里的 Codex 和 Claude', tint: '#F0EEFF' },
];

function Spaces() {
  const styles = useStyles();
  return <View>
    <Heading title="三个空间，一键切换" text="在顶部中间切换，每个空间都会停在你离开时的位置。" />
    <View style={styles.switchMock} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {SPACES.map((space, index) => <View key={space.name} style={[styles.switchItem, index === 0 && styles.switchItemOn]}><Text style={[styles.switchText, index === 0 && styles.switchTextOn]}>{space.name}</Text></View>)}
    </View>
    <View style={styles.card}>
      {SPACES.map((space, index) => <Appear key={space.name} delay={80 + index * 60} distance={6}>
        <View style={[styles.row, index > 0 && styles.divider]}>
          <View style={[styles.glyph, { backgroundColor: space.tint }]}><Icon name={space.icon} size={17} color={colors.primaryDeep} /></View>
          <View style={styles.body}><Text style={styles.name}>{space.name}</Text><Text style={styles.detail}>{space.detail}</Text></View>
        </View>
      </Appear>)}
    </View>
  </View>;
}

function Connect({ chatProvider, imageProvider, voiceReady, onConnect, onVoice }: Omit<OnboardingProps, 'onFinish'>) {
  const styles = useStyles();
  const items = [
    { icon: 'chat' as IconName, title: '对话服务', detail: chatProvider ? `已连接 · ${prettyModel(chatProvider.chatModel)}` : '必需 · 填入一个 API 密钥', done: Boolean(chatProvider), action: onConnect },
    { icon: 'image' as IconName, title: '绘图', detail: imageProvider ? `已连接 · ${prettyModel(imageProvider.model)}` : '可选 · 让助手能画图、改图', done: Boolean(imageProvider), action: onConnect },
    { icon: 'mic' as IconName, title: '语音', detail: voiceReady ? '已可用' : '可选 · 语音输入、朗读和 Live', done: voiceReady, action: onVoice },
  ];
  return <View>
    <Heading title="连上你的 AI" text="先连接对话服务就能开始，其余的以后在设置里随时添加。" />
    <View style={styles.card}>
      {items.map((item, index) => <Pressable key={item.title} accessibilityRole="button" accessibilityLabel={`${item.done ? '管理' : '设置'}：${item.title}`} onPress={item.action}
        style={({ pressed }) => [styles.row, index > 0 && styles.divider, pressed && { backgroundColor: colors.surface }]}>
        <View style={[styles.glyph, item.done && styles.glyphDone]}><Icon name={item.done ? 'check' : item.icon} size={16} color={item.done ? '#FFFFFF' : colors.primaryDeep} /></View>
        <View style={styles.body}><Text style={styles.name}>{item.title}</Text><Text style={styles.detail} numberOfLines={1}>{item.detail}</Text></View>
        <Icon name="chevronRight" size={15} color={colors.faint}/>
      </Pressable>)}
    </View>
    {PROMO.enabled && !chatProvider ? <Pressable accessibilityRole="link" accessibilityLabel={`没有 API 密钥？${PROMO.name}`} onPress={() => void openPromo('onboarding')} style={styles.promo}>
      <Text style={styles.promoText}>没有 API 密钥？<Text style={styles.promoLink}>试试 {PROMO.name} ›</Text></Text>
    </Pressable> : null}
    <View style={styles.tip}><Icon name="laptop" size={14} color={colors.textMuted} /><Text style={styles.tipText}>想在手机上用电脑写代码？之后到「编程」里扫码绑定电脑即可。</Text></View>
  </View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.card },
  header: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, zIndex: 2 },
  dots: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  dot: { width: 6, height: 4, borderRadius: 2, backgroundColor: c.primaryDeep },
  skip: { height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: 'center', backgroundColor: c.glass },
  skipText: { color: c.textMuted, fontSize: 13, fontWeight: '500' },
  pager: { flex: 1 },
  page: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 16 },
  bottom: { paddingHorizontal: 22, paddingBottom: 14, paddingTop: 6, gap: 6 },
  later: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 16 }, laterText: { color: c.textMuted, fontSize: 13 },
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingBottom: 40 },
  markHalo: { width: 104, height: 104, borderRadius: 52, alignItems: 'center', justifyContent: 'center', backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  welcomeText: { color: c.textMuted, fontSize: 15, lineHeight: 23, textAlign: 'center' },
  heading: { marginTop: 18, marginBottom: 20 },
  title: { color: c.text, fontSize: 24, lineHeight: 31, fontWeight: '700', letterSpacing: -0.5 },
  text: { color: c.textMuted, fontSize: 13.5, lineHeight: 20, marginTop: 6 },
  switchMock: { alignSelf: 'center', flexDirection: 'row', padding: 2, borderRadius: 17, backgroundColor: c.blueSurface, marginBottom: 16 },
  switchItem: { width: 46, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  switchItemOn: { backgroundColor: c.card },
  switchText: { fontSize: 13, fontWeight: '600', color: colors.subtle }, switchTextOn: { color: colors.primaryDeep },
  card: { backgroundColor: c.card, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 14, paddingVertical: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  glyph: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: c.blueSurface },
  glyphDone: { backgroundColor: colors.success },
  body: { flex: 1, minWidth: 0, gap: 2 }, name: { color: c.text, fontSize: 14.5, fontWeight: '600' }, detail: { color: c.textMuted, fontSize: 12, lineHeight: 17 },
  promo: { marginTop: 14, paddingVertical: 6 }, promoText: { color: c.textMuted, fontSize: 12.5 }, promoLink: { color: c.primaryDeep, fontWeight: '500' },
  tip: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 14, paddingHorizontal: 2 }, tipText: { flex: 1, color: c.textMuted, fontSize: 12, lineHeight: 18 },
}));
