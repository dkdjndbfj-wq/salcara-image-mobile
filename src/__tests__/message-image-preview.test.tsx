import React from 'react';
import { act, render } from '@testing-library/react-native';

import type { ChatMessage, GeneratedImage, ReferenceImage } from '../domain';
import { useMessageImagePreview } from '../components/useMessageImagePreview';

const complete = (n: number): GeneratedImage => ({ id: `image-${n}`, uri: `file:///generated/${n}.png`, status: 'complete' });
const message = (images: GeneratedImage[], patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'message', conversationId: 'conversation', role: 'assistant', prompt: '', preparedPrompt: '风景', mode: 'generate', status: 'complete',
  providerId: 'provider', model: 'image-model', quality: 'auto', size: '1024x1024', transparent: false, imageUri: null, remoteImageUrl: null,
  references: [], maskUri: null, error: null, elapsedMs: 1, createdAt: 1, generatedImages: images, ...patch,
});
let preview: ReturnType<typeof useMessageImagePreview>;
function Probe({ context = 'conversation', messages }: { context?: string; messages: ChatMessage[] }) {
  preview = useMessageImagePreview(context, messages);
  return null;
}

test.each([1, 4, 5, 10])('%i-image preview opens the selected image and remains inside its owning message', async (count) => {
  const images = Array.from({ length: count }, (_, index) => complete(index + 1));
  const selected = images[Math.min(2, count - 1)].uri!;
  await render(<Probe messages={[message(images), message([complete(99)], { id: 'other' })]} />);
  await act(async () => { preview.open('message', selected, images); });
  expect(preview.uri).toBe(selected);
  expect(preview.images?.map((image) => image.id)).toEqual(images.map((image) => image.id));
  await act(async () => { preview.onSelect('file:///generated/99.png'); });
  expect(preview.uri).toBe(selected);
  await act(async () => { preview.onSelect(images[count - 1].uri!); });
  expect(preview.uri).toBe(images[count - 1].uri);
});

test('late results extend navigation without moving the selection or compressing failed slots', async () => {
  const initial: GeneratedImage[] = [{ id: 'image-1', uri: null, status: 'error' }, complete(2), { id: 'image-3', uri: null, status: 'pending' }];
  const view = await render(<Probe messages={[message(initial, { status: 'pending' })]} />);
  await act(async () => { preview.open('message', complete(2).uri!, initial); });
  await view.rerender(<Probe messages={[message([initial[0], complete(2), complete(3)])]} />);
  expect(preview.uri).toBe(complete(2).uri);
  expect(preview.images?.map((image) => image.status)).toEqual(['error', 'complete', 'complete']);
  await act(async () => { preview.onSelect(complete(3).uri!); });
  expect(preview.uri).toBe(complete(3).uri);
});

test('switching away and back retires old open and swipe callbacks', async () => {
  const images = [complete(1), complete(2)], messages = [message(images)];
  const view = await render(<Probe messages={messages} />);
  await act(async () => { preview.open('message', images[0].uri!, images); });
  const oldOpen = preview.open, oldSelect = preview.onSelect;
  await view.rerender(<Probe context="another" messages={messages} />);
  expect(preview.uri).toBeNull();
  await view.rerender(<Probe messages={messages} />);
  await act(async () => { oldOpen('message', images[0].uri!, images); oldSelect(images[1].uri!); });
  expect(preview.uri).toBeNull();
});

test('callbacks from a closed preview cannot change or close a new preview', async () => {
  const images = [complete(1), complete(2), complete(3)];
  await render(<Probe messages={[message(images)]} />);
  await act(async () => { preview.open('message', images[0].uri!, images); });
  const oldSelect = preview.onSelect, oldClose = preview.onClose;
  await act(async () => { preview.onClose(); });
  await act(async () => { preview.open('message', images[2].uri!, images); });
  await act(async () => { oldSelect(images[1].uri!); oldClose(); });
  expect(preview.uri).toBe(images[2].uri);
});

test.each(['delete', 'regenerate', 'replace file'] as const)('%s retires the current preview and stale navigation', async (change) => {
  const images = [complete(1), complete(2)];
  const view = await render(<Probe messages={[message(images)]} />);
  await act(async () => { preview.open('message', images[0].uri!, images); });
  const oldSelect = preview.onSelect;
  const next = change === 'delete' ? [] : [message(change === 'regenerate'
    ? images.map((image) => ({ ...image, uri: null, status: 'pending' as const }))
    : [{ ...images[0], uri: 'file:///generated/replaced.png' }, images[1]])];
  await view.rerender(<Probe messages={next} />);
  await act(async () => { oldSelect(images[1].uri!); });
  expect(preview.uri).toBeNull();
});

test('single attachment previews do not inherit a prior generated batch', async () => {
  const images = [complete(1), complete(2)];
  await render(<Probe messages={[message(images, { references: [{ id: 'upload', uri: 'file:///upload.png', name: 'upload.png', mimeType: 'image/png', size: 1 }] })]} />);
  await act(async () => { preview.open('message', images[0].uri!, images); });
  await act(async () => { preview.open('message', 'file:///upload.png'); });
  expect(preview.uri).toBe('file:///upload.png');
  expect(preview.images).toBeUndefined();
  await act(async () => { preview.onSelect(images[1].uri!); });
  expect(preview.uri).toBe('file:///upload.png');
});

test('replacing a single attachment retires its preview and old click callback', async () => {
  const reference: ReferenceImage = { id: 'upload', uri: 'file:///upload.png', name: 'upload.png', mimeType: 'image/png', size: 1 };
  const view = await render(<Probe messages={[message([], { references: [reference] })]} />);
  await act(async () => { preview.open('message', reference.uri); });
  const oldOpen = preview.open;
  await view.rerender(<Probe messages={[message([], { references: [{ ...reference, uri: 'file:///replacement.png' }] })]} />);
  expect(preview.uri).toBeNull();
  await act(async () => { oldOpen('message', reference.uri); });
  expect(preview.uri).toBeNull();
});

test('known unreadable files remain excluded until the result is redownloaded', async () => {
  const images = [complete(1), complete(2)];
  const view = await render(<Probe messages={[message(images)]} />);
  await act(async () => { preview.open('message', images[0].uri!, [images[0], { ...images[1], status: 'error' }]); });
  expect(preview.images?.[1].status).toBe('error');
  await act(async () => { preview.onSelect(images[1].uri!); });
  expect(preview.uri).toBe(images[0].uri);
  await view.rerender(<Probe messages={[message([images[0], { ...images[1], uri: 'file:///generated/repaired.png' }])]} />);
  await act(async () => { preview.onSelect('file:///generated/repaired.png'); });
  expect(preview.uri).toBe('file:///generated/repaired.png');
});
