import React from 'react';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import {RemoteReviewPage} from '../remote/RemoteReviewPage';
import {createDemoGitFactory} from '../remote/RemoteDemoGitPage';
import type {FileEdit} from '../remote/blocks';

jest.mock('../remote/store',()=>({}));
jest.mock('../remote/WorkspaceRuntimeContext',()=>({useWorkspaceRuntime:()=>null}));
jest.mock('expo-clipboard',()=>({setStringAsync:jest.fn(async()=>{})}));
const selection={deviceId:'pc',agentId:'codex' as const,sessionKey:'codex:one',surface:'cli' as const,cwd:'/project'};
const changes:FileEdit[]=[{id:'change',path:'main.ts',status:'done',add:2,del:2,diff:'@@ -1 +1 @@\n-one\n+ONE\n@@ -10 +10 @@\n-ten\n+TEN\n'}];
async function selectScope(view:Awaited<ReturnType<typeof render>>,label:string){await fireEvent.press(view.getByLabelText('选择审查范围'));await fireEvent.press(view.getByLabelText(`审查${label}`));await waitFor(()=>expect(view.queryByText('正在加载审查…')).toBeNull());}
async function openFile(view:Awaited<ReturnType<typeof render>>,title='main.ts'){
  await waitFor(()=>expect(view.getByLabelText(`审查文件 ${title}`)).toBeTruthy());
  await fireEvent.press(view.getByLabelText(`审查文件 ${title}`));
  await waitFor(()=>expect(view.getByTestId('inline-review-diff')).toBeTruthy());
}
async function openHunkMenu(view:Awaited<ReturnType<typeof render>>,index=1){await fireEvent.press(view.getByLabelText(`差异段操作 ${index}`));}
async function refresh(view:Awaited<ReturnType<typeof render>>){await fireEvent.press(view.getByLabelText('审查更多操作'));await fireEvent.press(view.getByLabelText('刷新审查'));}

