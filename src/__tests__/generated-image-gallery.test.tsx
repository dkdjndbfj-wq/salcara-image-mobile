import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

let mockReducedMotion = true;
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/MotionPressable', () => {
  const React = require('react');
  const { Pressable, View } = require('react-native');
  return { useReducedMotion: () => mockReducedMotion, Appear: ({ children }: { children: React.ReactNode }) => <View>{children}</View>, MotionPressable: Pressable };
});
jest.mock('../components/Brand', () => ({ LivingMark: () => null }));
jest.mock('../components/AgentTrace', () => ({ ActionCards: () => null, AgentActivity: () => null, DraftStrip: () => null, FileCards: () => null, PlanCard: () => null, SourcesRow: () => null, SuggestionList: () => null }));
jest.mock('../components/MessageContent', () => ({ MessageContent: () => null }));
jest.mock('../components/ui', () => ({ showToast: jest.fn() }));
jest.mock('../companion/CharacterAvatar', () => ({ CharacterAvatar: () => null }));
jest.mock('../companion/reactions', () => ({ isPoke: () => false }));
jest.mock('../state/live-text', () => ({ useLiveText: (_id: string, text: string) => text }));
jest.mock('../document-inputs', () => ({ attachmentKind: () => 'image' }));
jest.mock('expo-media-library', () => ({ requestPermissionsAsync: jest.fn(), Asset: { create: jest.fn() } }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => false), shareAsync: jest.fn() }));

import type { ChatMessage, GeneratedImage } from '../domain';
import type { Character } from '../memorybox/types';
import { GeneratedImageGallery } from '../components/GeneratedImageGallery';
import { MessageBubble } from '../components/MessageBubble';
import { CompanionMessage } from '../companion/CompanionMessage';

const complete = (n: number): GeneratedImage => ({ id: `image-${n}`, uri: `file:///images/${n}.png`, status: 'complete' });
const pendingImage = (n: number): GeneratedImage => ({ id: `image-${n}`, uri: null, status: 'pending' });
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message', conversationId: 'conversation', role: 'assistant', prompt: '', preparedPrompt: '画花', mode: 'generate', status: 'complete',
  providerId: 'provider', model: 'image-model', quality: 'auto', size: '1024x1024', transparent: false, imageUri: null, remoteImageUrl: null,
  references: [], maskUri: null, error: null, elapsedMs: 1, createdAt: 1, ...patch,
});

beforeAll(() => { jest.spyOn(Image, 'getSize').mockImplementation(() => undefined); });
beforeEach(() => { mockReducedMotion = true; jest.mocked(Image.getSize).mockImplementation(() => undefined); });
afterAll(() => { jest.restoreAllMocks(); });

test('separate fresh messages have unique SVG paint servers and each artwork references its own gradients', async () => {
  mockReducedMotion = false;
  const first = message({ createdAt: Date.now(), generatedImages: [complete(1)] });
  const second = message({ ...first, id: 'second-message' });
  const view = await render(<View>
    <GeneratedImageGallery message={first} fresh onPreview={jest.fn()} />
    <GeneratedImageGallery message={second} fresh onPreview={jest.fn()} />
  </View>);
  const definitions: string[] = [];
  const references: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as { type?: string; props?: { name?: string; fill?: { brushRef?: string } }; children?: unknown[] };
    if (node.type?.endsWith('Gradient') && node.props?.name) definitions.push(node.props.name);
    if (node.props?.fill?.brushRef) references.push(node.props.fill.brushRef);
    node.children?.forEach(visit);
  };
  visit(view.toJSON());
  expect(definitions).toHaveLength(8);
  expect(new Set(definitions).size).toBe(8);
  expect(definitions.every((id) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id))).toBe(true);
  expect(references.sort()).toEqual([...definitions].sort());
});

