import React from 'react';
import {act,fireEvent,render} from '@testing-library/react-native';
import {RemoteSidebar} from '../remote/RemoteSidebar';
import {initialWorkspacePages,WORKSPACE_PAGES,type WorkspacePage} from '../remote/WorkspaceTabs';
import {loadWorkspaceLayout,parseWorkspaceLayout,resetWorkspaceLayoutMemoryForTests,saveWorkspaceLayout} from '../remote/workspace-layout';
import type {AgentProfile} from '../remote/client';
import type {ConversationArtifactTarget} from '../remote/conversation-artifact-target';

const mockDisk=new Map<string,string>();
const mockMounted=jest.fn(),mockUnmounted=jest.fn();
let mockRemote:any;
let mockPreviewActions:Array<{scope:string;compose:(text:string)=>boolean|void}>=[];
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockDisk.get(key)??null,setSetting:async(key:string,value:string|null)=>{if(value===null)mockDisk.delete(key);else mockDisk.set(key,value);}}));
jest.mock('../remote/store',()=>({useRemote:()=>mockRemote,remoteDeliveryScope:()=> 'pairing-fixture',timelineKey:(device:string,key:string)=>`${device}|${key}`,loadSessions:async()=>{},loadNativeSessions:async()=>{},hubSupportsSessionActions:()=>false}));
jest.mock('../components/ui',()=>({useReducedMotion:()=>true,AppDialog:()=>null,dismissKeyboardAndBlur:jest.fn()}));
jest.mock('../remote/RemoteBrowserPage',()=>({RemoteBrowserPage:()=>null}));
jest.mock('../remote/ConversationArtifactPreview',()=>{
  const React=require('react'),{TextInput}=require('react-native');
  return {ConversationArtifactPreview:({target,onCompose}:any)=>{
    const [value,setValue]=React.useState('');
    React.useEffect(()=>{mockMounted(target);return()=>mockUnmounted(target);},[]);
    mockPreviewActions.push({scope:target.scopeKey,compose:onCompose??(()=>false)});
    return React.createElement(TextInput,{accessibilityLabel:'动态界面预览草稿',value,onChangeText:setValue});
  }};
});

const agent:AgentProfile={id:'codex',name:'Codex',tool:'codex',available:true,remoteSendSupported:true,api:{name:'fixture',model:'',protocol:'responses',configured:true,pending:false,source:'computer'}};
const target:ConversationArtifactTarget={scopeKey:'pc/api-a/project/session',messageId:'assistant-result',index:2,revision:'a'.repeat(64),source:'<main>Private interface source</main>',title:'预算界面'};
const props={visible:true,docked:true,mode:'tools' as const,deviceId:'pc',agent,activeSessionKey:'codex:session',controlSurface:'cli' as const,onClose:jest.fn(),onOpenSession:jest.fn(),artifactScope:target.scopeKey};
beforeEach(()=>{
  mockDisk.clear();resetWorkspaceLayoutMemoryForTests();jest.clearAllMocks();mockPreviewActions=[];
  mockRemote={connection:'open',connectionId:'paired',selectedHubUrl:'https://relay.example',devices:[{deviceId:'pc',name:'Computer',online:true,capabilities:[]}],sessions:{pc:{loaded:true,pages:{codex:{}},list:[{sessionKey:'codex:session',tool:'codex',client:'Codex',title:'Task',cwd:'/project',controlSurface:'cli',status:'idle',updatedAt:1}]}},timelines:{}};
});

test('interface previews have no permanent tool or initial tab entry',async()=>{
  expect(WORKSPACE_PAGES.some(page=>page.kind==='artifact')).toBe(false);
  expect(initialWorkspacePages().some(page=>page.kind==='artifact')).toBe(false);
  const view=await render(<RemoteSidebar {...props}/>);
  expect(mockMounted).not.toHaveBeenCalled();expect(view.queryByRole('tab',{name:target.title})).toBeNull();
  await fireEvent.press(view.getByLabelText('添加工具标签'));
  expect(view.queryByLabelText('打开界面设计标签')).toBeNull();
  await view.unmount();
});

test('an explicit card target opens a dynamic tab and repeated opens reuse its exact version',async()=>{
  const view=await render(<RemoteSidebar {...props}/>);
  await view.rerender(<RemoteSidebar {...props} artifactTarget={{target,nonce:1}}/>);
  expect(view.getByRole('tab',{name:target.title})).toBeSelected();expect(mockMounted).toHaveBeenCalledTimes(1);
  await fireEvent.changeText(view.getByLabelText('动态界面预览草稿'),'keep the current controls');
  await view.rerender(<RemoteSidebar {...props} artifactTarget={{target:{...target},nonce:2}}/>);
  expect(view.getAllByRole('tab',{name:target.title})).toHaveLength(1);expect(mockMounted).toHaveBeenCalledTimes(1);
  expect(view.getByLabelText('动态界面预览草稿').props.value).toBe('keep the current controls');
  await view.rerender(<RemoteSidebar {...props} artifactTarget={{target:{...target,revision:'b'.repeat(64),title:'预算界面新版'},nonce:3}}/>);
  expect(view.getByRole('tab',{name:'预算界面新版'})).toBeSelected();expect(mockMounted).toHaveBeenCalledTimes(2);
  expect(mockUnmounted).not.toHaveBeenCalled();await view.unmount();
});

