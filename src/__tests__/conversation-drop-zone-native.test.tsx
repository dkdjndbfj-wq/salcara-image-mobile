import React, { useState } from 'react';
import { Pressable, Text, TextInput } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ConversationDropZone, type ConversationFilesHandle } from '../remote/ConversationDropZone';
import { appendComposerFiles, type ComposerFiles } from '../remote/composer-files';
import { splitPastedText } from '../remote/pasted-text';

const mockPicker = jest.fn(), mockInfo = jest.fn(), mockRead = jest.fn(), mockPrepareImage = jest.fn(), mockToast = jest.fn();
jest.mock('expo-document-picker', () => ({ getDocumentAsync: (...args: unknown[]) => mockPicker(...args) }));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: (...args: unknown[]) => mockInfo(...args), readAsStringAsync: (...args: unknown[]) => mockRead(...args), EncodingType: { Base64: 'base64', UTF8: 'utf8' } }));
jest.mock('../remote/attachments', () => ({ prepareRemoteImage: (...args: unknown[]) => mockPrepareImage(...args) }));
jest.mock('../components/ui', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));
const originalDecoder = global.TextDecoder;
beforeAll(() => { global.TextDecoder = require('node:util').TextDecoder; });
afterAll(() => { global.TextDecoder = originalDecoder; });
const asset = (name = 'source.ts') => ({ uri: `file://cache/${name}`, name, mimeType: '' });
const image = { uri: 'file://prepared.png', base64: 'YWJjZA==', mime: 'image/png' as const, width: 2, height: 2 };
beforeEach(() => {
  jest.clearAllMocks();mockPicker.mockResolvedValue({ canceled: false, assets: [asset()] });
  mockInfo.mockResolvedValue({ exists: true, isDirectory: false, size: 24 });
  mockRead.mockResolvedValue(Buffer.from('exact file text', 'utf8').toString('base64'));
  mockPrepareImage.mockResolvedValue(image);
});
const ref = () => ({ current: undefined as ConversationFilesHandle | undefined });
async function pick(importRef: ReturnType<typeof ref>) { await act(async () => { importRef.current!.pick(); }); }
function Harness({ importRef, onSend }: { importRef: ReturnType<typeof ref>; onSend: () => void }) {
  const [draft, setDraft] = useState({ text: 'Keep my draft', images: [] as typeof image[] });
  return <ConversationDropZone scopeKey="pc-a/session-a/api-a" enabled importRef={importRef} onFiles={async files => { setDraft(current => appendComposerFiles(current, files));return true; }}>
    <TextInput accessibilityLabel="draft" value={draft.text} /><Text testID="image-count">{draft.images.length}</Text>
    <Pressable accessibilityLabel="send" onPress={onSend}><Text>send</Text></Pressable>
  </ConversationDropZone>;
}

test('native picker appends complete text and prepared images to the draft without sending', async () => {
  const importRef = ref(), send = jest.fn(), text = '  中文🙂\r\nconst text = "replacement �";\n';
  mockPicker.mockResolvedValue({ canceled: false, assets: [asset(), asset('picture.png')] });
  mockRead.mockResolvedValue(Buffer.from(text, 'utf8').toString('base64'));
  const view = await render(<Harness importRef={importRef} onSend={send} />);await pick(importRef);
  await waitFor(() => expect(mockToast).toHaveBeenCalledWith('已加入草稿', 'check'));
  expect(splitPastedText(view.getByLabelText('draft').props.value)).toEqual({ prompt: 'Keep my draft', attachments: [{ name: 'source.ts', text }] });
  expect(view.getByTestId('image-count').props.children).toBe(1);expect(send).not.toHaveBeenCalled();
  expect(mockRead).toHaveBeenCalledWith('file://cache/source.ts', { encoding: 'base64' });
  expect(mockPrepareImage).toHaveBeenCalledWith({ uri: 'file://cache/picture.png' });
  expect(mockPicker).toHaveBeenCalledWith({ type: '*/*', multiple: true, copyToCacheDirectory: true });
  await fireEvent.press(view.getByLabelText('send'));expect(send).toHaveBeenCalledTimes(1);
});

