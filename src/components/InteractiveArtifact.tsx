import React,{useEffect,useRef} from 'react';
import { Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { InteractiveArtifactProps } from '../remote/artifact-viewer-types';
import { useInteractiveArtifact } from './useInteractiveArtifact';
import {artifactScriptJSON} from '../remote/artifact-content';
import {PreviewLogPanel} from '../remote/PreviewLogPanel';

export function InteractiveArtifact(props: InteractiveArtifactProps) {
  const { html, height, error, report, identity, logs } = useInteractiveArtifact(props);
  const web=useRef<WebView>(null);
  const syncAnnotations=()=>web.current?.injectJavaScript(`window.__salcaraAnnotationControl?.(${artifactScriptJSON({token:identity,pins:props.annotationPins??[],focus:props.annotationFocus?.id,focusNonce:props.annotationFocus?.nonce})});true;`);
  useEffect(syncAnnotations,[html,identity,props.annotationPins,props.annotationFocus]);
  const displayHeight = props.inline ? height : Math.max(500, height);
  return <View style={{ width: '100%', minHeight: 180, backgroundColor: '#fff' }}>
    {error ? <Text accessibilityRole="alert" style={{ fontSize: 12, padding: 8, color: '#80504a' }}>{error}</Text> : null}
    {html ? <WebView key={identity} ref={web} onLoadEnd={syncAnnotations} testID="interactive-artifact" accessibilityLabel={props.title ?? '交互预览'} source={{ html }} originWhitelist={['about:*']} javaScriptEnabled domStorageEnabled={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} incognito cacheEnabled={false}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never" setSupportMultipleWindows mediaPlaybackRequiresUserAction
      onShouldStartLoadWithRequest={request => request.url === 'about:blank' || request.url === 'about:srcdoc'} onOpenWindow={() => {}}
      onMessage={event => { if (event.nativeEvent.data.length > 2100000) return; try { report(JSON.parse(event.nativeEvent.data)); } catch { /* Ignore invalid bridge data. */ } }}
      style={{ height: displayHeight, backgroundColor: '#fff' }} /> : <Text style={{ padding: 20, fontSize: 13 }}>正在加载预览…</Text>}
    {!props.readOnlyState ? <PreviewLogPanel scopeKey={identity} entries={logs} active={props.active} origin={`${props.title ?? '交互预览'} · ${props.artifactId} · ${props.revision}`} onCompose={props.onComposeLogs}/> : null}
  </View>;
}