test('switching tabs and hiding the sidebar retain the preview instance but hidden callbacks cannot compose',async()=>{
  const onCompose=jest.fn(()=>true),request={target,nonce:1};
  const view=await render(<RemoteSidebar {...props} artifactTarget={request} onCompose={onCompose}/>);
  const compose=mockPreviewActions.at(-1)!.compose;
  expect(compose('active note')).toBe(true);
  await fireEvent.press(view.getByRole('tab',{name:'新标签页'}));
  expect(compose('hidden tab note')).toBe(false);expect(mockUnmounted).not.toHaveBeenCalled();
  await view.rerender(<RemoteSidebar {...props} visible={false} artifactTarget={request} onCompose={onCompose}/>);
  expect(compose('hidden sidebar note')).toBe(false);expect(mockUnmounted).not.toHaveBeenCalled();
  await view.rerender(<RemoteSidebar {...props} artifactTarget={request} onCompose={onCompose}/>);
  await fireEvent.press(view.getByRole('tab',{name:target.title}));
  expect(mockMounted).toHaveBeenCalledTimes(1);expect(onCompose).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('API scope changes dispose old previews and never revive stale requests or callbacks',async()=>{
  const onCompose=jest.fn(()=>true),request={target,nonce:1};
  const view=await render(<RemoteSidebar {...props} artifactTarget={request} onCompose={onCompose}/>);
  const staleCompose=mockPreviewActions.at(-1)!.compose;
  await view.rerender(<RemoteSidebar {...props} artifactScope="pc/api-b/project/session" artifactTarget={request} onCompose={onCompose}/>);
  expect(view.queryByRole('tab',{name:target.title})).toBeNull();expect(mockUnmounted).toHaveBeenCalledTimes(1);
  expect(staleCompose('late result')).toBe(false);
  await view.rerender(<RemoteSidebar {...props} artifactTarget={request} onCompose={onCompose}/>);
  expect(view.queryByRole('tab',{name:target.title})).toBeNull();expect(staleCompose('late result after return')).toBe(false);
  await view.rerender(<RemoteSidebar {...props} artifactTarget={{target,nonce:2}} onCompose={onCompose}/>);
  expect(view.getByRole('tab',{name:target.title})).toBeSelected();
  expect(mockPreviewActions.at(-1)!.compose('current note')).toBe(true);expect(onCompose).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('closing a dynamic preview returns to its neighbour without replaying the old open request',async()=>{
  const request={target,nonce:1},view=await render(<RemoteSidebar {...props} artifactTarget={request}/>);
  await fireEvent.press(view.getByLabelText(`关闭标签 ${target.title}`));
  expect(view.getByRole('tab',{name:'新标签页'})).toBeSelected();expect(mockUnmounted).toHaveBeenCalledTimes(1);
  await view.rerender(<RemoteSidebar {...props} artifactTarget={{...request}}/>);
  expect(view.queryByRole('tab',{name:target.title})).toBeNull();await view.unmount();
});

test('preview source and closed previews never enter durable layout or block other tabs from saving',async()=>{
  const artifact:WorkspacePage={id:'artifact-fixture',kind:'artifact',title:target.title,artifact:{...target,source:'private-interface '.repeat(100000)}};
  const browser:WorkspacePage={id:'browser-fixture',kind:'preview',title:'Public page',preview:{kind:'web',url:'https://example.com'}};
  await expect(saveWorkspaceLayout({scope:'layout-fixture',pages:[browser,artifact],activeId:artifact.id,closedPages:[artifact,{id:'terminal:1',kind:'terminal',title:'终端'}]})).resolves.toBeUndefined();
  const raw=mockDisk.get('remote.workspace.layout.v1:layout-fixture')!;
  expect(raw).not.toContain('private-interface');expect(raw).not.toContain('artifact-fixture');
  const saved=JSON.parse(raw);expect(saved.activeId).toBe(browser.id);expect(saved.pages).toHaveLength(1);expect(saved.closedPages).toHaveLength(1);
  expect((await loadWorkspaceLayout('layout-fixture'))?.pages).toHaveLength(2);
  resetWorkspaceLayoutMemoryForTests();expect((await loadWorkspaceLayout('layout-fixture'))?.pages).toEqual([browser]);
  await saveWorkspaceLayout({scope:'artifact-only',pages:[artifact],activeId:artifact.id});
  expect(JSON.parse(mockDisk.get('remote.workspace.layout.v1:artifact-only')!)).toMatchObject({pages:initialWorkspacePages(),activeId:'newtab'});
  expect(parseWorkspaceLayout(JSON.stringify({scope:'unsafe',pages:[{...browser,artifact:target}],activeId:browser.id}),'unsafe')).toBeUndefined();
});