test('canceling the picker makes no draft or error change and permits another selection', async () => {
  const importRef = ref(), onFiles = jest.fn(async () => true);
  mockPicker.mockResolvedValueOnce({ canceled: true, assets: null });
  await render(<ConversationDropZone scopeKey="pc/session" enabled importRef={importRef} onFiles={onFiles}>{null}</ConversationDropZone>);
  await pick(importRef);expect(onFiles).not.toHaveBeenCalled();expect(mockRead).not.toHaveBeenCalled();expect(mockToast).not.toHaveBeenCalled();
  await pick(importRef);await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
});

test('one unsupported file rejects a mixed selection before reading any of its files', async () => {
  const importRef = ref(), onFiles = jest.fn(async () => true);
  mockPicker.mockResolvedValue({ canceled: false, assets: [asset(), asset('archive.zip')] });
  await render(<ConversationDropZone scopeKey="pc/session" enabled importRef={importRef} onFiles={onFiles}>{null}</ConversationDropZone>);
  await pick(importRef);await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('暂不支持'), 'alert'));
  expect(mockInfo).not.toHaveBeenCalled();expect(mockRead).not.toHaveBeenCalled();expect(onFiles).not.toHaveBeenCalled();
});

test.each([
  { name: 'invalid UTF-8', encoded: Buffer.from([0xc3, 0x28]).toString('base64'), message: '不是有效的 UTF-8' },
  { name: 'binary text', encoded: Buffer.from('a\0b').toString('base64'), message: '含二进制' },
  { name: 'too many characters', encoded: Buffer.from('x'.repeat(40001)).toString('base64'), message: '40,000' },
])('rejects $name without appending any part of a mixed batch', async ({ encoded, message }) => {
  const importRef = ref(), onFiles = jest.fn(async () => true);
  mockPicker.mockResolvedValue({ canceled: false, assets: [asset('good.ts'), asset('bad.ts')] });
  mockRead.mockResolvedValueOnce(Buffer.from('valid content').toString('base64')).mockResolvedValueOnce(encoded);
  await render(<ConversationDropZone scopeKey="pc/session" enabled importRef={importRef} onFiles={onFiles}>{null}</ConversationDropZone>);
  await pick(importRef);await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining(message), 'alert'));
  expect(onFiles).not.toHaveBeenCalled();
});

test.each([
  { name: 'too many total files', assets: Array.from({ length: 9 }, (_, index) => asset(`${index}.ts`)), stat: undefined, message: '最多选择 8' },
  { name: 'too many images', assets: Array.from({ length: 5 }, (_, index) => asset(`${index}.png`)), stat: undefined, message: '最多添加 4' },
  { name: 'oversized text', assets: [asset()], stat: { exists: true, size: 1024 * 1024 + 1 }, message: '过大' },
  { name: 'oversized image', assets: [asset('huge.png')], stat: { exists: true, size: 8 * 1024 * 1024 + 1 }, message: '过大' },
  { name: 'empty file', assets: [asset()], stat: { exists: true, size: 0 }, message: '为空' },
  { name: 'missing file', assets: [asset()], stat: { exists: false }, message: '为空' },
])('native limits match web limits for $name', async ({ assets, stat, message }) => {
  const importRef = ref(), onFiles = jest.fn(async () => true);
  mockPicker.mockResolvedValue({ canceled: false, assets });if (stat) mockInfo.mockResolvedValue(stat);
  await render(<ConversationDropZone scopeKey="pc/session" enabled importRef={importRef} onFiles={onFiles}>{null}</ConversationDropZone>);
  await pick(importRef);await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining(message), 'alert'));
  expect(mockRead).not.toHaveBeenCalled();expect(mockPrepareImage).not.toHaveBeenCalled();expect(onFiles).not.toHaveBeenCalled();
});

test('switching scope while reading never appends old files to the new draft and stale handles cannot pick', async () => {
  const importRef = ref(), oldFiles = jest.fn(async () => true), newFiles = jest.fn(async () => true);
  let finish!: (encoded: string) => void;mockRead.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  const view = await render(<ConversationDropZone scopeKey="pc-a/session-a/api-a" enabled importRef={importRef} onFiles={oldFiles}>{null}</ConversationDropZone>);
  const oldHandle = importRef.current!;await pick(importRef);await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(1));
  await view.rerender(<ConversationDropZone scopeKey="pc-b/session-b/api-b" enabled importRef={importRef} onFiles={newFiles}>{null}</ConversationDropZone>);
  await act(async () => { oldHandle.pick();finish(Buffer.from('old scope content').toString('base64')); });
  expect(mockPicker).toHaveBeenCalledTimes(1);expect(oldFiles).not.toHaveBeenCalled();expect(newFiles).not.toHaveBeenCalled();expect(mockToast).not.toHaveBeenCalled();
  await pick(importRef);await waitFor(() => expect(newFiles).toHaveBeenCalledTimes(1));
});

