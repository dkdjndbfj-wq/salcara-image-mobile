import React from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { colors } from '../theme';

/** A small native renderer. No HTML, remote images or executable content. */
export function MessageContent({ text }: { text: string }) {
  return <View style={styles.content}>{text.split(/(```[\s\S]*?```)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('```')) {
      const match = part.match(/^```([^\n]*)\n?([\s\S]*?)```$/);
      const code = match?.[2]?.replace(/\n$/, '') ?? part;
      return <CodeBlock key={index} language={match?.[1] || '代码'} code={code} />;
    }
    return <View key={index} style={styles.paragraphs}>{part.trim().split(/\n\s*\n/).filter(Boolean).map((paragraph, p) => <View key={p} style={styles.paragraph}>{paragraph.split('\n').map((line, l) => {
      const heading = line.match(/^(#{1,6})\s+(.+)/);
      const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)/);
      const quote = line.match(/^>\s?(.*)/);
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return <View key={l} style={styles.divider} />;
      if (heading) return <Text key={l} selectable style={[styles.text, styles.heading, heading[1].length === 1 && { fontSize: 20 }]}>{inline(heading[2])}</Text>;
      if (bullet) return <View key={l} style={styles.bullet}><Text style={styles.bulletMark}>{line.trim().match(/^\d+/)?.[0] ? line.trim().match(/^\d+/)![0] + '.' : '•'}</Text><Text selectable style={[styles.text, styles.grow]}>{inline(bullet[1])}</Text></View>;
      if (quote) return <View key={l} style={styles.quote}><Text selectable style={[styles.text, { color: colors.textMuted }]}>{inline(quote[1])}</Text></View>;
      return <Text key={l} selectable style={styles.text}>{inline(line)}</Text>;
    })}</View>)}</View>;
  })}</View>;
}

function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <Text key={i} style={{ fontWeight: '600' }}>{part.slice(2, -2)}</Text>;
    if (part.startsWith('`') && part.endsWith('`')) return <Text key={i} style={styles.inlineCode}>{part.slice(1, -1)}</Text>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) return <Text key={i} accessibilityRole="link" style={{ color: colors.primaryStrong }} onPress={() => void Linking.openURL(link[2]).catch(() => {})}>{link[1]}</Text>;
    return part;
  });
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = React.useState(false);
  return <View style={styles.codeBlock}><View style={styles.codeHeading}><Text style={styles.language}>{language}</Text><Pressable accessibilityRole="button" onPress={() => void Clipboard.setStringAsync(code).then(() => setCopied(true)).catch(() => setCopied(false))}><Text style={styles.language}>{copied ? '已复制' : '复制代码'}</Text></Pressable></View><ScrollView horizontal contentContainerStyle={styles.codeScroll}><Text selectable style={styles.code}>{code}</Text></ScrollView></View>;
}
const styles = StyleSheet.create({
  content: { width: '100%', gap: 16 }, paragraphs: { gap: 16 }, paragraph: { gap: 5 }, text: { fontSize: 15, lineHeight: 25, color: colors.text }, heading: { fontSize: 17, lineHeight: 26, fontWeight: '600', paddingVertical: 3 }, grow: { flex: 1 }, bullet: { flexDirection: 'row', gap: 9, paddingLeft: 2 }, bulletMark: { color: colors.textMuted, fontSize: 15, lineHeight: 25, minWidth: 12 }, quote: { borderLeftWidth: 3, borderColor: '#CDDCEA', paddingLeft: 12, marginVertical: 4 }, divider: { height: 1, backgroundColor: colors.border, marginVertical: 12 }, inlineCode: { fontFamily: 'monospace', fontSize: 13, backgroundColor: colors.surface }, codeBlock: { width: '100%', borderRadius: 14, overflow: 'hidden', backgroundColor: colors.surface }, codeHeading: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border }, language: { fontSize: 11, color: colors.textMuted }, codeScroll: { padding: 14 }, code: { fontSize: 12, lineHeight: 20, fontFamily: 'monospace', color: colors.text },
});
