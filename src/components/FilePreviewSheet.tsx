import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { extensionOf, readGeneratedFile, shareGeneratedFile } from '../agent/files';
import type { GeneratedFile } from '../agent/types';
import { colors, radius, themed } from '../theme';
import { MessageContent } from './MessageContent';
import { PrimaryButton, Sheet, showToast } from './ui';

/** Parses simple CSV (quoted fields, commas, newlines in quotes). */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !field) quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((item) => item.some((cell) => cell.trim()));
}

export function FilePreviewSheet({ file, onClose }: { file: GeneratedFile | null; onClose: () => void }) {
  const styles = useStyles();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    if (file) {
      readGeneratedFile(file).then((text) => { if (alive) setContent(text); })
        .catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : '无法读取文件'); });
    }
    return () => { alive = false; };
  }, [file]);
  const extension = file ? extensionOf(file.name) : '';
  const share = () => { if (file) void shareGeneratedFile(file).catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : '分享失败', 'alert')); };
  const copy = () => { if (content) void Clipboard.setStringAsync(content).then(() => showToast('已复制内容')); };
  const rows = content && (extension === 'csv' || extension === 'tsv') ? parseCsv(content, extension === 'tsv' ? '\t' : ',').slice(0, 200) : null;
  return <Sheet visible={Boolean(file)} title={file?.name} subtitle="由 Salcara 生成" onClose={onClose}
    footer={<View style={styles.footer}>
      <PrimaryButton label="复制" tone="secondary" icon="copy" onPress={copy} disabled={!content} style={{ flex: 1 }} />
      <PrimaryButton label="分享 / 保存" icon="share" onPress={share} style={{ flex: 1.4 }} />
    </View>}>
    <View style={styles.body}>
      {error ? <Text style={styles.error}>{error}</Text>
        : content === null ? <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
          : rows ? <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.table}>
              {rows.map((row, r) => <View key={r} style={[styles.row, r === 0 && styles.head]}>
                {row.map((cell, c) => <Text key={c} selectable style={[styles.cell, r === 0 && styles.headText]} numberOfLines={3}>{cell}</Text>)}
              </View>)}
            </View>
          </ScrollView>
            : extension === 'md' || extension === 'markdown' || extension === 'txt' ? <MessageContent text={content} />
              : <ScrollView horizontal showsHorizontalScrollIndicator={false}><Text selectable style={styles.code}>{content}</Text></ScrollView>}
    </View>
  </Sheet>;
}

/** iOS has no font named “monospace”. */
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

const useStyles = themed((c, d) => StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 },
  footer: { flexDirection: 'row', gap: 10 },
  error: { color: colors.danger, fontSize: 14, marginTop: 20 },
  table: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  row: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  head: { backgroundColor: colors.surface, borderTopWidth: 0 },
  cell: { width: 128, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: colors.text, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  headText: { fontWeight: '600' },
  code: { fontFamily: MONO, fontSize: 12.5, lineHeight: 19, color: colors.textSecondary },
}));
