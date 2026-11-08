import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { TemporarySideChat } from '../remote/TemporarySideChat';
import { resetTemporarySideChatsForTests, temporarySideChatSession, type TemporarySideChatTransport } from '../remote/temporary-side-chat';
import { SideQuestionNotDispatchedError, type SideQuestionReading, type SideQuestionResult } from '../remote/side-question';
const mockWrite = jest.fn();
jest.mock('../storage/database', () => ({ getSetting: jest.fn(), setSetting: (...args: unknown[]) => mockWrite(...args) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => jest.requireActual('node:crypto').randomUUID() }));
jest.mock('../remote/attachments', () => ({ pickRemoteImages: jest.fn(async () => []) }));
jest.mock('../components/MessageContent', () => ({ MessageContent: ({ text }: { text: string }) => { const { Text } = require('react-native'); return <Text>{text}</Text>; } }));
const key = 'codex:parent';
const reading: SideQuestionReading = { scope: 'binding:account:generation', value: { sessionKey: key, revision: 'snapshot-1', available: true, contextScope: 'loadedSnapshot', contextMessages: 2, contextTruncated: false,
  inputOptions: { version: 1, model: true, effort: true, images: true, readOnly: true, defaultModel: 'model-a' } } };
const result = (operationId: string): SideQuestionResult => ({ sessionKey: key, operationId, state: 'completed', answer: '临时回答', contextScope: 'loadedSnapshot', contextMessages: 2, contextTruncated: false });
let transport: TemporarySideChatTransport;
beforeEach(() => { resetTemporarySideChatsForTests(); jest.clearAllMocks(); transport = { isCurrent: () => true, read: jest.fn(async () => reading), ask: jest.fn(async (_, _input, id) => result(id)) }; });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('tab reopen restores only process memory; bindings, accounts, sessions and tab identities stay separate', async () => {
  const session = temporarySideChatSession('binding-a|account-a|tab-one', key); await session.read(transport); session.update({ draft: '未发送内容' });
  expect(temporarySideChatSession('binding-a|account-a|tab-one', key)).toBe(session);
  for (const scope of ['binding-b|account-a|tab-one', 'binding-a|account-b|tab-one', 'binding-a|account-a|tab-two']) expect(temporarySideChatSession(scope, key).snapshot().draft).toBe('');
  expect(temporarySideChatSession('binding-a|account-a|tab-one', 'codex:other').snapshot().draft).toBe('');
  resetTemporarySideChatsForTests(); expect(temporarySideChatSession('binding-a|account-a|tab-one', key).snapshot().draft).toBe(''); expect(mockWrite).not.toHaveBeenCalled();
});
test('double send is one request and a later edit is not consumed by an earlier answer', async () => {
  const session = temporarySideChatSession('one', key), pending = deferred<SideQuestionResult>(); await session.read(transport);
  transport.ask = jest.fn((_reading, _input, operation) => pending.promise.then(() => result(operation)));
  session.update({ draft: '第一问' }); const first = session.send(transport), second = session.send(transport); session.update({ draft: '继续编辑' });
  expect(first).toBe(second); expect(transport.ask).toHaveBeenCalledTimes(1); pending.resolve(result('ignored')); await first;
  expect(session.snapshot().draft).toBe('继续编辑'); expect(session.snapshot().turns).toHaveLength(1);
  transport.ask = jest.fn(async (_, _input, id) => result(id)); await session.send(transport);
  expect(transport.ask).toHaveBeenCalledWith(reading, expect.objectContaining({ question: '继续编辑', previousOperationId: session.snapshot().turns[0].operationId }), expect.any(String)); expect(mockWrite).not.toHaveBeenCalled();
});
test('unknown delivery freezes its chain and never retries automatically after tab reopen', async () => {
  const session = temporarySideChatSession('one', key); await session.read(transport); transport.ask = jest.fn(async () => { throw new Error('连接中断'); });
  session.update({ draft: '不要重复执行' }); await session.send(transport); await temporarySideChatSession('one', key).send(transport);
  expect(session.snapshot().phase).toBe('unconfirmed'); expect(session.snapshot().draft).toBe('不要重复执行'); expect(transport.ask).toHaveBeenCalledTimes(1);
});
test('a local pre-dispatch refusal preserves editable input, unlike an ambiguous network failure', async () => {
  const session = temporarySideChatSession('one', key); await session.read(transport); transport.ask = jest.fn(async () => { throw new SideQuestionNotDispatchedError('API 正在切换'); });
  session.update({ draft: '保留' }); await session.send(transport); expect(session.snapshot()).toMatchObject({ phase: 'ready', draft: '保留', turns: [] });
});
test('stale replies cannot enter the new source and are not shown as a confirmed old-source answer', async () => {
  const session = temporarySideChatSession('one', key), pending = deferred<SideQuestionResult>(); await session.read(transport);
  transport.ask = jest.fn((_reading, _input, operation) => pending.promise.then(() => result(operation))); session.update({ draft: '旧电脑' }); const flight = session.send(transport);
  transport.isCurrent = () => false; const next = temporarySideChatSession('two', key); pending.resolve(result('ignored')); await flight;
  expect(session.snapshot().turns[0].answer).toBe(''); expect(session.snapshot().phase).toBe('unconfirmed'); expect(next.snapshot().turns).toHaveLength(0);
});
test('model, reported effort and uploaded images reach the ephemeral request without permission escalation', async () => {
  const session = temporarySideChatSession('one', key); await session.read(transport); const attachment = 'att_11111111222243338444555555555555';
  transport.uploadImages = jest.fn(async () => [attachment]); session.update({ draft: '解释图片', model: 'model-b', effort: 'high', images: [{ uri: 'data:image/png;base64,YQ==', base64: 'YQ==', mime: 'image/png', width: 1, height: 1 }],
    models: { models: ['model-a', 'model-b'], modelCapabilities: { 'model-b': { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['high'], inputModalities: ['text', 'image'] } } } });
  await session.send(transport); expect(transport.uploadImages).toHaveBeenCalledTimes(1);
  expect(transport.ask).toHaveBeenCalledWith(reading, { question: '解释图片', model: 'model-b', effort: 'high', attachments: [attachment] }, expect.any(String)); expect(session.snapshot().images).toHaveLength(0);
});
test('unsupported options are rejected before upload or inference instead of silently discarded', async () => {
  const session = temporarySideChatSession('one', key); await session.read(transport); session.update({ draft: '问题', model: 'invented' }); await session.send(transport);
  expect(transport.ask).not.toHaveBeenCalled(); expect(session.snapshot().error).toContain('不会被忽略');
});
test('a text-only follow-up cannot silently resend an earlier image to an incompatible model', async () => {
  const session=temporarySideChatSession('one',key);await session.read(transport);transport.uploadImages=jest.fn(async()=>['att_11111111222243338444555555555555']);
  session.update({draft:'图片问题',images:[{uri:'data:image/png;base64,YQ==',base64:'YQ==',mime:'image/png',width:1,height:1}]});await session.send(transport);
  session.update({draft:'继续',model:'text-only',models:{models:['text-only'],modelCapabilities:{'text-only':{source:'codex-model-list',reasoningKnown:false,inputModalities:['text']}}}});await session.send(transport);
  expect(transport.ask).toHaveBeenCalledTimes(1);expect(session.snapshot().draft).toBe('继续');expect(session.snapshot().error).toContain('不会被忽略');
});
test('side panel uses temporary empty state, full input tools, and retains draft after tab unmount', async () => {
  let view = await render(<TemporarySideChat visible scopeKey="ui" sessionKey={key} transport={transport}/>);
  expect(view.getByText('侧边聊天是临时聊天，关闭应用后会消失。')).toBeTruthy();
  for (const label of ['临时聊天添加附件', '临时聊天权限', '临时聊天模型', '临时聊天推理强度']) expect(view.getByLabelText(label)).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'), '留在内存'); await view.unmount();
  view = await render(<TemporarySideChat visible scopeKey="ui" sessionKey={key} transport={transport}/>); expect(view.getByLabelText('临时侧边聊天输入').props.value).toBe('留在内存'); expect(transport.read).toHaveBeenCalledTimes(1); expect(mockWrite).not.toHaveBeenCalled();
  await view.rerender(<TemporarySideChat visible={false} scopeKey="ui" sessionKey={key} transport={transport}/>); await fireEvent.press(view.getByLabelText('发送临时聊天')); expect(transport.ask).not.toHaveBeenCalled();
});
test('native Work without a contract has an honest unavailable state and cannot submit', async () => {
  const view = await render(<TemporarySideChat visible scopeKey="native" sessionKey="codex-desktop:parent" unavailableReason="当前原生 Work 连接尚未提供临时侧边聊天能力"/>);
  expect(view.getByText('当前原生 Work 连接尚未提供临时侧边聊天能力')).toBeTruthy(); await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'), '不能伪造'); await fireEvent.press(view.getByLabelText('发送临时聊天')); expect(transport.ask).not.toHaveBeenCalled();
});

