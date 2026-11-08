jest.mock('../remote/useManagedImage', () => ({ useManagedImage: (uri?: string) => ({ uri, active: Boolean(uri), foreground: true, loading: false }) }));
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

type GestureKind = 'pinch' | 'pan' | 'tap';
type GestureHarness = {
  kind: GestureKind;
  handlers: Record<string, (...args: any[]) => void>;
  options: Record<string, unknown>;
};
let mockGestures: GestureHarness[] = [];
type SpringHarness = { from: number; to: number; active: boolean; atProgress: (progress: number) => void };
let mockControlledSprings = false;
let mockSprings: SpringHarness[] = [];
let mockDeferredJS = false;
let mockJSCallbacks: Array<() => void> = [];

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => ({ ToastHost: () => null }));
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const native = require('react-native');
  return { __esModule: true, default: { View: native.View, Image: native.Image },
    useSharedValue: (initial: unknown) => {
      const shared = React.useRef(null);
      if (!shared.current) {
        let current = initial;
        shared.current = {
          get value() { return current; },
          set value(next: any) {
            if (shared.current.animation) shared.current.animation.active = false;
            shared.current.animation = undefined;
            if (!next?.__previewSpring) { current = next; return; }
            if (!mockControlledSprings) { current = next.target; return; }
            const spring: SpringHarness = { from: Number(current), to: next.target, active: true,
              atProgress(progress) {
                if (!spring.active) return;
                const sampled = spring.from + (spring.to - spring.from) * progress;
                current = next.options?.overshootClamping
                  ? Math.max(Math.min(spring.from, spring.to), Math.min(Math.max(spring.from, spring.to), sampled)) : sampled;
              },
            };
            shared.current.animation = spring; mockSprings.push(spring);
          },
        };
      }
      return shared.current;
    },
    // Evaluate the animated style actually attached to the rendered image.
    // Shared-value writes run without a React render, just as on the UI thread.
    useAnimatedStyle: (create: () => unknown) => ({ __previewAnimatedStyle: create }),
    withSpring: (target: number, options?: Record<string, unknown>) => ({ __previewSpring: true, target, options }),
    cancelAnimation: (shared: { animation?: SpringHarness }) => { if (shared.animation) shared.animation.active = false; },
    runOnJS: (callback: (...args: any[]) => void) => (...args: any[]) => {
      if (mockDeferredJS) mockJSCallbacks.push(() => callback(...args));
      else callback(...args);
    },
  };
});
jest.mock('react-native-gesture-handler', () => {
  const React = require('react'); const { View } = require('react-native');
  const gesture = (kind: GestureKind) => {
    const result: any = { kind, handlers: {}, options: {} };
    for (const method of ['onBegin', 'onTouchesDown', 'onStart', 'onUpdate', 'onChange', 'onEnd', 'onFinalize']) {
      result[method] = (callback: (...args: any[]) => void) => { result.handlers[method] = callback; return result; };
    }
    for (const method of ['enabled', 'numberOfTaps', 'averageTouches']) {
      result[method] = (value: unknown) => { result.options[method] = value; return result; };
    }
    return result;
  };
  return { GestureHandlerRootView: View,
    GestureDetector: ({ gesture: current, children }: { gesture: GestureHarness[]; children: React.ReactNode }) => {
      mockGestures = current;
      return React.createElement(View, null, children);
    },
    Gesture: { Pinch: () => gesture('pinch'), Pan: () => gesture('pan'), Tap: () => gesture('tap'), Simultaneous: (...items: GestureHarness[]) => items },
  };
});

import { ImagePreview } from '../components/ImagePreview';
import type { GeneratedImage } from '../domain';

