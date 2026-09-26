import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '../theme';
import { Icon } from './Icon';

/**
 * A small native Markdown renderer: headings, lists, quotes, tables, code
 * blocks, bold/italic/inline code and links. No HTML or remote content.
 */
export function MessageContent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = text.split(/(```[\s\S]*?(?:```|$))/g).filter(Boolean);
  return <View style={styles.content}>
    {blocks.map((part, index) => {
      const last = index === blocks.length - 1;
      if (part.startsWith('```')) {
        const match = part.match(/^```([^\n]*)\n?([\s\S]*?)(?:```)?$/);
        return <CodeBlock key={index} language={match?.[1]?.trim() || 'code'} code={(match?.[2] ?? part).replace(/\n$/, '')} />;
      }
      return <Blocks key={index} text={part} caret={streaming && last} />;
    })}
    {streaming && blocks[blocks.length - 1]?.startsWith('```') && <Caret />}
  </View>;
}

function Blocks({ text, caret }: { text: string; caret: boolean }) {
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
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      rows.push(cells(line)); i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      out.push(<Table key={out.length} rows={rows} />);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      out.push(<Text key={out.length} selectable style={[styles.text, heading[1].length <= 2 ? styles.h1 : styles.h2]}>{inline(heading[2])}{caret && isLast() ? <CaretText /> : null}</Text>);
      i += 1; continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push(<View key={out.length} style={styles.divider} />); i += 1; continue; }
    const quote = line.match(/^>\s?(.*)/);
    if (quote) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      out.push(<View key={out.length} style={styles.quote}><Text selectable style={[styles.text, { color: colors.textSecondary }]}>{inline(body.join('\n'))}</Text></View>);
      continue;
    }
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)/);
    if (bullet) {
      const indent = Math.min(3, Math.floor(bullet[1].length / 2));
      const ordered = /\d/.test(bullet[2]);
      out.push(<View key={out.length} style={[styles.bullet, { paddingLeft: indent * 16 }]}>
        {ordered ? <Text style={styles.number}>{bullet[2].replace(')', '.')}</Text> : <View style={styles.dotWrap}><View style={[styles.dot, indent > 0 && styles.dotHollow]} /></View>}
        <Text selectable style={[styles.text, styles.grow]}>{inline(bullet[3])}{caret && isLast() ? <CaretText /> : null}</Text>
      </View>);
      i += 1; continue;
    }
    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|\s*([-*+]|\d+[.)])\s|\s*\|.*\|\s*$)/.test(lines[i])) { paragraph.push(lines[i]); i += 1; }
    out.push(<Text key={out.length} selectable style={styles.text}>{inline(paragraph.join('\n'))}{caret && i >= lines.length ? <CaretText /> : null}</Text>);
  }
  if (caret && !out.length) out.push(<Caret key="caret" />);
  return <View style={styles.blocks}>{out}</View>;
}

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).filter((part) => part !== '').map((part, i) => {
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) return <Text key={i} style={styles.bold}>{part.slice(2, -2)}</Text>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <Text key={i} style={styles.inlineCode}>{` ${part.slice(1, -1)} `}</Text>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <Text key={i} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) return <Text key={i} accessibilityRole="link" style={styles.link} onPress={() => void Linking.openURL(link[2]).catch(() => {})}>{link[1]}</Text>;
    return part;
  });
}

function Table({ rows }: { rows: string[][] }) {
  const columns = Math.max(...rows.map((row) => row.length));
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
    <View style={styles.table}>
      {rows.map((row, r) => <View key={r} style={[styles.tableRow, r === 0 && styles.tableHead]}>
        {Array.from({ length: columns }).map((_, c) => <View key={c} style={[styles.cell, c > 0 && styles.cellBorder]}>
          <Text selectable style={[styles.cellText, r === 0 && styles.bold]}>{inline(row[c] ?? '')}</Text>
        </View>)}
      </View>)}
    </View>
  </ScrollView>;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
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
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}><Text selectable style={styles.code}>{code}</Text></ScrollView>
  </View>;
}

function useBlink() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.15, duration: 420, useNativeDriver: false }),
      Animated.timing(opacity, { toValue: 1, duration: 420, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return opacity;
}

/** Inline caret appended to the streaming paragraph. */
function CaretText() {
  const opacity = useBlink();
  return <Animated.Text style={[styles.caretText, { opacity }]}> ●</Animated.Text>;
}
function Caret() {
  const opacity = useBlink();
  return <Animated.View style={[styles.caret, { opacity }]} />;
}

const styles = StyleSheet.create({
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
  inlineCode: { fontFamily: 'monospace', fontSize: 14, color: colors.text, backgroundColor: colors.surfaceStrong },
  link: { color: colors.primaryStrong, textDecorationLine: 'underline' },
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
  code: { fontSize: 13.5, lineHeight: 21, fontFamily: 'monospace', color: colors.textSecondary },
  caretText: { color: colors.primary, fontSize: 12 },
  caret: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginTop: 4 },
});
