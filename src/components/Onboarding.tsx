import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { ProviderProfile } from '../domain';
import { colors, prettyModel, radius, shadow } from '../theme';
import { BrandMark, GradientText } from './Brand';
import { Icon, type IconName } from './Icon';
import { Appear, MotionPressable, useReducedMotion } from './MotionPressable';
import { PrimaryButton, slopFor } from './ui';

/**
 * First-run guide: what Salcara is, its two spaces, “one function, one API”, Live — then a short
 * checklist that stays open while the user connects services, so they land in a working app.
 */

export interface OnboardingProps {
  chatProvider: ProviderProfile | null;
  imageProvider: ProviderProfile | null;
  voiceReady: boolean;
  onConnect: () => void;
  onVoice: () => void;
  onFinish: () => void;
}

const PAGES = 5;

export function Onboarding({ chatProvider, imageProvider, voiceReady, onConnect, onVoice, onFinish }: OnboardingProps) {
  const { width } = useWindowDimensions();
  const scroll = useRef<{ scrollTo: (options: { x: number; animated: boolean }) => void } | null>(null);
  const x = useRef(new Animated.Value(0)).current;
  const [page, setPage] = useState(0);
  const go = (next: number) => { scroll.current?.scrollTo({ x: next * width, animated: true }); setPage(next); };
  const onEnd = (event: { nativeEvent: { contentOffset: { x: number } } }) => setPage(Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width)));
  const connected = Boolean(chatProvider || imageProvider);
  const last = page === PAGES - 1;

  return <View style={styles.root}>
    <Backdrop x={x} width={width} />
    <View style={styles.top}>
      <Dots x={x} width={width} />
      {!last && <MotionPressable accessibilityRole="button" accessibilityLabel="跳过介绍" hitSlop={slopFor(32)} onPress={() => go(PAGES - 1)} style={styles.skip}>
        <Text style={styles.skipText} numberOfLines={1}>跳过</Text>
      </MotionPressable>}
    </View>
    <Animated.ScrollView ref={scroll as never} horizontal pagingEnabled showsHorizontalScrollIndicator={false} bounces={false}
      onMomentumScrollEnd={onEnd} scrollEventThrottle={16}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { x } } }], { useNativeDriver: true })}>
      <Page width={width} index={0} x={x}><Hello /></Page>
      <Page width={width} index={1} x={x}><Spaces /></Page>
      <Page width={width} index={2} x={x}><Apis active={page === 2} /></Page>
      <Page width={width} index={3} x={x}><Voice active={page === 3} /></Page>
      <Page width={width} index={4} x={x}>
        <Checklist chatProvider={chatProvider} imageProvider={imageProvider} voiceReady={voiceReady} onConnect={onConnect} onVoice={onVoice} />
      </Page>
    </Animated.ScrollView>
    <View style={styles.bottom}>
      {last
        ? <>
          <PrimaryButton label={connected ? '开始使用 Salcara' : '先连接一个 AI 服务'} icon={connected ? 'sparkles' : 'plus'} onPress={connected ? onFinish : onConnect} />
          <Text style={styles.bottomNote}>{connected ? '以上设置随时可以在“设置”里修改' : '需要一个对话或绘图服务的 API 密钥，支持 DeepSeek、通义千问、豆包、OpenAI、Claude、Gemini 等'}</Text>
        </>
        : <PrimaryButton label={page === 0 ? '了解一下' : '下一步'} onPress={() => go(page + 1)} />}
    </View>
  </View>;
}

// ——— frame ———

function Page({ width, index, x, children }: { width: number; index: number; x: Animated.Value; children: React.ReactNode }) {
  // Content drifts a little slower than the swipe, so pages feel layered.
  const range = [(index - 1) * width, index * width, (index + 1) * width];
  const translateX = x.interpolate({ inputRange: range, outputRange: [width * 0.28, 0, -width * 0.28], extrapolate: 'clamp' });
  const opacity = x.interpolate({ inputRange: range, outputRange: [0, 1, 0], extrapolate: 'clamp' });
  return <View style={{ width }}>
    <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
      <Animated.View style={{ flex: 1, opacity, transform: [{ translateX }] }}>{children}</Animated.View>
    </ScrollView>
  </View>;
}

