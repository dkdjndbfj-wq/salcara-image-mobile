import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import { NewConversationFlow } from '../remote/NewConversationFlow';
import { parseProjectBrowserResult } from '../remote/project-browser';
import type { AgentProfile } from '../remote/client';

jest.mock('../remote/direct-api', () => ({ requestDirect: jest.fn() }));
jest.mock('../remote/direct-pairing', () => ({ directConnectionGeneration: () => 1, directDeliveryScope: () => 'direct', getDirectConnectionState: () => ({ status: 'connected', deviceId: 'pc' }) }));
const agents: AgentProfile[] = ['codex', 'claude'].map(id => ({ id, tool: id, name: id === 'codex' ? 'Codex' : 'Claude Code', available: true, remoteSendSupported: true,
  capabilities: { list: true, read: true, send: true, interrupt: false, approval: false, questions: false, subagents: false, attachments: false, imageInput: false, imageOutput: false, modelOverride: false }, api: { name: '主力 API', model: 'model', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_00112233' } }));
function setup(overrides: Record<string, unknown> = {}) {
  const request = jest.fn(async (agent: AgentProfile, input: any) => {
    const base = { tool: agent.tool, workspaceMode: 'code', cwd: input.cwd, path: input.path };
    if (!input.cwd) return { ...base, roots: [{ path: 'C:/', name: '本地磁盘 (C:)' }, { path: 'E:/', name: '数据 (E:)' }] };
    if (input.action === 'mkdir') return { ...base, project: { path: input.cwd + (input.path ? input.path + '/' : '') + input.name, name: input.name } };
    return { ...base, directory: { path: input.path, entries: input.path ? [] : ['Windows', 'Users', '.hidden'].map(name => ({ name, path: name, kind: 'directory' })) } };
  });
  const props = { scopeKey: 'pair|pc', deviceId: 'pc', deviceName: '工作电脑', transport: 'direct' as const, mode: 'code' as const, agents, online: true,
    explorerAvailable: true, projectlessAvailable: true, onRefresh: jest.fn(), onClose: jest.fn(), onComplete: jest.fn(),
    requestForAgent: (agent: AgentProfile) => (input: any) => request(agent, input), ...overrides };
  return { request, props };
}

test('global new conversation chooses Agent before browsing disks and requires a new folder name', async () => {
  const { request, props } = setup(), view = await render(<NewConversationFlow {...props} />);
  expect(view.getByText('选择这次使用的 Agent')).toBeTruthy(); expect(request).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('选择 Claude Code'));
  await fireEvent.press(await view.findByLabelText('浏览磁盘 C:/'));
  expect(await view.findByLabelText('浏览文件夹 Windows')).toBeTruthy(); expect(view.getByLabelText('浏览文件夹 .hidden')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('浏览文件夹 Users'));
  await fireEvent.press(await view.findByLabelText('在此位置新建文件夹'));
  expect(view.queryByLabelText('使用当前文件夹')).toBeNull(); expect(props.onComplete).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([, input]) => input.action === 'mkdir')).toBe(false);
  await fireEvent.changeText(view.getByLabelText('新文件夹名称'), '新的项目');
  await fireEvent.press(view.getByLabelText('创建文件夹并使用'));
  await waitFor(() => expect(props.onComplete).toHaveBeenCalledWith({ agent: agents[1], cwd: 'C:/Users/新的项目', project: { path: 'C:/Users/新的项目', name: '新的项目' } }));
  expect(request.mock.calls.every(([agent]) => agent.id === 'claude')).toBe(true);
  expect(request.mock.calls.filter(([, input]) => input.action === 'mkdir')).toHaveLength(1);
});

test('global no-folder choice preserves the selected Agent without a filesystem mutation', async () => {
  const { request, props } = setup(), view = await render(<NewConversationFlow {...props} />);
  await fireEvent.press(view.getByLabelText('选择 Codex'));
  await fireEvent.press(await view.findByLabelText('不关联文件夹，直接开始'));
  expect(props.onComplete).toHaveBeenCalledWith({ agent: agents[0], cwd: '', projectless: true });
  expect(request.mock.calls.some(([, input]) => input.action !== 'list')).toBe(false);
});

test('back follows name, directory, disk, Agent, then close, including the registered hardware path', async () => {
  const keyboard = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  let back: (() => boolean) | null = null;
  const { props } = setup({ onRegisterBack: (action: (() => boolean) | null) => { back = action; } });
  const view = await render(<NewConversationFlow {...props} />);
  await fireEvent.press(view.getByLabelText('选择 Codex')); await fireEvent.press(await view.findByLabelText('浏览磁盘 C:/'));
  await fireEvent.press(await view.findByLabelText('在此位置新建文件夹'));
  await act(async () => { expect(back?.()).toBe(true); }); expect(view.queryByLabelText('新文件夹名称')).toBeNull();
  await act(async () => { expect(back?.()).toBe(true); }); expect(await view.findByLabelText('浏览磁盘 C:/')).toBeTruthy();
  await act(async () => { expect(back?.()).toBe(true); }); expect(view.getByLabelText('选择 Claude Code')).toBeTruthy();
  await act(async () => { expect(back?.()).toBe(true); }); expect(props.onClose).toHaveBeenCalledTimes(1); keyboard.mockRestore();
});

test('cancelled or switched global flow cannot deliver a late directory creation', async () => {
  const { props, request } = setup(), view = await render(<NewConversationFlow {...props} />);
  await fireEvent.press(view.getByLabelText('选择 Codex')); await fireEvent.press(await view.findByLabelText('浏览磁盘 C:/'));
  await fireEvent.press(await view.findByLabelText('在此位置新建文件夹')); await fireEvent.changeText(view.getByLabelText('新文件夹名称'), 'late');
  let finish!: (value: any) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await fireEvent.press(view.getByLabelText('创建文件夹并使用'));
  await fireEvent.press(view.getByLabelText('取消新建会话'));
  await view.rerender(<NewConversationFlow {...props} scopeKey="other-pc" deviceId="other" />);
  await act(async () => finish({ tool: 'codex', workspaceMode: 'code', cwd: 'C:/', path: '', project: { path: 'C:/late', name: 'late' } }));
  expect(props.onComplete).not.toHaveBeenCalled(); expect(view.getByText('选择这次使用的 Agent')).toBeTruthy();
});

test('an older peer does not masquerade authorized projects as all disks', async () => {
  const { props, request } = setup({ explorerAvailable: false }), view = await render(<NewConversationFlow {...props} />);
  await fireEvent.press(view.getByLabelText('选择 Codex'));
  expect(await view.findByText(/请更新电脑端和中转站后浏览电脑磁盘/)).toBeTruthy(); expect(request).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('返回选择 Agent')); expect(view.getByLabelText('选择 Claude Code')).toBeTruthy();
});

