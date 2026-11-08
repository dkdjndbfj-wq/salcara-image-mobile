import React from 'react';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import { runInNewContext } from 'node:vm';
import { PreviewLogPanel } from '../remote/PreviewLogPanel';
import { appendPreviewLog, parsePreviewLog, projectRunLogEntries, type PreviewLogEntry } from '../remote/preview-logs';
import { previewLogScript } from '../components/preview-log-script';
import { useInteractiveArtifact } from '../components/useInteractiveArtifact';
import { parsePreviewFrame } from '../remote/workspace-preview';
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-crypto', () => { let id = 0; return { randomUUID: () => `preview-token-${++id}` }; });
jest.mock('react-native',()=>{
 const React=require('react'),actual=jest.requireActual('react-native'),replacement=Object.create(actual);
 Object.defineProperty(replacement,'Pressable',{enumerable:true,value:({children,style,...props}:any)=>React.createElement(actual.View,{...props,accessible:true,accessibilityState:{...props.accessibilityState,disabled:props.disabled},style:typeof style==='function'?style({pressed:false}):style},children)});
 return replacement;
});

const entries: PreviewLogEntry[] = [
  { id: 'runtime:1', level: 'error', message: 'Missing widget', source: 'http://localhost:5173/src/App.tsx', line: 17, column: 3 },
  { id: 'runtime:2', level: 'warn', message: 'Slow render', source: 'http://localhost:5173/src/List.tsx', line: 42 },
];
test('preview logs append an explicit row or selected batch and preserve level/source/line without automatic sends', async () => {
  const compose = jest.fn((_text: string) => true);
  const view = await render(<PreviewLogPanel scopeKey="session-a" entries={entries} origin="http://localhost:5173/" onCompose={compose}/>);
  expect(compose).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('展开预览日志'));
  await fireEvent.press(view.getByLabelText('将日志 runtime:1 加入对话'));
  expect(compose).toHaveBeenCalledWith(expect.stringContaining('[error] Missing widget\n位置：http://localhost:5173/src/App.tsx:17:3'));
  expect(compose.mock.calls[0][0]).not.toContain('Slow render');
  await fireEvent.press(view.getByLabelText('选择日志 runtime:1'));
  await fireEvent.press(view.getByLabelText('选择日志 runtime:2'));
  await fireEvent.press(view.getByLabelText('将所选预览日志加入对话'));
  expect(compose.mock.calls[1][0]).toContain('[warn] Slow render');
  expect(view.getByText('已将 2 条日志加入草稿')).toBeTruthy();
  expect(compose).toHaveBeenCalledTimes(2);
});
test('rejected draft writes retain selection and old callbacks cannot append after hiding or changing scope', async () => {
  const compose = jest.fn((_text: string) => false), props = {scopeKey:'a', entries, origin:'page', onCompose:compose};
  const view = await render(<PreviewLogPanel {...props} initiallyOpen/>);
  await fireEvent.press(view.getByLabelText('选择日志 runtime:1'));
  await fireEvent.press(view.getByLabelText('将所选预览日志加入对话'));
  expect(view.getByLabelText('选择日志 runtime:1').props.accessibilityState.checked).toBe(true);
  const oldPress = view.getByLabelText('将日志 runtime:1 加入对话').props.onPress;
  await view.rerender(<PreviewLogPanel {...props} active={false} initiallyOpen/>);
  await act(async () => oldPress());
  expect(compose).toHaveBeenCalledTimes(1);
  await view.rerender(<PreviewLogPanel {...props} scopeKey="b" initiallyOpen/>);
  await act(async () => oldPress());
  expect(compose).toHaveBeenCalledTimes(1);
  expect(view.getByLabelText('选择日志 runtime:1').props.accessibilityState.checked).toBe(false);
});
test('unsupported browser logs expose the capability explanation without fabricated entries or draft actions', async () => {
  const compose = jest.fn();
  const view = await render(<PreviewLogPanel scopeKey="unavailable" entries={[]} origin="page" supported={false} unavailableReason="此电脑尚未开放日志" onCompose={compose}/>);
  await fireEvent.press(view.getByLabelText('展开预览日志'));
  expect(view.getByText('此电脑尚未开放日志')).toBeTruthy();
  expect(view.queryByLabelText('将所选预览日志加入对话')).toBeNull();
  expect(compose).not.toHaveBeenCalled();
});
test('injected capture forwards actual console calls, exceptions and promise rejections with bounded values', () => {
  const captured: PreviewLogEntry[] = [], handlers: Record<string, (event:any) => void> = {};
  const original = jest.fn(), console = { log:original, warn:original, error:original, debug:original, info:original };
  runInNewContext(previewLogScript('entry=>captured.push(entry)'), { captured, console, location:{href:'http://localhost/page'}, addEventListener:(type:string, listener:any)=>{handlers[type]=listener;}, Error });
  console.warn('slow', { count: 2 });
  handlers.error({message:'broken',filename:'http://localhost/app.js',lineno:8,colno:4});
  handlers.unhandledrejection({reason:'request rejected'});
  console.log('x'.repeat(2200));
  expect(original).toHaveBeenCalledWith('slow', {count:2});
  expect(captured[0]).toMatchObject({level:'warn',message:'slow {"count":2}',source:'http://localhost/page'});
  expect(captured[1]).toMatchObject({level:'error',message:'broken',source:'http://localhost/app.js',line:8,column:4});
  expect(captured[2].message).toBe('Unhandled rejection: request rejected');
  expect(captured[3].message).toHaveLength(2000); expect(captured[3].truncated).toBe(true);
});
test('artifact log delivery requires the current document token and drops a retired revision callback', async () => {
  const props = {scopeKey:'conversation-a',artifactId:'artifact',revision:'v1',source:'<p>One</p>'};
  const hook = await renderHook((value: typeof props)=>useInteractiveArtifact(value), {initialProps:props});
  const previous = hook.result.current;
  await act(async()=>previous.report({channel:'salcara-artifact',token:'other',type:'log',entry:entries[0]}));
  expect(hook.result.current.logs).toHaveLength(0);
  await act(async()=>previous.report({channel:'salcara-artifact',token:previous.identity,type:'log',entry:entries[0]}));
  expect(hook.result.current.logs).toEqual([entries[0]]);
  await hook.rerender({...props,revision:'v2',source:'<p>Two</p>'});
  await act(async()=>previous.report({channel:'salcara-artifact',token:previous.identity,type:'log',entry:entries[1]}));
  expect(hook.result.current.logs).toHaveLength(0);
});
test('log transport bounds data, rejects invented capability and keeps process output locations honest', () => {
  let logs: PreviewLogEntry[] = [];
  for(let index=0;index<100;index++) logs=appendPreviewLog(logs,{id:`log:${index}`,level:'log',message:'x'.repeat(1000)});
  expect(logs.reduce((sum,entry)=>sum+entry.message.length,0)).toBeLessThanOrEqual(32000);
  expect(parsePreviewLog({...entries[0],line:-1})).toBeUndefined();
  const frame={pageId:'page-test-123456',url:'http://localhost:5173/',width:640,height:640,nextSequence:1};
  expect(parsePreviewFrame({...frame,logsSupported:true,logs:entries}).logs).toEqual(entries);
  expect(()=>parsePreviewFrame({...frame,logs:entries})).toThrow('网页日志响应无效');
  expect(()=>parsePreviewFrame({...frame,logsSupported:true,logs:[entries[0],entries[0]]})).toThrow('网页日志响应无效');
  const process=projectRunLogEntries('first\nsecond\n','项目 web · dev','build failed');
  expect(process[0]).toMatchObject({level:'log',message:'first',source:'项目 web · dev'});
  expect(process[0].line).toBeUndefined(); expect(process[2].level).toBe('error');
});
