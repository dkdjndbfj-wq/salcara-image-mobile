import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { DirectComposer } from '../remote/DirectComposer';
import type { DirectDraftInput } from '../remote/direct-composer-drafts';
import type { DirectSessionServices } from '../remote/direct-session-services';
import type { AgentProfile, ModelCatalog, SessionInfo } from '../remote/client';
import type { WorkspaceRuntime } from '../remote/WorkspaceRuntimeContext';
import type { ComposerFilesAppender } from '../remote/composer-files';
import {splitPastedText} from '../remote/pasted-text';
import type { RemoteImage } from '../remote/attachment-chunks';
import type {SentEditRestorer} from '../remote/sent-edit-recovery';
import type {TimelineItem} from '../remote/store';

const mockRestore = jest.fn(), mockSave = jest.fn(), mockConsume = jest.fn(), mockClose = jest.fn();
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID(),CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:async(_:string,value:string)=>require('node:crypto').createHash('sha256').update(value).digest('hex')}));
jest.mock('../remote/direct-composer-drafts', () => ({ createDirectComposerDraft: (_pairing: string, _device: string, owner: string) => ({
  restore: () => mockRestore(owner), save: (value: DirectDraftInput) => mockSave(owner, value), consume: mockConsume,
  hydrate: async (value: DirectDraftInput) => value.images, close: () => mockClose(owner),
}) }));
jest.mock('../remote/attachments', () => ({ pickRemoteImages: jest.fn() }));
jest.mock('../remote/ContextBar', () => ({ ContextBar: require('react').forwardRef(() => null) }));
jest.mock('../remote/ContextReferencePicker', () => ({ ContextReferencePicker: () => null }));

const image = (id: string): RemoteImage => ({ uri: `file:///cache/${id}.png`, base64: `bytes-${id}`, mime: 'image/png', width: 800, height: 500 });
const imageA = image('existing'), imageB = image('annotation');
const initial = (): DirectDraftInput => ({ text: '已有草稿', images: [imageA], imageCount: 1, options: { collaborationMode: 'plan' }, model: 'model-a', effort: 'high', permission: 'ask' });
const snapshot = (value: DirectDraftInput) => ({ ...value, images: value.images.map(row => ({ ...row })), revision: 1, identity: 'saved' });
const profile: AgentProfile = { id: 'codex', tool: 'codex', name: 'Codex', available: true, remoteSendSupported: true,
  api: { accountId: 'api', model: 'model-a', name: 'Computer API', protocol: 'openai', configured: true, pending: false, source: 'computer' },
  capabilities: { list: true, read: true, send: true, interrupt: true, approval: true, questions: true, subagents: true, attachments: true,
    imageInput: true, imageOutput: true, modelOverride: true, features: true, contextReferences:true, permissionModes: ['ask'] } };
const session: SessionInfo = { sessionKey: 'codex:main', tool: 'codex', client: 'Codex', title: 'Task', cwd: '/project', status: 'idle', controllable: true, updatedAt: 1 };
const runtime = { scope: 'binding', remote: { agents: { pc: { autoAll: false } }, devices: [], sessions: { pc: { list: [] } } } } as unknown as WorkspaceRuntime;
const send = jest.fn(), upload = jest.fn();
let annotation: React.MutableRefObject<ComposerFilesAppender | undefined>, services: DirectSessionServices, modelCatalog: ModelCatalog;
let editRestorer:React.MutableRefObject<SentEditRestorer|undefined>;
function Harness({ owner = services, selectedProfile = profile, items=[] }: { owner?: DirectSessionServices; selectedProfile?: AgentProfile;items?:TimelineItem[] }) {
  const [text, setText] = useState('已有草稿'); const latest = useRef(text); latest.current = text;
  useEffect(() => { if (owner.scope !== 'scope-a') setText('新电脑草稿'); }, [owner.scope]);
  return <View><Pressable accessibilityLabel="外部追加文字" onPress={() => setText('用户后来输入的内容')}><Text>更新</Text></Pressable>
    <DirectComposer services={owner} runtime={runtime} deviceId="pc" profile={selectedProfile} session={session} timeline={{ items, loading: false }} tablet text={text}
      onText={setText} getLatestText={() => latest.current} sending={false} canSend uncertain={false} onSend={send} onStop={jest.fn()} onReferenceConsumed={jest.fn()} filesAppenderRef={annotation} editRestoreRef={editRestorer} onPickFiles={()=>{}} />
  </View>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const ready = async () => { await act(async () => {}); expect(annotation.current).toBeDefined(); };
test('complete Direct history recovery appends the original input and references without sending',async()=>{
 const reference={kind:'file' as const,projectPath:'/project',path:'main.ts',label:'main.ts',text:'historical code',startLine:1,endLine:1,capturedAt:1};
 const items:TimelineItem[]=[{kind:'message',id:'previous-input',role:'user',text:'Historical request',final:true,ts:1,contextReferences:[reference]}];
 const view=await render(<Harness items={items}/>);await ready();await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('最近输入'));await fireEvent.press(view.getByLabelText('复用输入 previous-input'));await act(async()=>{});
 expect(view.queryAllByRole('alert').map(item=>item.props.children)).toEqual([]);
 expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('已有草稿\n\nHistorical request');
 expect(mockSave.mock.calls.at(-1)?.[1]).toMatchObject({images:[imageA],options:{collaborationMode:'plan',contextReferences:[reference]},model:'model-a',effort:'high',permission:'ask'});
 expect(send).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();await view.unmount();
});
async function append(text = '请调整原图', images: readonly RemoteImage[] = [imageB]) { let result!: boolean; await act(async () => { result = await annotation.current!({texts:[{name:'notes.md',text}],images:[...images]}); }); return result; }