type Preview = Awaited<ReturnType<typeof render>>;
const uri = 'file:///documents/preview-landscape.png';
const image = { width: 600, height: 300 };
const frame = { width: 300, height: 600 };
const pinchEvent = (scale = 1) => ({ scale, numberOfPointers: 2, focalX: 150, focalY: 300, velocity: 0 });
const getGesture = (kind: GestureKind) => {
  const result = mockGestures.find(item => item.kind === kind);
  expect(result).toBeDefined();
  return result!;
};
async function gestureEvent(kind: GestureKind, callback: string, event: unknown = {}, success = true) {
  const handler = getGesture(kind).handlers[callback];
  expect(typeof handler).toBe('function');
  await act(async () => { handler(event, success); });
}
async function pinch(relativeScale: number, cancelled = false) {
  await gestureEvent('pinch', 'onStart', pinchEvent());
  await gestureEvent('pinch', 'onUpdate', pinchEvent(relativeScale));
  // A cancelled native gesture finalizes without a successful onEnd.
  await gestureEvent('pinch', 'onFinalize', pinchEvent(relativeScale), !cancelled);
}
async function pan(changeX: number, changeY: number, start = true) {
  if (start) {
    await gestureEvent('pan', 'onBegin', { numberOfPointers: 2 });
    await gestureEvent('pan', 'onStart', { numberOfPointers: 2 });
  }
  await gestureEvent('pan', 'onChange', { changeX, changeY, translationX: changeX, translationY: changeY, numberOfPointers: 2 });
}
async function swipe(translationX: number, translationY = 0, success = true) {
  const event = { translationX, translationY, changeX: translationX, changeY: translationY, numberOfPointers: 1 };
  await gestureEvent('pan', 'onBegin', event);
  await gestureEvent('pan', 'onStart', event);
  await gestureEvent('pan', 'onChange', event);
  await gestureEvent('pan', 'onEnd', event, success);
  await gestureEvent('pan', 'onFinalize', event, success);
}
async function flushJS() {
  const queued = mockJSCallbacks.splice(0);
  await act(async () => { queued.forEach((callback) => callback()); });
}
const imageBatch = (): GeneratedImage[] => [
  { id: 'first', uri, status: 'complete' },
  { id: 'failed', uri: null, status: 'error', remoteUrl: 'https://example.com/failed.png' },
  { id: 'pending', uri: null, status: 'pending' },
  { id: 'fourth', uri: 'file:///documents/fourth.png', status: 'complete' },
  { id: 'fifth', uri: 'file:///documents/fifth.png', status: 'complete' },
];
async function layout(view: Preview, width = frame.width, height = frame.height) {
  await fireEvent(view.getByTestId('image-preview-stage'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height } } });
}
async function loadImage(view: Preview, width = image.width, height = image.height, sourceUri = uri) {
  await fireEvent(view.getByTestId('image-preview-image'), 'load', { nativeEvent: { source: { uri: sourceUri, width, height } } });
}
function transform(view: Preview): { scale: number; translateX: number; translateY: number } {
  const rendered = view.getByTestId('image-preview-image');
  expect(rendered.props.resizeMode).toBe('contain');
  const style = StyleSheet.flatten(rendered.props.style) as unknown as { __previewAnimatedStyle: () => { transform: Array<Record<string, number>> } };
  expect(typeof style.__previewAnimatedStyle).toBe('function');
  const values = Object.assign({}, ...style.__previewAnimatedStyle().transform);
  // Positive and negative zero render at the same pixel coordinate.
  if (Object.is(values.translateX, -0)) values.translateX = 0;
  if (Object.is(values.translateY, -0)) values.translateY = 0;
  return values;
}
async function mount(extra: Partial<React.ComponentProps<typeof ImagePreview>> = {}) {
  const props: React.ComponentProps<typeof ImagePreview> = { uri, onClose: jest.fn(), onSave: jest.fn(), onShare: jest.fn(), ...extra };
  const view = await render(<ImagePreview {...props} />);
  await layout(view); await loadImage(view);
  return { view, props };
}

beforeEach(() => { mockGestures = []; mockControlledSprings = false; mockSprings = []; mockDeferredJS = false; mockJSCallbacks = []; });

test('returning from the canvas restores the original image zoom and bounded position',async()=>{
  const openCanvas=jest.fn();const first=await mount({onOpenCanvas:openCanvas});
  await pinch(3);await pan(100,0);
  await fireEvent.press(first.view.getByLabelText('打开图片画布'));
  const viewState=openCanvas.mock.calls[0][1];expect(viewState).toMatchObject({uri,scale:3,x:100});
  await first.view.unmount();
  const restored=await mount({initialView:viewState});
  expect(transform(restored.view)).toEqual({scale:3,translateX:100,translateY:0});
  await restored.view.rerender(<ImagePreview uri="file:///different.png" initialView={viewState} onClose={jest.fn()}/>);
  expect(transform(restored.view).scale).toBe(1);
});

