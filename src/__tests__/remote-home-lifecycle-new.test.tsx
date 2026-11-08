import React from 'react';
import { act, render } from '@testing-library/react-native';
import { RemoteHome } from '../remote/RemoteHome';
import type { RemoteState } from '../remote/store';

const mockLoad = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadAgents = jest.fn(async (..._args: unknown[]) => undefined);
let mockScope = 'station|credential:old';
jest.mock('../remote/store', () => ({ useRemote: () => ({}), remoteDeliveryScope: () => mockScope,
  loadSessions: (...args: unknown[]) => mockLoad(...args), loadAgentProfiles: (...args:unknown[]) => mockLoadAgents(...args),
  hydrateCachedSessions: async () => undefined }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => {
  const React = require('react'); const { View } = require('react-native');
  return { Group: ({ children }: { children: unknown }) => React.createElement(View, null, children) };
});
jest.mock('../remote/parts', () => ({ ToolBadge: () => null, relTime: () => '刚刚', osName: () => 'Windows' }));
jest.mock('react-native', () => {
  const React = require('react'); const actual = jest.requireActual('react-native'); const replacement = Object.create(actual);
  Object.defineProperty(replacement, 'Pressable', { enumerable: true, value: ({ children, ...props }: Record<string, unknown>) => React.createElement(actual.View, props, children) });
  return replacement;
});
const state = (): RemoteState => ({ phase: 'ready', connectionId: 'paired', selectedHubUrl: 'https://station.example', serviceId: null,
  connection: 'open', connections: [], probes: {}, signingIn: null, devicesLoaded: true,
  devices: [{ deviceId: 'pc', name: '工作电脑', online: true, os: 'windows', lastSeen: 1, tools: [], projects: [] }], agents: {},
  sessions: { pc: { loading: false, loaded: true, list: [{ sessionKey: 'codex:old', title: '旧会话', tool: 'codex', client: 'Codex App', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli', cwd: '', workspaceMode: 'code' }] } },
  timelines: {}, approvals: {}, focus: null });
beforeEach(() => { jest.clearAllMocks(); mockScope = 'station|credential:old'; });

test('known extension cards stay visible without inventing installation or routing support', async () => {
  const remote = state();remote.agents.pc = { list: [], apis: [], loaded: true, loading: false, autoAll: false };
  const onAgent = jest.fn();
  const props = { remote, device: remote.devices[0], onAgent, onComputer: jest.fn(), onApi: jest.fn(), onProjects: jest.fn(), onSession: jest.fn(), onDownload: jest.fn() };
  const view = await render(<RemoteHome {...props} visible />);
  for (const name of ['DeepSeek Harness', 'Hermes Agent']) {
    const button = view.getByLabelText(`打开 ${name}`);
    expect(button.props.disabled).toBe(true);
    await act(async () => button.props.onPress());
  }
  expect(onAgent).not.toHaveBeenCalled();expect(view.getAllByText('电脑端未提供')).toHaveLength(2);
});

test('advertised DeepSeek and Hermes have one entrance each and keep their names in recent tasks', async () => {
  const remote = state();
  const list = ['deepseek-harness', 'hermes'].map((id, index) => ({ id, tool: id, name: index ? 'Hermes Agent' : 'DeepSeek Harness', available: true, remoteSendSupported: true,
    execution: { tool: id, controlSurface: 'cli' as const }, api: { name: '工作 API', model: 'model', protocol: 'chat', configured: true, pending: false, source: 'computer' as const } }));
  remote.agents.pc = { list, apis: [], loaded: true, loading: false, autoAll: false };
  remote.sessions.pc.list = list.map(profile => ({ ...remote.sessions.pc.list[0], sessionKey: `${profile.id}:task`, tool: profile.tool, client: profile.name, title: profile.id }));
  const onAgent = jest.fn(), props = { remote, device: remote.devices[0], onAgent, onComputer: jest.fn(), onApi: jest.fn(), onProjects: jest.fn(), onSession: jest.fn(), onDownload: jest.fn() };
  const view = await render(<RemoteHome {...props} visible />);
  for (const profile of list) {
    expect(view.getAllByLabelText(`打开 ${profile.name}`)).toHaveLength(1);
    expect(view.getByText(`${profile.name} · 刚刚`)).toBeTruthy();
    await act(async () => view.getByLabelText(`打开 ${profile.name}`).props.onPress());
    expect(onAgent).toHaveBeenLastCalledWith(profile.id);
  }
  mockLoad.mockClear();mockLoadAgents.mockClear();
  await act(async () => view.getByTestId('remote-home').props.refreshControl.props.onRefresh());
  expect(mockLoad).toHaveBeenCalledTimes(1);expect(mockLoadAgents).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('remote-home').props.refreshControl.props.refreshing).toBe(false);
});

test.each(['hidden', 'reopened', 'scope', 'credential', 'device', 'unmounted'] as const)('stale home entrances and refresh are ignored after %s', async condition => {
  const remote = state();
  const props: React.ComponentProps<typeof RemoteHome> = { visible: true, remote, device: remote.devices[0],
    onComputer: jest.fn(), onApi: jest.fn(), onAgent: jest.fn(), onProjects: jest.fn(), onSession: jest.fn(), onDownload: jest.fn() };
  const view = await render(<RemoteHome {...props} />);
  const oldActions = ['连接电脑', 'API 管理', '打开 Codex', '项目与会话', '旧会话', '下载电脑端'].map(label => view.getByLabelText(label).props.onPress);
  const refresh = view.getByTestId('remote-home').props.refreshControl.props.onRefresh;
  if (condition === 'hidden' || condition === 'reopened') {
    await view.rerender(<RemoteHome {...props} visible={false} />);
    if (condition === 'reopened') await view.rerender(<RemoteHome {...props} />);
  } else if (condition === 'scope') await view.rerender(<RemoteHome {...props} remote={{ ...remote, serviceId: 'new-relay' }} />);
  else if (condition === 'credential') { mockScope = 'station|credential:renewed'; await view.rerender(<RemoteHome {...props} />); }
  else if (condition === 'device') await view.rerender(<RemoteHome {...props} device={{ ...remote.devices[0], deviceId: 'other' }} />);
  else await view.unmount();
  mockLoad.mockClear();
  await act(async () => { oldActions.forEach(action => action()); refresh(); });
  expect(props.onComputer).not.toHaveBeenCalled(); expect(props.onApi).not.toHaveBeenCalled(); expect(props.onAgent).not.toHaveBeenCalled();
  expect(props.onProjects).not.toHaveBeenCalled(); expect(props.onSession).not.toHaveBeenCalled(); expect(props.onDownload).not.toHaveBeenCalled(); expect(mockLoad).not.toHaveBeenCalled();
});

test.each([
  ['connecting', '正在建立加密直连…'],
  ['authenticating', '正在建立加密直连…'],
  ['closed', '未连接 · 点按重连'],
] as const)('direct home card shows the %s lifecycle state', async (status, label) => {
  const remote = state();
  const onDirect = jest.fn();
  const props: React.ComponentProps<typeof RemoteHome> = { visible: true, remote, device: remote.devices[0],
    directDevice: { deviceId: 'pc', deviceName: '直连电脑', connected: false, status }, onDirect,
    onComputer: jest.fn(), onApi: jest.fn(), onAgent: jest.fn(), onProjects: jest.fn(), onSession: jest.fn(), onDownload: jest.fn() };
  const view = await render(<RemoteHome {...props} />);
  expect(view.getByText(label)).toBeTruthy();
  await act(async () => { view.getByLabelText('打开电脑直连').props.onPress(); });
  expect(onDirect).toHaveBeenCalledTimes(1);
});

test('selecting direct retires Hub entrances and never loads the old computer data',async()=>{
  const remote=state(),props:React.ComponentProps<typeof RemoteHome>={visible:true,remote,device:remote.devices[0],
    directDevice:{deviceId:'direct-B',deviceName:'直连 B',connected:true,status:'connected'},onDirect:jest.fn(),
    onComputer:jest.fn(),onApi:jest.fn(),onAgent:jest.fn(),onProjects:jest.fn(),onSession:jest.fn(),onDownload:jest.fn()};
  const view=await render(<RemoteHome {...props}/>);
  const oldApi=view.getByLabelText('API 管理').props.onPress,oldTask=view.getByLabelText('旧会话').props.onPress;
  mockLoad.mockClear();mockLoadAgents.mockClear();
  await view.rerender(<RemoteHome {...props} directSelected/>);
  expect(view.getByText('直连 B')).toBeTruthy();expect(view.getByText('直连 · 已连接')).toBeTruthy();
  expect(view.queryByLabelText('API 管理')).toBeNull();expect(view.queryByLabelText('打开 Codex')).toBeNull();expect(view.queryByLabelText('旧会话')).toBeNull();
  await act(async()=>{oldApi();oldTask();view.getByTestId('remote-home').props.refreshControl.props.onRefresh();});
  expect(props.onApi).not.toHaveBeenCalled();expect(props.onSession).not.toHaveBeenCalled();
  expect(mockLoad).not.toHaveBeenCalled();expect(mockLoadAgents).not.toHaveBeenCalled();
  await act(async()=>view.getByLabelText('打开电脑直连').props.onPress());expect(props.onDirect).toHaveBeenCalledTimes(1);
});