test('late dimensions from a previous selection cannot replace the current image aspect ratio', async () => {
  const sizes = new Map<string, (width: number, height: number) => void>();
  jest.mocked(Image.getSize).mockImplementation((uri, callback) => { sizes.set(uri, callback!); });
  const view = await render(<GeneratedImageGallery message={message({ generatedImages: [complete(1), complete(2)] })} fresh={false} onPreview={jest.fn()} />);
  await fireEvent(view.getByTestId('generated-image-gallery'), 'layout', { nativeEvent: { layout: { width: 400, height: 400 } } });
  await fireEvent.press(view.getByLabelText('第 2 张图片'));
  await act(async () => { sizes.get('file:///images/2.png')!(100, 200); });
  const measuredHeight = StyleSheet.flatten(view.getByTestId('generated-image-stage').props.style).height;
  expect(measuredHeight).toBe(420);
  await act(async () => { sizes.get('file:///images/1.png')!(200, 100); });
  expect(StyleSheet.flatten(view.getByTestId('generated-image-stage').props.style).height).toBe(measuredHeight);
  expect(view.getByTestId('generated-image-main').props.source.uri).toBe('file:///images/2.png');
});

test('a late error from an unmounted image cannot poison that result when it is selected again', async () => {
  const view = await render(<GeneratedImageGallery message={message({ generatedImages: [complete(1), complete(2)] })} fresh={false} onPreview={jest.fn()} />);
  const obsoleteError = view.getByTestId('generated-image-main').props.onError;
  await fireEvent.press(view.getByLabelText('第 2 张图片'));
  await act(async () => { obsoleteError({ nativeEvent: { error: 'cancelled native load' } }); });
  expect(view.getByTestId('generated-image-main').props.source.uri).toBe('file:///images/2.png');
  await fireEvent.press(view.getByLabelText('第 1 张图片'));
  expect(view.getByLabelText('查看第 1 张大图')).toBeTruthy();
  expect(view.queryByText('图片无法显示')).toBeNull();
});

test('legacy single images retain preview and real image actions without a thumbnail rail', async () => {
  const preview = jest.fn(), edit = jest.fn(), share = jest.fn();
  const view = await render(<GeneratedImageGallery message={message({ imageUri: 'file:///images/old.png' })} fresh={false} onPreview={preview} onEdit={edit} onShare={share} />);
  expect(view.queryByTestId('generated-image-thumbnails')).toBeNull();
  await fireEvent.press(view.getByLabelText('查看大图'));
  await fireEvent.press(view.getByLabelText('编辑当前图片'));
  await fireEvent.press(view.getByLabelText('分享当前图片'));
  for (const action of [edit, share]) expect(action).toHaveBeenCalledWith('file:///images/old.png');
  expect(preview).toHaveBeenCalledWith('file:///images/old.png', [expect.objectContaining({ uri: 'file:///images/old.png', status: 'complete' })]);
});

test('selection changes the main image and every action URI, with the first successful image preferred', async () => {
  const preview = jest.fn(), edit = jest.fn(), share = jest.fn(), save = jest.fn();
  const view = await render(<GeneratedImageGallery message={message({ generatedImages: [{ id: 'waiting', uri: null, status: 'pending' }, complete(2), complete(3)] })}
    fresh={false} onPreview={preview} onEdit={edit} onShare={share}
    renderActions={(uri) => uri ? <Pressable accessibilityLabel="保存选中图" onPress={() => save(uri)}><Text>保存</Text></Pressable> : null} />);
  expect(view.getByLabelText('第 2 张图片').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByLabelText('第 3 张图片'));
  expect(view.getByLabelText('第 2 张图片').props.accessibilityState.selected).toBe(false);
  expect(view.getByLabelText('第 3 张图片').props.accessibilityState.selected).toBe(true);
  expect(view.getByTestId('generated-image-main').props.source).toEqual({ uri: 'file:///images/3.png' });
  await fireEvent.press(view.getByLabelText('查看第 3 张大图'));
  await fireEvent.press(view.getByLabelText('编辑当前图片'));
  await fireEvent.press(view.getByLabelText('分享当前图片'));
  await fireEvent.press(view.getByLabelText('保存选中图'));
  for (const action of [edit, share, save]) expect(action).toHaveBeenCalledWith('file:///images/3.png');
  expect(preview).toHaveBeenCalledWith('file:///images/3.png', [
    expect.objectContaining({ id: 'waiting', status: 'pending' }), expect.objectContaining({ id: 'image-2' }), expect.objectContaining({ id: 'image-3' }),
  ]);
});