test('one-finger swipes visit only delivered files in order, keep original slot numbers, and stop at either end', async () => {
  const images = imageBatch(), onSelect = jest.fn();
  const { view, props } = await mount({ images, onSelect });
  expect(view.getByText('1 / 5')).toBeTruthy();
  await swipe(120);
  expect(onSelect).not.toHaveBeenCalled();
  await swipe(-120);
  expect(onSelect.mock.calls).toEqual([['file:///documents/fourth.png']]);
  // A controlled preview waits for its owner to accept the requested selection.
  expect(view.getByTestId('image-preview-image').props.source.uri).toBe(uri);
  await gestureEvent('pan', 'onEnd', { translationX: -180, translationY: 0, numberOfPointers: 1 });
  await swipe(-180);
  expect(onSelect).toHaveBeenCalledTimes(1);
  await view.rerender(<ImagePreview {...props} uri="file:///documents/fourth.png" />);
  expect(view.getByText('4 / 5')).toBeTruthy();
  await swipe(-120);
  expect(onSelect.mock.calls[1]).toEqual(['file:///documents/fifth.png']);
  await view.rerender(<ImagePreview {...props} uri="file:///documents/fifth.png" />);
  await swipe(-120);
  expect(onSelect).toHaveBeenCalledTimes(2);
  await swipe(120);
  expect(onSelect.mock.calls[2]).toEqual(['file:///documents/fourth.png']);
});

test.each([[47, 0], [-47, 0], [-80, 70], [0, 120], [-80, NaN]])('a short or nonhorizontal swipe (%s, %s) never changes the image', async (x, y) => {
  const onSelect = jest.fn();
  await mount({ images: imageBatch(), onSelect });
  await swipe(x, y);
  expect(onSelect).not.toHaveBeenCalled();
});

test('a cancelled swipe does not select an image and the next intentional swipe still works', async () => {
  const onSelect = jest.fn();
  await mount({ images: imageBatch(), onSelect });
  await swipe(-120, 0, false);
  expect(onSelect).not.toHaveBeenCalled();
  await swipe(-48);
  expect(onSelect).toHaveBeenCalledWith('file:///documents/fourth.png');
});

test('zoomed dragging and any gesture that used two fingers cannot become a page swipe', async () => {
  const onSelect = jest.fn();
  const { view } = await mount({ images: imageBatch(), onSelect });
  await pinch(2);
  await swipe(-120);
  expect(onSelect).not.toHaveBeenCalled();
  expect(transform(view)).toEqual({ scale: 2, translateX: -120, translateY: 0 });
  await pinch(0.5);
  const event = { translationX: -120, translationY: 0, changeX: -120, changeY: 0, numberOfPointers: 1 };
  await gestureEvent('pan', 'onBegin', event);
  await gestureEvent('pan', 'onStart', event);
  await gestureEvent('pan', 'onTouchesDown', { numberOfTouches: 2 });
  await gestureEvent('pan', 'onChange', event);
  await gestureEvent('pan', 'onEnd', event);
  expect(onSelect).not.toHaveBeenCalled();
  await gestureEvent('pan', 'onBegin', event);
  await gestureEvent('pan', 'onStart', event);
  await pinch(1);
  await gestureEvent('pan', 'onChange', event);
  await gestureEvent('pan', 'onEnd', event);
  expect(onSelect).not.toHaveBeenCalled();
  await swipe(-120);
  expect(onSelect).toHaveBeenCalledTimes(1);
});

test('zoom animation targets prevent swiping before the first zoomed frame and navigation resets the next image', async () => {
  const onSelect = jest.fn();
  const { view, props } = await mount({ images: imageBatch(), onSelect });
  mockControlledSprings = true;
  await gestureEvent('tap', 'onEnd');
  expect(transform(view).scale).toBe(1);
  await swipe(-120);
  expect(onSelect).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('下一张图片'));
  expect(onSelect).toHaveBeenCalledWith('file:///documents/fourth.png');
  await view.rerender(<ImagePreview {...props} uri="file:///documents/fourth.png" />);
  await act(async () => { mockSprings.forEach((spring) => spring.atProgress(1)); });
  expect(transform(view)).toEqual({ scale: 1, translateX: 0, translateY: 0 });
});

