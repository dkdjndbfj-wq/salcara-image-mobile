import React, { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { DirectConversation } from '../remote/DirectConversation';
import { RemoteDemoWorkspace } from '../remote/RemoteDemoWorkspace';

let mockWidth = 390;
const mockBackHandlers = new Set<() => boolean>();
const mockVisibility = jest.fn(), mockBack = jest.fn();
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native'), replacement = Object.create(actual);
  Object.defineProperty(replacement, 'useWindowDimensions', { enumerable: true,
    value: () => ({ width: mockWidth, height: 844, scale: 1, fontScale: 1 }) });
  Object.defineProperty(replacement, 'BackHandler', { enumerable: true, value: {
    addEventListener: (_event: string, listener: () => boolean) => {
      mockBackHandlers.add(listener); return { remove: () => mockBackHandlers.delete(listener) };
    },
  } });
  return replacement;
});
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => {} }));
jest.mock('../components/ui', () => ({ ...jest.requireActual('../components/ui'), useReducedMotion: () => true }));
jest.mock('../remote/direct-pairing', () => ({ directDeliveryScope: () => 'pairing-a', directConnectionGeneration: () => 1,
  getDirectConnectionState: () => ({ status: 'connected', deviceId: 'pc' }) }));
jest.mock('../remote/direct-api', () => ({ requestDirect: jest.fn() }));
jest.mock('../remote/RemoteSidebar', () => ({ RemoteSidebar: (props: any) => {
  const React = require('react'), { TextInput } = require('react-native');
  const {WorkspaceTabBar}=jest.requireActual('../remote/WorkspaceTabs');
  const [draft, setDraft] = React.useState('');
  return props.mode === 'tools' ? <><WorkspaceTabBar pages={[{id:'newtab',kind:'newtab',title:'新标签页'}]} activeId="newtab" onSelect={()=>{}} onClose={()=>{}} onAdd={()=>{}}/><TextInput accessibilityLabel="Direct工具草稿" value={draft} onChangeText={setDraft}/></> : null;
} }));
jest.mock('../remote/DirectComposer', () => ({ DirectComposer: ({ text, onText, onDraftReadyChange }: any) => {
  const React = require('react'), { TextInput } = require('react-native');
  React.useEffect(() => { onDraftReadyChange(true); }, []);
  return <TextInput accessibilityLabel="Direct聊天草稿" value={text} onChangeText={onText}/>;
} }));
jest.mock('../remote/thread-extras', () => ({ ImageViewer: () => null, JumpToLatest: () => null }));
jest.mock('../remote/QuestionDock', () => ({ QuestionDock: ({ children }: any) => children }));
jest.mock('../remote/thread-rows', () => ({ ThreadUi: require('react').createContext({}), BlockRow: () => null, ApprovalCard: () => null,
  ThreadClockProvider: ({ children }: any) => children, ThreadClockLabel: () => null }));
jest.mock('../remote/blocks', () => ({ ...jest.requireActual('../remote/blocks'), buildBlocks: () => [], conversationBlocks: () => [], fileEdits: () => [] }));
jest.mock('../remote/thread-stats', () => ({ turnStats: () => new Map(), quoteFor: (text: string) => text }));

const directProps: any = {
  runtime: { scope: 'pairing-a', remote: { devices: [{ deviceId: 'pc', capabilities: [] }] } },
  deviceId: 'pc', profile: { id: 'codex', tool: 'codex', name: 'Codex', available: true, api: { accountId: 'account-a' }, capabilities: {} },
  session: { sessionKey: 'codex:session', title: 'Task', cwd: 'C:/fixture', status: 'idle', controlSurface: 'cli' },
  timeline: { items: [] }, workspaceMode: 'code', loading: false, loadingMore: false, sending: false,
  canSend: true, uncertain: false, error: '', onSend: jest.fn(), onStop: jest.fn(), onRespond: jest.fn(),
  onEarlier: jest.fn(), onRefresh: jest.fn(), onBack: mockBack, onOpenSession: jest.fn(), onNew: jest.fn(),
};
function DirectHarness() {
  const [draft, setDraft] = useState('');
  return <DirectConversation {...directProps} text={draft} onText={setDraft} onMobileWorkspaceVisibilityChange={mockVisibility}/>;
}
function hardwareBack() {
  for (const callback of [...mockBackHandlers].reverse()) if (callback()) return true;
  return false;
}
beforeEach(() => { mockWidth = 390; mockBackHandlers.clear(); jest.clearAllMocks(); });

