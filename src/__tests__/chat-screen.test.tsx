import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { ChatMessage, DocumentAttachment, ProviderProfile, ReferenceImage } from '../domain';
import type { useApp } from '../state/AppContext';

let mockApp: ReturnType<typeof useApp>;
const mockPickGallery = jest.fn();
const mockPickFiles = jest.fn();
const mockCreateReference = jest.fn();
const mockDeleteLocal = jest.fn();

jest.mock('../state/AppContext', () => ({ useApp: () => mockApp }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../components/MotionPressable', () => ({ MotionPressable: require('react-native').Pressable }));
jest.mock('../image-inputs', () => ({
  pickFromGallery: (...args: unknown[]) => mockPickGallery(...args),
  pickFromFiles: jest.fn(async () => []), takePhoto: jest.fn(async () => []),
  createReferenceFromGenerated: (...args: unknown[]) => mockCreateReference(...args),
  prepareReferenceForMask: jest.fn(async (image: unknown) => image),
  prepareReferenceFromAttachment: jest.fn(async (image: unknown) => image),
}));
jest.mock('../document-inputs', () => ({
  pickAnyFiles: (...args: unknown[]) => mockPickFiles(...args),
  attachmentKind: (name: string) => name.endsWith('.pdf') ? 'pdf' : 'image',
  isImageAttachment: (item: DocumentAttachment) => item.mimeType.startsWith('image/'),
  validateAttachments: jest.fn(),
}));
jest.mock('../storage/files', () => ({
  deleteLocalFile: (...args: unknown[]) => mockDeleteLocal(...args),
  saveToGallery: jest.fn(async () => {}), shareImage: jest.fn(async () => {}),
}));
jest.mock('../components/ui', () => {
  const ReactModule = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    IconButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement(Pressable, { accessibilityLabel: label, onPress, disabled }, ReactModule.createElement(Text, null, label)),
    Chip: () => null,
    Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? ReactModule.createElement(View, null, children) : null,
    AppDialog: ({ visible, title, message }: { visible: boolean; title: string; message?: string }) => visible ? ReactModule.createElement(Text, null, `${title}：${message}`) : null,
    dismissKeyboardAndBlur: jest.fn(),
  };
});
jest.mock('../components/CreationSkillPicker', () => {
  const ReactModule = require('react');
  const { Pressable, Text, View } = require('react-native');
  return { CreationSkillPicker: ({ visible, onSelect, onClose }: { visible: boolean; onSelect: (id: string | null) => void; onClose: () => void }) => !visible ? null : ReactModule.createElement(View, null,
    ...[['image-create', '选择通用创作'], ['reference-edit', '选择参考图修改'], ['poster-layout', '选择海报排版']].map(([id, label]) => ReactModule.createElement(Pressable, { key: id, onPress: () => { onSelect(id); onClose(); } }, ReactModule.createElement(Text, null, label)))) };
});
jest.mock('../components/ReferenceTray', () => {
  const ReactModule = require('react'); const { Text, View } = require('react-native');
  return { ReferenceTray: ({ images }: { images: ReferenceImage[] }) => ReactModule.createElement(View, null, ...images.map((image) => ReactModule.createElement(Text, { key: image.id }, image.name))) };
});
jest.mock('../components/MessageBubble', () => {
  const ReactModule = require('react'); const { Pressable, Text } = require('react-native');
  return { MessageBubble: ({ onReuse }: { onReuse: () => void }) => ReactModule.createElement(Pressable, { accessibilityLabel: '引用生成图片', onPress: onReuse }, ReactModule.createElement(Text, null, '引用生成图片')) };
});
jest.mock('../components/ConversationDrawer', () => ({ ConversationDrawer: () => null }));
jest.mock('../components/AboutSheet', () => ({ AboutSheet: () => null }));
jest.mock('../components/AppSettingsSheet', () => ({ AppSettingsSheet: () => null }));
jest.mock('../components/ImagePreview', () => ({ ImagePreview: () => null }));
jest.mock('../components/MaskEditor', () => ({ MaskEditor: () => null }));
jest.mock('../components/NetworkDiagnostics', () => ({ NetworkDiagnostics: () => null }));
jest.mock('../components/ProviderManager', () => ({ ProviderManager: () => null }));
jest.mock('../components/SettingsSheet', () => ({ SettingsSheet: () => null }));
jest.mock('../components/UpdateManager', () => ({ UpdateManager: () => null }));

import { ChatScreen } from '../screens/ChatScreen';

const provider: ProviderProfile = { id: 'p', name: '服务商', baseUrl: 'https://example.com/v1', model: 'image-model', quality: 'high', aspectRatio: '1:1', resolutionTier: '1K', chatModel: 'chat-model', createdAt: 1, updatedAt: 1 };
const reference: ReferenceImage = { id: 'ref', uri: 'file:///reference.png', name: '示意图.png', mimeType: 'image/png', size: 128 };
const pdf: DocumentAttachment = { id: 'pdf', uri: 'file:///source.pdf', name: '资料.pdf', mimeType: 'application/pdf', size: 256 };
const imageMessage: ChatMessage = { id: 'image', conversationId: 'c', providerId: 'p', role: 'assistant', mode: 'generate', prompt: '猫咪', model: 'image-model', quality: 'high', size: '1024x1024', transparent: false, status: 'complete', imageUri: 'file:///generated.png', remoteImageUrl: null, references: [], maskUri: null, error: null, elapsedMs: 1000, createdAt: 1 };

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  const resolved = () => jest.fn(async () => {});
  mockApp = {
    ready: true, providers: [provider], activeProvider: provider, conversations: [], activeConversation: null, messages: [],
    generating: false, elapsedSeconds: 0, requestStage: '', composerMode: 'auto',
    setComposerMode: resolved(), reloadProviders: resolved(), activateProvider: resolved(), updateActiveProviderSettings: resolved(), updateProviderSettings: resolved(),
    removeProvider: resolved(), startConversation: resolved(), selectConversation: resolved(), removeConversation: resolved(), toggleTransparent: resolved(),
    sendPrompt: resolved(), cancelGeneration: jest.fn(), retryMessage: resolved(),
  };
  mockPickGallery.mockReset().mockResolvedValue([reference]);
  mockPickFiles.mockReset().mockResolvedValue([pdf]);
  mockCreateReference.mockReset().mockResolvedValue({ ...reference, id: 'reused', uri: 'file:///copied-result.png', name: '已生成的图片.png' });
});
afterEach(async () => {
  await act(async () => { jest.runOnlyPendingTimers(); });
  jest.useRealTimers();
});