test.each(['close-button', 'reopen', 'different-image', 'same-uri-new-batch', 'unmount'] as const)('a queued UI-to-JS swipe is discarded after %s', async (transition) => {
  const images = imageBatch(), onSelect = jest.fn();
  const { view, props } = await mount({ images, onSelect });
  mockDeferredJS = true;
  await swipe(-120);
  expect(mockJSCallbacks).toHaveLength(1);
  if (transition === 'close-button') await fireEvent.press(view.getByLabelText('关闭预览'));
  else if (transition === 'reopen') {
    await view.rerender(<ImagePreview {...props} uri={null} />);
    await view.rerender(<ImagePreview {...props} />);
  } else if (transition === 'different-image') {
    await view.rerender(<ImagePreview {...props} uri="file:///documents/fourth.png" />);
    await view.rerender(<ImagePreview {...props} />);
  } else if (transition === 'same-uri-new-batch') {
    await view.rerender(<ImagePreview {...props} images={images.map((image) => ({ ...image, id: `new-${image.id}` }))} />);
    await view.rerender(<ImagePreview {...props} />);
  } else await view.unmount();
  await flushJS();
  expect(onSelect).not.toHaveBeenCalled();
});

test('a changed batch invalidates a gesture still in progress even when the new handler receives its end', async () => {
  const images = imageBatch(), onSelect = jest.fn();
  const { view, props } = await mount({ images, onSelect });
  const event = { translationX: -120, translationY: 0, numberOfPointers: 1 };
  await gestureEvent('pan', 'onBegin', event);
  await gestureEvent('pan', 'onStart', event);
  await view.rerender(<ImagePreview {...props} images={[images[0], images[4]]} />);
  await gestureEvent('pan', 'onEnd', event);
  expect(onSelect).not.toHaveBeenCalled();
  await swipe(-120);
  expect(onSelect).toHaveBeenCalledWith('file:///documents/fifth.png');
});

test('an equivalent batch rerender keeps a valid queued swipe and uses the latest owner callback', async () => {
  const images = imageBatch(), onSelect = jest.fn(), replacementSelect = jest.fn();
  const { view, props } = await mount({ images, onSelect });
  mockDeferredJS = true;
  await swipe(-120);
  await view.rerender(<ImagePreview {...props} images={images.map((image) => ({ ...image }))} onSelect={replacementSelect} />);
  await flushJS();
  expect(onSelect).not.toHaveBeenCalled();
  expect(replacementSelect).toHaveBeenCalledWith('file:///documents/fourth.png');
});

test('two fingers can enlarge and shrink the rendered image between one and five times', async () => {
  const { view } = await mount();
  expect(transform(view)).toEqual({ scale: 1, translateX: 0, translateY: 0 });
  expect(getGesture('pinch').options.enabled).toBe(true);
  await pinch(20);
  expect(transform(view).scale).toBe(5);
  await pinch(0.5);
  expect(transform(view).scale).toBe(2.5);
  await pinch(0.01);
  expect(transform(view)).toEqual({ scale: 1, translateX: 0, translateY: 0 });
  await pinch(2);
  expect(transform(view).scale).toBe(2);
});

test('shrinking a dragged wide image clamps both axes during the pinch, including its letterbox', async () => {
  const { view } = await mount();
  await pinch(5); await pan(1000, 1000);
  // Contain fits this image to 300 x 150; at 5x its visible bounds are 600/75.
  expect(transform(view)).toEqual({ scale: 5, translateX: 600, translateY: 75 });
  await gestureEvent('pinch', 'onStart', pinchEvent());
  await gestureEvent('pinch', 'onUpdate', pinchEvent(0.6));
  expect(transform(view)).toEqual({ scale: 3, translateX: 300, translateY: 0 });
  await gestureEvent('pinch', 'onUpdate', pinchEvent(0.2));
  expect(transform(view)).toEqual({ scale: 1, translateX: 0, translateY: 0 });
  await gestureEvent('pinch', 'onFinalize', pinchEvent(0.2));
  await pan(-1000, -1000);
  expect(transform(view)).toEqual({ scale: 1, translateX: 0, translateY: 0 });
});

test('a narrow portrait cannot be dragged out of view through the horizontal letterbox', async () => {
  const { view } = await mount();
  await loadImage(view, 200, 1000);
  await pinch(2); await pan(5000, -5000);
  expect(transform(view)).toEqual({ scale: 2, translateX: 0, translateY: -300 });
  await pinch(2.5); await pan(-5000, 5000);
  expect(transform(view)).toEqual({ scale: 5, translateX: -150, translateY: 1200 });
  await pinch(0.6);
  expect(transform(view)).toEqual({ scale: 3, translateX: -30, translateY: 600 });
});

