import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import type { AgentProfile } from '../remote/client';
import { RemoteSidebar } from '../remote/RemoteSidebar';
import { TabletThreadFrame } from '../remote/TabletThreadFrame';
import { useWorkspaceLayoutControls } from '../remote/WorkspaceLayoutContext';
import { resetWorkspaceLayoutMemoryForTests, saveWorkspaceLayout } from '../remote/workspace-layout';
import type { WorkspacePage } from '../remote/WorkspaceTabs';

const mockDisk = new Map<string, string>();
let mockRemote: any;
let mockCloseOthers: ((id: string) => void) | undefined;
jest.mock('../remote/WorkspaceTabs', () => {
  const actual = jest.requireActual('../remote/WorkspaceTabs');
  const React = require('react');
  return { ...actual, WorkspaceTabBar: (props: any) => {
    mockCloseOthers = props.onCloseOthers;
    return React.createElement(actual.WorkspaceTabBar, props);
  } };
});
jest.mock('../storage/database', () => ({
  getSetting: async (key: string) => mockDisk.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => {
    if (value === null) mockDisk.delete(key); else mockDisk.set(key, value);
  },
}));
jest.mock('../remote/store', () => ({
  useRemote: () => mockRemote,
  remoteDeliveryScope: () => 'collaboration-fixture',
  timelineKey: (device: string, key: string) => `${device}|${key}`,
  loadSessions: async () => {}, loadNativeSessions: async () => {},
  hubSupportsSessionActions: () => false,
}));
jest.mock('../components/ui', () => ({
  ...jest.requireActual('../components/ui'), useReducedMotion: () => true,
}));
jest.mock('../remote/RemoteTerminalPage', () => ({ RemoteTerminalPage: () => null }));
jest.mock('../remote/RemoteBrowserPage', () => ({ RemoteBrowserPage: () => null }));

const agent: AgentProfile = {
  id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true,
  api: { name: 'fixture', model: '', protocol: 'responses', configured: true, pending: false, source: 'computer' },
};
const props = {
  visible: true, docked: true, mode: 'tools' as const, deviceId: 'pc', agent,
  activeSessionKey: 'codex:session', controlSurface: 'cli' as const,
  onClose: jest.fn(), onOpenSession: jest.fn(),
};
const scope = JSON.stringify(['collaboration-fixture', 'paired', 'https://fixture.example', 'pc', 'codex', 'codex:session', 'code', false, false]);
const newtab: WorkspacePage = { id: 'newtab', kind: 'newtab', title: '新标签页' };
async function restartWith(pages: WorkspacePage[]) {
  await saveWorkspaceLayout({ scope, pages, activeId: 'newtab' });
  resetWorkspaceLayoutMemoryForTests();
}

beforeEach(() => {
  mockDisk.clear(); resetWorkspaceLayoutMemoryForTests(); jest.clearAllMocks();
  mockRemote = {
    connection: 'open', connectionId: 'paired', selectedHubUrl: 'https://fixture.example',
    devices: [{ deviceId: 'pc', name: 'Computer', online: true, capabilities: ['workspace.terminal.v1'] }],
    sessions: { pc: { loaded: true, pages: { codex: {} }, list: [{
      sessionKey: 'codex:session', tool: 'codex', client: 'Codex', title: 'Task', cwd: '/fixture',
      controlSurface: 'cli', status: 'idle', updatedAt: 1,
    }] } }, timelines: {},
  };
});

test('a new terminal after cold restoration keeps the existing restored terminal', async () => {
  await restartWith([newtab, { id: 'terminal:2', kind: 'terminal', title: '终端' }]);
  const view = await render(<RemoteSidebar {...props} />);
  expect(view.getAllByRole('tab', { name: '终端' })).toHaveLength(1);
  await fireEvent.press(view.getByLabelText('添加工具标签'));
  await fireEvent.press(view.getByLabelText('打开终端标签'));
  expect(view.getAllByRole('tab', { name: '终端' })).toHaveLength(2);
  await view.unmount();
});

test('a new Agent page after cold restoration preserves the old page and foreground selection', async () => {
  await restartWith([newtab, {
    id: 'browser:1', kind: 'preview', title: 'old.example', browserPageId: 'desktop-old',
    preview: { kind: 'web', url: 'https://old.example/' },
  }]);
  const activity: any = { id: 'new-agent-open', kind: 'tool', status: 'done',
    browser: { action: 'open', pageId: 'desktop-new', url: 'https://new.example/' } };
  const view = await render(<RemoteSidebar {...props} toolActivities={[activity]} />);
  expect(view.getByRole('tab', { name: '网页 old.example' })).toBeTruthy();
  expect(view.getByRole('tab', { name: '网页 new.example' }).props.accessibilityState.selected).toBe(false);
  expect(view.getByRole('tab', { name: '新标签页' }).props.accessibilityState.selected).toBe(true);
  await view.unmount();
});

