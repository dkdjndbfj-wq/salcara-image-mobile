import React, { useEffect, useRef } from 'react';
import type { InteractiveArtifactProps } from '../remote/artifact-viewer-types';
import { useInteractiveArtifact } from './useInteractiveArtifact';
import {PreviewLogPanel} from '../remote/PreviewLogPanel';

export function InteractiveArtifact(props: InteractiveArtifactProps) {
  const { html, height, error, report, identity, logs } = useInteractiveArtifact(props), frame = useRef<HTMLIFrameElement>(null);
  const syncAnnotations=()=>frame.current?.contentWindow?.postMessage({channel:'salcara-annotation-control',token:identity,pins:props.annotationPins??[],focus:props.annotationFocus?.id,focusNonce:props.annotationFocus?.nonce},'*');
  useEffect(syncAnnotations,[html,identity,props.annotationPins,props.annotationFocus]);
  useEffect(() => { const listener = (event: MessageEvent) => { if (event.source === frame.current?.contentWindow) report(event.data); }; window.addEventListener('message', listener); return () => window.removeEventListener('message', listener); }, [report]);
  return <div style={{ width: '100%', minHeight: 180, background: '#fff' }}>
    {error ? <div role="status" style={{ fontSize: 12, padding: 8, color: '#80504a' }}>{error}</div> : null}
    {html ? <iframe key={identity} ref={frame} onLoad={syncAnnotations} title={props.title ?? '交互预览'} data-testid="interactive-artifact" srcDoc={html} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" style={{ display: 'block', width: '100%', height: props.inline ? height : Math.max(500, height), border: 0, background: '#fff' }} /> : <div style={{ padding: 20, fontSize: 13 }}>正在加载预览…</div>}
    {!props.readOnlyState ? <PreviewLogPanel scopeKey={identity} entries={logs} active={props.active} origin={`${props.title ?? '交互预览'} · ${props.artifactId} · ${props.revision}`} onCompose={props.onComposeLogs}/> : null}
  </div>;
}