function Dots({ x, width }: { x: Animated.Value; width: number }) {
  return <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {Array.from({ length: PAGES }, (_, index) => {
      const range = [(index - 1) * width, index * width, (index + 1) * width];
      return <Animated.View key={index} style={[styles.dot, {
        opacity: x.interpolate({ inputRange: range, outputRange: [0.35, 1, 0.35], extrapolate: 'clamp' }),
        transform: [{ scaleX: x.interpolate({ inputRange: range, outputRange: [1, 2.6, 1], extrapolate: 'clamp' }) }],
      }]} />;
    })}
  </View>;
}

/** Soft brand-colored light that slides with the pages. */
function Backdrop({ x, width }: { x: Animated.Value; width: number }) {
  const tint = ['#DCEBFF', '#E9E3FF', '#FFE6F2', '#E3F4FF', '#EEF1FF'];
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    {tint.map((color, index) => <Animated.View key={index} style={[styles.glow, {
      backgroundColor: color, left: width * 0.5 - 220 + (index % 2 ? 60 : -60),
      opacity: x.interpolate({ inputRange: [(index - 1) * width, index * width, (index + 1) * width], outputRange: [0, 0.9, 0], extrapolate: 'clamp' }),
    }]} />)}
    {SPARKS.map(([left, top, size], index) => <View key={index} style={[styles.spark, { left: `${left}%`, top: `${top}%`, width: size, height: size, borderRadius: size / 2 }]} />)}
  </View>;
}

/** A few fixed specks of light (percent position, size). */
const SPARKS: Array<[number, number, number]> = [[12, 14, 4], [84, 10, 3], [70, 28, 5], [20, 44, 3], [90, 52, 4], [8, 72, 5], [60, 80, 3], [34, 90, 4]];

function useLoop(duration: number, active = true) {
  const value = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!active || reduced) return undefined;
    const loop = Animated.loop(Animated.timing(value, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [active, duration, reduced, value]);
  return value;
}

function Title({ kicker, title, text }: { kicker: string; title: string; text: string }) {
  return <View style={styles.titleBlock}>
    <Text style={styles.kicker}>{kicker}</Text>
    <Text style={styles.title}>{title}</Text>
    <Text style={styles.text}>{text}</Text>
  </View>;
}

// ——— pages ———

function Hello() {
  const spin = useLoop(14000);
  const breathe = useLoop(3200);
  const orbit = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const scale = breathe.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.06, 1] });
  return <View style={styles.center}>
    <View style={styles.heroWrap}>
      <Animated.View style={[styles.halo, { transform: [{ scale }] }]} />
      <Animated.View style={[styles.orbit, { transform: [{ rotate: orbit }] }]}>
        <View style={[styles.planet, { top: -5, left: '50%', backgroundColor: colors.primary }]} />
        <View style={[styles.planet, { bottom: 18, left: 14, backgroundColor: colors.accent, width: 8, height: 8 }]} />
        <View style={[styles.planet, { bottom: 30, right: 6, backgroundColor: colors.pink, width: 6, height: 6 }]} />
      </Animated.View>
      <Appear distance={14} duration={520}><BrandMark size={112} /></Appear>
    </View>
    <Appear delay={160}><GradientText text="Salcara" fontSize={44} width={200} weight="700" /></Appear>
    <Appear delay={260}><Text style={styles.tagline}>对话、理解与创作，{'\n'}都在一句话之间。</Text></Appear>
    <Appear delay={380} style={styles.pills}>
      {['聊天', '看图读文件', '画图', '联网', '语音'].map((label) => <View key={label} style={styles.pill}><Text style={styles.pillText}>{label}</Text></View>)}
    </Appear>
  </View>;
}

