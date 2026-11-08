import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { workspaceBrowserTarget } from './workspace-browser';
import { localServiceCanOpenOnPhone } from './remote-links';

/** Native implementation for the demo workbench's independent browser tab. */
export function RemoteDemoBrowser({ uri, onError, onNavigate, onOpenNew }: { uri: string; onError: () => void; onNavigate?: (url: string) => void; onOpenNew?: (url: string) => void }) {
  const allowed = (url: string) => {
    const target = workspaceBrowserTarget(url);
    return Boolean(target && (target.kind !== 'local-service' || localServiceCanOpenOnPhone(target.url)));
  };
  return <WebView
    source={{ uri }}
    // Route every scheme through our validator; a restrictive whitelist otherwise
    // delegates unlisted schemes to Linking before onShouldStartLoadWithRequest.
    originWhitelist={['*']}
    incognito
    cacheEnabled={false}
    sharedCookiesEnabled={false}
    javaScriptEnabled
    domStorageEnabled
    allowFileAccess={false}
    allowUniversalAccessFromFileURLs={false}
    setSupportMultipleWindows
    javaScriptCanOpenWindowsAutomatically={false}
    allowsInlineMediaPlayback
    startInLoadingState
    onError={onError}
    onHttpError={onError}
    onShouldStartLoadWithRequest={request => { const valid = allowed(request.url); if (!valid) onError(); return valid; }}
    onNavigationStateChange={state => { if (!state.loading && allowed(state.url)) onNavigate?.(state.url); }}
    onOpenWindow={event => { if (allowed(event.nativeEvent.targetUrl)) onOpenNew?.(event.nativeEvent.targetUrl); else onError(); }}
    renderLoading={() => <View style={styles.loading}><ActivityIndicator color="#14B8A6" /></View>}
    style={styles.webView}
  />;
}

const styles = StyleSheet.create({
  webView: { flex: 1, backgroundColor: '#FFFFFF' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
