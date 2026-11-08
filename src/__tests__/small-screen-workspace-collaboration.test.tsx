import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { TabletThreadFrame } from '../remote/TabletThreadFrame';

let mockWidth = 390;
const mockChatMount = jest.fn(), mockChatUnmount = jest.fn();
const mockWorkspaceMount = jest.fn(), mockWorkspaceUnmount = jest.fn();
const mockClose = jest.fn(), mockVisibility = jest.fn();
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => {} }));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native'), replacement = Object.create(actual);
  Object.defineProperty(replacement, 'useWindowDimensions', { enumerable: true,
    value: () => ({ width: mockWidth, height: 844, scale: 1, fontScale: 1 }) });
  return replacement;
});

function Chat({ onOpen }: { onOpen: () => void }) {
  const [draft, setDraft] = useState('');
  useEffect(() => { mockChatMount(); return () => { mockChatUnmount(); }; }, []);
  return <View>
    <TextInput accessibilityLabel="聊天草稿" value={draft} onChangeText={setDraft}/>
    <Pressable accessibilityRole="button" accessibilityLabel="打开工具区" onPress={onOpen}><Text>打开工具区</Text></Pressable>
  </View>;
}

function Workspace() {
  const [draft, setDraft] = useState('');
  useEffect(() => { mockWorkspaceMount(); return () => { mockWorkspaceUnmount(); }; }, []);
  return <View><Text>工具页面</Text><TextInput accessibilityLabel="工具页面草稿" value={draft} onChangeText={setDraft}/></View>;
}

function Harness({ tablet = false }: { tablet?: boolean }) {
  const [open, setOpen] = useState(false);
  return <TabletThreadFrame enabled={tablet} navigation={<Text>导航</Text>} header={<Text>聊天标题</Text>}
    workspace={<Workspace/>} mobileWorkspaceOpen={open} onCloseWorkspace={() => { mockClose(); setOpen(false); }}
    onWorkspaceVisibilityChange={mockVisibility}>
    <Chat onOpen={() => setOpen(true)}/>
  </TabletThreadFrame>;
}

beforeEach(() => { mockWidth = 390; jest.clearAllMocks(); });

test('a phone workspace replaces the visible chat and has no interactive drawer backdrop', async () => {
  const view = await render(<Harness/>);
  expect(view.getByLabelText('聊天草稿')).toBeTruthy();
  expect(view.queryByText('工具页面')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开工具区'));
  expect(view.getByText('工具页面')).toBeTruthy();
  expect(view.queryByLabelText('聊天草稿')).toBeNull();
  expect(view.queryByLabelText('打开工具区')).toBeNull();
  expect(view.queryByLabelText('关闭侧边栏背景')).toBeNull();
  expect(view.queryByTestId('remote-sidebar-backdrop')).toBeNull();
  expect(view.getByRole('button', { name: '返回聊天' })).toBeTruthy();
  expect(mockVisibility).toHaveBeenLastCalledWith(true);
  await view.unmount();
});

test('returning to chat and reopening tools preserves both drafts without remounting either pane', async () => {
  const view = await render(<Harness/>);
  await fireEvent.changeText(view.getByLabelText('聊天草稿'), '聊天里尚未发送的内容');
  await fireEvent.press(view.getByLabelText('打开工具区'));
  await fireEvent.changeText(view.getByLabelText('工具页面草稿'), '工具里尚未保存的内容');
  const mounts = [mockChatMount.mock.calls.length, mockWorkspaceMount.mock.calls.length];
  await fireEvent.press(view.getByRole('button', { name: '返回聊天' }));
  expect(mockClose).toHaveBeenCalledTimes(1);
  expect(view.getByLabelText('聊天草稿').props.value).toBe('聊天里尚未发送的内容');
  expect(view.queryByLabelText('工具页面草稿')).toBeNull();
  expect(mockVisibility).toHaveBeenLastCalledWith(false);
  await fireEvent.press(view.getByLabelText('打开工具区'));
  expect(view.getByLabelText('工具页面草稿').props.value).toBe('工具里尚未保存的内容');
  expect([mockChatMount.mock.calls.length, mockWorkspaceMount.mock.calls.length]).toEqual(mounts);
  expect(mockChatUnmount).not.toHaveBeenCalled(); expect(mockWorkspaceUnmount).not.toHaveBeenCalled();
  await view.unmount();
});

test('phone and tablet layout changes keep the chat and workspace instances alive', async () => {
  const view = await render(<Harness/>);
  await fireEvent.changeText(view.getByLabelText('聊天草稿'), '保留聊天');
  await fireEvent.press(view.getByLabelText('打开工具区'));
  await fireEvent.changeText(view.getByLabelText('工具页面草稿'), '保留工具');
  const mounts = [mockChatMount.mock.calls.length, mockWorkspaceMount.mock.calls.length];
  mockWidth = 1194; await view.rerender(<Harness tablet/>);
  expect(view.getByLabelText('工具页面草稿').props.value).toBe('保留工具');
  mockWidth = 390; await view.rerender(<Harness/>);
  expect(view.queryByLabelText('聊天草稿')).toBeNull();
  await fireEvent.press(view.getByRole('button', { name: '返回聊天' }));
  expect(view.getByLabelText('聊天草稿').props.value).toBe('保留聊天');
  expect([mockChatMount.mock.calls.length, mockWorkspaceMount.mock.calls.length]).toEqual(mounts);
  expect(mockChatUnmount).not.toHaveBeenCalled(); expect(mockWorkspaceUnmount).not.toHaveBeenCalled();
  await view.unmount();
});
