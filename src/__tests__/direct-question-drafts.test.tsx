import React from 'react';
import {Text} from 'react-native';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {QuestionDock} from '../remote/QuestionDock';
import {useDirectQuestionDraft} from '../remote/useDirectQuestionDraft';
import {directQuestionDraftSource,finishDirectQuestionDraft,readDirectQuestionDraft,saveDirectQuestionDraft} from '../remote/direct-question-drafts';
import {clearRemoteQueuedScope} from '../remote/drafts';
import type {QuestionDraft} from '../remote/QuestionCard';
import type {ApprovalItem} from '../remote/thread-rows';

const mockSettings=new Map<string,string>();
const mockGet=jest.fn(async(key:string)=>mockSettings.get(key)??null);
const mockSet=jest.fn(async(key:string,value:string)=>{mockSettings.set(key,value);});
jest.mock('../storage/database',()=>({getSetting:(key:string)=>mockGet(key),setSetting:(key:string,value:string)=>mockSet(key,value)}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID(),CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:async(_algorithm:string,value:string)=>require('node:crypto').createHash('sha256').update(value).digest('hex')}));
jest.mock('../components/ui',()=>({useReducedMotion:()=>true}));
const setting='remote_composer_drafts_v1',device='pc',session='codex:question-thread';
let scope='direct:question-binding',scopeNumber=0;
const question:ApprovalItem={kind:'approval',approval:'question',id:'request-1',title:'Choose',state:'pending',ts:1,turnId:'turn-1',questions:[
  {id:'choice',header:'Choice',question:'Select one',options:[{label:'A'},{label:'B'}]},
  {id:'notes',header:'Notes',question:'Explain',allowCustom:true},
]};
const input:QuestionDraft={answers:{choice:['B']},custom:{notes:'  exact\n unfinished  '},customPresent:{notes:true},page:1,customOpen:{notes:true}};
const source=(pairing=scope,target=session,value=question)=>directQuestionDraftSource(pairing,device,target,value);
let latest:ReturnType<typeof useDirectQuestionDraft>;
function Form({value=question,items=[value],pairing=scope}:{value?:ApprovalItem|null;items?:any[];pairing?:string}){
  const draft=useDirectQuestionDraft({scope:pairing,deviceId:device,sessionKey:session,question:value??null,items:items.filter(Boolean),isCurrent:()=>true});latest=draft;
  return <><Text>{draft.error??''}</Text><QuestionDock question={draft.ready?value??null:null} busy={!draft.ready} initialDraft={draft.draft} draftIdentity={draft.identity}
    onDraftChange={draft.save} onAnswer={()=>{}} onCancel={()=>{}}><Text>Composer</Text></QuestionDock></>;
}
beforeEach(()=>{jest.useRealTimers();jest.clearAllMocks();mockSettings.clear();scope=`direct:question-binding-${++scopeNumber}`;mockGet.mockImplementation(async(key:string)=>mockSettings.get(key)??null);mockSet.mockImplementation(async(key:string,value:string)=>{mockSettings.set(key,value);});});
afterEach(()=>jest.useRealTimers());

test('real question form restores its selection, unfinished whitespace and page after a disconnect unmount',async()=>{
  const view=await render(<Form/>);await fireEvent.press(await view.findByRole('radio',{name:'B'}));await fireEvent.press(view.getByRole('button',{name:'下一题'}));
  await fireEvent.changeText(view.getByLabelText('Notes：回答'),'  exact\n unfinished  ');
  await view.rerender(<Text>Disconnected</Text>);await view.rerender(<Form/>);
  expect((await view.findByLabelText('Notes：回答')).props.value).toBe('  exact\n unfinished  ');
  await fireEvent.press(view.getByRole('button',{name:'上一题'}));expect(view.getByRole('radio',{name:'B'}).props.accessibilityState.checked).toBe(true);
  await view.unmount();
});

test('same approval ID with changed request identity, question schema, session or pairing cannot restore another draft',async()=>{
  const original=source();await readDirectQuestionDraft(original);await saveDirectQuestionDraft(original,input);
  for(const target of [source('direct:other-binding'),source(scope,'codex:other'),source(scope,session,{...question,ts:2}),
    source(scope,session,{...question,questions:[{id:'notes',question:'Different request',allowCustom:true}]})])expect(await readDirectQuestionDraft(target)).toBeUndefined();
  // Merely visiting a different request does not destroy the original draft.
  expect(await readDirectQuestionDraft(original)).toEqual(input);
});

test('rapid reconnect waits for the last local save and stale owners cannot overwrite a new request',async()=>{
  const original=source();await readDirectQuestionDraft(original);let release!:()=>void,started!:()=>void;
  const writing=new Promise<void>(resolve=>{started=resolve;});
  mockSet.mockImplementationOnce(async(key:string,value:string)=>{started();await new Promise<void>(resolve=>{release=resolve;});mockSettings.set(key,value);});
  const save=saveDirectQuestionDraft(original,input);await writing;const reload=readDirectQuestionDraft(original);release();await save;expect(await reload).toEqual(input);
  const newer=source(scope,session,{...question,ts:9});await readDirectQuestionDraft(newer);
  await saveDirectQuestionDraft(original,{...input,custom:{notes:'stale input'}});
  expect(await readDirectQuestionDraft(newer)).toBeUndefined();
});

