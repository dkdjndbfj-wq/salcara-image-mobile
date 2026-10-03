import React from 'react';
import { fireEvent, render, act } from '@testing-library/react-native';
import { ApiPicker } from '../remote/ApiPicker';
import { QuestionCard } from '../remote/QuestionCard';
import { ModelPopover } from '../remote/ModelPopover';
import { questionValidation } from '../remote/questions';
import { apiProblem, modelCatalogProblem } from '../remote/api-errors';
import { HubError, type AgentProfile } from '../remote/client';

const mockSetApi = jest.fn();
const mockToast = jest.fn();
jest.mock('../remote/store', () => ({ useRemote: () => ({ connectionId: 'paired' }), setAgentApi: (...args: unknown[]) => mockSetApi(...args) }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => {
  const React = require('react'); const { Pressable, View, Text } = require('react-native');
  return {
    Group: ({ children }: { children: unknown }) => React.createElement(View, null, children),
    Sheet: ({ visible, title, children, footer }: { visible: boolean; title: string; children: unknown; footer: unknown }) => visible ? React.createElement(View, null, React.createElement(Text, null, title), children, footer) : null,
    PrimaryButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: label, onPress, disabled }, React.createElement(Text, null, label)),
    showToast: (...args: unknown[]) => mockToast(...args),
    dismissKeyboardAndBlur: () => undefined,
    useReducedMotion: () => true,
  };
});

const agent: AgentProfile = { id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true, conversationApiSwitch: true,
  api: { name: '主力', model: 'gpt-fixture', protocol: 'responses', configured: true, pending: false, source: 'computer' } };
beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); });

test('model popup contains a concise API entry', async () => {
  const api = jest.fn();
  const view = await render(<ModelPopover visible anchor={null} value="" fallback="gpt-fixture" models={['gpt-fixture']} loading={false} apiName="主力" onApi={api} onClose={jest.fn()} onSelect={jest.fn()} onRefresh={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('更换对话 API'));
  expect(view.getByText('API：主力')).toBeTruthy(); expect(api).toHaveBeenCalledTimes(1);
});

test('model popup dismisses through its backdrop without a visible close action or accidental model/refresh presses', async () => {
  const close = jest.fn(), select = jest.fn(), refresh = jest.fn();
  const popup = (visible: boolean) => <ModelPopover visible={visible} anchor={null} value="" fallback="gpt-fixture" models={['gpt-fixture']} loading={false}
    onClose={close} onSelect={select} onRefresh={refresh} />;
  const view = await render(popup(true));
  expect(view.queryByText('关闭')).toBeNull();
  expect(view.queryByLabelText('关闭模型选择')).toBeNull();
  // The modal card hides siblings from accessibility queries; the backdrop remains touchable.
  await fireEvent.press(view.getByTestId('remote-model-backdrop', { includeHiddenElements: true }));
  expect(close).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  close.mockClear();
  await view.rerender(popup(false)); await view.rerender(popup(true));
  await fireEvent.press(view.getByRole('radio', { name: 'gpt-fixture' }));
  expect(select).toHaveBeenCalledWith('gpt-fixture'); expect(close).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('刷新模型列表'));
  expect(refresh).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled(); expect(select).toHaveBeenCalledTimes(1);
});

test('a managed API popup lists only verified catalog members, not old current/default models', async () => {
  const view = await render(<ModelPopover visible anchor={null} value="old-model" fallback="retired-default" models={['deepseek-chat']} loading={false} catalogOnly catalogReady
    onClose={jest.fn()} onSelect={jest.fn()} onRefresh={jest.fn()} />);
  expect(view.queryByRole('radio', { name: 'old-model' })).toBeNull();
  expect(view.queryByRole('radio', { name: 'retired-default' })).toBeNull();
  expect(view.queryByRole('radio', { name: '默认' })).toBeNull();
  expect(view.getAllByRole('radio')).toHaveLength(1);
});

test('conversation API switch passes original session and uses opaque computer handle only', async () => {
  const changed = jest.fn(), close = jest.fn(); mockSetApi.mockResolvedValue({ ...agent, api: { ...agent.api, name: '备用', model: 'deepseek-chat', source: 'phone' } });
  const view = await render(<ApiPicker visible deviceId="pc" agent={agent} apis={[{ id: 'api_opaque', name: '备用', models: ['deepseek-chat'] }]} sessionKey="codex:original" onChanged={changed} onClose={close} />);
  await fireEvent.press(view.getByRole('radio', { name: '备用' }));
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  expect(mockSetApi).toHaveBeenCalledWith('pc', 'codex', 'api_opaque', '', 'codex:original');
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ api: expect.objectContaining({ model: 'deepseek-chat' }) })); expect(close).toHaveBeenCalledTimes(1);
  expect(mockToast).not.toHaveBeenCalled();
  expect(view.queryByText('原对话保留，下一轮后台重连。')).toBeNull();
});

