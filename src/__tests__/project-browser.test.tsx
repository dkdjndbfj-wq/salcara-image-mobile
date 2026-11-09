import React from 'react';
import { BackHandler, Keyboard } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ProjectBrowser } from '../remote/ProjectBrowser';
import { parseProjectBrowserResult } from '../remote/project-browser';

jest.mock('../remote/direct-api', () => ({ requestDirect: jest.fn() }));
jest.mock('../remote/direct-pairing', () => ({ directConnectionGeneration: () => 1, directDeliveryScope: () => 'direct', getDirectConnectionState: () => ({ status: 'connected', deviceId: 'pc' }) }));
const root = 'C:/allowed';
const page = (path = '', entries: any[] = []) => ({ path, entries, truncated: false });
function response(input: any, values: object) { return { tool: 'codex', workspaceMode: 'code', cwd: input.cwd, path: input.path, ...values }; }
function props(request: any) { return { scopeKey: 'pc|codex|code', tool: 'codex', mode: 'code' as const, request, onClose: jest.fn(), onSelect: jest.fn(), onProjectless: jest.fn() }; }

test('hardware Back cancels only the project picker and ignores its late response', async () => {
  let handle!:()=>boolean, finish!:(value:unknown)=>void;
  const registration=jest.spyOn(BackHandler,'addEventListener').mockImplementation((_event,callback)=>{handle=callback as ()=>boolean;return {remove:jest.fn()};});
  const keyboard=jest.spyOn(Keyboard,'isVisible').mockReturnValue(false);
  const p=props(jest.fn(()=>new Promise(resolve=>{finish=resolve;})));
  const view=await render(<ProjectBrowser {...p}/>);
  await act(async()=>{expect(handle()).toBe(true);});
  expect(p.onClose).toHaveBeenCalledTimes(1);
  await act(async()=>finish(response({cwd:'',path:''},{roots:[{path:root,name:'late'}]})));
  expect(view.queryByText('late')).toBeNull();expect(p.onSelect).not.toHaveBeenCalled();
  await view.unmount();registration.mockRestore();keyboard.mockRestore();
});

test('first use has an explicit new authorization location and retry, never a default folder', async () => {
  let authorized = false;
  const request = jest.fn(async input => response(input, { roots: authorized ? [{ path: root, name: 'Allowed' }] : [] }));
  const p = props(request), view = await render(<ProjectBrowser {...p} />);
  expect(await view.findByText('还没有可用文件夹')).toBeTruthy();
  expect(view.getByText(/设置 → 远程目录授权/)).toBeTruthy();
  expect(view.queryByRole('button', { name: '使用当前文件夹' })).toBeNull();
  expect(p.onSelect).not.toHaveBeenCalled();
  authorized = true; await fireEvent.press(view.getByRole('button', { name: '重新读取授权目录' }));
  expect(await view.findByRole('button', { name: `浏览目录 ${root}` })).toBeTruthy();
  await view.unmount();
});

test('browse an empty folder and select its exact path without creating a conversation', async () => {
  const request = jest.fn(async input => response(input, !input.cwd ? { roots: [{ path: root, name: 'Allowed' }] }
    : input.action === 'select' ? { project: { path: root + '/empty', name: 'empty' } }
    : { directory: page(input.path, input.path ? [] : [{ name: 'empty', path: 'empty', kind: 'directory' }]) }));
  const p = props(request), view = await render(<ProjectBrowser {...p} />);
  await fireEvent.press(await view.findByRole('button', { name: `浏览目录 ${root}` }));
  await fireEvent.press(await view.findByRole('button', { name: '浏览文件夹 empty' }));
  expect(await view.findByText('这里没有子文件夹')).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: '使用当前文件夹' }));
  expect(p.onSelect).toHaveBeenCalledWith({ path: root + '/empty', name: 'empty' });
  expect(request.mock.calls.at(-1)![0]).toEqual({ action: 'select', cwd: root, path: 'empty' });
  await view.unmount();
});

test('new folder failure does not report success or automatically repeat a mutation', async () => {
  const request = jest.fn(async input => {
    if (input.action === 'mkdir') throw new Error('结果未确认');
    return response(input, !input.cwd ? { roots: [{ path: root, name: 'Allowed' }] } : { directory: page() });
  });
  const p = props(request), view = await render(<ProjectBrowser {...p} />);
  await fireEvent.press(await view.findByRole('button', { name: `浏览目录 ${root}` }));
  await fireEvent.press(view.getByRole('button', { name: '新建文件夹' }));
  await fireEvent.changeText(await view.findByLabelText('新文件夹名称'), 'chosen');
  await fireEvent.press(view.getByRole('button', { name: '创建文件夹并使用' }));
  expect(await view.findByText(/刷新目录核对/)).toBeTruthy(); expect(p.onSelect).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([input]) => input.action === 'mkdir')).toHaveLength(1);
  await view.unmount();
});

test.each(['computer-b|codex|code', 'pc|claude|code', 'pc|codex|work'])('late directory response cannot cross %s switch', async scopeKey => {
  let resolve!: (value: unknown) => void;
  const oldRequest = jest.fn(() => new Promise(yes => { resolve = yes; }));
  const p = props(oldRequest), view = await render(<ProjectBrowser {...p} />);
  const next = jest.fn(async (input: any) => response(input, { roots: [] }));
  await view.rerender(<ProjectBrowser {...p} scopeKey={scopeKey} request={next} />);
  await waitFor(() => expect(next).toHaveBeenCalled());
  await act(async () => resolve({ tool: 'codex', workspaceMode: 'code', cwd: '', path: '', roots: [{ path: root, name: 'old-root' }] }));
  expect(view.queryByText('old-root')).toBeNull(); expect(p.onSelect).not.toHaveBeenCalled(); await view.unmount();
});