async function chooseSkill(screen: Awaited<ReturnType<typeof render>>, name = '选择通用创作') {
  await fireEvent.press(screen.getByText('技能'));
  await fireEvent.press(screen.getByText(name));
}

test('choosing a skill only adds a removable chip and never sends a request', async () => {
  const screen = await render(<ChatScreen />);
  await chooseSkill(screen);
  expect(screen.getByText('通用创作')).toBeTruthy();
  expect(screen.getByLabelText('移除创作技能')).toBeTruthy();
  expect(mockApp.sendPrompt).not.toHaveBeenCalled();
});

test('sending includes the selected skill as the sixth argument and clears it for the next draft', async () => {
  const screen = await render(<ChatScreen />);
  await chooseSkill(screen, '选择海报排版');
  await fireEvent.changeText(screen.getByLabelText('消息'), '春日活动海报');
  await fireEvent.press(screen.getByLabelText('发送'));
  expect(mockApp.sendPrompt).toHaveBeenCalledWith('春日活动海报', [], null, true, [], 'poster-layout');
  expect(screen.queryByLabelText('移除创作技能')).toBeNull();
  expect(screen.getByLabelText('消息').props.value).toBe('');
});

test('ordinary gallery and file attachments do not implicitly choose a creation skill', async () => {
  const screen = await render(<ChatScreen />);
  await fireEvent.press(screen.getByLabelText('添加图片或文件'));
  await fireEvent.press(screen.getByText('相册'));
  await waitFor(() => expect(screen.getByText(reference.name)).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('添加图片或文件'));
  await fireEvent.press(screen.getByText('文件'));
  await waitFor(() => expect(screen.getByText(pdf.name)).toBeTruthy());
  await fireEvent.changeText(screen.getByLabelText('消息'), '请分析这份资料和示意图');
  await fireEvent.press(screen.getByLabelText('发送'));
  expect(mockApp.sendPrompt).toHaveBeenCalledWith('请分析这份资料和示意图', [reference], null, true, [pdf], null);
});

test('the in-flight send control stops the request without submitting a second message', async () => {
  mockApp.generating = true;
  const screen = await render(<ChatScreen />);
  await fireEvent.press(screen.getByLabelText('停止生成'));
  expect(mockApp.cancelGeneration).toHaveBeenCalledTimes(1);
  expect(mockApp.sendPrompt).not.toHaveBeenCalled();
});

test('removing the skill restores ordinary message submission', async () => {
  const screen = await render(<ChatScreen />);
  await chooseSkill(screen);
  await fireEvent.press(screen.getByLabelText('移除创作技能'));
  await fireEvent.changeText(screen.getByLabelText('消息'), '帮我分析一下风格');
  await fireEvent.press(screen.getByLabelText('发送'));
  expect(mockApp.sendPrompt).toHaveBeenCalledWith('帮我分析一下风格', [], null, true, [], null);
});

test('reusing a generated image chooses the reference editing skill without starting generation', async () => {
  mockApp.messages = [imageMessage];
  mockApp.activeConversation = { id: 'c', title: '猫咪', providerId: 'p', transparent: false, mode: 'auto', createdAt: 1, updatedAt: 1 };
  const screen = await render(<ChatScreen />);
  await fireEvent.press(screen.getByLabelText('引用生成图片'));
  await waitFor(() => expect(screen.getByText('参考图修改')).toBeTruthy());
  expect(mockCreateReference).toHaveBeenCalledWith(imageMessage.imageUri);
  expect(mockApp.sendPrompt).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByLabelText('消息'), '把背景改成蓝色');
  await fireEvent.press(screen.getByLabelText('发送'));
  expect(mockApp.sendPrompt).toHaveBeenCalledWith('把背景改成蓝色', [expect.objectContaining({ id: 'reused' })], null, true, [], 'reference-edit');
});

test('a rejected send restores its draft, files, and selected skill', async () => {
  (mockApp.sendPrompt as jest.Mock).mockRejectedValueOnce(new Error('请先选择模型'));
  const screen = await render(<ChatScreen />);
  await chooseSkill(screen);
  await fireEvent.changeText(screen.getByLabelText('消息'), '水彩猫咪');
  await fireEvent.press(screen.getByLabelText('发送'));
  await waitFor(() => expect(screen.getByText('通用创作')).toBeTruthy());
  expect(screen.getByLabelText('消息').props.value).toBe('水彩猫咪');
  expect(screen.getByText('无法发送：请先选择模型')).toBeTruthy();
});
