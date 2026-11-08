import * as Clipboard from 'expo-clipboard';
import React, { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Source } from '../agent/types';
import { colors, radius, themed } from '../theme';
import { Icon } from './Icon';
import { InlineMath, RichMessageBlock } from './RichMessageBlock';
import { highlightCode, INLINE_MATH, type CodeTokenKind, inlineMathBody, splitDisplayMath } from './markdown-extras';
import { markdownTableCells } from './markdown-table';
import { WORKBENCH_SPACING, useWorkbenchTypography, workbenchTypography } from '../remote/workbench-presentation';
import { conversationCodeFontFamily, conversationFontFamily } from '../remote/conversation-typography';
import { MessageCodeViewport } from './MessageCodeViewport';

/**
 * A small native Markdown renderer: headings, lists, quotes, tables, code
 * blocks (lightly coloured), bold/italic/strikethrough/inline code, links and
 * locally rendered math and diagrams. No remote scripts or message HTML.
 */
type LinkActions = { onOpenLink?: (target: string) => void; isInteractiveReference?: (target: string) => boolean };
const CompactMarkdown = createContext<'normal' | 'compact' | 'desktop'>('normal');
export const MessageContent = memo(function MessageContent({ text, streaming = false, sources, onOpenLink, isInteractiveReference, compact = false, desktop = false, renderInteractive }: { text: string; streaming?: boolean; sources?: Source[]; compact?: boolean; desktop?: boolean; renderInteractive?:(source:string,language:string,index:number)=>React.ReactNode } & LinkActions) {
  const styles = useMessageStyles(compact, desktop);
  const density = desktop ? 'desktop' : compact ? 'compact' : 'normal';
  const blocks = text.split(/(```[\s\S]*?(?:```|$))/g).filter(Boolean);
  return <CompactMarkdown.Provider value={density}><View style={styles.content}>
    {blocks.map((part, index) => {
      const last = index === blocks.length - 1;
      if (part.startsWith('```')) {
        const match = part.match(/^```([^\n]*)\n?([\s\S]*?)(?:```)?$/);
        const language = match?.[1]?.trim() || 'code', code = (match?.[2] ?? part).replace(/\n$/, '');
        if(renderInteractive && /^(?:html|interactive-html|visualization|svg)$/i.test(language) && part.endsWith('```')) return <View key={index}>{renderInteractive(code,language,index)}</View>;
        return language.toLowerCase() === 'mermaid' && part.endsWith('```') ? <RichMessageBlock key={index} kind="mermaid" source={code} /> : <CodeBlock key={index} language={language} code={code} />;
      }
      // Paragraph by paragraph: while a reply streams, finished paragraphs are kept
      // as they are and only the one still growing is parsed again. Display math
      // ($$…$$ on its own lines) becomes its own block.
      const pieces = splitDisplayMath(part).flatMap((piece) => (piece.math ? [piece] : piece.text.split(/\n[ \t]*\n/).filter((chunk) => chunk.trim()).map((chunk) => ({ math: false, text: chunk }))));
      const render = (piece: { math: boolean; text: string }, j: number, isLast: boolean) => (piece.math
        ? <RichMessageBlock key={j} kind="math" source={piece.text} />
        : <Blocks key={j} text={piece.text} caret={streaming && last && isLast} sources={sources} onOpenLink={onOpenLink} isInteractiveReference={isInteractiveReference} />);
      if (pieces.length <= 1) return pieces[0]?.math ? render(pieces[0], index, true) : <Blocks key={index} text={part} caret={streaming && last} sources={sources} onOpenLink={onOpenLink} isInteractiveReference={isInteractiveReference} />;
      return <View key={index} style={styles.blocks}>{pieces.map((piece, j) => render(piece, j, j === pieces.length - 1))}</View>;
    })}
    {streaming && blocks[blocks.length - 1]?.startsWith('```') && <Caret />}
  </View></CompactMarkdown.Provider>;
});

