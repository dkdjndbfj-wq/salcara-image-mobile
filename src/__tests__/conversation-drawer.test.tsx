import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import type { Conversation } from '../domain';

const mockSelect = jest.fn(); const mockStart = jest.fn(); const mockRemove = jest.fn();
let mockConversations: Conversation[];
jest.mock('../state/AppContext', () => ({ useApp: () => ({ conversations: mockConversations, activeConversation: mockConversations[0], providers: [{ id: 'p' }], startConversation: mockStart, selectConversation: mockSelect, removeConversation: mockRemove }) }));
jest.mock('../components/MotionPressable', () => ({ useReducedMotion: () => true }));
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react'); const { View } = require('react-native');
  return { SafeAreaView: ({ children, ...props }: { children: React.ReactNode }) => ReactModule.createElement(View, props, children) };
});
jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react'); const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => ReactModule.createElement(Text, null, name) };
});
jest.mock('../components/ui', () => ({ AppDialog: () => null, dismissKeyboardAndBlur: jest.fn() }));
import { ConversationDrawer } from '../components/ConversationDrawer';

beforeEach(() => {
  mockSelect.mockReset().mockResolvedValue(undefined); mockStart.mockReset().mockResolvedValue(undefined);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(12, 0, 0, 0);
  mockConversations = [
    { id: 'today', title: '海报创作', providerId: 'p', transparent: false, createdAt: Date.now(), updatedAt: Date.now() },
    { id: 'yesterday', title: '旅行计划', providerId: 'p', transparent: false, createdAt: yesterday.getTime(), updatedAt: yesterday.getTime() },
  ];
});

test('groups recent conversations, searches titles and opens selected conversation', async () => {
  const onClose = jest.fn();
  const screen = await render(<ConversationDrawer visible onClose={onClose} onOpenProviders={jest.fn()} onOpenAbout={jest.fn()} onOpenNetwork={jest.fn()} onOpenSettings={jest.fn()} />);
  expect(screen.getByText('今天')).toBeTruthy(); expect(screen.getByText('昨天')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('搜索会话'), '旅行');
  expect(screen.queryByText('海报创作')).toBeNull(); expect(screen.queryByText('今天')).toBeNull();
  await fireEvent.press(screen.getByText('旅行计划'));
  expect(mockSelect).toHaveBeenCalledWith('yesterday'); expect(onClose).toHaveBeenCalledTimes(1);
});

test('keeps one settings entry and creates a new conversation', async () => {
  const onSettings = jest.fn();
  const screen = await render(<ConversationDrawer visible onClose={jest.fn()} onOpenProviders={jest.fn()} onOpenAbout={jest.fn()} onOpenNetwork={jest.fn()} onOpenSettings={onSettings} />);
  expect(screen.queryByText('网络诊断')).toBeNull(); expect(screen.queryByText('服务商管理')).toBeNull();
  await fireEvent.press(screen.getByText('设置')); expect(onSettings).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('新会话')); expect(mockStart).toHaveBeenCalledTimes(1);
});
