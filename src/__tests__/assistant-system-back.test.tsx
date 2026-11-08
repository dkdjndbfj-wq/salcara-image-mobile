import React from 'react';
import { BackHandler, Keyboard, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ChatMessage, ReferenceImage } from '../domain';
import type { useApp } from '../state/AppContext';

let mockApp: ReturnType<typeof useApp>;
let mockComposer: any;
let mockDictationState = 'idle';
const mockCancelDictation = jest.fn();
const mockDeleteFile = jest.fn();
const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockPick = jest.fn();
const settings = new Map<string, string>();
const backHandlers = new Set<Parameters<typeof BackHandler.addEventListener>[1]>();
jest.mock('../state/AppContext', () => ({ useApp: () => mockApp }));
jest.mock('../storage/database', () => ({ getSetting: (...args: unknown[]) => mockRead(...args), setSetting: (...args: unknown[]) => mockWrite(...args) }));
jest.mock('../storage/files', () => ({ deleteLocalFile: (...args: unknown[]) => mockDeleteFile(...args) }));
jest.mock('../agent/agents', () => ({ useAgents: () => [{ id: 'agent', name: '写作助理', starters: [] }] }));
jest.mock('../voice/settings', () => ({ useVoiceSettings: () => ({}) }));
jest.mock('../voice/useDictation', () => ({ useDictation: () => ({ state: mockDictationState, cancel: mockCancelDictation }) }));
jest.mock('../document-inputs', () => ({ validateAttachments: jest.fn() }));
jest.mock('../image-inputs', () => ({ pickFromGallery: (...args: unknown[]) => mockPick(...args) }));
jest.mock('../components/LaunchIntro', () => ({ useLaunchRevealed: () => true }));
jest.mock('../components/useGeneratedImageDraft', () => ({ useGeneratedImageDraft: () => jest.fn() }));
jest.mock('../components/useMessageImagePreview', () => ({ useMessageImagePreview: () => ({}) }));

// Isolate navigation and composer state from unrelated API configuration/native media UIs.
for (const [module, names] of [
  ['../companion/MemoryBoxSettingsSheet', ['MemoryBoxSettingsSheet']],
  ...['AboutSheet', 'FilePreviewSheet', 'PersonalizationSheet', 'ToolsSheet', 'AppSettingsSheet',
    'LiveMode', 'VoiceSettingsSheet', 'Icon', 'ImagePreview', 'MaskEditor', 'ModelSwitcher',
    'Onboarding', 'NetworkDiagnostics', 'ProviderManager', 'UpdateManager'].map(name => [`../components/${name}`, [name]]),
  ['../components/AgentsSheet', ['AgentAvatar']], ['../components/Brand', ['BrandMark']],
  ['../components/Skeleton', ['Skeleton', 'SkeletonGroup']],
] as Array<[string, string[]]>) jest.doMock(module, () => Object.fromEntries(names.map(name => [name, () => null])));
jest.doMock('../components/KeyboardSafeView', () => ({ KeyboardSafeView: View }));
jest.doMock('../components/AssistantWelcome', () => ({ AssistantWelcome: () => <Text>助理起始页</Text> }));
jest.doMock('../components/AssistantTopBar', () => ({ AssistantTopBar: ({ onOpenConversations }: any) => <Pressable accessibilityLabel="会话列表" onPress={onOpenConversations} /> }));
jest.doMock('../components/ConversationDrawer', () => ({ ConversationDrawer: ({ visible, onClose }: any) => visible ? <Modal testID="drawer" visible onRequestClose={onClose}><Text>历史会话</Text></Modal> : null }));
jest.doMock('../components/Composer', () => ({ Composer: (props: any) => {
  mockComposer = props;
  return <><TextInput testID="composer" value={props.value} onChangeText={props.onChangeText} />
    {props.editing ? <Text>编辑消息中</Text> : null}</>;
} }));
jest.doMock('../components/MessageBubble', () => ({ MessageBubble: ({ message, onUserMessageAction }: any) => <Pressable accessibilityLabel="消息操作" onPress={() => onUserMessageAction(message)}><Text>{message.prompt}</Text></Pressable> }));
jest.doMock('../components/ui', () => ({
  Appear: View, MotionPressable: Pressable, IconButton: () => null, PrimaryButton: () => null, ToastHost: () => null,
  showToast: jest.fn(), dismissKeyboardAndBlur: () => Keyboard.dismiss(),
  Sheet: ({ visible, onClose, children }: any) => visible ? <Modal visible onRequestClose={onClose}>{children}</Modal> : null,
  AppDialog: ({ visible, onClose, actions }: any) => visible ? <Modal visible onRequestClose={onClose}>{actions?.map((action: any) => <Pressable key={action.label} accessibilityLabel={action.label} onPress={action.onPress}><Text>{action.label}</Text></Pressable>)}</Modal> : null,
}));
const { ChatScreen } = require('../screens/ChatScreen');
const message = { id: 'message', conversationId: 'thread', role: 'user', prompt: '已发送的问题', references: [] } as unknown as ChatMessage;
const attachment: ReferenceImage = { id: 'draft-image', uri: 'file:///draft.png', name: 'draft.png', mimeType: 'image/png', size: 12 };

beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); settings.clear(); backHandlers.clear();
  mockDictationState = 'idle';
  mockRead.mockImplementation(async (key: string) => key === 'onboarding_done' ? '1' : settings.get(key) ?? null);
  mockWrite.mockImplementation(async (key: string, value: string | null) => { if (value === null) settings.delete(key); else settings.set(key, value); });
  mockPick.mockResolvedValue([attachment]);
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    backHandlers.add(handler);
    return { remove: () => { backHandlers.delete(handler); } };
  });
  mockApp = {
    ready: true, providers: [{ id: 'api', chatModel: 'model' }], chatProvider: { id: 'api', chatModel: 'model' },
    activeConversationId: 'thread', activeConversation: { title: '对话' }, activeAgentId: null, messages: [message],
    busy: false, phase: 'idle', stop: jest.fn(), retry: jest.fn(), retryImage: jest.fn(),
    newChat: jest.fn(() => { mockApp = { ...mockApp, activeConversationId: null, activeConversation: null, activeAgentId: null, messages: [] }; }),
  } as unknown as ReturnType<typeof useApp>;
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

async function back(view: Awaited<ReturnType<typeof render>>) {
  let handled = false;
  await act(async () => {
    for (const handler of [...backHandlers].reverse()) if (handler({ type: 'hardwareBackPress', timeStamp: Date.now() })) { handled = true; break; }
  });
  await view.rerender(<ChatScreen />);
  return handled;
}

test('back returns from a running conversation, saves a fresh draft and restores its attachments when reopened', async () => {
  mockApp.busy = true;
  const view = await render(<ChatScreen />);
  await fireEvent.changeText(view.getByTestId('composer'), '刚写的草稿');
  await act(async () => mockComposer.onOpenAttach());
  await fireEvent.press(view.getByLabelText('照片'));
  expect(mockComposer.images).toEqual([attachment]);
  expect(await back(view)).toBe(true);
  expect(view.getByText('助理起始页')).toBeTruthy();
  expect(mockApp.stop).not.toHaveBeenCalled();
  expect(settings.get('draft.assistant.thread')).toBe(JSON.stringify({ prompt: '刚写的草稿', research: false }));
  mockApp = { ...mockApp, activeConversationId: 'thread', messages: [message] };
  await view.rerender(<ChatScreen />);
  expect(view.getByTestId('composer').props.value).toBe('刚写的草稿');
  expect(mockComposer.images).toEqual([attachment]);
  expect(mockDeleteFile).not.toHaveBeenCalled();
});

test('keyboard and dictation are dismissed before leaving the conversation', async () => {
  mockDictationState = 'listening';
  const view = await render(<ChatScreen />);
  jest.mocked(Keyboard.isVisible).mockReturnValue(true);
  expect(await back(view)).toBe(true);
  expect(Keyboard.dismiss).toHaveBeenCalledTimes(1);
  expect(mockCancelDictation).not.toHaveBeenCalled();
  expect(mockApp.newChat).not.toHaveBeenCalled();
  jest.mocked(Keyboard.isVisible).mockReturnValue(false);
  expect(await back(view)).toBe(true);
  expect(mockCancelDictation).toHaveBeenCalledTimes(1);
  expect(mockApp.newChat).not.toHaveBeenCalled();
});

test('back cancels message editing and restores the original unsent draft before navigating', async () => {
  const view = await render(<ChatScreen />);
  await fireEvent.changeText(view.getByTestId('composer'), '还没有发送的草稿');
  await fireEvent.press(view.getByLabelText('消息操作'));
  await fireEvent.press(view.getByLabelText('编辑后重新发送'));
  expect(view.getByTestId('composer').props.value).toBe(message.prompt);
  await fireEvent.changeText(view.getByTestId('composer'), '未提交的编辑');
  await act(async () => mockComposer.onOpenAttach());
  await fireEvent.press(view.getByLabelText('照片'));
  expect(await back(view)).toBe(true);
  expect(view.queryByText('编辑消息中')).toBeNull();
  expect(view.getByTestId('composer').props.value).toBe('还没有发送的草稿');
  expect(mockDeleteFile).toHaveBeenCalledWith(attachment.uri);
  expect(mockApp.newChat).not.toHaveBeenCalled();
  expect(await back(view)).toBe(true);
  expect(settings.get('draft.assistant.thread')).toBe(JSON.stringify({ prompt: '还没有发送的草稿', research: false }));
});

test('native drawer close returns to the current conversation without navigating', async () => {
  const view = await render(<ChatScreen />);
  await fireEvent.press(view.getByLabelText('会话列表'));
  await fireEvent(view.getByTestId('drawer'), 'requestClose');
  expect(view.queryByText('历史会话')).toBeNull();
  expect(mockApp.newChat).not.toHaveBeenCalled();
});

test('an agent draft returns to the assistant start without discarding text, then lets Android handle root back', async () => {
  mockApp = { ...mockApp, activeConversationId: null, activeConversation: null, activeAgentId: 'agent', messages: [] };
  const view = await render(<ChatScreen />);
  await fireEvent.changeText(view.getByTestId('composer'), '给助理的草稿');
  expect(await back(view)).toBe(true);
  expect(view.getByText('助理起始页')).toBeTruthy();
  expect(view.getByTestId('composer').props.value).toBe('给助理的草稿');
  expect(await back(view)).toBe(false);
  expect(mockApp.stop).not.toHaveBeenCalled();
});

test('back before hydration never replaces an unread saved draft with empty text', async () => {
  let resolveDraft!: (value: string) => void;
  const draft = new Promise<string>(resolve => { resolveDraft = resolve; });
  mockRead.mockImplementation(async (key: string) => key === 'draft.assistant.thread' ? draft : '1');
  const view = await render(<ChatScreen />);
  expect(await back(view)).toBe(true);
  await act(async () => resolveDraft(JSON.stringify({ prompt: '磁盘上的草稿', research: false })));
  expect(mockWrite.mock.calls.filter(([key]) => key === 'draft.assistant.thread')).toEqual([]);
  expect(view.getByTestId('composer').props.value).toBe('');
});