function Spaces() {
  return <View>
    <Title kicker="两个空间" title="一个帮你做事，一个陪你聊天" text="顶部一键切换，两个空间互不打扰。" />
    <SpaceCard icon="bot" tone={colors.primary} name="助手空间" line="像 ChatGPT 一样能干活"
      chips={['联网搜索', '看图读文件', '一句话画图', '深度研究', '生成表格文件', Platform.OS === 'ios' ? '加日程提醒' : '设闹钟日程']} />
    <SpaceCard icon="heart" tone="#E0679F" name="聊天空间" line="创建你的专属角色，TA 会记得你"
      chips={['自定义角色和头像', '记忆匣', '聊多久都不断片', '专属 Live 语音', '拍一拍 · 表情']} />
  </View>;
}

function SpaceCard({ icon, tone, name, line, chips }: { icon: IconName; tone: string; name: string; line: string; chips: string[] }) {
  return <View style={styles.card}>
    <View style={styles.cardHead}>
      <View style={[styles.cardIcon, { backgroundColor: `${tone}1A` }]}><Icon name={icon} size={22} color={tone} /></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.cardName}>{name}</Text>
        <Text style={styles.cardLine}>{line}</Text>
      </View>
    </View>
    <View style={styles.chips}>{chips.map((chip) => <View key={chip} style={styles.chip}><Text style={styles.chipText}>{chip}</Text></View>)}</View>
  </View>;
}

const API_ROWS: Array<{ icon: IconName; label: string; vendors: string[] }> = [
  { icon: 'chat', label: '对话', vendors: ['DeepSeek', '通义千问', 'Claude', 'Kimi', 'GPT', 'Gemini', '豆包'] },
  { icon: 'image', label: '绘图', vendors: ['GPT Image', '豆包 Seedream', '通义万相', 'Flux'] },
  { icon: 'mic', label: '语音识别', vendors: ['阿里云百炼', '豆包语音', 'OpenAI', Platform.OS === 'ios' ? '硅基流动' : '本地模型'] },
  { icon: 'speaker', label: '语音合成', vendors: ['OpenAI', 'MiniMax', '豆包语音', 'ElevenLabs'] },
  { icon: 'waveform', label: '实时语音', vendors: ['GPT Realtime', 'Qwen Omni', 'Gemini Live', '阶跃星辰'] },
];

function Apis({ active }: { active: boolean }) {
  const [tick, setTick] = useState(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!active || reduced) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 1500);
    return () => clearInterval(timer);
  }, [active, reduced]);
  return <View>
    <Title kicker="用你自己的 API" title="一个功能，一个服务，自由组合" text="对话用 DeepSeek、画图用 GPT Image、语音用阿里云……每项都能单独选，市面上常见的服务基本都支持。" />
    <View style={styles.card}>
      {API_ROWS.map((row, index) => <View key={row.label} style={[styles.apiRow, index > 0 && styles.apiRowLine]}>
        <View style={styles.apiIcon}><Icon name={row.icon} size={18} color={colors.primary} /></View>
        <Text style={styles.apiLabel}>{row.label}</Text>
        <Swap text={row.vendors[(tick + index) % row.vendors.length]} />
      </View>)}
    </View>
    <View style={styles.facts}>
      <Fact icon="lock" text="密钥存放在手机的系统安全区，请求直接发给你选的服务商" />
      <Fact icon="history" text="对话没有长度限制，聊到一半也能随时换模型" />
    </View>
  </View>;
}