// Memoized per fenced segment so a streaming reply only re-parses the segment still growing.
const Blocks = memo(function Blocks({ text, caret, sources, onOpenLink, isInteractiveReference }: { text: string; caret: boolean; sources?: Source[] } & LinkActions) {
  const styles = useMessageStyles();
  const inline = (value: string) => inlineNodes(value, sources, false, onOpenLink, isInteractiveReference, styles);
  const lines = text.replace(/^\n+|\n+$/g, '').split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isLast = () => i === lines.length - 1;
    if (!line.trim()) { i += 1; continue; }
    // Table: header | --- | rows
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const rows: string[][] = [];
      rows.push(markdownTableCells(line)); i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(markdownTableCells(lines[i])); i += 1; }
      out.push(<Table key={out.length} rows={rows} sources={sources} onOpenLink={onOpenLink} isInteractiveReference={isInteractiveReference} />);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      out.push(<Text key={out.length} selectable testID="message-selectable-text" style={[styles.text, heading[1].length <= 2 ? styles.h1 : styles.h2]}>{inline(heading[2])}{caret && isLast() ? <CaretText /> : null}</Text>);
      i += 1; continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push(<View key={out.length} style={styles.divider} />); i += 1; continue; }
    const quote = line.match(/^>\s?(.*)/);
    if (quote) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      out.push(<View key={out.length} style={styles.quote}><Text selectable testID="message-selectable-text" style={[styles.text, { color: colors.textSecondary }]}>{inline(body.join('\n'))}</Text></View>);
      continue;
    }
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)/);
    if (bullet) {
      const indent = Math.min(3, Math.floor(bullet[1].length / 2));
      const ordered = /\d/.test(bullet[2]);
      out.push(<View key={out.length} style={[styles.bullet, { paddingLeft: indent * 16 }]}>
        {ordered ? <Text style={styles.number}>{bullet[2].replace(')', '.')}</Text> : <View style={styles.dotWrap}><View style={[styles.dot, indent > 0 && styles.dotHollow]} /></View>}
        <Text selectable testID="message-selectable-text" style={[styles.text, styles.grow]}>{inline(bullet[3])}{caret && isLast() ? <CaretText /> : null}</Text>
      </View>);
      i += 1; continue;
    }
    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|\s*([-*+]|\d+[.)])\s|\s*\|.*\|\s*$)/.test(lines[i])) { paragraph.push(lines[i]); i += 1; }
    out.push(<Text key={out.length} selectable testID="message-selectable-text" style={styles.text}>{inline(paragraph.join('\n'))}{caret && i >= lines.length ? <CaretText /> : null}</Text>);
  }
  if (caret && !out.length) out.push(<Caret key="caret" />);
  return <View style={styles.blocks}>{out}</View>;
});

/** “[1]”, “[2, 3]” citation markers that point at a known source. */
const CITATION = /^\[(\d{1,2}(?:\s*[,，、]\s*\d{1,2})*)\]$/;

const INLINE = new RegExp(`(${INLINE_MATH.source}|${/\*\*[^*]+\*\*|__[^_]+__|~~[^~\n]+~~|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]\n]{1,512}\]\((?:<[^<>\n]{1,2048}>|(?:[^\s()]|\([^\s()]{0,256}\)){1,2048})\)|\[\d{1,2}(?:\s*[,，、]\s*\d{1,2})*\](?!\()|(?:[A-Za-z]:[\\\\/]|\.{1,2}[\\\\/]|\/)?[\w@.-]+(?:[\\\\/][\w@.-]+)*\.(?:pdf|docx|xlsx|pptx|png|jpg|jpeg|webp|gif|svg|txt|md|mdx|rst|go|rs|c|h|cpp|hpp|cs|java|kt|swift|py|rb|php|js|jsx|ts|tsx|vue|svelte|html|css|scss|less|json|yaml|yml|toml|xml|sql|sh|ps1|bat|cmd|gradle)(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?|(?:https?:\/\/|codex:\/\/threads\/)[^\s<>()（）「」"'，。；！？]+/.source})`, 'gi');

function inlineNodes(text: string, sources?: Source[], inLink = false, onOpenLink?: LinkActions['onOpenLink'], isInteractiveReference?: LinkActions['isInteractiveReference'], styles = useStyles.current()): React.ReactNode[] {
  return text.split(INLINE).filter((part) => part !== '' && part !== undefined).map((part, i) => {
    const math = inlineMathBody(part);
    if (math !== null) return <InlineMath key={i} source={math} />;
    if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4) return <Text key={i} style={styles.strike}>{inlineNodes(part.slice(2, -2), sources, inLink, onOpenLink, isInteractiveReference, styles)}</Text>;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) return <Text key={i} style={styles.bold}>{inlineNodes(part.slice(2, -2), sources, inLink, onOpenLink, isInteractiveReference, styles)}</Text>;
    if (inLink) return part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <Text key={i} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text> : part;
    return inlineLeaf(part, i, sources, styles, onOpenLink, isInteractiveReference);
  });
}