test('ten results fit a narrow companion column as a grid with at least 44 dp targets', async () => {
  const view = await render(<GeneratedImageGallery message={message({ generatedImages: Array.from({ length: 12 }, (_, index) => complete(index + 1)) })} fresh={false} onPreview={jest.fn()} />);
  await fireEvent(view.getByTestId('generated-image-gallery'), 'layout', { nativeEvent: { layout: { width: 209, height: 400 } } });
  expect(view.queryByLabelText('第 11 张图片')).toBeNull();
  const stage = StyleSheet.flatten(view.getByTestId('generated-image-stage').props.style);
  const rail = StyleSheet.flatten(view.getByTestId('generated-image-thumbnails').props.style);
  const thumb = StyleSheet.flatten(view.getByLabelText('第 10 张图片').props.style);
  expect(thumb.width).toBeGreaterThanOrEqual(44);
  expect(thumb.height).toBeGreaterThanOrEqual(44);
  // The selected image sits above a wrapping grid of results, both within the column.
  expect(Number(stage.width)).toBeLessThanOrEqual(209);
  expect(Number(rail.width)).toBeLessThanOrEqual(209);
  expect(Number(thumb.width) * 4 + 6 * 3).toBeLessThanOrEqual(209);
  await fireEvent.press(view.getByLabelText('第 10 张图片'));
  expect(view.getByLabelText('查看第 10 张大图')).toBeTruthy();
  expect(view.getByText('10 / 10')).toBeTruthy();
});

test.each([4, 5, 10])('%i-image batches preserve an explicit pending selection as the list and downloads arrive', async (count) => {
  const preview = jest.fn();
  const view = await render(<GeneratedImageGallery message={message({ status: 'pending', imageCount: count, generatedImages: [pendingImage(1), pendingImage(2), pendingImage(3)] })} fresh={false} onPreview={preview} />);
  await fireEvent.press(view.getByLabelText('第 3 张图片'));
  const full = Array.from({ length: count }, (_, index) => index === 0 ? complete(1) : pendingImage(index + 1));
  await view.rerender(<GeneratedImageGallery message={message({ status: 'pending', imageCount: count, generatedImages: full })} fresh={false} onPreview={preview} />);
  expect(view.getByLabelText('第 3 张图片').props.accessibilityState.selected).toBe(true);
  expect(view.getByText(`3 / ${count}`)).toBeTruthy();
  expect(view.getByText('正在绘制')).toBeTruthy();
  await view.rerender(<GeneratedImageGallery message={message({ imageCount: count, generatedImages: Array.from({ length: count }, (_, index) => complete(index + 1)) })} fresh={false} onPreview={preview} />);
  expect(view.getByLabelText('第 3 张图片').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByLabelText('查看第 3 张大图'));
  expect(preview).toHaveBeenCalledWith('file:///images/3.png', expect.any(Array));
  expect(preview.mock.calls[0][1]).toHaveLength(count);
});

test.each([4, 5, 10])('%i-image batches keep the first completed preview when earlier positions finish later', async (count) => {
  const initial = Array.from({ length: count }, (_, index) => pendingImage(index + 1));
  const view = await render(<GeneratedImageGallery message={message({ status: 'pending', generatedImages: initial })} fresh={false} onPreview={jest.fn()} />);
  const firstDelivery = initial.map((image, index) => index === count - 1 ? complete(count) : image);
  await view.rerender(<GeneratedImageGallery message={message({ status: 'pending', generatedImages: firstDelivery })} fresh={false} onPreview={jest.fn()} />);
  expect(view.getByLabelText(`查看第 ${count} 张大图`)).toBeTruthy();
  await view.rerender(<GeneratedImageGallery message={message({ generatedImages: Array.from({ length: count }, (_, index) => complete(index + 1)) })} fresh={false} onPreview={jest.fn()} />);
  expect(view.getByLabelText(`查看第 ${count} 张大图`)).toBeTruthy();
  expect(view.getByLabelText(`第 ${count} 张图片`).props.accessibilityState.selected).toBe(true);
});