test('a selected response cannot substitute another directory, Agent or Code/Work identity', () => {
  const input = { action: 'select', cwd: root, path: 'exact' };
  const valid = response(input, { project: { path: root + '/exact', name: 'exact' } });
  expect(parseProjectBrowserResult(valid, input, 'codex', 'code').project?.path).toBe(root + '/exact');
  for (const changed of [{ ...valid, tool: 'claude' }, { ...valid, workspaceMode: 'work' }, { ...valid, project: { path: root + '/other', name: 'other' } }]) {
    expect(() => parseProjectBrowserResult(changed, input, 'codex', 'code')).toThrow();
  }
});

test('creating a normal project name returns its exact child folder without starting a session', async () => {
  const request = jest.fn(async input => response(input, !input.cwd ? { roots: [{ path: root, name: 'Allowed' }] }
    : input.action === 'mkdir' ? { project: { path: root + '/config', name: 'config' } } : { directory: page() }));
  const p = props(request), view = await render(<ProjectBrowser {...p} />);
  await fireEvent.press(await view.findByRole('button', { name: `浏览目录 ${root}` }));
  await fireEvent.press(view.getByRole('button', { name: '新建文件夹' }));
  await fireEvent.changeText(view.getByLabelText('新文件夹名称'), 'config');
  await fireEvent.press(view.getByRole('button', { name: '创建文件夹并使用' }));
  expect(p.onSelect).toHaveBeenCalledWith({path:root+'/config',name:'config'});
  expect(request.mock.calls.map(([input]) => input.action)).toEqual(['list','list','mkdir']);
  await view.unmount();
});

test.each(['cancel', 'switch', 'switch-back', 'unmount'])('a delayed mkdir reply is ignored after %s', async action => {
  let finish!: (value: unknown) => void;
  const request = jest.fn(async input => input.action === 'mkdir' ? new Promise(resolve => { finish = resolve; })
    : response(input, !input.cwd ? { roots: [{ path: root, name: 'Allowed' }] } : { directory: page() }));
  const p = props(request), view = await render(<ProjectBrowser {...p} />);
  await fireEvent.press(await view.findByRole('button', { name: `浏览目录 ${root}` }));
  await fireEvent.press(view.getByRole('button', { name: '新建文件夹' }));
  await fireEvent.changeText(view.getByLabelText('新文件夹名称'), 'chosen');
  await fireEvent.press(view.getByRole('button', { name: '创建文件夹并使用' }));
  if (action === 'cancel') await fireEvent.press(view.getByRole('button', {name:'取消新建会话'}));
  else if (action === 'unmount') await view.unmount();
  else {
    await view.rerender(<ProjectBrowser {...p} scopeKey="other-computer" />);
    if (action === 'switch-back') await view.rerender(<ProjectBrowser {...p} />);
  }
  await act(async () => finish(response({cwd:root,path:''},{project:{path:root+'/chosen',name:'chosen'}})));
  expect(p.onSelect).not.toHaveBeenCalled();
  expect(request.mock.calls.filter(([input]) => input.action === 'mkdir')).toHaveLength(1);
  if (action !== 'unmount') await view.unmount();
});


test('projectless choice is explicit, available without authorized folders and cancels a late directory response', async()=>{
 let finish!:(value:unknown)=>void;
 const request=jest.fn(()=>new Promise(resolve=>{finish=resolve;})),p=props(request),view=await render(<ProjectBrowser {...p}/>);
 await fireEvent.press(view.getByRole('button',{name:'不关联文件夹，直接开始'}));
 expect(p.onProjectless).toHaveBeenCalledTimes(1);expect(p.onSelect).not.toHaveBeenCalled();
 await act(async()=>finish(response({cwd:'',path:''},{roots:[{path:root,name:'late'}]})));
 expect(view.queryByText('late')).toBeNull();expect(request).toHaveBeenCalledTimes(1);await view.unmount();
});
test('legacy computers keep a usable folder fallback and do not claim a projectless selection',async()=>{
 const p=props(jest.fn(async input=>response(input,{roots:[{path:root,name:'Allowed'}]}))),view=await render(<ProjectBrowser {...p} projectlessUnavailable="请更新电脑端，或选择文件夹"/>);
 await fireEvent.press(view.getByRole('button',{name:'不关联文件夹，直接开始'}));
 expect(await view.findByRole('alert')).toBeTruthy();expect(p.onProjectless).not.toHaveBeenCalled();expect(view.getByRole('button',{name:`浏览目录 ${root}`})).toBeTruthy();await view.unmount();
});
test('folder input is a separate step and returning preserves the chosen location',async()=>{
 const p=props(jest.fn(async input=>response(input,input.cwd?{directory:page()}:{roots:[{path:root,name:'Allowed'}]}))),view=await render(<ProjectBrowser {...p}/>);
 await fireEvent.press(await view.findByRole('button',{name:`浏览目录 ${root}`}));
 expect(view.queryByLabelText('新文件夹名称')).toBeNull();
 await fireEvent.press(view.getByRole('button',{name:'新建文件夹'}));
 await fireEvent.changeText(view.getByLabelText('新文件夹名称'),'draft');
 await fireEvent.press(view.getByRole('button',{name:'返回选择文件夹'}));
 expect(view.queryByLabelText('新文件夹名称')).toBeNull();expect(view.getByRole('button',{name:'使用当前文件夹'})).toBeTruthy();expect(p.onClose).not.toHaveBeenCalled();await view.unmount();
});