test('opening a page after restart cannot reuse the ID of a still-restorable closed page', async () => {
  await saveWorkspaceLayout({ scope, pages: [newtab], activeId: newtab.id, closedPages: [{
    id: 'browser:1', kind: 'preview', title: 'old.example',
    preview: { kind: 'web', url: 'https://old.example/' },
    browserHistory: { urls: ['https://old.example/'], index: 0 },
  }] });
  resetWorkspaceLayoutMemoryForTests();
  const view = await render(<RemoteSidebar {...props} />);
  await fireEvent.press(view.getByLabelText('新标签页更多'));
  await fireEvent.press(view.getByLabelText('打开浏览器标签'));
  await fireEvent.press(view.getByLabelText('标签页更多'));
  await fireEvent.press(view.getByLabelText('恢复关闭的标签'));
  expect(view.getByRole('tab', { name: '网页 old.example' }).props.accessibilityState.selected).toBe(true);
  expect(view.getByRole('tab', { name: '工具栏预览' })).toBeTruthy();
  await view.unmount();
});

test('background Agent opens retain distinct page identities without showing a hidden sidebar', async () => {
  const first: any = { id: 'background-one', kind: 'tool', status: 'done',
    browser: { action: 'open', pageId: 'desktop-one', url: 'https://same.example/' } };
  const second: any = { ...first, id: 'background-two', browser: { ...first.browser, pageId: 'desktop-two' } };
  const view = await render(<RemoteSidebar {...props} visible={false} toolActivities={[first, second]} />);
  expect(view.queryByRole('tab', { name: '网页 same.example' })).toBeNull();
  await view.rerender(<RemoteSidebar {...props} toolActivities={[first, second]} />);
  expect(view.getAllByRole('tab', { name: '网页 same.example' })).toHaveLength(2);
  expect(view.getByRole('tab', { name: '新标签页' }).props.accessibilityState.selected).toBe(true);
  await view.unmount();
});

test('restored pages and the close stack stay scoped when switching computers', async () => {
  await restartWith([newtab, { id: 'terminal:7', kind: 'terminal', title: '终端' }]);
  const view = await render(<RemoteSidebar {...props} />);
  await fireEvent.press(view.getByLabelText('关闭标签 终端'));
  await fireEvent.press(view.getByLabelText('标签页更多'));
  expect(view.getByLabelText('恢复关闭的标签')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭标签菜单'));
  await view.rerender(<RemoteSidebar {...props} deviceId="other-computer" />);
  expect(view.queryByRole('tab', { name: '终端' })).toBeNull();
  expect(view.queryByLabelText('恢复关闭的标签')).toBeNull();
  await view.rerender(<RemoteSidebar {...props} />);
  await fireEvent.press(view.getByLabelText('标签页更多'));
  await fireEvent.press(view.getByLabelText('恢复关闭的标签'));
  expect(view.getByRole('tab', { name: '终端' })).toBeTruthy();
  await view.unmount();
});

test('closing the tab that owns a context menu dismisses that menu', async () => {
  await restartWith([newtab, { id: 'terminal:4', kind: 'terminal', title: '终端' }]);
  const view = await render(<RemoteSidebar {...props} />);
  await fireEvent(view.getByRole('tab', { name: '终端' }), 'longPress');
  expect(view.getByLabelText('关闭其他标签')).toBeTruthy();
  await fireEvent.press(within(view.getByTestId('workspace-tab-menu')).getByLabelText('关闭标签 终端'));
  expect(view.queryByLabelText('关闭其他标签')).toBeNull();
  await view.unmount();
});

test('a queued close-others callback from a removed tab cannot remove the remaining pages', async () => {
  await restartWith([newtab, { id: 'terminal:4', kind: 'terminal', title: '终端' }]);
  const view = await render(<RemoteSidebar {...props} />);
  await fireEvent(view.getByRole('tab', { name: '终端' }), 'longPress');
  const closeOthers = mockCloseOthers!;
  await fireEvent.press(within(view.getByTestId('workspace-tab-menu')).getByLabelText('关闭标签 终端'));
  await act(async () => closeOthers('terminal:4'));
  expect(view.getByRole('tab', { name: '新标签页' }).props.accessibilityState.selected).toBe(true);
  await view.unmount();
});

function LayoutActions() {
  const controls = useWorkspaceLayoutControls();
  return <View>
    <Text testID="observed-workspace-view">{controls?.view}</Text>
    <Pressable accessibilityLabel="test reveal workspace" onPress={() => controls?.setView('split')} />
    <Pressable accessibilityLabel="test fullscreen workspace" onPress={() => controls?.setView('full')} />
  </View>;
}

test('the shared reveal action opens a hidden phone workspace', async () => {
  const view = await render(<TabletThreadFrame enabled={false} navigation={null} header={null}
    workspace={<Text>phone workspace contents</Text>} mobileWorkspaceOpen={false}>
    <LayoutActions />
  </TabletThreadFrame>);
  expect(view.queryByText('phone workspace contents')).toBeNull();
  await fireEvent.press(view.getByLabelText('test reveal workspace'));
  await act(async () => {});
  expect(view.getByText('phone workspace contents')).toBeTruthy();
  await view.unmount();
});

test('closing the phone overlay after full-page view does not leave the main chat hidden', async () => {
  const tree = (open: boolean) => <TabletThreadFrame enabled={false} navigation={null} header={null}
    workspace={<LayoutActions />} mobileWorkspaceOpen={open}>
    <Text>main chat contents</Text>
  </TabletThreadFrame>;
  const view = await render(tree(true));
  await fireEvent.press(view.getByLabelText('test fullscreen workspace'));
  await view.rerender(tree(false));
  expect(view.getByText('main chat contents')).toBeTruthy();
  await view.unmount();
});