test('regenerating the same message with reused slot IDs clears previous selection and decode errors', async () => {
  const results = Array.from({ length: 4 }, (_, index) => complete(index + 1));
  const view = await render(<GeneratedImageGallery message={message({ generatedImages: results })} fresh={false} onPreview={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('第 4 张图片'));
  await fireEvent(view.getByTestId('generated-image-main'), 'error', { nativeEvent: { error: 'obsolete decoder result' } });
  await fireEvent.press(view.getByLabelText('第 3 张图片'));
  await view.rerender(<GeneratedImageGallery message={message({ status: 'pending', generatedImages: results.map((_, index) => pendingImage(index + 1)) })} fresh={false} onPreview={jest.fn()} />);
  expect(view.getByLabelText('第 1 张图片').props.accessibilityState.selected).toBe(true);
  // Reuse even the same local URI to check the new batch cannot inherit old view-only errors.
  await view.rerender(<GeneratedImageGallery message={message({ generatedImages: results })} fresh={false} onPreview={jest.fn()} />);
  expect(view.getByLabelText('查看第 1 张大图')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('第 4 张图片'));
  expect(view.getByLabelText('查看第 4 张大图')).toBeTruthy();
  expect(view.queryByText('图片无法显示')).toBeNull();
});

test('retrying one downloaded artifact preserves the selected slot throughout pending and success', async () => {
  const failed: GeneratedImage = { id: 'image-4', uri: null, remoteUrl: 'https://images.example/4.png', status: 'error', error: '下载中断' };
  const previous = [complete(1), complete(2), complete(3), failed];
  const view = await render(<GeneratedImageGallery message={message({ generatedImages: previous })} fresh={false} onPreview={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('第 4 张图片'));
  await view.rerender(<GeneratedImageGallery message={message({ status: 'pending', generatedImages: [...previous.slice(0, 3), { ...failed, status: 'pending', error: null }] })} fresh={false} onPreview={jest.fn()} downloading />);
  expect(view.getByLabelText('第 4 张图片').props.accessibilityState.selected).toBe(true);
  expect(view.getByText('正在取回图片')).toBeTruthy();
  await view.rerender(<GeneratedImageGallery message={message({ generatedImages: [...previous.slice(0, 3), complete(4)] })} fresh={false} onPreview={jest.fn()} />);
  expect(view.getByLabelText('查看第 4 张大图')).toBeTruthy();
});

test.each([4, 5, 10])('%i-image landscape batches fill the 280 dp column and preserve their natural ratio', async (count) => {
  const view = await render(<GeneratedImageGallery message={message({ size: '2048x1024', generatedImages: Array.from({ length: count }, (_, index) => complete(index + 1)) })}
    fresh={false} onPreview={jest.fn()} onEdit={jest.fn()} onShare={jest.fn()} />);
  await fireEvent(view.getByTestId('generated-image-gallery'), 'layout', { nativeEvent: { layout: { width: 280, height: 200 } } });
  const stage = StyleSheet.flatten(view.getByTestId('generated-image-stage').props.style);
  expect(stage.width).toBe(280);
  expect(stage.height).toBe(140);
  expect(stage.borderRadius).toBe(14);
  expect(StyleSheet.flatten(view.getByLabelText('编辑当前图片').props.style).minHeight).toBeGreaterThanOrEqual(44);
  expect(StyleSheet.flatten(view.getByLabelText('分享当前图片').props.style).height).toBeGreaterThanOrEqual(44);
});

test('an individual failed result keeps the other images usable and retries only its remote download', async () => {
  const retry = jest.fn(), share = jest.fn();
  const view = await render(<GeneratedImageGallery message={message({ generatedImages: [complete(1), { id: 'failure', uri: null, status: 'error', error: '连接中断', remoteUrl: 'https://images.example/2.png' }] })}
    fresh={false} onPreview={jest.fn()} onShare={share} onRetryImage={retry} />);
  expect(view.getByLabelText('查看第 1 张大图')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('第 2 张图片'));
  expect(view.getByText('连接中断')).toBeTruthy();
  expect(view.getByText('图片未下载')).toBeTruthy();
  expect(view.queryByLabelText('分享当前图片')).toBeNull();
  await fireEvent.press(view.getByLabelText('重新下载第 2 张图片'));
  expect(retry).toHaveBeenCalledWith('failure', undefined);
  await fireEvent.press(view.getByLabelText('第 1 张图片'));
  await fireEvent.press(view.getByLabelText('分享当前图片'));
  expect(share).toHaveBeenCalledWith('file:///images/1.png');
});

test('a decode-failed local image requests its exact file replacement and stays unavailable until the new URI arrives', async () => {
  const retry = jest.fn();
  const broken = { ...complete(1), remoteUrl: 'https://images.example/1.png' };
  const view = await render(<GeneratedImageGallery message={message({ generatedImages: [broken, complete(2)] })}
    fresh={false} onPreview={jest.fn()} onRetryImage={retry} />);
  const obsoleteError = view.getByTestId('generated-image-main').props.onError;
  await fireEvent(view.getByTestId('generated-image-main'), 'error', { nativeEvent: { error: 'bad image bytes' } });
  expect(view.getByText('图片无法显示')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('重新下载第 1 张图片'));
  expect(retry).toHaveBeenCalledWith('image-1', 'file:///images/1.png');
  expect(view.queryByTestId('generated-image-main')).toBeNull();
  expect(view.getByText('图片无法显示')).toBeTruthy();
  await view.rerender(<GeneratedImageGallery message={message({ status: 'pending', generatedImages: [{ ...broken, status: 'pending' }, complete(2)] })}
    fresh={false} onPreview={jest.fn()} onRetryImage={retry} downloading />);
  expect(view.getByText('正在取回图片')).toBeTruthy();
  expect(view.queryByLabelText('重新下载第 1 张图片')).toBeNull();
  await view.rerender(<GeneratedImageGallery message={message({ generatedImages: [{ ...broken, uri: 'file:///images/1-replacement.png' }, complete(2)] })}
    fresh={false} onPreview={jest.fn()} onRetryImage={retry} />);
  await act(async () => { obsoleteError({ nativeEvent: { error: 'obsolete bad image bytes' } }); });
  expect(view.getByTestId('generated-image-main').props.source.uri).toBe('file:///images/1-replacement.png');
  expect(view.queryByText('图片无法显示')).toBeNull();
  expect(view.queryByLabelText('重新下载第 1 张图片')).toBeNull();
});

test.each(['chat', 'companion'] as const)('%s forwards the decoded-failure URI with the selected message and image', async (surface) => {
  const retry = jest.fn();
  const current = message({ generatedImages: [complete(1), { ...complete(2), remoteUrl: 'https://images.example/2.png' }] });
  const common = { message: current, phase: 'idle' as const, isLast: false,
    onStop: jest.fn(), onRetry: jest.fn(), onPreview: jest.fn(), onSave: jest.fn(), onShare: jest.fn(), onRetryImage: retry };
  const view = await render(surface === 'chat' ? <MessageBubble {...common} />
    : <CompanionMessage {...common} character={{ id: 'character', name: '暖暖', color: '#8B8AFF' } as Character}
      fresh={false} timeLabel={null} reaction={undefined} onLongPress={jest.fn()} onReact={jest.fn()} onPoke={jest.fn()} onOpenTrail={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('第 2 张图片'));
  await fireEvent(view.getByTestId('generated-image-main'), 'error', { nativeEvent: { error: 'bad image bytes' } });
  await fireEvent.press(view.getByLabelText('重新下载第 2 张图片'));
  expect(retry).toHaveBeenCalledWith(current, 'image-2', 'file:///images/2.png');
});

test('pending results expose progress and stop while a failure without a remote URL has no fake retry', async () => {
  const stop = jest.fn();
  const pendingMessage = message({ status: 'pending', generatedImages: [{ id: 'waiting', uri: null, status: 'pending' }, { id: 'failure', uri: null, status: 'error', error: '上游拒绝生成' }] });
  const view = await render(<GeneratedImageGallery message={pendingMessage} fresh={false} onPreview={jest.fn()} onStop={stop} onRetryImage={jest.fn()} />);
  expect(view.getByText('正在绘制')).toBeTruthy();
  expect(view.getByText('0 / 2 已完成')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('停止绘制'));
  expect(stop).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('第 2 张图片'));
  expect(view.getByText('上游拒绝生成')).toBeTruthy();
  expect(view.queryByLabelText('重新下载第 2 张图片')).toBeNull();
});

test('a decode failure affects only that image, and another message does not inherit the selection', async () => {
  const view = await render(<GeneratedImageGallery message={message({ generatedImages: [complete(1), complete(2)] })} fresh={false} onPreview={jest.fn()} />);
  await fireEvent(view.getByTestId('generated-image-main'), 'error', { nativeEvent: { error: 'bad bytes' } });
  expect(view.getByText('图片无法显示')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('第 2 张图片'));
  expect(view.getByLabelText('查看第 2 张大图')).toBeTruthy();
  await view.rerender(<GeneratedImageGallery message={message({ id: 'different-message', generatedImages: [complete(3), complete(4)] })} fresh={false} onPreview={jest.fn()} />);
  expect(view.getByLabelText('第 1 张图片').props.accessibilityState.selected).toBe(true);
  expect(view.getByTestId('generated-image-main').props.source.uri).toBe('file:///images/3.png');
});

test('the assistant message toolbar saves the selected result rather than the legacy first URI', async () => {
  const save = jest.fn(), share = jest.fn(), edit = jest.fn();
  const view = await render(<MessageBubble message={message({ imageUri: 'file:///images/1.png', generatedImages: [complete(1), complete(2)] })}
    phase="idle" isLast={false} onStop={jest.fn()} onRetry={jest.fn()} onPreview={jest.fn()} onSave={save} onShare={share} onEditImage={edit} />);
  await fireEvent.press(view.getByLabelText('第 2 张图片'));
  await fireEvent.press(view.getByLabelText('保存到相册'));
  await fireEvent.press(view.getByLabelText('分享当前图片'));
  await fireEvent.press(view.getByLabelText('编辑当前图片'));
  for (const action of [save, share, edit]) expect(action).toHaveBeenCalledWith('file:///images/2.png');
});

test('a multi-image reply omits the ambiguous follow-ups that refer to the last image', async () => {
  const view = await render(<MessageBubble message={message({ generatedImages: [complete(1), complete(2)] })}
    phase="idle" isLast onStop={jest.fn()} onRetry={jest.fn()} onPreview={jest.fn()} onSave={jest.fn()} onShare={jest.fn()} onFollowUp={jest.fn()} />);
  expect(view.queryByLabelText('换个风格')).toBeNull();
  await view.rerender(<MessageBubble message={message({ generatedImages: [complete(1)] })}
    phase="idle" isLast onStop={jest.fn()} onRetry={jest.fn()} onPreview={jest.fn()} onSave={jest.fn()} onShare={jest.fn()} onFollowUp={jest.fn()} />);
  expect(view.getByLabelText('换个风格')).toBeTruthy();
});

test('the companion message exposes the same selected-result actions', async () => {
  const save = jest.fn(), share = jest.fn(), edit = jest.fn();
  const character = { id: 'character', name: '暖暖', color: '#8B8AFF' } as Character;
  const view = await render(<CompanionMessage message={message({ imageUri: 'file:///images/1.png', generatedImages: [complete(1), complete(2)] })}
    character={character} phase="idle" isLast={false} fresh={false} timeLabel={null} reaction={undefined} onStop={jest.fn()}
    onRetry={jest.fn()} onPreview={jest.fn()} onSave={save} onShare={share} onEditImage={edit} onLongPress={jest.fn()} onReact={jest.fn()} onPoke={jest.fn()} onOpenTrail={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('第 2 张图片'));
  await fireEvent.press(view.getByLabelText('保存到相册'));
  await fireEvent.press(view.getByLabelText('分享当前图片'));
  await fireEvent.press(view.getByLabelText('编辑当前图片'));
  for (const action of [save, share, edit]) expect(action).toHaveBeenCalledWith('file:///images/2.png');
});