test('a cancelled pinch and the next pinch keep the current zoom instead of jumping to an old baseline', async () => {
  const { view } = await mount();
  await pinch(3, true);
  expect(transform(view).scale).toBe(3);
  await gestureEvent('pinch', 'onStart', pinchEvent());
  await gestureEvent('pinch', 'onUpdate', pinchEvent());
  expect(transform(view).scale).toBe(3);
  await gestureEvent('pinch', 'onUpdate', pinchEvent(1.2));
  expect(transform(view).scale).toBeCloseTo(3.6);
  await gestureEvent('pinch', 'onFinalize', pinchEvent(1.2));
  await pinch(0.5);
  expect(transform(view).scale).toBeCloseTo(1.8);
});

test('dragging resumes at the current position after cancellation and after pinch shrinkage', async () => {
  const { view } = await mount();
  expect(getGesture('pan').options.averageTouches).toBe(true);
  await pinch(5); await pan(100, 40);
  // Native cancellation does not dispatch a successful Pan.onEnd.
  await pan(10, 5);
  expect(transform(view)).toEqual({ scale: 5, translateX: 110, translateY: 45 });
  await pan(440, 25, false);
  expect(transform(view)).toEqual({ scale: 5, translateX: 550, translateY: 70 });
  await pinch(0.4);
  expect(transform(view)).toEqual({ scale: 2, translateX: 150, translateY: 0 });
  await pan(-20, -100);
  expect(transform(view)).toEqual({ scale: 2, translateX: 130, translateY: 0 });
  await pan(10, 0);
  expect(transform(view)).toEqual({ scale: 2, translateX: 140, translateY: 0 });
});

test('rotation clamps translation to the new contain frame before the user drags again', async () => {
  const { view } = await mount();
  await layout(view, 600, 300);
  await pinch(3); await pan(1000, 1000);
  expect(transform(view)).toEqual({ scale: 3, translateX: 600, translateY: 300 });
  await layout(view, 300, 600);
  expect(transform(view)).toEqual({ scale: 3, translateX: 300, translateY: 0 });
  await pan(-15, 30);
  expect(transform(view)).toEqual({ scale: 3, translateX: 285, translateY: 0 });
});

test('reopening the same image and switching images both return to the original centered zoom', async () => {
  const { view, props } = await mount();
  await pinch(5); await pan(100, 40);
  await view.rerender(<ImagePreview {...props} uri={null} />);
  await view.rerender(<ImagePreview {...props} />);
  expect(transform(view)).toEqual({ scale: 1, translateX: 0, translateY: 0 });
  // Same-file reopen still knows its dimensions if native onLoad is not repeated.
  await pinch(2); await pan(5000, 5000);
  expect(transform(view)).toEqual({ scale: 2, translateX: 150, translateY: 0 });
  const replacement = 'file:///documents/preview-portrait.png';
  await view.rerender(<ImagePreview {...props} uri={replacement} />);
  expect(transform(view)).toEqual({ scale: 1, translateX: 0, translateY: 0 });
  expect(view.getByTestId('image-preview-image').props.source.uri).toBe(replacement);
  await loadImage(view, 200, 1000, replacement);
  await pinch(2); await pan(5000, 5000);
  expect(transform(view)).toEqual({ scale: 2, translateX: 0, translateY: 300 });
});

test('a late load from the previous URI cannot replace the new images drag bounds', async () => {
  const { view, props } = await mount();
  const oldLoad = view.getByTestId('image-preview-image').props.onLoad;
  const replacement = 'file:///documents/preview-portrait.png';
  await view.rerender(<ImagePreview {...props} uri={replacement} />);
  await loadImage(view, 200, 1000, replacement);
  await pinch(2); await pan(5000, 5000);
  expect(transform(view)).toEqual({ scale: 2, translateX: 0, translateY: 300 });
  await act(async () => { oldLoad({ nativeEvent: { source: { uri, width: image.width, height: image.height } } }); });
  await pan(5000, 0);
  expect(transform(view)).toEqual({ scale: 2, translateX: 0, translateY: 300 });
});

test('the web DOM image-load event supplies the same bounds and missing dimensions leave them intact', async () => {
  const { view } = await mount();
  await fireEvent(view.getByTestId('image-preview-image'), 'load', { nativeEvent: { target: { naturalWidth: 200, naturalHeight: 1000 } } });
  await pinch(2); await pan(5000, 5000);
  expect(transform(view)).toEqual({ scale: 2, translateX: 0, translateY: 300 });
  await fireEvent(view.getByTestId('image-preview-image'), 'load', { nativeEvent: {} });
  await pan(5000, 0);
  expect(transform(view)).toEqual({ scale: 2, translateX: 0, translateY: 300 });
});