test('permission errors keep the current directory navigable and do not create a folder', async () => {
  const { props, request } = setup(), view = await render(<NewConversationFlow {...props} />);
  await fireEvent.press(view.getByLabelText('选择 Codex')); await fireEvent.press(await view.findByLabelText('浏览磁盘 C:/'));
  request.mockRejectedValueOnce(new Error('explorer_permission: 电脑系统不允许访问此文件夹，请选择其他位置'));
  await fireEvent.press(await view.findByLabelText('浏览文件夹 Windows'));
  expect(await view.findByText(/不允许访问此文件夹/)).toBeTruthy(); expect(view.getByLabelText('上一级')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('上一级')); expect(await view.findByLabelText('浏览磁盘 E:/')).toBeTruthy();
  expect(props.onComplete).not.toHaveBeenCalled(); expect(request.mock.calls.some(([, input]) => input.action === 'mkdir')).toBe(false);
});

test('the explorer parser accepts a Linux root and hidden paths but rejects escaped or substituted directories', () => {
  const input = { action: 'mkdir', cwd: '/', path: 'home/user/.projects', name: 'new' };
  const reply = { tool: 'codex', workspaceMode: 'code', cwd: '/', path: input.path, project: { path: '/home/user/.projects/new', name: 'new' } };
  expect(parseProjectBrowserResult(reply, input, 'codex', 'code', true).project?.path).toBe(reply.project.path);
  expect(() => parseProjectBrowserResult({ ...reply, project: { path: '/other/new', name: 'new' } }, input, 'codex', 'code', true)).toThrow();
  const list = { action: 'list', cwd: '/', path: '' };
  expect(() => parseProjectBrowserResult({ ...reply, path: '', directory: { path: '', entries: [{ name: '..', path: '..', kind: 'directory' }] } }, list, 'codex', 'code', true)).toThrow();
});
