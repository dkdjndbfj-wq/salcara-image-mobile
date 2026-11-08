import React, { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

/** Browser preview for Expo Web, where the native WebView package has no renderer. */
export function RemoteDemoBrowser({ uri, onError, onNavigate, onOpenNew }: { uri: string; onError: () => void; onNavigate?: (url: string) => void; onOpenNew?: (url: string) => void }) {
  const [loading, setLoading] = useState(true);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanup.current?.(), []);
  return <View style={styles.frame}>
    <iframe
      title={`浏览器页面 ${uri}`}
      src={uri}
      referrerPolicy="no-referrer"
      sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
      onLoad={event => {
        setLoading(false); cleanup.current?.(); cleanup.current = undefined;
        // Same-origin pages expose navigation; cross-origin pages retain their own
        // browsing context without trying to bypass the browser's origin boundary.
        try {
          const frame = event.currentTarget, document = frame.contentDocument;
          const url = frame.contentWindow?.location.href;
          if (url) onNavigate?.(url);
          if (!document) return;
          const open = (click: MouseEvent) => {
            const element = click.target as Element | null;
            const link = element?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null;
            if (!link || !onOpenNew) return;
            click.preventDefault(); onOpenNew(link.href);
          };
          document.addEventListener('click', open);
          cleanup.current = () => document.removeEventListener('click', open);
        } catch { /* A cross-origin page's DOM is intentionally unavailable. */ }
      }}
      onError={() => { setLoading(false); onError(); }}
      style={iframeStyle}
    />
    {loading ? <View pointerEvents="none" style={styles.fallback}><ActivityIndicator color="#14B8A6" /><Text style={styles.caption}>正在加载网页</Text></View> : null}
  </View>;
}

const styles = StyleSheet.create({
  frame: { flex: 1, overflow: 'hidden' },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#FFFFFF' },
  caption: { color: '#666666', fontSize: 10 },
});

const iframeStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 1,
  width: '100%',
  height: '100%',
  border: 0,
  backgroundColor: '#FFFFFF',
};