test('double tap toggles zoom without reacting to a failed tap and its result is the next pinch baseline', async () => {
  const { view } = await mount();
  expect(getGesture('tap').options.numberOfTaps).toBe(2);
  await gestureEvent('tap', 'onEnd', {}, false);
  expect(transform(view).scale).toBe(1);
  await gestureEvent('tap', 'onEnd');
  expect(transform(view).scale).toBe(2.4);
  await pinch(1);
  expect(transform(view).scale).toBe(2.4);
  await pan(100, 0);
  await gestureEvent('tap', 'onEnd');
  expect(transform(view)).toEqual({ scale: 1, translateX: 0, translateY: 0 });
});

test('different zoom and translation spring progress keeps every rendered frame inside the image bounds', async () => {
  const { view } = await mount();
  await pinch(5); await pan(1000, 1000);
  mockControlledSprings = true;
  await gestureEvent('tap', 'onEnd');
  const zoom = mockSprings.find(spring => spring.from === 5 && spring.to === 1)!;
  const horizontal = mockSprings.find(spring => spring.from === 600 && spring.to === 0)!;
  const vertical = mockSprings.find(spring => spring.from === 75 && spring.to === 0)!;
  expect(zoom).toBeDefined(); expect(horizontal).toBeDefined(); expect(vertical).toBeDefined();
  await act(async () => { zoom.atProgress(0.75); horizontal.atProgress(0.1); vertical.atProgress(0.2); });
  // Scale already reached 2x while the independent translations are still
  // near 540/60. The rendered image must obey its current 150/0 bounds.
  expect(transform(view)).toEqual({ scale: 2, translateX: 150, translateY: 0 });
  await pan(-10, 0);
  expect(transform(view)).toEqual({ scale: 2, translateX: 140, translateY: 0 });
  await act(async () => { zoom.atProgress(1.4); });
  expect(transform(view)).toEqual({ scale: 1, translateX: 0, translateY: 0 });
  await pinch(4.5);
  await fireEvent.press(view.getByLabelText('图片更多操作'));
  await fireEvent.press(view.getByLabelText('放大图片'));
  const enlarge = mockSprings.find(spring => spring.from === 4.5 && spring.to === 5)!;
  expect(enlarge).toBeDefined();
  await act(async () => { enlarge.atProgress(1.6); });
  expect(transform(view).scale).toBe(5);
});

test('a pinch takes over the visible intermediate spring zoom and a cancelled animation cannot jump it', async () => {
  const { view } = await mount();
  mockControlledSprings = true;
  await gestureEvent('tap', 'onEnd');
  const zoom = mockSprings.find(spring => spring.from === 1 && spring.to === 2.4)!;
  expect(zoom).toBeDefined();
  await act(async () => { zoom.atProgress(0.5); });
  expect(transform(view).scale).toBeCloseTo(1.7);
  await gestureEvent('pinch', 'onStart', pinchEvent());
  await gestureEvent('pinch', 'onUpdate', pinchEvent());
  expect(transform(view).scale).toBeCloseTo(1.7);
  await act(async () => { zoom.atProgress(1); });
  expect(transform(view).scale).toBeCloseTo(1.7);
  await gestureEvent('pinch', 'onUpdate', pinchEvent(2));
  expect(transform(view).scale).toBeCloseTo(3.4);
  await gestureEvent('pinch', 'onFinalize', pinchEvent(2));
  await pinch(0.5);
  expect(transform(view).scale).toBeCloseTo(1.7);
});

test.each(['save', 'share'] as const)('a pending %s keeps double-finger zoom and panning available', async pendingAction => {
  const { view, props } = await mount({ pendingAction });
  await fireEvent.press(view.getByLabelText('图片更多操作'));
  expect(view.getByLabelText('保存图片').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('分享图片').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('保存图片')); await fireEvent.press(view.getByLabelText('分享图片'));
  expect(props.onSave).not.toHaveBeenCalled(); expect(props.onShare).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('关闭图片操作'));
  expect(getGesture('pinch').options.enabled).toBe(true);
  expect(getGesture('pan').options.enabled).toBe(true);
  await pinch(3); await pan(120, 0);
  expect(transform(view)).toEqual({ scale: 3, translateX: 120, translateY: 0 });
  await pinch(0.5);
  expect(transform(view)).toEqual({ scale: 1.5, translateX: 75, translateY: 0 });
});