test('shared review stages only one hunk, exposes separate staged content and unstages it without losing other edits',async()=>{
  const view=await render(<RemoteReviewPage active selection={selection} factory={createDemoGitFactory(changes)}/>);
  await openFile(view);expect(view.queryByLabelText('暂存此段')).toBeNull();
  await openHunkMenu(view);await fireEvent.press(view.getByLabelText('暂存此段'));
  await waitFor(()=>expect(view.queryByText('+ONE')).toBeNull());
  expect(view.getAllByLabelText(/差异段操作/)).toHaveLength(1);
  expect(view.queryByText('+ONE')).toBeNull();expect(view.getByText('+TEN')).toBeTruthy();
  await selectScope(view,'已暂存');await openFile(view);expect(view.getByText('+ONE')).toBeTruthy();expect(view.queryByText('+TEN')).toBeNull();
  await openHunkMenu(view);await fireEvent.press(view.getByLabelText('取消暂存此段'));await waitFor(()=>expect(view.getByText('此范围没有改动')).toBeTruthy());
  await selectScope(view,'未暂存');await openFile(view);expect(view.getAllByLabelText(/差异段操作/)).toHaveLength(2);
  expect(view.getByText('+ONE')).toBeTruthy();expect(view.getByText('+TEN')).toBeTruthy();await view.unmount();
});
test('Git line comments compose an explicit scoped snapshot; recent-turn comments retain their structured diff references',async()=>{
  const compose=jest.fn(),reference=jest.fn();const view=await render(<RemoteReviewPage active selection={selection} lastTurn={changes} onCompose={compose} onReference={reference} factory={createDemoGitFactory(changes)}/>);
  await openFile(view);await fireEvent.press(view.getByLabelText('选择新行 1'));
  await fireEvent.changeText(view.getByLabelText('差异批注评论'),'请保留兼容性');await fireEvent.press(view.getByLabelText('加入差异批注草稿'));
  expect(compose).toHaveBeenCalledWith(expect.stringContaining('审查范围：未暂存'));expect(compose.mock.calls[0][0]).toContain('新版本第 1–1 行');expect(compose.mock.calls[0][0]).toContain('仓库版本：');expect(compose.mock.calls[0][0]).toContain('"ONE"');expect(reference).not.toHaveBeenCalled();
  await selectScope(view,'上一轮');await openFile(view);await fireEvent.press(view.getByLabelText('选择旧行 10'));await fireEvent.press(view.getByLabelText('加入差异批注草稿'));
  expect(reference).toHaveBeenCalledWith(expect.objectContaining({kind:'diff',path:'main.ts',side:'old',startLine:10,endLine:10,text:'ten'}));await view.unmount();
});
test('destructive hunk operations wait for confirmation and an unknown result never silently retries',async()=>{
  const base=createDemoGitFactory(changes),mutations=jest.fn(async()=>{throw new Error('transport timeout: refresh actual state');});
  const factory=()=>({...base(),mutate:mutations});const view=await render(<RemoteReviewPage active selection={selection} factory={factory}/>);
  await openFile(view);await openHunkMenu(view);await fireEvent.press(view.getByLabelText('撤销此段'));expect(mutations).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('确认'));await waitFor(()=>expect(view.getByText(/transport timeout/)).toBeTruthy());
  expect(mutations).toHaveBeenCalledTimes(1);expect(mutations.mock.calls[0]).toMatchObject(['review-apply','1'.padStart(64,'0'),{path:'main.ts',reviewScope:'unstaged',operation:'discard'}]);
  await refresh(view);await waitFor(()=>expect(view.queryByText(/transport timeout/)).toBeNull());expect(mutations).toHaveBeenCalledTimes(1);await view.unmount();
});
test('old hosts retain last-turn diffs and annotations without creating any Git transport',async()=>{
  const factory=jest.fn(),reference=jest.fn();const view=await render(<RemoteReviewPage active selection={selection} readOnlyLastTurn lastTurn={changes} factory={factory} onReference={reference}/>);
  await openFile(view);expect(view.getByText('+ONE')).toBeTruthy();expect(factory).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('文件操作 main.ts'));expect(view.queryByLabelText('暂存文件')).toBeNull();await fireEvent.press(view.getByLabelText('关闭操作菜单'));
  await fireEvent.press(view.getByLabelText('选择新行 10'));await fireEvent.press(view.getByLabelText('加入差异批注草稿'));expect(reference).toHaveBeenCalledWith(expect.objectContaining({text:'TEN',side:'new'}));
  await fireEvent.press(view.getByLabelText('审查更多操作'));expect(view.queryByLabelText('提交与仓库')).toBeNull();await fireEvent.press(view.getByLabelText('刷新审查'));expect(factory).not.toHaveBeenCalled();await view.unmount();
});
test('successive last-turn edits of the same path remain separate snapshots with their own line references',async()=>{
  const reference=jest.fn(),next={...changes[0],id:'next-edit',diff:'@@ -1 +1 @@\n-ONE\n+final value\n'};
  const view=await render(<RemoteReviewPage active selection={selection} readOnlyLastTurn lastTurn={[changes[0],next]} onReference={reference}/>);
  await openFile(view,'main.ts · 改动 2');expect(view.getByText('+final value')).toBeTruthy();expect(view.queryByText('+TEN')).toBeNull();
  await fireEvent.press(view.getByLabelText('审查文件 main.ts · 改动 1'));expect(view.getByText('+TEN')).toBeTruthy();expect(view.queryByText('+final value')).toBeNull();
  await fireEvent.press(view.getByLabelText('选择新行 10'));await fireEvent.press(view.getByLabelText('加入差异批注草稿'));expect(reference).toHaveBeenCalledWith(expect.objectContaining({text:'TEN',startLine:10}));await view.unmount();
});
test('a pending review from a previous computer cannot replace the next computer’s review',async()=>{
  let resolve!:(value:any)=>void;const first=createDemoGitFactory(changes)(),second=createDemoGitFactory([{...changes[0],path:'other.ts'}])();
  const pending=new Promise<any>(done=>{resolve=done;});const result=await first.review({reviewScope:'unstaged'});
  const view=await render(<RemoteReviewPage active selection={selection} factory={()=>({...first,review:()=>pending})}/>);
  await view.rerender(<RemoteReviewPage active selection={{...selection,deviceId:'other'}} factory={()=>second}/>);
  await act(async()=>resolve(result));await waitFor(()=>expect(view.getByLabelText('审查文件 other.ts')).toBeTruthy());expect(view.queryByLabelText('审查文件 main.ts')).toBeNull();await view.unmount();
});

