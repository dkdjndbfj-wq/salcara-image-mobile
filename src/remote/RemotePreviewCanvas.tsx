import React, { useRef } from 'react';
import { Image, Pressable, View, type GestureResponderEvent } from 'react-native';
import type { PreviewFrame, PreviewInput } from './workspace-preview';

export interface PreviewCanvasProps { frame: PreviewFrame; width: number; disabled: boolean; onInput: (input: PreviewInput) => void; selectionMode?: boolean; elementPicking?: boolean; onCopySelection?: () => void | Promise<void> }
export function RemotePreviewCanvas({ frame, width, disabled, onInput, selectionMode, elementPicking }: PreviewCanvasProps) {
  const height = width * frame.height / frame.width;
  const lastMove = useRef(0);
  const point = (event: GestureResponderEvent) => ({ x: Math.min(frame.width - 1, Math.max(0, Math.floor(event.nativeEvent.locationX * frame.width / width))), y: Math.min(frame.height - 1, Math.max(0, Math.floor(event.nativeEvent.locationY * frame.height / height))) });
  const image = <Image source={{ uri: `data:image/jpeg;base64,${frame.imageBase64}` }} style={{ width, height }} resizeMode="contain" />;
  if (selectionMode && !elementPicking) return <View accessibilityLabel="拖动选择电脑网页文字" style={{ width, height }} onStartShouldSetResponder={() => !disabled}
    onResponderGrant={event => onInput({ action: 'mouse', phase: 'down', ...point(event) })}
    onResponderMove={event => { if (Date.now() - lastMove.current < 90) return; lastMove.current = Date.now(); onInput({ action: 'mouse', phase: 'move', ...point(event) }); }}
    onResponderRelease={event => onInput({ action: 'mouse', phase: 'up', ...point(event) })}
    onResponderTerminate={event => onInput({ action: 'mouse', phase: 'up', ...point(event) })}>{image}</View>;
  const box = frame.element?.documentId === frame.documentId ? frame.element?.rect : undefined;
  const scale = width / frame.width;
  return <Pressable accessibilityRole="button" accessibilityLabel={elementPicking ? '选择网页元素' : '电脑网页内容'} disabled={disabled} onPress={event => {
    if (elementPicking) { if (frame.domSupported && frame.documentId) onInput({ action: 'element-pick', documentId: frame.documentId, ...point(event) }); }
    else onInput({ action: 'click', ...point(event) });
  }} style={{ width, height, overflow: 'hidden' }}>{image}
    {box ? <View pointerEvents="none" testID="preview-element-outline" style={{ position: 'absolute', left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale, borderWidth: 2, borderColor: '#2F6BFF', backgroundColor: 'rgba(47,107,255,0.08)' }} /> : null}
  </Pressable>;
}