test('Direct phone tools replace the conversation and report return without losing either draft', async () => {
  const view = await render(<DirectHarness/>);
  await fireEvent.changeText(view.getByLabelText('Direct聊天草稿'), 'Direct草稿');
  await fireEvent.press(view.getByRole('button', { name: '打开工作区' }));
  expect(view.queryByLabelText('Direct聊天草稿')).toBeNull();
  expect(view.queryByLabelText('关闭侧边栏背景')).toBeNull();
  expect(mockVisibility).toHaveBeenLastCalledWith(true);
  expect(view.getAllByRole('button',{name:'返回聊天'})).toHaveLength(1);
  await fireEvent.changeText(view.getByLabelText('Direct工具草稿'), 'Direct工具未保存');
  await fireEvent.press(view.getByRole('button', { name: '返回聊天' }));
  expect(view.getByLabelText('Direct聊天草稿').props.value).toBe('Direct草稿');
  expect(mockVisibility).toHaveBeenLastCalledWith(false);
  await fireEvent.press(view.getByRole('button', { name: '打开工作区' }));
  expect(view.getByLabelText('Direct工具草稿').props.value).toBe('Direct工具未保存');
  await view.unmount(); expect(mockVisibility).toHaveBeenLastCalledWith(false);
});

test('Android Back closes Direct tools before invoking outer navigation', async () => {
  const view = await render(<DirectHarness/>);
  await fireEvent.changeText(view.getByLabelText('Direct聊天草稿'), '返回后保留');
  await fireEvent.press(view.getByRole('button', { name: '打开工作区' }));
  let consumed = false; await act(async () => { consumed = hardwareBack(); });
  expect(consumed).toBe(true); expect(mockBack).not.toHaveBeenCalled();
  expect(view.getByLabelText('Direct聊天草稿').props.value).toBe('返回后保留');
  expect(mockVisibility).toHaveBeenLastCalledWith(false);
  await act(async () => { expect(hardwareBack()).toBe(true); });
  expect(mockBack).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('demo phone tools replace the conversation and return through the same user flow', async () => {
  const view = await render(<RemoteDemoWorkspace agentName="Codex" onMobileWorkspaceVisibilityChange={mockVisibility} onBack={mockBack}/>);
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'), '演示聊天草稿');
  await fireEvent.press(view.getByRole('button', { name: '打开工作区面板' }));
  expect(view.queryByLabelText('编程对话输入框')).toBeNull();
  expect(view.queryByLabelText('关闭工作区面板')).toBeNull();
  expect(mockVisibility).toHaveBeenLastCalledWith(true);
  await fireEvent.press(view.getByLabelText('打开终端标签'));
  await fireEvent.changeText(view.getByLabelText('终端命令输入框'), 'echo retained');
  await fireEvent.press(view.getByRole('button', { name: '返回聊天' }));
  expect(view.getByLabelText('编程对话输入框').props.value).toBe('演示聊天草稿');
  expect(mockVisibility).toHaveBeenLastCalledWith(false);
  await fireEvent.press(view.getByRole('button', { name: '打开工作区面板' }));
  expect(view.getByLabelText('终端命令输入框').props.value).toBe('echo retained');
  await view.unmount(); expect(mockVisibility).toHaveBeenLastCalledWith(false);
});

test('Android Back closes demo tools before returning to the project directory', async () => {
  const view = await render(<RemoteDemoWorkspace agentName="Codex" onMobileWorkspaceVisibilityChange={mockVisibility} onBack={mockBack}/>);
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'), '演示返回保留');
  await fireEvent.press(view.getByRole('button', { name: '打开工作区面板' }));
  let consumed = false; await act(async () => { consumed = hardwareBack(); });
  expect(consumed).toBe(true); expect(mockBack).not.toHaveBeenCalled();
  expect(view.getByLabelText('编程对话输入框').props.value).toBe('演示返回保留');
  expect(mockVisibility).toHaveBeenLastCalledWith(false);
  await act(async () => { expect(hardwareBack()).toBe(true); });
  expect(mockBack).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('tablet Back restores split tools, folds them, then returns to the directory', async () => {
  mockWidth = 1194;
  const view = await render(<DirectHarness/>);
  await fireEvent.changeText(view.getByLabelText('Direct工具草稿'), '平板工具草稿');
  await fireEvent.press(view.getByRole('button', { name: '标签页更多' }));
  await fireEvent.press(view.getByRole('button', { name: '全页查看' }));
  expect(view.queryByLabelText('Direct聊天草稿')).toBeNull();
  await act(async () => { expect(hardwareBack()).toBe(true); });
  expect(view.getByLabelText('Direct聊天草稿')).toBeTruthy();
  expect(view.getByLabelText('Direct工具草稿').props.value).toBe('平板工具草稿');
  expect(mockBack).not.toHaveBeenCalled();
  await act(async () => { expect(hardwareBack()).toBe(true); });
  expect(view.queryByLabelText('Direct工具草稿')).toBeNull();
  expect(mockBack).not.toHaveBeenCalled();
  await act(async () => { expect(hardwareBack()).toBe(true); });
  expect(mockBack).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('demo Back closes the conversation navigation before leaving its conversation', async () => {
  const view = await render(<RemoteDemoWorkspace agentName="Codex" onBack={mockBack}/>);
  await fireEvent.press(view.getByLabelText('打开会话侧栏'));
  expect(view.getAllByLabelText('关闭会话侧栏').length).toBeGreaterThan(0);
  await act(async () => { expect(hardwareBack()).toBe(true); });
  expect(view.getByLabelText('打开会话侧栏')).toBeTruthy();
  expect(mockBack).not.toHaveBeenCalled();
  await view.unmount();
});

test('an 844px landscape phone keeps demo tools in one full page with no split-view control', async () => {
  mockWidth = 844;
  const view = await render(<RemoteDemoWorkspace agentName="Codex" onMobileWorkspaceVisibilityChange={mockVisibility}/>);
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'), '横屏草稿');
  await fireEvent.press(view.getByRole('button', { name: '打开工作区面板' }));
  expect(view.queryByLabelText('编程对话输入框')).toBeNull();
  expect(view.getByRole('button', { name: '返回聊天' })).toBeTruthy();
  expect(view.queryByRole('button', { name: '返回分屏' })).toBeNull();
  expect(view.queryByRole('button', { name: '全页查看' })).toBeNull();
  expect(view.queryByLabelText('关闭工作区面板')).toBeNull();
  expect(mockVisibility).toHaveBeenLastCalledWith(true);
  await fireEvent.press(view.getByRole('button', { name: '返回聊天' }));
  expect(view.getByLabelText('编程对话输入框').props.value).toBe('横屏草稿');
  expect(mockVisibility).toHaveBeenLastCalledWith(false);
  await view.unmount();
});

test('demo file tab previews a nested file and preserves its filter, expansion and selection across code tabs', async () => {
  const view = await render(<RemoteDemoWorkspace agentName="Codex"/>);
  await fireEvent.press(view.getByRole('button', { name: '打开工作区面板' }));
  await fireEvent.press(view.getByLabelText('打开文件标签'));
  expect(view.getByLabelText('当前工作区目录').props.accessibilityHint).toBe('D:\\Projects\\salcara-web');
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  await fireEvent.press(view.getByLabelText('打开目录 auth'));
  await fireEvent.press(view.getByLabelText('打开文件 login.css'));
  expect(view.getByTestId('demo-workspace-file-content').props.children).toContain('.auth-layout');
  expect(view.queryByRole('tab', { name: 'login.css' })).toBeNull();
  await fireEvent.press(view.getByLabelText('返回文件目录'));
  expect(view.getByLabelText('打开文件 login.css')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('筛选文件'), 'login.css');
  await fireEvent.press(view.getByLabelText('打开文件 login.css'));
  await fireEvent.press(view.getByLabelText('文件更多'));
  await fireEvent.press(view.getByLabelText('在新标签页打开'));
  expect(view.getByRole('tab', { name: 'login.css' }).props.accessibilityState).toMatchObject({ selected: true });
  expect(view.queryByTestId('demo-workspace-file-content')).toBeNull();
  expect(view.getByText(/grid-template-columns: minmax/)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭login.css'));
  expect(view.getByTestId('demo-workspace-file-content').props.children).toContain('.auth-layout');
  expect(view.queryByTestId('workspace-file-actions')).toBeNull();
  expect(view.getByLabelText('文件更多').props.accessibilityState).toMatchObject({ expanded: false });
  await fireEvent.press(view.getByLabelText('返回文件目录'));
  expect(view.getByLabelText('筛选文件').props.value).toBe('login.css');
  await fireEvent.press(view.getByLabelText('清除文件筛选'));
  expect(view.getByLabelText('打开目录 src').props.accessibilityState).toMatchObject({ expanded: true });
  expect(view.getByLabelText('打开目录 auth').props.accessibilityState).toMatchObject({ expanded: true });
  expect(view.getByLabelText('打开文件 LoginPage.tsx')).toBeTruthy();
  await view.unmount();
});
