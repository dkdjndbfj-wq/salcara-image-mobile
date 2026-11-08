import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { RemoteDemoFlow } from '../remote/RemoteDemoFlow';
import { SIMULATED_REMOTE_AGENTS, SIMULATED_REMOTE_DEVICE, SIMULATED_REMOTE_SESSIONS } from '../remote/development-fixture';

test('demo model selection preserves its separately selected supported effort',async()=>{
  const view=await render(<RemoteDemoFlow computer={SIMULATED_REMOTE_DEVICE} agents={SIMULATED_REMOTE_AGENTS} sessions={SIMULATED_REMOTE_SESSIONS} initialAgentId="codex" onBack={()=>undefined}/>);
  await fireEvent.press(view.getByLabelText('打开 修复登录页平板布局'));
  await fireEvent.press(view.getByLabelText('模型：GPT-5.2'));await fireEvent.press(view.getByLabelText('GPT-5.2'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  expect(view.getByTestId('remote-effort-chip').props.accessibilityLabel).toBe('High');
  await fireEvent.press(view.getByLabelText('模型：GPT-5.2'));await fireEvent.press(view.getByLabelText('Claude Sonnet 4.5'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  expect(view.getByTestId('remote-effort-chip').props.accessibilityLabel).toBe('High');await view.unmount();
});

test('demo composer opens slash commands and selects plan and skills without sending the command text',async()=>{
  const view=await render(<RemoteDemoFlow computer={SIMULATED_REMOTE_DEVICE} agents={SIMULATED_REMOTE_AGENTS} sessions={SIMULATED_REMOTE_SESSIONS} initialAgentId="codex" onBack={()=>undefined}/>);
  await fireEvent.press(view.getByLabelText('打开 修复登录页平板布局'));
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'),'/');
  expect(view.getByTestId('remote-slash-menu')).toBeTruthy();await fireEvent.press(view.getByLabelText('选择计划模式，/plan'));
  expect(view.getByLabelText('关闭演示计划模式')).toBeTruthy();expect(view.getByLabelText('编程对话输入框').props.value).toBe('');
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'),'/frontend');
  await fireEvent.press(view.getByLabelText('选择技能 前端设计，/frontend-design'));
  expect(view.getByLabelText('移除演示技能 frontend-design')).toBeTruthy();expect(view.getByLabelText('编程对话输入框').props.value).toBe('');await view.unmount();
});

test('demo directory opens in the requested Work mode and filters to that mode', async () => {
  const view = await render(<RemoteDemoFlow computer={SIMULATED_REMOTE_DEVICE} agents={SIMULATED_REMOTE_AGENTS}
    sessions={SIMULATED_REMOTE_SESSIONS} initialAgentId="codex" initialWorkspaceMode="work" onBack={() => undefined} />);

  expect(view.getByText('Work 项目')).toBeTruthy();
  expect(view.queryByRole('tab', { name: 'Code 工作区' })).toBeNull();
  expect(view.getByLabelText('折叠项目 release-operations')).toBeTruthy();
  expect(view.getByLabelText('折叠项目 product-planning')).toBeTruthy();
  expect(view.getByText('准备平板发布检查清单')).toBeTruthy();
  expect(view.queryByText('修复登录页平板布局')).toBeNull();
});

test('demo important slash actions open settings and prepare initialization without sending',async()=>{
  const view=await render(<RemoteDemoFlow computer={SIMULATED_REMOTE_DEVICE} agents={SIMULATED_REMOTE_AGENTS} sessions={SIMULATED_REMOTE_SESSIONS} initialAgentId="codex" onBack={()=>undefined}/>);
  await fireEvent.press(view.getByLabelText('打开 修复登录页平板布局'));
  const input=()=>view.getByLabelText('编程对话输入框');
  await fireEvent.changeText(input(),'/model');await fireEvent.press(view.getByLabelText('选择模型，/model'));
  expect(view.getByLabelText('关闭模型选择')).toBeTruthy();expect(input().props.value).toBe('');
  await fireEvent.press(view.getByLabelText('关闭模型选择'));
  await fireEvent.changeText(input(),'/reasoning');await fireEvent.press(view.getByLabelText('选择推理强度，/reasoning'));
  expect(view.getByTestId('main-effort-slider')).toBeTruthy();await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  await fireEvent.changeText(input(),'/init');await fireEvent.press(view.getByLabelText('选择初始化，/init'));
  expect(input().props.value).toContain('AGENTS.md');expect(view.queryByTestId('remote-slash-menu')).toBeNull();
  await fireEvent.changeText(input(),'/');
  expect(view.queryByLabelText(/宠物|智能伙伴/)).toBeNull();expect(view.queryByLabelText('选择归档，/archive')).toBeNull();
  await view.unmount();
});

test('demo directory defaults to Code when no initial mode is supplied', async () => {
  const view = await render(<RemoteDemoFlow computer={SIMULATED_REMOTE_DEVICE} agents={SIMULATED_REMOTE_AGENTS}
    sessions={SIMULATED_REMOTE_SESSIONS} initialAgentId="codex" onBack={() => undefined} />);

  expect(view.getByText('Code 项目')).toBeTruthy();
  expect(view.getByLabelText('折叠项目 salcara-web')).toBeTruthy();
  expect(view.getByLabelText('折叠项目 remote-bridge')).toBeTruthy();
  expect(view.getByText('修复登录页平板布局')).toBeTruthy();
  expect(view.queryByText('准备平板发布检查清单')).toBeNull();
});

test('external back moves from the session directory to Agent selection, then exits from Agent selection', async () => {
  let externalBack: (() => void) | null = null;
  const onBack = jest.fn();
  const registerBack = (handler: (() => void) | null) => { externalBack = handler; };
  const view = await render(<RemoteDemoFlow computer={SIMULATED_REMOTE_DEVICE} agents={SIMULATED_REMOTE_AGENTS}
    sessions={SIMULATED_REMOTE_SESSIONS} initialAgentId="codex" onBack={onBack} onRegisterBack={registerBack} />);

  expect(view.getByText('Code 项目')).toBeTruthy();
  await act(async () => { externalBack?.(); });
  expect(view.getByLabelText('选择 Codex')).toBeTruthy();
  expect(onBack).not.toHaveBeenCalled();

  await act(async () => { externalBack?.(); });
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('external back from the demo conversation returns to its session directory', async () => {
  let externalBack: (() => void) | null = null;
  const registerBack = (handler: (() => void) | null) => { externalBack = handler; };
  const view = await render(<RemoteDemoFlow computer={SIMULATED_REMOTE_DEVICE} agents={SIMULATED_REMOTE_AGENTS}
    sessions={SIMULATED_REMOTE_SESSIONS} initialAgentId="codex" onBack={() => undefined} onRegisterBack={registerBack} />);

  await fireEvent.press(view.getByLabelText('打开 修复登录页平板布局'));
  expect(view.getByText('示例数据 · Codex')).toBeTruthy();
  await act(async () => { externalBack?.(); });
  expect(view.getByText('Code 项目')).toBeTruthy();
  expect(view.getByLabelText('打开 修复登录页平板布局')).toBeTruthy();
});

test('choosing an Agent only opens its project tree; folders collapse and only a session opens chat', async () => {
  const open = jest.fn();
  const view = await render(<RemoteDemoFlow agents={SIMULATED_REMOTE_AGENTS} sessions={SIMULATED_REMOTE_SESSIONS} onBack={()=>undefined} onOpenWorkspace={open}/>);
  await fireEvent.press(view.getByLabelText('选择 Codex'));
  expect(open).not.toHaveBeenCalled();
  const app = within(view.getByTestId('demo-project:project:d:\\projects\\salcara-web'));
  const bridge = within(view.getByTestId('demo-project:project:d:\\projects\\remote-bridge'));
  expect(app.getByLabelText('打开 修复登录页平板布局')).toBeTruthy();
  expect(app.getByLabelText('打开 整理工作区工具标签')).toBeTruthy();
  expect(bridge.queryByLabelText('打开 修复登录页平板布局')).toBeNull();
  expect(bridge.getByLabelText('打开 补齐会话事件同步')).toBeTruthy();
  expect(view.getByLabelText('整理工作区工具标签：运行中')).toBeTruthy();
  expect(view.queryByText('整理 API 错误处理')).toBeNull();
  expect(view.queryByText('准备平板发布检查清单')).toBeNull();
  await fireEvent.press(view.getByLabelText('折叠项目 salcara-web'));
  expect(view.queryByLabelText('打开 修复登录页平板布局')).toBeNull();
  expect(open).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('打开 补齐会话事件同步'));
  expect(open).toHaveBeenCalledWith({agent:SIMULATED_REMOTE_AGENTS[0],session:expect.objectContaining({sessionKey:'codex:simulated-events',cwd:'D:\\Projects\\remote-bridge'}),workspaceMode:'code'});
});

test.each(['code','work'] as const)('every demo Agent has multiple projects with multiple %s sessions', async mode => {
  for (const agent of SIMULATED_REMOTE_AGENTS) {
    const view = await render(<RemoteDemoFlow agents={SIMULATED_REMOTE_AGENTS} sessions={SIMULATED_REMOTE_SESSIONS} initialAgentId={agent.id} initialWorkspaceMode={mode} onBack={()=>undefined}/>);
    const groups = view.getAllByTestId(/^demo-project:/);
    expect(groups).toHaveLength(2);
    for (const group of groups) expect(within(group).getAllByRole('button',{name:/^打开 /}).length).toBeGreaterThanOrEqual(2);
    await view.unmount();
  }
});