beforeEach(() => {
  jest.clearAllMocks(); annotation = { current: undefined };editRestorer={current:undefined};
  modelCatalog = { models: ['model-a'], modelCapabilities: { 'model-a': { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['high'], inputModalities: ['text', 'image'] } } };
  services = { scope: 'scope-a', models: jest.fn(async () => modelCatalog), features: jest.fn(async () => ({ collaborationModes: ['default', 'plan'], skills: [], skillsSupported: true })),
    guard: jest.fn(), isCurrent: () => true, context: {}, sideQuestions: {}, uploadImages: upload } as unknown as DirectSessionServices;
  mockRestore.mockImplementation(async (owner: string) => owner === 'scope-a' ? snapshot(initial()) : undefined);
  mockSave.mockImplementation(async (_owner: string, value: DirectDraftInput) => snapshot(value));
  mockConsume.mockResolvedValue(true); send.mockResolvedValue(true);
});


test('local files persist complete text and images before display and never send automatically',async()=>{
  const pending=deferred<ReturnType<typeof snapshot>>(),view=await render(<Harness/>);await ready();
  mockSave.mockImplementationOnce(()=>pending.promise);
  let operation!:Promise<boolean>;await act(async()=>{operation=annotation.current!({texts:[{name:'notes.md',text:'  # Full text\n\n尾行\n'}],images:[imageB]});});
  const stored=mockSave.mock.calls.find(([,value])=>value.text.includes('notes.md'))![1];
  expect(splitPastedText(stored.text)).toEqual({prompt:'已有草稿',attachments:[{name:'notes.md',text:'  # Full text\n\n尾行\n'}]});
  expect(view.queryByLabelText('预览文本附件 notes.md')).toBeNull();
  await act(async()=>pending.resolve(snapshot(stored)));expect(await operation).toBe(true);
  expect(view.getByLabelText('预览文本附件 notes.md')).toBeTruthy();expect(view.getAllByLabelText(/^移除待发送图片/)).toHaveLength(2);
  expect(send).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();await view.unmount();
});
test('text-only models accept source files while images and incomplete batches preserve the draft',async()=>{
  modelCatalog.modelCapabilities!['model-a'].inputModalities=['text'];
  const view=await render(<Harness/>);await ready();
  expect(await append('const a = 1;',[])).toBe(true);
  await expect(append('new batch',[imageB])).rejects.toThrow('不支持图片输入');
  expect(view.queryAllByLabelText('预览文本附件 notes.md')).toHaveLength(1);expect(send).not.toHaveBeenCalled();await view.unmount();
});
test('native text arriving during file save is retained and the import can be retried',async()=>{
  const pending=deferred<ReturnType<typeof snapshot>>(),view=await render(<Harness/>);await ready();mockSave.mockImplementationOnce(()=>pending.promise);
  let operation!:Promise<boolean>;await act(async()=>{operation=annotation.current!({texts:[{name:'a.ts',text:'old file'}],images:[]});});const outcome=operation.catch(e=>e);
  const stored=mockSave.mock.calls.find(([,value])=>value.text.includes('a.ts'))![1];
  await fireEvent.press(view.getByLabelText('外部追加文字'));await act(async()=>pending.resolve(snapshot(stored)));
  expect((await outcome).message).toContain('草稿已变化');expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('用户后来输入的内容');
  expect(mockSave).toHaveBeenLastCalledWith('scope-a',expect.objectContaining({text:'用户后来输入的内容'}));expect(send).not.toHaveBeenCalled();await view.unmount();
});
test('old device callbacks and imports completing after a switch cannot change the new draft',async()=>{
  const pending=deferred<ReturnType<typeof snapshot>>(),view=await render(<Harness/>);await ready();const old=annotation.current!;mockSave.mockImplementationOnce(()=>pending.promise);
  let operation!:Promise<boolean>;await act(async()=>{operation=old({texts:[{name:'old.ts',text:'old file'}],images:[]});});
  const stored=mockSave.mock.calls.find(([,value])=>value.text.includes('old.ts'))![1];services={...services,scope:'scope-b'};
  await view.rerender(<Harness owner={services}/>);await ready();await act(async()=>pending.resolve(snapshot(stored)));
  expect(await operation).toBe(false);expect(await old({texts:[{name:'late.ts',text:'late'}],images:[]})).toBe(false);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('新电脑草稿');expect(view.queryByLabelText('预览文本附件 old.ts')).toBeNull();expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('edited-message recovery preserves current draft and images, persists once and never sends',async()=>{
 const view=await render(<Harness/>);await ready();
 const operation='b3d117de-91f8-4850-b1a7-425848c809f2';
 let accepted=false;await act(async()=>{accepted=await editRestorer.current!({text:'修改后的任务',images:[imageB],features:{skills:[{name:'review',path:'/skill'}]}},operation);});
 expect(accepted).toBe(true);expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('已有草稿\n\n修改后的任务');
 const saved=mockSave.mock.calls.find(([,row])=>row.lastRestoredEdit===operation)![1];
 expect(saved).toMatchObject({options:{collaborationMode:'plan',skills:[{name:'review',path:'/skill'}]},images:[imageA,imageB]});expect(send).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
 mockRestore.mockResolvedValue(snapshot(saved));const saves=mockSave.mock.calls.length;
 await act(async()=>{expect(await editRestorer.current!({text:'修改后的任务',images:[imageB],features:{}},operation)).toBe(true);});
 expect(mockSave.mock.calls.length).toBe(saves);await view.unmount();
});

test('edited-message recovery cannot overwrite input that changes while persistence is pending',async()=>{
 const pending=deferred<ReturnType<typeof snapshot>>(),view=await render(<Harness/>);await ready();mockSave.mockImplementationOnce(()=>pending.promise);
 let operation!:Promise<boolean>;await act(async()=>{operation=editRestorer.current!({text:'修改内容',images:[],features:{}},'b3d117de-91f8-4850-b1a7-425848c809f2');});const outcome=operation.catch(e=>e);
 const saved=mockSave.mock.calls.at(-1)![1];await fireEvent.press(view.getByLabelText('外部追加文字'));await act(async()=>pending.resolve(snapshot(saved)));
 expect((await outcome).message).toContain('草稿已变化');expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('用户后来输入的内容');
 expect(mockSave).toHaveBeenLastCalledWith('scope-a',expect.objectContaining({lastRestoredEdit:'',text:'用户后来输入的内容'}));expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('leaving during edit recovery retains the original draft and removes its unpresented restoration marker',async()=>{
 const pending=deferred<ReturnType<typeof snapshot>>(),view=await render(<Harness/>);await ready();mockSave.mockImplementationOnce(()=>pending.promise);
 let operation!:Promise<boolean>;await act(async()=>{operation=editRestorer.current!({text:'修改内容',images:[],features:{}},'b3d117de-91f8-4850-b1a7-425848c809f2');});
 const saved=mockSave.mock.calls.at(-1)![1];
 services={...services,scope:'scope-b'};await view.rerender(<Harness owner={services}/>);await ready();
 await act(async()=>pending.resolve(snapshot(saved)));expect(await operation).toBe(false);
 expect(mockSave.mock.calls.some(([owner,value])=>owner==='scope-a'&&value.text==='已有草稿'&&value.lastRestoredEdit==='')).toBe(true);
 expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('新电脑草稿');expect(send).not.toHaveBeenCalled();await view.unmount();
});
