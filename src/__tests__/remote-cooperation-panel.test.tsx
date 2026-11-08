import React from 'react';
import { fireEvent, render, act } from '@testing-library/react-native';
import { CooperationSheet } from '../remote/CooperationSheet';
const mockPrepare = jest.fn(), mockSend = jest.fn(), mockSettings = new Map<string,string>();
let mockScope = 'scope-a';
const mockSource = { sessionKey: 'codex:source', tool: 'codex', title: '当前任务', status: 'idle', controllable: true, controlSurface: 'cli', cwd: '/project' };
const mockTarget = { ...mockSource, sessionKey: 'codex:target', title: '修复任务' };
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null, setSetting: async (key: string,value: string) => { mockSettings.set(key,value); } }));
jest.mock('../remote/store', () => ({ cooperationScope: () => mockScope, cooperationReceiptOwner: (deviceId: string) => 'owner:' + deviceId, loadSessions: async () => undefined,
  prepareCooperation: (...args: unknown[]) => mockPrepare(...args), sendCooperation: (...args: unknown[]) => mockSend(...args),
  useRemote: () => ({ sessions: { pc: { list: [mockSource,mockTarget,{...mockTarget,sessionKey:'claude:other',tool:'claude',title:'其他 Agent'}] } } }) }));
beforeEach(() => { mockSettings.clear(); mockScope='scope-a'; mockPrepare.mockReset();mockSend.mockReset();
  mockPrepare.mockImplementation(async () => ({ ticket:'a'.repeat(64),expiresAt:Date.now()+300000,source:mockSource,target:mockTarget,scope:mockScope }));
  mockSend.mockResolvedValue({state:'sent'});
});
test('opening reply prepares its exact pair but requires typing and an explicit send tap', async () => {
  const view=await render(<CooperationSheet deviceId="pc" sourceSessionKey="codex:source" initialTarget="codex:target" onClose={jest.fn()} onOpenTask={jest.fn()}/>);
  expect(mockPrepare).toHaveBeenCalledWith('pc','codex:source','codex:target',expect.anything()); expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.changeText(view.getByLabelText('跨任务消息'),'请检查这里'); expect(mockSend).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('发送消息'));expect(mockSend).toHaveBeenCalledTimes(1);expect(mockSend.mock.calls[0][2]).toBe('请检查这里');
});
test('search filters same-agent writable tasks and clicking a target only prepares', async () => {
  const view=await render(<CooperationSheet deviceId="pc" sourceSessionKey="codex:source" onClose={jest.fn()} onOpenTask={jest.fn()}/>);
  expect(view.queryByText('其他 Agent')).toBeNull();expect(mockPrepare).not.toHaveBeenCalled();
  await fireEvent.changeText(view.getByLabelText('搜索接收任务'),'不存在');expect(view.queryByLabelText('选择 修复任务')).toBeNull();
  await fireEvent.changeText(view.getByLabelText('搜索接收任务'),'修复');await fireEvent.press(view.getByLabelText('选择 修复任务'));
  expect(mockPrepare).toHaveBeenCalledTimes(1);expect(mockSend).not.toHaveBeenCalled();
});
test('late preparation from an old API scope cannot populate a new composer', async () => {
  let resolve!: (value: unknown)=>void;mockPrepare.mockReturnValue(new Promise(done=>{resolve=done;}));
  const node=()=> <CooperationSheet deviceId="pc" sourceSessionKey="codex:source" onClose={jest.fn()} onOpenTask={jest.fn()}/>;
  const view=await render(node());await fireEvent.press(view.getByLabelText('选择 修复任务'));
  mockScope='scope-b';await view.rerender(node());
  await act(async()=>{resolve({ticket:'a'.repeat(64),expiresAt:Date.now()+300000,source:mockSource,target:mockTarget,scope:'scope-a'});});
  expect(view.queryByLabelText('跨任务消息')).toBeNull();expect(mockSend).not.toHaveBeenCalled();
});
