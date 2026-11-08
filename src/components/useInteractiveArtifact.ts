import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { artifactStateKey, readArtifactState, writeArtifactState } from '../remote/artifact-state';
import type { InteractiveArtifactProps } from '../remote/artifact-viewer-types';
import { buildInteractiveArtifactDocument, parseInteractiveMessage } from './interactive-artifact-document';
import { appendPreviewLog, type PreviewLogEntry } from '../remote/preview-logs';

export function useInteractiveArtifact(props: InteractiveArtifactProps) {
  const key = artifactStateKey(props.scopeKey, props.artifactId, props.revision);
  const identity = useMemo(() => ({ key, token: randomUUID() }), [key, props.source]);
  const current = useRef(identity), latest = useRef(props), mounted = useRef(true); current.current = identity; latest.current = props;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [document, setDocument] = useState<{ identity: typeof identity; html: string }>();
  const [height, setHeight] = useState(400), [error, setError] = useState('');
  const [logs, setLogs] = useState<{ identity: typeof identity; entries: PreviewLogEntry[] }>({ identity, entries: [] });
  const annotate = Boolean(props.onAnnotate);
  useEffect(() => {
    let active = true; setError(''); setHeight(400);
    void readArtifactState(key).catch(() => { if (active && current.current === identity) setError('交互状态无法恢复，当前使用初始状态'); return undefined; }).then(saved => {
      if (!active || current.current !== identity) return;
      setDocument({ identity, html: buildInteractiveArtifactDocument(props.source, identity.token, saved ?? props.initialState ?? {}, annotate, props.title ?? '交互预览',props.elementAnnotations===true) });
    });
    return () => { active = false; };
  }, [identity, key, annotate,props.elementAnnotations]);
  const report = useCallback((value: unknown) => {
    if (!mounted.current || current.current !== identity) return;
    const message = parseInteractiveMessage(value, identity.token);
    if (!message) return;
    if (message.type === 'height') setHeight(message.height);
    if (message.type === 'log') setLogs(previous => ({ identity, entries: appendPreviewLog(previous.identity === identity ? previous.entries : [], message.entry) }));
    if (message.type === 'annotation') latest.current.onAnnotate?.(message.selection);
    if(message.type==='annotation-focus')latest.current.onAnnotationFocus?.(message.id);
    if (message.type === 'error') { setError(message.message); latest.current.onError?.(message.message); }
    if (message.type === 'state') {
      if(latest.current.readOnlyState)return;
      latest.current.onState?.(message.state);
      void writeArtifactState(key, message.state).catch(() => { if (current.current === identity) setError('本次交互状态尚未保存，请保留页面后重试'); });
    }
  }, [identity, key]);
  return { html: document?.identity === identity ? document.html : '', height, error, report, identity: identity.token, logs: logs.identity === identity ? logs.entries : [] };
}