test('disabled and unmounted pickers cannot launch and concurrent picker calls are ignored', async () => {
  const importRef = ref(), onFiles = jest.fn(async () => true);let finish!: (value: unknown) => void;
  const view = await render(<ConversationDropZone scopeKey="pc/session" enabled={false} importRef={importRef} onFiles={onFiles}>{null}</ConversationDropZone>);
  await pick(importRef);expect(mockPicker).not.toHaveBeenCalled();
  await view.rerender(<ConversationDropZone scopeKey="pc/session" enabled importRef={importRef} onFiles={onFiles}>{null}</ConversationDropZone>);
  mockPicker.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await pick(importRef);await pick(importRef);expect(mockPicker).toHaveBeenCalledTimes(1);
  const oldHandle = importRef.current!;await view.unmount();expect(importRef.current).toBeUndefined();
  await act(async () => { oldHandle.pick();finish({ canceled: false, assets: [asset()] }); });
  expect(mockRead).not.toHaveBeenCalled();expect(onFiles).not.toHaveBeenCalled();
});

test('an appender that declines a stale draft produces no success message', async () => {
  const importRef = ref(), onFiles = jest.fn(async (_batch: ComposerFiles) => false);
  await render(<ConversationDropZone scopeKey="pc/session" enabled importRef={importRef} onFiles={onFiles}>{null}</ConversationDropZone>);
  await pick(importRef);await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));expect(mockToast).not.toHaveBeenCalled();
});

test.each(['scope', 'enabled'] as const)('a %s round trip invalidates an old picker and its handle without unlocking a new picker', async transition => {
  const importRef = ref(), onFiles = jest.fn(async () => true);
  let finishOld!: (value: unknown) => void, finishNew!: (value: unknown) => void;
  mockPicker.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  const component = (scopeKey: string, enabled: boolean) => <ConversationDropZone scopeKey={scopeKey} enabled={enabled} importRef={importRef} onFiles={onFiles}>{null}</ConversationDropZone>;
  const view = await render(component('pc-a/session/api', true));const staleHandle = importRef.current!;
  await pick(importRef);
  await view.rerender(component(transition === 'scope' ? 'pc-b/session/api' : 'pc-a/session/api', transition !== 'enabled'));
  await view.rerender(component('pc-a/session/api', true));
  await act(async () => staleHandle.pick());expect(mockPicker).toHaveBeenCalledTimes(1);
  await pick(importRef);expect(mockPicker).toHaveBeenCalledTimes(2);
  await act(async () => finishOld({ canceled: false, assets: [asset('stale.ts')] }));
  expect(onFiles).not.toHaveBeenCalled();expect(mockRead).not.toHaveBeenCalled();expect(mockToast).not.toHaveBeenCalled();
  await pick(importRef);expect(mockPicker).toHaveBeenCalledTimes(2);
  await act(async () => finishNew({ canceled: false, assets: [asset('current.ts')] }));
  await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
  expect(onFiles).toHaveBeenCalledWith({ texts: [{ name: 'current.ts', text: 'exact file text' }], images: [] });
});

test.each(['scope', 'enabled'] as const)('a %s round trip during reading discards the old bytes and allows a fresh import', async transition => {
  const importRef = ref(), onFiles = jest.fn(async () => true);let finish!: (value: string) => void;
  mockRead.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  const component = (scopeKey: string, enabled: boolean) => <ConversationDropZone scopeKey={scopeKey} enabled={enabled} importRef={importRef} onFiles={onFiles}>{null}</ConversationDropZone>;
  const view = await render(component('pc-a/session/api', true));await pick(importRef);
  await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(1));
  await view.rerender(component(transition === 'scope' ? 'pc-b/session/api' : 'pc-a/session/api', transition !== 'enabled'));
  await view.rerender(component('pc-a/session/api', true));
  await act(async () => finish(Buffer.from('stale byte contents').toString('base64')));
  expect(onFiles).not.toHaveBeenCalled();expect(mockToast).not.toHaveBeenCalled();
  await pick(importRef);await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
  expect(onFiles).toHaveBeenCalledWith({ texts: [{ name: 'source.ts', text: 'exact file text' }], images: [] });
});
