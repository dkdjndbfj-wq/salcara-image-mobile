import React from 'react';
import { act, render } from '@testing-library/react-native';
import { RemoteHome } from '../remote/RemoteHome';
import type { RemoteState } from '../remote/store';

const mockLoad = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('../remote/store', () => ({ loadSessions: (...args: unknown[]) => mockLoad(...args), hydrateCachedSessions: async () => undefined }));
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
  sessions: { pc: { loading: false, loaded: true, list: [{ sessionKey: 'codex:old', title: '旧会话', tool: 'codex', client: 'Codex App', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli', cwd: '' }] } },
  timelines: {}, approvals: {}, focus: null });
beforeEach(() => jest.clearAllMocks());

test.each(['hidden', 'reopened', 'scope', 'device', 'unmounted'] as const)('stale home entrances and refresh are ignored after %s', async condition => {
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
  else if (condition === 'device') await view.rerender(<RemoteHome {...props} device={{ ...remote.devices[0], deviceId: 'other' }} />);
  else await view.unmount();
  mockLoad.mockClear();
  await act(async () => { oldActions.forEach(action => action()); refresh(); });
  expect(props.onComputer).not.toHaveBeenCalled(); expect(props.onApi).not.toHaveBeenCalled(); expect(props.onAgent).not.toHaveBeenCalled();
  expect(props.onProjects).not.toHaveBeenCalled(); expect(props.onSession).not.toHaveBeenCalled(); expect(props.onDownload).not.toHaveBeenCalled(); expect(mockLoad).not.toHaveBeenCalled();
});