test('an explicit resolution clears the draft and a late old form callback cannot resurrect it',async()=>{
  const target=source();await readDirectQuestionDraft(target);await saveDirectQuestionDraft(target,input);
  const view=await render(<Form/>);await waitFor(()=>expect(latest.ready).toBe(true));const staleSave=latest.save;
  await view.rerender(<Form value={null} items={[{...question,state:'allow',by:'desktop',ts:5}]}/>);
  await waitFor(()=>expect(JSON.parse(mockSettings.get(setting)??'{}')).toEqual({}));
  staleSave(question.id,input);expect(await readDirectQuestionDraft(target)).toBeUndefined();await view.unmount();
});

test('an old resolution cannot clear a newer request reusing the approval ID',async()=>{
  const target=source(scope,session,{...question,ts:100});await readDirectQuestionDraft(target);await saveDirectQuestionDraft(target,input);
  await finishDirectQuestionDraft(scope,device,session,question.id,50);
  expect(await readDirectQuestionDraft(target)).toEqual(input);
});

test('an exact accepted answer clears its original request even when the phone clock trails the host',async()=>{
  const target=source(scope,session,{...question,ts:100});await readDirectQuestionDraft(target);await saveDirectQuestionDraft(target,input);
  await finishDirectQuestionDraft(scope,device,session,question.id,50,target.request);
  expect(await readDirectQuestionDraft(target)).toBeUndefined();expect(JSON.parse(mockSettings.get(setting)??'{}')).toEqual({});
});

test('a corrupted draft never turns into empty restored input or gets overwritten',async()=>{
  const target=source();await readDirectQuestionDraft(target);await saveDirectQuestionDraft(target,input);
  const rows=JSON.parse(mockSettings.get(setting)!);rows[target.key].text='{invalid';mockSettings.set(setting,JSON.stringify(rows));const corrupted=mockSettings.get(setting);
  await expect(readDirectQuestionDraft(target)).rejects.toThrow('无法读取');await expect(saveDirectQuestionDraft(target,input)).rejects.toThrow('无法读取');expect(mockSettings.get(setting)).toBe(corrupted);
});

test('expiry clears saved unfinished input without sending an answer',async()=>{
  const value={...question,id:'expiring-request',expiresAt:Date.now()+5000},target=source(scope,session,value);
  await readDirectQuestionDraft(target);await saveDirectQuestionDraft(target,input);
  jest.useFakeTimers();const view=await render(<Form value={value}/>);await act(async()=>{jest.advanceTimersByTime(5001);});
  await waitFor(()=>expect(JSON.parse(mockSettings.get(setting)??'{}')).toEqual({}));await view.unmount();jest.useRealTimers();
});

test('forgetting a pairing uses the existing cleanup fence and cannot recreate its draft',async()=>{
  const pairing='direct:retired-question-binding',target=source(pairing);await readDirectQuestionDraft(target);await saveDirectQuestionDraft(target,input);
  await clearRemoteQueuedScope(pairing);expect(JSON.parse(mockSettings.get(setting)??'{}')).toEqual({});
  await expect(saveDirectQuestionDraft(target,input)).rejects.toThrow();await expect(readDirectQuestionDraft(target)).rejects.toThrow();
  expect(await readDirectQuestionDraft(source('direct:fresh-question-binding'))).toBeUndefined();
});

test('a failed local save keeps the edited form and retry saves that content without rehydrating an older row',async()=>{
  const value={...question,id:'write-failure-request'},view=await render(<Form value={value}/>);
  await fireEvent.press(await view.findByRole('radio',{name:'B'}));await fireEvent.press(view.getByRole('button',{name:'下一题'}));
  await waitFor(()=>expect(JSON.parse(mockSettings.get(setting)??'{}')[source(scope,session,value).key]?.text).toContain('"page":1'));
  mockSet.mockImplementation(async()=>{throw new Error('disk temporarily unavailable');});
  await fireEvent.changeText(view.getByLabelText('Notes：回答'),'newer unsaved answer');await waitFor(()=>expect(latest.error).toContain('disk temporarily unavailable'));
  mockSet.mockImplementation(async(key:string,value:string)=>{mockSettings.set(key,value);});await act(async()=>latest.retry());
  await waitFor(()=>expect(latest.error).toBeUndefined());expect(view.getByLabelText('Notes：回答').props.value).toBe('newer unsaved answer');
  expect((await readDirectQuestionDraft(source(scope,session,value)))?.custom.notes).toBe('newer unsaved answer');await view.unmount();
});