test('compact file rows expand inline, filter by path and open the exact file without opening diff controls',async()=>{
  const other={...changes[0],id:'other',path:'src/auth/LoginScreen.tsx'},onOpenFile=jest.fn();
  const view=await render(<RemoteReviewPage active selection={selection} lastTurn={[...changes,other]} readOnlyLastTurn onOpenFile={onOpenFile}/>);
  expect(view.queryByTestId('inline-review-diff')).toBeNull();expect(view.queryByText(/差异版本/)).toBeNull();expect(view.queryByLabelText('差异批注评论')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开文件 src/auth/LoginScreen.tsx'));expect(onOpenFile).toHaveBeenCalledWith('src/auth/LoginScreen.tsx');expect(view.queryByTestId('inline-review-diff')).toBeNull();
  await openFile(view);await fireEvent.press(view.getByLabelText('审查文件 main.ts'));expect(view.queryByTestId('inline-review-diff')).toBeNull();
  await fireEvent.press(view.getByLabelText('查找审查文件'));await fireEvent.changeText(view.getByLabelText('查找变更文件'),'AUTH/login');
  expect(view.getByLabelText('审查文件 src/auth/LoginScreen.tsx')).toBeTruthy();expect(view.queryByLabelText('审查文件 main.ts')).toBeNull();
  await fireEvent.changeText(view.getByLabelText('查找变更文件'),'missing');expect(view.getByText('没有匹配的文件')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭文件查找'));expect(view.getByLabelText('审查文件 main.ts')).toBeTruthy();await view.unmount();
});

test('copy actions preserve complete snapshots and repeated-path menus choose the requested edit',async()=>{
  const next={...changes[0],id:'next-edit',diff:'@@ -1 +1 @@\n-ONE\n+final value\n'};
  const view=await render(<RemoteReviewPage active selection={selection} readOnlyLastTurn lastTurn={[changes[0],next]}/>);
  await fireEvent.press(view.getByLabelText('复制全部差异'));
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(`main.ts\n${changes[0].diff}\n\nmain.ts\n${next.diff}`);
  await fireEvent.press(view.getByLabelText('文件操作 main.ts · 改动 1'));await fireEvent.press(view.getByLabelText('复制文件差异'));
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(changes[0].diff);
  await fireEvent.press(view.getByLabelText('文件操作 main.ts · 改动 2'));await fireEvent.press(view.getByLabelText('复制文件差异'));
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(next.diff);
  await fireEvent.press(view.getByLabelText('文件操作 main.ts · 改动 2'));await fireEvent.press(view.getByLabelText('复制文件路径'));
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith('main.ts');await view.unmount();
});

test('review typography follows its panel width and resizing preserves the open diff',async()=>{
  const view=await render(<RemoteReviewPage active selection={selection} readOnlyLastTurn lastTurn={changes}/>);
  await openFile(view);
  await fireEvent(view.getByTestId('workspace-review'),'layout',{nativeEvent:{layout:{width:733,height:800}}});
  await fireEvent(view.getByTestId('inline-review-diff'),'layout',{nativeEvent:{layout:{width:733,height:300}}});
  expect(view.getByText('main.ts')).toHaveStyle({fontSize:20});expect(view.getByLabelText('审查文件 main.ts')).toHaveStyle({minHeight:56});expect(view.getByText('+ONE')).toHaveStyle({fontSize:17});
  await fireEvent(view.getByTestId('workspace-review'),'layout',{nativeEvent:{layout:{width:390,height:800}}});
  await fireEvent(view.getByTestId('inline-review-diff'),'layout',{nativeEvent:{layout:{width:390,height:300}}});
  expect(view.getByText('main.ts')).toHaveStyle({fontSize:15});expect(view.getByLabelText('审查文件 main.ts')).toHaveStyle({minHeight:48});expect(view.getByText('+ONE')).toHaveStyle({fontSize:14});
  await view.unmount();
});

async function multiRepositoryFixture(){
  const base=await createDemoGitFactory(changes)().review({reviewScope:'unstaged'});
  const repositories=[{path:'desktop',name:'desktop',id:'d'.repeat(64)},{path:'mobile',name:'mobile',id:'e'.repeat(64)}];
  const values=Object.fromEntries(repositories.map((repository,index)=>[repository.path,{...base,state:{...base.state,repository,revision:(index?'b':'a').repeat(64)},files:base.files.map(file=>({...file,patchRevision:(index?'e':'d').repeat(64),hunks:file.hunks.map((hunk,i)=>({...hunk,id:(index?'f':'c').repeat(63)+i}))}))}]));
  const review=jest.fn(async(input:any)=>{
    const value=values[input.repositoryPath];if(!value)throw new Error('wrong repository');
    return input.reviewScope==='last-turn'?{...value,scope:input.reviewScope,files:[{...value.files[0],path:input.path,diff:input.sourceDiff}]}:{...value,scope:input.reviewScope};
  });
  const mutate=jest.fn(async(_action:any,revision:string,input:any)=>{
    const value=values[input.repositoryPath];if(value.state.revision!==revision||value.files[0].patchRevision!==input.patchRevision)throw new Error('wrong revision');
    value.files=[];return {state:value.state};
  });
  const status=jest.fn(async(path?:string)=>values[path??'']?.state);
  const factory=()=>({repositories:jest.fn(async()=>({repositories,truncated:false})),review,mutate,status,diff:jest.fn(),dispose:jest.fn()});
  return {factory,review,mutate,status,values};
}
test('discovered repositories group duplicate paths and mutations retain the selected repository revision',async()=>{
  const fixture=await multiRepositoryFixture(),onOpenFile=jest.fn(),onCompose=jest.fn();
  const view=await render(<RemoteReviewPage active selection={selection} factory={fixture.factory} onOpenFile={onOpenFile} onCompose={onCompose}/>);
  await openFile(view,'mobile/main.ts');expect(view.getByLabelText('审查文件 desktop/main.ts')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开文件 mobile/main.ts'));expect(onOpenFile).toHaveBeenCalledWith('mobile/main.ts');
  await fireEvent.press(view.getByLabelText('选择新行 1'));await fireEvent.press(view.getByLabelText('加入差异批注草稿'));
  expect(onCompose).toHaveBeenCalledWith(expect.stringContaining('文件：mobile/main.ts'));expect(onCompose.mock.calls[0][0]).toContain('仓库：mobile');
  await openHunkMenu(view);await fireEvent.press(view.getByLabelText('暂存此段'));
  await waitFor(()=>expect(fixture.mutate).toHaveBeenCalledWith('review-apply','b'.repeat(64),expect.objectContaining({repositoryPath:'mobile',path:'main.ts',patchRevision:'e'.repeat(64),hunk:'f'.repeat(63)+'0'})));
  await waitFor(()=>expect(view.queryByLabelText('审查文件 mobile/main.ts')).toBeNull());expect(view.getByLabelText('审查文件 desktop/main.ts')).toBeTruthy();
  expect(fixture.review.mock.calls.map(call=>call[0].repositoryPath)).toEqual(['desktop','mobile','mobile']);await view.unmount();
});
test('repository errors and truncation remain visible without hiding healthy groups',async()=>{
  const fixture=await multiRepositoryFixture();const factory=()=>({...fixture.factory(),repositories:async()=>({repositories:Object.values(fixture.values).map(value=>value.state.repository),truncated:true}),review:async(input:any)=>{if(input.repositoryPath==='desktop')throw new Error('desktop unavailable');return fixture.review(input);}});
  const view=await render(<RemoteReviewPage active selection={selection} factory={factory}/>);
  await waitFor(()=>expect(view.getByLabelText('审查文件 mobile/main.ts')).toBeTruthy());expect(view.getByText('desktop unavailable')).toBeTruthy();expect(view.getByText(/部分目录未能扫描/)).toBeTruthy();
  await view.unmount();
});
test('last-turn nested paths use the owning repository while annotations retain the original snapshot path',async()=>{
  const fixture=await multiRepositoryFixture(),onReference=jest.fn();const nested={...changes[0],path:'mobile/main.ts'};
  const view=await render(<RemoteReviewPage active selection={selection} initialScope="last-turn" lastTurn={[nested]} factory={fixture.factory} onReference={onReference}/>);
  await waitFor(()=>expect(fixture.review).toHaveBeenCalledWith(expect.objectContaining({repositoryPath:'mobile',path:'main.ts',sourceDiff:nested.diff})));
  await openFile(view,'mobile/main.ts');await fireEvent.press(view.getByLabelText('选择新行 1'));await fireEvent.press(view.getByLabelText('加入差异批注草稿'));
  expect(onReference).toHaveBeenCalledWith(expect.objectContaining({path:'mobile/main.ts',text:'ONE'}));await view.unmount();
});
test('repository management wraps status and mutation routing without replacing the authorized cwd',async()=>{
  const fixture=await multiRepositoryFixture();const factory=jest.fn(fixture.factory);
  const view=await render(<RemoteReviewPage active selection={selection} factory={factory}/>);
  await waitFor(()=>expect(view.getByLabelText('选择仓库 mobile')).toBeTruthy());await fireEvent.press(view.getByLabelText('选择仓库 mobile'));
  await fireEvent.press(view.getByLabelText('审查更多操作'));await fireEvent.press(view.getByLabelText('提交与仓库'));
  await waitFor(()=>expect(fixture.status).toHaveBeenCalledWith('mobile'));expect(factory).toHaveBeenLastCalledWith(selection,expect.any(Function));await view.unmount();
});

test('an open diff keeps its own repository after another group menu changes the management selection',async()=>{
  const fixture=await multiRepositoryFixture(),onCompose=jest.fn();
  const view=await render(<RemoteReviewPage active selection={selection} factory={fixture.factory} onCompose={onCompose}/>);
  await openFile(view,'desktop/main.ts');await fireEvent.press(view.getByLabelText('文件操作 mobile/main.ts'));await fireEvent.press(view.getByLabelText('关闭操作菜单'));
  await fireEvent.press(view.getByLabelText('选择新行 1'));await fireEvent.press(view.getByLabelText('加入差异批注草稿'));
  expect(onCompose).toHaveBeenCalledWith(expect.stringContaining('仓库：desktop'));expect(onCompose.mock.calls[0][0]).toContain('仓库版本：'+'a'.repeat(64));
  await openHunkMenu(view);await fireEvent.press(view.getByLabelText('暂存此段'));
  await waitFor(()=>expect(fixture.mutate).toHaveBeenCalledWith('review-apply','a'.repeat(64),expect.objectContaining({repositoryPath:'desktop',patchRevision:'d'.repeat(64)})));await view.unmount();
});
