import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { terminalDocument } from './terminal-native-document';
import type { TerminalSurfaceHandle, TerminalSurfaceProps } from './TerminalSurface.types';

export const TerminalSurface = forwardRef<TerminalSurfaceHandle, TerminalSurfaceProps>(function TerminalSurface(props, ref) {
  const web = useRef<WebView>(null), ready = useRef(false);
  const run = (script: string) => { if (ready.current) web.current?.injectJavaScript(`${script};true;`); };
  useImperativeHandle(ref, () => ({ writeBase64: data => run(`terminalWrite(${JSON.stringify(data)})`), writeText: data => run(`terminal.write(${JSON.stringify(data)})`),
    clear: () => run('terminal.clear()'), focus: () => run('terminal.focus()'), setEnabled: enabled => run(`terminal.options.disableStdin=${!enabled}`) }), []);
  useEffect(() => { run(`terminal.options.disableStdin=${!props.enabled}`); }, [props.enabled]);
  useEffect(() => { if (props.active) run('sizing.fit();terminal.focus()'); }, [props.active]);
  const message = (event: WebViewMessageEvent) => {
    if (event.nativeEvent.data.length > 32768) return;
    try {
      const data = JSON.parse(event.nativeEvent.data) as Record<string, unknown>;
      if (data.type === 'ready') { ready.current = true; run(`terminal.options.disableStdin=${!props.enabled}`); props.onReady(); }
      else if (data.type === 'input' && typeof data.data === 'string' && data.data.length <= 16384) props.onInput(data.data);
      else if (data.type === 'resize' && Number.isSafeInteger(data.cols) && Number.isSafeInteger(data.rows)) props.onResize(data.cols as number, data.rows as number);
    } catch { /* Ignore malformed renderer messages. */ }
  };
  return <WebView ref={web} source={{ html: terminalDocument }} onMessage={message} originWhitelist={['about:blank']} onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
    onError={() => props.onError(new Error('终端渲染器加载失败，请重新打开'))} onContentProcessDidTerminate={() => props.onError(new Error('终端显示已中断，请重新打开'))}
    javaScriptEnabled domStorageEnabled={false} allowFileAccess={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never" setSupportMultipleWindows={false}
    keyboardDisplayRequiresUserAction={false} style={{ flex: 1, backgroundColor: '#FFFFFF' }} accessibilityLabel="交互式电脑终端" />;
});