/** A vendor name that slides in when it changes. */
function Swap({ text }: { text: string }) {
  const progress = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    progress.setValue(0);
    Animated.timing(progress, { toValue: 1, duration: 360, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [progress, text]);
  return <Animated.View style={[styles.vendor, { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}>
    <Text style={styles.vendorText} numberOfLines={1}>{text}</Text>
  </Animated.View>;
}

function Fact({ icon, text }: { icon: IconName; text: string }) {
  return <View style={styles.fact}><Icon name={icon} size={16} color={colors.primary} /><Text style={styles.factText}>{text}</Text></View>;
}

function Voice({ active }: { active: boolean }) {
  const ring = useLoop(2400, active);
  return <View>
    <Title kicker="Live" title="开口就聊，像打电话一样" text="说话时可以随时打断；聊天空间里的每个角色，都有自己的 Live。" />
    <View style={styles.liveStage}>
      {[0, 0.33, 0.66].map((offset) => {
        const phase = Animated.modulo(Animated.add(ring, offset), 1);
        return <Animated.View key={offset} style={[styles.ring, {
          opacity: phase.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
          transform: [{ scale: phase.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.3] }) }],
        }]} />;
      })}
      <View style={styles.portrait}>
        <Image source={require('../../assets/live/stars.webp')} style={styles.portraitImage} resizeMode="cover" />
        <View style={styles.portraitMark}><BrandMark size={64} /></View>
      </View>
      <View style={styles.liveBadge}><Icon name="waveform" size={14} color="#FFFFFF" /><Text style={styles.liveBadgeText}>正在听…</Text></View>
    </View>
    <View style={styles.facts}>
      <Fact icon="bolt" text="实时语音：GPT Realtime、Qwen Omni、Gemini Live 等" />
      <Fact icon="cloudDown" text="也可以下载本地识别模型，说话内容只在手机上处理" />
    </View>
  </View>;
}