function inlineLeaf(part: string, i: number, sources: Source[] | undefined, styles: ReturnType<typeof useStyles.current>, onOpenLink?: LinkActions['onOpenLink'], isInteractiveReference?: LinkActions['isInteractiveReference']): React.ReactNode {
  const open = (target: string) => {
    if (onOpenLink) { onOpenLink(target); return; }
    // Generic chat retains browser links but never forwards arbitrary schemes.
    try { const url = new URL(target); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) void Linking.openURL(url.toString()).catch(() => {}); } catch { /* malformed/inactive reference */ }
  };
  const citation = sources?.length ? part.match(CITATION) : null;
  if (citation) {
    const numbers = citation[1].split(/[,，、]/).map((item) => Number(item.trim())).filter((number) => number >= 1 && number <= sources!.length);
    if (numbers.length) {
      return <React.Fragment key={i}>{numbers.map((number, index) => <Text key={`${index}-${number}`} accessibilityRole="link" accessibilityLabel={`来源 ${number}：${sources![number - 1].title}`}
        style={styles.citation} onPress={() => open(sources![number - 1].url)}>{`\u00A0${number}\u00A0`}</Text>)}</React.Fragment>;
    }
  }
  if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
    const target = part.slice(1, -1), interactive = Boolean(onOpenLink && isInteractiveReference?.(target));
    return <Text key={i} accessibilityRole={interactive ? 'link' : undefined} style={[styles.inlineCode, interactive && styles.link]} onPress={interactive ? () => open(target) : undefined}>{target}</Text>;
  }
  if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <Text key={i} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text>;
  const link = part.match(/^\[([^\]]+)\]\((?:<([^<>\n]+)>|((?:[^\s()]|\([^\s()]{0,256}\)){1,2048}))\)$/);
  // The link text keeps its own bold / strikethrough / math.
  if (link) {
    const target = link[2] ?? link[3];
    if (!onOpenLink && !/^https?:\/\//i.test(target)) return <Text key={i}>{inlineNodes(link[1], sources, true, undefined, undefined, styles)}</Text>;
    return <Text key={i} accessibilityRole="link" style={styles.link} onPress={() => open(target)}>{inlineNodes(link[1], sources, true, undefined, undefined, styles)}</Text>;
  }
  if (/^(?:https?:\/\/|codex:\/\/threads\/)/i.test(part)) {
    // Bare URL: keep trailing punctuation out of the link.
    const url = part.replace(/[.,:;!?)\]]+$/, '');
    return <React.Fragment key={i}>
      <Text accessibilityRole="link" style={styles.link} onPress={() => open(url)}>{url}</Text>
      {part.slice(url.length)}
    </React.Fragment>;
  }
  if (onOpenLink && isInteractiveReference?.(part)) {
    return <Text key={i} accessibilityRole="link" style={styles.link} onPress={() => open(part)}>{part}</Text>;
  }
  return part;
}

function Table({ rows, sources, onOpenLink, isInteractiveReference }: { rows: string[][]; sources?: Source[] } & LinkActions) {
  const styles = useMessageStyles();
  const inline = (value: string) => inlineNodes(value, sources, false, onOpenLink, isInteractiveReference, styles);
  const columns = Math.max(...rows.map((row) => row.length));
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
    <View style={styles.table}>
      {rows.map((row, r) => <View key={r} style={[styles.tableRow, r === 0 && styles.tableHead]}>
        {Array.from({ length: columns }).map((_, c) => <View key={c} style={[styles.cell, c > 0 && styles.cellBorder]}>
          <Text selectable testID="message-selectable-text" style={[styles.cellText, r === 0 && styles.bold]}>{inline(row[c] ?? '')}</Text>
        </View>)}
      </View>)}
    </View>
  </ScrollView>;
}