test('temporary model and effort controls open separate panels without changing inherited model ownership',async()=>{
  const catalog={models:['model-a','model-b'],modelCapabilities:{'model-a':{source:'codex-model-list' as const,reasoningKnown:true,reasoningEfforts:['high' as const]}}};
  transport.models=jest.fn(async()=>catalog);
  const view=await render(<TemporarySideChat visible scopeKey="slider" sessionKey={key} transport={transport}/>);
  const session=temporarySideChatSession('slider',key);
  await fireEvent.press(view.getByLabelText('临时聊天推理强度'));
  expect(view.getByTestId('main-effort-popover')).toBeTruthy();expect(view.queryByTestId('remote-model-popover')).toBeNull();
  await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  expect(session.snapshot()).toMatchObject({model:'',effort:'high'});
  await fireEvent.press(view.getByLabelText('临时聊天推理强度'));
  await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',0);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  expect(session.snapshot()).toMatchObject({model:'',effort:''});
  await fireEvent.press(view.getByLabelText('临时聊天模型'));
  expect(view.queryByTestId('main-effort-slider')).toBeNull();expect(view.queryByText('推理强度')).toBeNull();
  await fireEvent.press(view.getByLabelText('model-b'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  expect(session.snapshot()).toMatchObject({model:'model-b',effort:''});
  await view.unmount();
});

test('temporary reasoning slash command opens only the reasoning control',async()=>{
  transport.models=jest.fn(async()=>({models:['model-a'],modelCapabilities:{'model-a':{source:'codex-model-list' as const,reasoningKnown:true,reasoningEfforts:['high' as const]}}}));
  const view=await render(<TemporarySideChat visible scopeKey="reasoning-slash" sessionKey={key} transport={transport}/>);
  await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'),'/reasoning');
  await fireEvent.press(view.getByLabelText('选择推理强度，/reasoning'));
  expect(view.getByTestId('main-effort-popover')).toBeTruthy();expect(view.queryByTestId('remote-model-popover')).toBeNull();
  await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  expect(temporarySideChatSession('reasoning-slash',key).snapshot()).toMatchObject({draft:'',model:'',effort:'high'});
  expect(transport.ask).not.toHaveBeenCalled();await view.unmount();
});

test('temporary model selection and defaults preserve supported effort and the rest of the draft',async()=>{
  transport.models=jest.fn(async()=>({models:['model-a','model-b','model-c'],modelCapabilities:{
    'model-a':{source:'codex-model-list' as const,reasoningKnown:true,reasoningEfforts:['high' as const]},
    'model-b':{source:'codex-model-list' as const,reasoningKnown:true,reasoningEfforts:['high' as const]},
    'model-c':{source:'codex-model-list' as const,reasoningKnown:true,reasoningEfforts:['low' as const]},
  }}));
  const view=await render(<TemporarySideChat visible scopeKey="retain-effort" sessionKey={key} transport={transport}/>),session=temporarySideChatSession('retain-effort',key);
  await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'),'keep this draft');
  await fireEvent.press(view.getByLabelText('临时聊天推理强度'));await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  for(const [label,model] of [['model-a',''],['model-b','model-b'],['使用默认模型','']]){
    await fireEvent.press(view.getByLabelText('临时聊天模型'));await fireEvent.press(view.getByLabelText(label));await fireEvent.press(view.getByLabelText('关闭模型选择'));
    expect(session.snapshot()).toMatchObject({model,effort:'high',draft:'keep this draft',permission:'read-only'});
  }
  await fireEvent.press(view.getByLabelText('临时聊天模型'));await fireEvent.press(view.getByLabelText('model-c'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  expect(session.snapshot()).toMatchObject({model:'model-c',effort:'',draft:'keep this draft'});
  await fireEvent.press(view.getByLabelText('临时聊天推理强度'));await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  await fireEvent.press(view.getByLabelText('临时聊天模型'));await fireEvent.press(view.getByLabelText('使用默认模型'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  expect(session.snapshot()).toMatchObject({model:'',effort:'',draft:'keep this draft'});await view.unmount();
});
