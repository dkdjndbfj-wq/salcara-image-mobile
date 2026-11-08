import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatMessage, GeneratedImage } from '../domain';
import { messageGeneratedImages } from '../generated-images';

type Selection = { contextKey: string; messageId: string; uri: string; images?: readonly GeneratedImage[] };

function containsSingleUri(message: ChatMessage, uri: string): boolean {
  return message.references.some((image) => image.uri === uri)
    || Boolean(message.agent?.drafts?.includes(uri))
    || messageGeneratedImages(message).some((image) => image.uri === uri && image.status === 'complete');
}

function liveImages(message: ChatMessage, snapshot: readonly GeneratedImage[]): GeneratedImage[] {
  return messageGeneratedImages(message).map((image) => {
    // A locally unreadable file stays out of paging until its URI is replaced.
    const unreadable = snapshot.some((item) => item.id === image.id && item.uri === image.uri && item.uri && item.status === 'error');
    return unreadable ? { ...image, status: 'error' } : image;
  });
}

/** A preview belongs to one message and retires with its conversation or files. */
export function useMessageImagePreview(contextKey: string, messages: readonly ChatMessage[]) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const latest = useRef(messages);
  latest.current = messages;
  const scopeRef = useRef({ key: contextKey });
  if (scopeRef.current.key !== contextKey) scopeRef.current = { key: contextKey };
  const scope = scopeRef.current;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const source = selection?.contextKey === contextKey ? messages.find((message) => message.id === selection.messageId) : undefined;
  const images = source && selection?.images ? liveImages(source, selection.images) : undefined;
  const valid = Boolean(source && selection && (images
    ? images.some((image) => image.uri === selection.uri && image.status === 'complete')
    : containsSingleUri(source, selection.uri)));
  const uri = valid ? selection!.uri : null;

  useEffect(() => {
    if (selection && !valid) setSelection((current) => current === selection ? null : current);
  }, [selection, valid]);

  const open = useCallback((messageId: string, nextUri: string, batch?: readonly GeneratedImage[]) => {
    if (!mounted.current || scopeRef.current !== scope) return;
    const message = latest.current.find((item) => item.id === messageId);
    if (!message) return;
    if (batch && !liveImages(message, batch).some((image) => image.uri === nextUri && image.status === 'complete')) return;
    if (!batch && !containsSingleUri(message, nextUri)) return;
    setSelection({ contextKey: scope.key, messageId, uri: nextUri, images: batch?.map((image) => ({ ...image })) });
  }, [scope]);

  const onSelect = useCallback((nextUri: string) => {
    if (!mounted.current || scopeRef.current !== scope || !selection?.images) return;
    const message = latest.current.find((item) => item.id === selection.messageId);
    if (!message) return;
    const currentImages = liveImages(message, selection.images);
    if (![selection.uri, nextUri].every((value) => currentImages.some((image) => image.uri === value && image.status === 'complete'))) return;
    setSelection((current) => current === selection ? { ...current, uri: nextUri } : current);
  }, [scope, selection]);

  const onClose = useCallback(() => {
    if (mounted.current) setSelection((current) => current === selection ? null : current);
  }, [selection]);

  return { uri, images: valid ? images : undefined, open, onSelect, onClose };
}