const CodeBlock = memo(function CodeBlock({ language, code }: { language: string; code: string }) {
  const styles = useMessageStyles();
  const workbench = useWorkbenchTypography(), density = useContext(CompactMarkdown);
  const bounded = Boolean(workbench) || density === 'desktop';
  const tokens = useMemo(() => highlightCode(code, language), [code, language]);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = () => void Clipboard.setStringAsync(code).then(() => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }).catch(() => undefined);
  return <View style={styles.codeBlock}>
    <View style={styles.codeHeading}>
      <Text style={styles.language}>{language}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="复制代码" hitSlop={8} onPress={copy} style={styles.copy}>
        <Icon name={copied ? 'check' : 'copy'} size={15} color={colors.textMuted} />
        <Text style={styles.language}>{copied ? '已复制' : '复制'}</Text>
      </Pressable>
    </View>
    <MessageCodeViewport bounded={bounded} contentStyle={styles.codeScroll} contentHeight={code.split('\n').length * styles.code.lineHeight + Number(styles.codeScroll.padding) * 2}><Text selectable testID="message-selectable-text" style={styles.code}>
      {tokens.map((token, index) => (token.kind === 'plain' ? token.text : <Text key={index} style={TOKEN_STYLE[token.kind] ? styles[TOKEN_STYLE[token.kind]!] : undefined}>{token.text}</Text>))}
    </Text></MessageCodeViewport>
  </View>;
});

function useBlink() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.15, duration: 420, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 420, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return opacity;
}

/** Inline caret appended to the streaming paragraph. Nested Text can't take a native-driven animation, so it stays steady; the growing text already reads as live. */
function CaretText() {
  const styles = useStyles();
  return <Text style={styles.caretText}> ●</Text>;
}
function Caret() {
  const styles = useStyles();
  const opacity = useBlink();
  return <Animated.View style={[styles.caret, { opacity }]} />;
}

const TOKEN_STYLE: Partial<Record<CodeTokenKind, 'tokenKeyword' | 'tokenString' | 'tokenComment' | 'tokenNumber'>> = {
  keyword: 'tokenKeyword', string: 'tokenString', comment: 'tokenComment', number: 'tokenNumber',
};

/** iOS has no font named “monospace”. */
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

function useMessageStyles(override?: boolean, desktopOverride?: boolean) {
  const inherited = useContext(CompactMarkdown), base = useStyles();
  const workbench = useWorkbenchTypography();
  const desktop = desktopOverride ?? inherited === 'desktop';
  const compact = override ?? inherited === 'compact';
  const typography = workbench ?? (desktop ? TABLET_TYPOGRAPHY : undefined);
  return useMemo(() => typography && !compact ? {
    ...base,
    content: { ...base.content, gap: WORKBENCH_SPACING.paragraph }, blocks: { ...base.blocks, gap: WORKBENCH_SPACING.paragraph },
    text: { ...base.text, ...typography.body, letterSpacing: 0, fontFamily:conversationFontFamily },
    h1: { ...base.h1, ...typography.heading, marginTop: 2, letterSpacing: 0 },
    h2: { ...base.h2, ...typography.subheading, marginTop: 2, letterSpacing: 0 },
    bullet: { ...base.bullet, gap: 8 }, number: { ...base.number, ...typography.body, minWidth: 18, fontFamily:conversationFontFamily },
    dotWrap: { ...base.dotWrap, width: 14, height: typography.body.lineHeight },
    quote: { ...base.quote, paddingLeft: 12 }, divider: { ...base.divider, marginVertical: 8 },
    inlineCode: { ...base.inlineCode, ...typography.inlineCode, fontFamily:conversationFontFamily }, citation: { ...base.citation, fontSize: typography.caption.fontSize, lineHeight: typography.body.lineHeight },
    cellText: { ...base.cellText, ...typography.process, fontFamily:conversationFontFamily },
    codeBlock: { ...base.codeBlock, borderRadius: 10 },
    codeHeading: { ...base.codeHeading, paddingLeft: 12, height: 38 }, copy: { ...base.copy, height: 36 },
    language:{...base.language,fontFamily:conversationFontFamily},
    codeScroll: { ...base.codeScroll, padding: 12 }, code: { ...base.code, ...typography.code, fontFamily:conversationCodeFontFamily },
    mathDisplay: { ...base.mathDisplay, ...typography.body },
  } : compact ? {
    ...base,
    content: { ...base.content, gap: 6 }, blocks: { ...base.blocks, gap: 6 },
    text: { ...base.text, fontSize: 13, lineHeight: 20 },
    h1: { ...base.h1, fontSize: 15, lineHeight: 22, marginTop: 2 },
    h2: { ...base.h2, fontSize: 14, lineHeight: 21, marginTop: 2 },
    bullet: { ...base.bullet, gap: 6 }, number: { ...base.number, fontSize: 13, lineHeight: 20, minWidth: 17 },
    dotWrap: { ...base.dotWrap, width: 13, height: 20 },
    quote: { ...base.quote, paddingLeft: 9 }, divider: { ...base.divider, marginVertical: 4 },
    inlineCode: { ...base.inlineCode, fontSize: 12 }, citation: { ...base.citation, fontSize: 10.5, lineHeight: 20 },
    cell: { ...base.cell, minWidth: 76, paddingHorizontal: 9, paddingVertical: 6 },
    cellText: { ...base.cellText, fontSize: 12, lineHeight: 18 },
    codeBlock: { ...base.codeBlock, borderRadius: 10 },
    codeHeading: { ...base.codeHeading, paddingLeft: 10, height: 32 }, copy: { ...base.copy, height: 30 },
    codeScroll: { ...base.codeScroll, padding: 10 }, code: { ...base.code, fontSize: 12, lineHeight: 18 },
    mathDisplay: { ...base.mathDisplay, fontSize: 14, lineHeight: 22 },
  } : base, [base, compact, typography]);
}