function Checklist({ chatProvider, imageProvider, voiceReady, onConnect, onVoice }: Pick<OnboardingProps, 'chatProvider' | 'imageProvider' | 'voiceReady' | 'onConnect' | 'onVoice'>) {
  const items = useMemo(() => [
    { icon: 'chat' as IconName, title: '连接对话服务', detail: chatProvider ? `已连接 · ${prettyModel(chatProvider.chatModel)}` : '必需 · 选一家填入 API 密钥即可', done: Boolean(chatProvider), action: onConnect, cta: chatProvider ? '管理' : '去连接' },
    { icon: 'image' as IconName, title: '添加绘图模型', detail: imageProvider ? `已连接 · ${prettyModel(imageProvider.model)}` : '可选 · 让 Salcara 能画图、改图', done: Boolean(imageProvider), action: onConnect, cta: imageProvider ? '管理' : '添加' },
    { icon: 'mic' as IconName, title: '设置语音', detail: voiceReady ? '已可用 · 语音输入和 Live' : '可选 · 语音输入、朗读和 Live', done: voiceReady, action: onVoice, cta: voiceReady ? '调整' : '设置' },
  ], [chatProvider, imageProvider, onConnect, onVoice, voiceReady]);
  const count = items.filter((item) => item.done).length;
  return <View>
    <Title kicker={`准备就绪 ${count}/3`} title="最后一步，连上你的 AI" text="先连接对话服务就能开始，其余的随时可以再加。" />
    <View style={styles.card}>
      {items.map((item, index) => <View key={item.title} style={[styles.step, index > 0 && styles.apiRowLine]}>
        <View style={[styles.stepIcon, item.done && styles.stepIconDone]}>
          <Icon name={item.done ? 'check' : item.icon} size={18} color={item.done ? '#FFFFFF' : colors.primary} strokeWidth={item.done ? 2.4 : 1.65} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.stepTitle}>{item.title}</Text>
          <Text style={styles.stepDetail} numberOfLines={2}>{item.detail}</Text>
        </View>
        <MotionPressable accessibilityRole="button" accessibilityLabel={`${item.cta}：${item.title}`} hitSlop={slopFor(34)} onPress={item.action}
          style={[styles.stepButton, !item.done && styles.stepButtonPrimary]}>
          <Text style={[styles.stepButtonText, !item.done && { color: colors.onPrimary }]}>{item.cta}</Text>
        </MotionPressable>
      </View>)}
    </View>
    <View style={styles.facts}>
      <Fact icon="info" text="不知道选哪家？DeepSeek、通义千问注册就送额度，价格也低" />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  glow: { position: 'absolute', top: 40, width: 440, height: 440, borderRadius: 220, opacity: 0.7 },
  top: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  dots: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary },
  spark: { position: 'absolute', backgroundColor: colors.glow, opacity: 0.9 },
  skip: { position: 'absolute', right: 16, top: 10, minWidth: 56, alignItems: 'center', height: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.7)' },
  skipText: { color: colors.textMuted, fontSize: 14, fontWeight: '500' },
  page: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 16 },
  center: { alignItems: 'center' },
  heroWrap: { width: 220, height: 220, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  halo: { position: 'absolute', width: 180, height: 180, borderRadius: 90, backgroundColor: colors.glow, opacity: 0.55 },
  orbit: { position: 'absolute', width: 210, height: 210, borderRadius: 105, borderWidth: 1, borderColor: 'rgba(61,123,250,0.18)' },
  planet: { position: 'absolute', width: 10, height: 10, borderRadius: 5 },
  tagline: { color: colors.textMuted, fontSize: 19, lineHeight: 29, textAlign: 'center', marginTop: 8, letterSpacing: -0.2 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 26 },
  pill: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.85)', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  pillText: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '500' },
  titleBlock: { marginBottom: 20 },
  kicker: { color: colors.primary, fontSize: 13, fontWeight: '700', letterSpacing: 0.6 },
  title: { color: colors.text, fontSize: 27, lineHeight: 35, fontWeight: '700', letterSpacing: -0.6, marginTop: 8 },
  text: { color: colors.textMuted, fontSize: 15.5, lineHeight: 23, marginTop: 8 },
  card: { backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 24, padding: 16, marginBottom: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, ...shadow.soft },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  cardName: { color: colors.text, fontSize: 17, fontWeight: '700' },
  cardLine: { color: colors.textMuted, fontSize: 13.5, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.surface },
  chipText: { color: colors.textSecondary, fontSize: 12.5 },
  apiRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  apiRowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  apiIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  apiLabel: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' },
  vendor: { minWidth: 104, alignItems: 'flex-end' },
  vendorText: { color: colors.primaryDeep, fontSize: 14, fontWeight: '600' },
  facts: { gap: 10, marginTop: 6 },
  fact: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 4 },
  factText: { flex: 1, color: colors.textMuted, fontSize: 13.5, lineHeight: 20 },
  liveStage: { height: 290, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  ring: { position: 'absolute', width: 190, height: 238, borderRadius: 40, borderWidth: 2, borderColor: colors.accent },
  portrait: { width: 190, height: 238, borderRadius: 32, overflow: 'hidden', backgroundColor: colors.primarySoft, borderWidth: 3, borderColor: '#FFFFFF', ...shadow.float },
  portraitImage: { width: '100%', height: '100%' },
  portraitMark: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  liveBadge: { position: 'absolute', bottom: 20, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 28, borderRadius: 14, backgroundColor: 'rgba(14,19,37,0.78)' },
  liveBadgeText: { color: '#FFFFFF', fontSize: 12.5, fontWeight: '600' },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  stepIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  stepIconDone: { backgroundColor: colors.success },
  stepTitle: { color: colors.text, fontSize: 15.5, fontWeight: '600' },
  stepDetail: { color: colors.textMuted, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  stepButton: { height: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: 'center', backgroundColor: colors.surface },
  stepButtonPrimary: { backgroundColor: colors.primary },
  stepButtonText: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '600' },
  bottom: { paddingHorizontal: 24, paddingBottom: 12, paddingTop: 8 },
  bottomNote: { color: colors.subtle, fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 10 },
});
