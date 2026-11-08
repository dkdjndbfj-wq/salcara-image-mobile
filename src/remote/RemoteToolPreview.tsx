import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';
import { localServiceCanOpenOnPhone, openLocalRemoteWebsite, openRemoteWebsite, resolveRemoteLink } from './remote-links';

export type RemoteToolPreviewTarget = { kind: 'web' | 'local-service'; url: string; pageId?: string };
type NavigationRequest = { url: string };

/** A safe link detail pane; local services are never fetched through the Hub. */
export function RemoteToolPreview({ target, onBack }: { target: RemoteToolPreviewTarget; onBack: () => void }) {
  const dk = useDesk();
  const styles = useStyles();
  const resolved = useMemo(() => resolveRemoteLink(target.url), [target.url]);
  const local = target.kind === 'local-service' && resolved.kind === 'local-service';
  const web = target.kind === 'web' && resolved.kind === 'web';
  const safeUrl = useMemo(() => {
    if (web && resolved.kind === 'web') return resolved.url;
    if (!local) return '';
    try { return new URL(target.url).toString(); } catch { return ''; }
  }, [local, target.url, web, resolved]);
  const phoneReachable = local && localServiceCanOpenOnPhone(safeUrl);
  const [webError, setWebError] = useState(false);
  // WebView callbacks can arrive after React has retired the old instance.
  // Keep their state scoped to the URL generation that created them so a
  // previous page cannot mark the newly selected page as failed or loaded.
  const loadGeneration = useRef<{ key: string; value: number }>({ key: '', value: 0 });
  const generationKey = `${local ? 'local' : 'web'}\u0000${safeUrl}`;
  if (loadGeneration.current.key !== generationKey) {
    loadGeneration.current = { key: generationKey, value: loadGeneration.current.value + 1 };
  }
  // A local-service WebView is an interactive LAN/VPN connection to the
  // computer's service. Keep transport state explicit so a failed load cannot
  // look like a Hub-backed preview.
  const [webLoading, setWebLoading] = useState(local && phoneReachable);
  useEffect(() => {
    // ThreadView reuses this pane while a link changes. Retire the previous
    // load/error state before the new WebView request starts.
    setWebError(false);
    setWebLoading(local && phoneReachable);
  }, [local, phoneReachable, safeUrl]);
  const renderedGeneration = loadGeneration.current;
  const currentLoad = () => renderedGeneration === loadGeneration.current;
  const origin = useMemo(() => {
    if (!phoneReachable) return '';
    try { return new URL(safeUrl).origin; } catch { return ''; }
  }, [phoneReachable, safeUrl]);
  const allowNavigation = (request: NavigationRequest): boolean => {
    if (!local || !phoneReachable || !origin) return false;
    try {
      const next = new URL(request.url);
      if (next.origin === origin && (next.protocol === 'http:' || next.protocol === 'https:') && !next.username && !next.password) return true;
      if (next.protocol === 'http:' || next.protocol === 'https:') openRemoteWebsite(next.toString());
    } catch { /* reject malformed or non-HTTP navigation */ }
    return false;
  };
  return <View testID="remote-tool-preview" style={styles.root}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回工具栏" onPress={onBack} style={styles.back}>
        <Icon name="arrowLeft" size={18} color={dk.muted} accent={dk.muted} />
      </Pressable>
      <View style={styles.heading}>
        <Text style={styles.title}>{local ? '电脑本地服务' : '网页链接'}</Text>
        <Text testID="remote-tool-preview-status" style={styles.caption}>{local
          ? !phoneReachable ? '电脑回环地址 · 手机不可达' : webError ? '电脑直连 · 无法加载' : webLoading ? '电脑直连 · 正在加载' : '电脑直连 · 可交互'
          : '在系统浏览器中打开'}</Text>
      </View>
    </View>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.addressCard}>
        <Icon name={local ? 'laptop' : 'link'} size={16} color={dk.muted} accent={dk.muted} />
        <Text selectable style={styles.address}>{target.url}</Text>
      </View>
      <Text style={styles.body}>{local
        ? phoneReachable
          ? '手机将直接连接电脑上的服务，流量不会经过 Salcara Hub。'
          : '这是电脑本机地址，手机无法直接访问。请把服务绑定到局域网或 VPN 地址后再打开；不会通过 Salcara Hub 代转。'
        : '此链接将在系统浏览器打开。网页内容不会被自动抓取或上传。'}</Text>
      {phoneReachable && !webError ? <View style={styles.webFrame}>
        <WebView testID="remote-tool-preview-webview" source={{ uri: safeUrl }} originWhitelist={['http://*', 'https://*']}
          incognito cacheEnabled={false} sharedCookiesEnabled={false} javaScriptEnabled domStorageEnabled
          allowFileAccess={false} allowUniversalAccessFromFileURLs={false} setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false} allowsInlineMediaPlayback onShouldStartLoadWithRequest={allowNavigation}
          onLoadStart={() => { if (!currentLoad()) return; setWebLoading(true); setWebError(false); }}
          onLoadEnd={() => { if (currentLoad()) setWebLoading(false); }}
          onError={() => { if (!currentLoad()) return; setWebLoading(false); setWebError(true); }} onHttpError={() => { if (!currentLoad()) return; setWebLoading(false); setWebError(true); }}
          startInLoadingState renderLoading={() => <View style={styles.webLoading}><ActivityIndicator size="small" color={dk.accentText} /></View>}
          style={styles.webView} />
      </View> : null}
      {(!local || !phoneReachable || webError) ? <Pressable accessibilityRole="button" accessibilityLabel={local ? '在手机浏览器打开局域网服务' : '在浏览器打开网页'} onPress={() => {
        if (local && !phoneReachable) { openLocalRemoteWebsite(safeUrl || target.url); return; }
        if (local && webError) { void Linking.openURL(safeUrl).catch(() => undefined); return; }
        openRemoteWebsite(safeUrl || target.url);
      }} style={styles.action}>
        <Icon name="external" size={18} color={dk.onInk} accent={dk.onInk} />
        <Text style={styles.actionText}>{local ? webError ? '改用浏览器打开' : '在手机浏览器打开' : '在浏览器打开'}</Text>
      </Pressable> : null}
      {webError ? <Text style={styles.error}>手机内嵌预览无法加载，已保留电脑服务和浏览器入口。</Text> : null}
    </ScrollView>
  </View>;
}

const useStyles = themed((_c, d) => StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line },
  back: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: d.surface2 },
  heading: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: d.text, fontSize: 14, fontWeight: '600' },
  caption: { color: d.muted, fontSize: 11.5 },
  content: { padding: 14, gap: 14 },
  addressCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 12, borderRadius: 12, backgroundColor: d.surface2 },
  address: { flex: 1, minWidth: 0, color: d.text, fontSize: 12.5, lineHeight: 18, fontFamily: 'monospace' },
  body: { color: d.muted, fontSize: 12.5, lineHeight: 19 },
  action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 11, backgroundColor: d.ink, paddingHorizontal: 14 },
  actionText: { color: d.onInk, fontSize: 13, fontWeight: '600' },
  webFrame: { minHeight: 220, height: 360, overflow: 'hidden', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: d.line, backgroundColor: d.surface2 },
  webView: { flex: 1, backgroundColor: d.bg },
  webLoading: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: d.bg },
  error: { color: d.muted, fontSize: 11.5, lineHeight: 17 },
}));