const TABLET_TYPOGRAPHY = workbenchTypography('tablet');

const useStyles = themed((c, d) => StyleSheet.create({
  content: { width: '100%', gap: 12 },
  blocks: { gap: 10 },
  text: { fontSize: 16, lineHeight: 27, color: colors.text, letterSpacing: 0.1 },
  h1: { fontSize: 20, lineHeight: 29, fontWeight: '600', marginTop: 6, letterSpacing: -0.3 },
  h2: { fontSize: 17, lineHeight: 27, fontWeight: '600', marginTop: 4 },
  bold: { fontWeight: '600' },
  grow: { flex: 1 },
  bullet: { flexDirection: 'row', gap: 10 },
  number: { color: colors.textMuted, fontSize: 16, lineHeight: 27, minWidth: 20, fontWeight: '500' },
  dotWrap: { width: 16, height: 27, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.text },
  dotHollow: { backgroundColor: 'transparent', borderWidth: 1.2, borderColor: colors.text },
  quote: { borderLeftWidth: 3, borderColor: colors.border, paddingLeft: 14, paddingVertical: 2 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
  inlineCode: { fontFamily: MONO, fontSize: 14, color: colors.text, backgroundColor: colors.surfaceStrong, paddingHorizontal: 4, borderRadius: 4 },
  link: { color: colors.primaryStrong, textDecorationLine: 'underline' },
  citation: { fontSize: 11.5, lineHeight: 27, fontWeight: '600', color: colors.primaryDeep, backgroundColor: colors.primarySoft },
  tableScroll: { flexGrow: 0 },
  table: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', backgroundColor: colors.card },
  tableRow: { flexDirection: 'row' },
  tableHead: { backgroundColor: colors.surface },
  cell: { minWidth: 92, maxWidth: 240, paddingHorizontal: 12, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  cellBorder: { borderLeftWidth: StyleSheet.hairlineWidth },
  cellText: { fontSize: 14, lineHeight: 21, color: colors.text },
  codeBlock: { width: '100%', borderRadius: 16, overflow: 'hidden', backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  codeHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 14, paddingRight: 10, height: 38, backgroundColor: colors.surfaceStrong },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 36, paddingHorizontal: 4 },
  language: { fontSize: 12, color: colors.textMuted },
  codeScroll: { padding: 14 },
  code: { fontSize: 13.5, lineHeight: 21, fontFamily: MONO, color: colors.textSecondary },
  tokenKeyword: { color: c.primaryStrong, fontWeight: '600' },
  tokenString: { color: c.success },
  tokenComment: { color: c.subtle, fontStyle: 'italic' },
  tokenNumber: { color: c.warningText },
  strike: { textDecorationLine: 'line-through', color: colors.textMuted },
  math: { fontStyle: 'italic', color: colors.text },
  mathScroll: { flexGrow: 0 },
  mathBlock: { minWidth: '100%', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 4 },
  mathDisplay: { fontSize: 17, lineHeight: 28, fontStyle: 'italic', color: colors.text, textAlign: 'center' },
  caretText: { color: colors.primary, fontSize: 12 },
  caret: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginTop: 4 },
}));