test('running or uncertain task cannot switch API', async () => {
  const view = await render(<ApiPicker visible deviceId="pc" agent={agent} apis={[]} blocked="先核对待确认消息，再换 API" onClose={jest.fn()} />);
  expect(view.getByLabelText('使用这个设置').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('使用这个设置')); expect(mockSetApi).not.toHaveBeenCalled();
});

test('older Bridge cannot silently ignore the conversation API safety guard', async () => {
  const view = await render(<ApiPicker visible deviceId="pc" agent={{ ...agent, conversationApiSwitch: undefined }} apis={[]} sessionKey="codex:original" onClose={jest.fn()} />);
  expect(view.getByText('请先更新电脑端 Bridge')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('使用这个设置'));
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('late switch receipt updates the original operation without reopening a dismissed picker', async () => {
  let finish!: (profile?: AgentProfile) => void;
  mockSetApi.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const close = jest.fn(), changed = jest.fn();
  const view = await render(<ApiPicker visible deviceId="pc" agent={agent} apis={[]} onClose={close} onChanged={changed} />);
  await act(async () => { fireEvent.press(view.getByLabelText('使用这个设置')); });
  await view.rerender(<ApiPicker visible={false} deviceId="pc" agent={agent} apis={[]} onClose={close} onChanged={changed} />);
  await act(async () => { finish(agent); });
  expect(close).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledWith(agent); expect(mockToast).not.toHaveBeenCalled();
});

test('phone submits selected choices and custom text; never auto-selects answers', async () => {
  const answer = jest.fn();
  const view = await render(<QuestionCard id="ask" title="需要选择" busy={false} onCancel={jest.fn()} onAnswer={answer} questions={[
    { id: 'one', question: '选方案', required: true, inputType: 'enum', options: [{ label: ' A ', description: '保留空格' }, { label: 'B' }] },
    { id: 'two', question: '选功能', required: true, multiSelect: true, allowCustom: true, options: [{ label: '手机' }, { label: '电脑' }] },
  ]} />);
  await fireEvent.press(view.getByLabelText('下一题')); expect(answer).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('radio', { name: ' A ' }));
  await fireEvent.press(view.getByLabelText('下一题'));
  await fireEvent.press(view.getByRole('checkbox', { name: '手机' }));
  await fireEvent.press(view.getByLabelText('选功能：自定义回答'));
  await fireEvent.changeText(view.getByLabelText('选功能：回答'), '平板');
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(answer).toHaveBeenCalledWith({ one: [' A '], two: ['手机', '平板'] });
});

test('expired questions are disabled and cannot be submitted', async () => {
  jest.useFakeTimers(); const answer = jest.fn();
  const view = await render(<QuestionCard id="expiry" title="问题" questions={[{ id: 'q', question: '名称', required: true }]} expiresAt={Date.now() + 500} busy={false} onAnswer={answer} onCancel={jest.fn()} />);
  await fireEvent.changeText(view.getByLabelText('名称：回答'), '回答');
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(view.getByText('问题已过期，请刷新')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('提交回答')); expect(answer).not.toHaveBeenCalled();
});

test('MCP boolean and numeric validation is strict, and cancel does not invent an answer', async () => {
  expect(questionValidation([{ id: 'n', question: '次数', inputType: 'integer', required: true, min: 1, max: 5 }], { n: ['1.5'] })).toBeTruthy();
  expect(questionValidation([{ id: 'n', question: '次数', inputType: 'integer' }], { n: ['9007199254740992'] })).toBeTruthy();
  expect(questionValidation([{ id: 'b', question: '开关', inputType: 'boolean' }], { b: ['true'] })).toBeNull();
  const answer = jest.fn(), cancel = jest.fn();
  const view = await render(<QuestionCard id="cancel" title="表单" questions={[{ id: 'b', question: '开关', inputType: 'boolean', required: true }]} busy={false} onAnswer={answer} onCancel={cancel} />);
  await fireEvent.press(view.getByLabelText('取消回答')); expect(cancel).toHaveBeenCalledTimes(1); expect(answer).not.toHaveBeenCalled();
});

test('provider failures guide API changes, while pairing/network failures do not', () => {
  expect(apiProblem('invalid_api_key')).toMatchObject({ kind: 'key' });
  expect(apiProblem('insufficient_quota')).toMatchObject({ kind: 'quota' });
  expect(apiProblem('上游返回 HTTP 429')).toMatchObject({ kind: 'rate' });
  expect(apiProblem('上游返回 HTTP 404')).toMatchObject({ kind: 'interface' });
  expect(apiProblem(new HubError('配对凭证无效或已撤销', 401))).toBeNull();
  expect(apiProblem('电脑不在线')).toBeNull(); expect(apiProblem('连不上中转站')).toBeNull(); expect(apiProblem('代码编译失败')).toBeNull();
  expect(modelCatalogProblem('这个 API 不支持该模型，请刷新后重选模型')).toBe(true);
  expect(modelCatalogProblem(new HubError('读取模型列表失败', 200))).toBe(true);
  expect(modelCatalogProblem(new HubError('读取模型列表失败', 401))).toBe(false);
  expect(modelCatalogProblem('电脑不在线')).toBe(false);
});

test('the compact form pages one question at a time, validates next and retains previous answers', async () => {
  const answer = jest.fn();
  const view = await render(<QuestionCard id="paged" title="三个问题" busy={false} onCancel={jest.fn()} onAnswer={answer} questions={[
    { id: 'name', question: '名称', required: true },
    { id: 'count', question: '次数', inputType: 'integer', min: 1, max: 5, required: true },
    { id: 'mode', question: '方式', required: true, options: [{ label: '只读' }, { label: '修改' }] },
  ]} />);
  expect(view.queryByLabelText('次数：回答')).toBeNull(); expect(view.queryByRole('radio', { name: '只读' })).toBeNull();
  const maxHeight = view.getByTestId('remote-question-body').props.style.maxHeight;
  expect(maxHeight).toBeGreaterThanOrEqual(72); expect(maxHeight).toBeLessThanOrEqual(220);
  await fireEvent.press(view.getByLabelText('下一题'));
  expect(view.getByText('请回答：名称')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('名称：回答'), '项目');
  await fireEvent.press(view.getByLabelText('下一题'));
  expect(view.queryByLabelText('名称：回答')).toBeNull();
  await fireEvent.changeText(view.getByLabelText('次数：回答'), '1.5');
  await fireEvent.press(view.getByLabelText('下一题'));
  expect(view.getByText('请填写范围内的数字')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('次数：回答'), '2');
  await fireEvent.press(view.getByLabelText('上一题'));
  expect(view.getByLabelText('名称：回答').props.value).toBe('项目');
  await fireEvent.press(view.getByLabelText('下一题'));
  expect(view.getByLabelText('次数：回答').props.value).toBe('2');
  await fireEvent.press(view.getByLabelText('下一题'));
  await fireEvent.press(view.getByRole('radio', { name: '只读' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(answer).toHaveBeenCalledWith({ name: ['项目'], count: ['2'], mode: ['只读'] });
});

test('offline answers can be prepared but are not sent or canceled; reconnect preserves the selection', async () => {
  const answer = jest.fn(), cancel = jest.fn();
  const card = (blocked?: string, busy = false) => <QuestionCard id="offline" title="问题" questions={[{ id: 'q', question: '决定', required: true, options: [{ label: 'A' }] }]}
    busy={busy} blocked={blocked} onAnswer={answer} onCancel={cancel} />;
  const view = await render(card('电脑离线，恢复后可回答'));
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  await fireEvent.press(view.getByLabelText('提交回答')); await fireEvent.press(view.getByLabelText('取消回答'));
  expect(answer).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  await view.rerender(card(undefined, true));
  expect(view.getByRole('radio', { name: 'A' }).props.accessibilityState.checked).toBe(true);
  expect(view.getByLabelText('提交回答').props.accessibilityState.disabled).toBe(true); expect(answer).not.toHaveBeenCalled();
  await view.rerender(card());
  expect(view.getByRole('radio', { name: 'A' }).props.accessibilityState.checked).toBe(true);
  await fireEvent.press(view.getByLabelText('提交回答')); expect(answer).toHaveBeenCalledWith({ q: ['A'] });
});

test('a collapsed custom answer remains visible in a concise label and selecting an option replaces it', async () => {
  const answer = jest.fn();
  const view = await render(<QuestionCard id="custom" title="问题" busy={false} onAnswer={answer} onCancel={jest.fn()}
    questions={[{ id: 'q', question: '方案', required: true, allowCustom: true, options: [{ label: 'A' }] }]} />);
  expect(view.queryByLabelText('方案：回答')).toBeNull();
  await fireEvent.press(view.getByLabelText('方案：自定义回答'));
  await fireEvent.changeText(view.getByLabelText('方案：回答'), '另一个方案');
  await fireEvent.press(view.getByLabelText('方案：自定义回答'));
  expect(view.queryByLabelText('方案：回答')).toBeNull(); expect(view.getByText('其他：另一个方案')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(answer).toHaveBeenLastCalledWith({ q: ['另一个方案'] });
  await fireEvent.press(view.getByRole('radio', { name: 'A' }));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(answer).toHaveBeenLastCalledWith({ q: ['A'] });
});

test('changing the request id does not reuse a previous form answer', async () => {
  const answer = jest.fn();
  const card = (id: string) => <QuestionCard id={id} title="问题" busy={false} onAnswer={answer} onCancel={jest.fn()} questions={[{ id: 'q', question: '名字', required: true }]} />;
  const view = await render(card('old'));
  await fireEvent.changeText(view.getByLabelText('名字：回答'), '旧回答');
  await view.rerender(card('new'));
  expect(view.getByLabelText('名字：回答').props.value).toBe('');
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(answer).not.toHaveBeenCalled();
});
