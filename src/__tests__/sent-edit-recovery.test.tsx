import React from 'react';
import {Text} from 'react-native';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {useSentEditBackup,type EditBackupBody} from '../remote/SentEditBackup';
import {mergeSentEditRecovery} from '../remote/sent-edit-recovery';
import {useConversationSyncNotice} from '../remote/useConversationSyncNotice';

const operationId='b3d117de-91f8-4850-b1a7-425848c809f2';
const mockRestore=jest.fn(),mockConsume=jest.fn(),mockHydrate=jest.fn();
jest.mock('../remote/composer-drafts',()=>({createComposerDraftSession:()=>({restore:mockRestore,save:jest.fn(),consume:mockConsume,dispose:jest.fn()}),hydrateComposerImages:(...args:unknown[])=>mockHydrate(...args)}));
jest.mock('../remote/ManagedImage',()=>({ManagedImage:()=>null}));
jest.mock('../remote/thread-extras',()=>({ImageViewer:()=>null}));
const originalImage={uri:'file:///original.png',mime:'image/png' as const,width:20,height:20,base64:'eA=='};
const base:EditBackupBody={version:1,text:'Revised code',features:{skills:[{name:'review',path:'/skill'}]},phase:'reverted',messageId:'user',turnId:'turn',operationId};
function Harness({restore,verify=async()=>{},receipts=[],disabled=false}:{restore:(value:any,id:string)=>Promise<boolean>;verify?:()=>Promise<void>;receipts?:string[];disabled?:boolean}){
 const backup=useSentEditBackup('pair','pc','same-source',{restore,verify,revertOperations:receipts,disabled});
 return <>{backup.panel}<Text>{backup.blocked?'blocked':'ready'}</Text></>;
}
beforeEach(()=>{jest.clearAllMocks();mockConsume.mockResolvedValue(true);mockHydrate.mockResolvedValue([originalImage]);mockRestore.mockResolvedValue({scope:'pair',text:JSON.stringify(base),images:[originalImage],imageCount:1,revision:3,identity:'backup'});});
test('recovery restores the complete saved message before consuming its exact backup and never sends',async()=>{
 const restore=jest.fn(async()=>true),view=await render(<Harness restore={restore}/>);
 await fireEvent.press(await view.findByLabelText('查看未完成的消息编辑'));
 await fireEvent.press(view.getByLabelText('恢复修改到输入框'));
 expect(restore).toHaveBeenCalledWith({text:base.text,features:base.features,images:[originalImage]},operationId);
 expect(mockConsume).toHaveBeenCalledWith(3,'backup');expect(restore.mock.invocationCallOrder[0]).toBeLessThan(mockConsume.mock.invocationCallOrder[0]);
 expect(view.getByText('ready')).toBeTruthy();await view.unmount();
});
test('missing original images or a failed restore never consume the backup',async()=>{
 mockHydrate.mockRejectedValueOnce(new Error('原图片已不存在'));
 const restore=jest.fn(async()=>false),view=await render(<Harness restore={restore}/>);
 await fireEvent.press(await view.findByLabelText('查看未完成的消息编辑'));await fireEvent.press(view.getByLabelText('恢复修改到输入框'));
 expect(view.getByText('原图片已不存在')).toBeTruthy();expect(restore).not.toHaveBeenCalled();expect(mockConsume).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('恢复修改到输入框'));expect(mockConsume).not.toHaveBeenCalled();await view.unmount();
});
test('unconfirmed revert must receive its exact confirmed receipt before recovery is enabled',async()=>{
 mockRestore.mockResolvedValue({scope:'pair',text:JSON.stringify({...base,phase:'reverting'}),images:[],imageCount:0,revision:3});
 const restore=jest.fn(async()=>true),verify=jest.fn(async()=>{}),view=await render(<Harness restore={restore} verify={verify}/>);
 await fireEvent.press(await view.findByLabelText('查看未完成的消息编辑'));
 expect(view.queryByLabelText('恢复修改到输入框')).toBeNull();await fireEvent.press(view.getByLabelText('核对消息编辑状态'));expect(verify).toHaveBeenCalledTimes(1);
 await view.rerender(<Harness restore={restore} receipts={['unrelated']}/>);expect(view.queryByLabelText('恢复修改到输入框')).toBeNull();
 await view.rerender(<Harness restore={restore} receipts={[operationId]}/>);expect(view.getByLabelText('恢复修改到输入框')).toBeTruthy();await view.unmount();
});
test('merging recovery preserves current images, context and mode, rejecting conflicts or partial truncation',()=>{
 const current={text:'New unsent draft',images:[originalImage],features:{collaborationMode:'plan' as const}};
 const saved={text:'Edited original',images:[originalImage],features:base.features};
 expect(mergeSentEditRecovery(current,saved)).toMatchObject({text:'New unsent draft\n\nEdited original',images:[originalImage],features:{collaborationMode:'plan',skills:base.features.skills}});
 expect(()=>mergeSentEditRecovery(current,{...saved,features:{collaborationMode:'default'}})).toThrow('工作模式不同');
 expect(()=>mergeSentEditRecovery(current,saved,10)).toThrow('过长');
 expect(()=>mergeSentEditRecovery(current,{...saved,images:Array.from({length:4},(_,i)=>({...originalImage,uri:`file:///${i}`}))})).toThrow('4 张');
 const ref={kind:'file' as const,projectPath:'/p',path:'main.ts',label:'main.ts',startLine:1,endLine:1,text:'new code',capturedAt:1};
 expect(()=>mergeSentEditRecovery({...current,features:{contextReferences:[ref]}},{...saved,features:{contextReferences:[{...ref,text:'old code'}]}})).toThrow('上下文内容已变化');
});

test('a pending delivery lock does not block read-only verification or permit recovery',async()=>{
 mockRestore.mockResolvedValue({scope:'pair',text:JSON.stringify({...base,phase:'sending'}),images:[],imageCount:0,revision:3});
 const restore=jest.fn(async()=>true),verify=jest.fn(async()=>{}),view=await render(<Harness restore={restore} verify={verify} disabled/>);
 await fireEvent.press(await view.findByLabelText('查看未完成的消息编辑'));
 await fireEvent.press(view.getByLabelText('核对消息编辑状态'));expect(verify).toHaveBeenCalledTimes(1);
 expect(view.queryByLabelText('恢复修改到输入框')).toBeNull();expect(restore).not.toHaveBeenCalled();await view.unmount();
});
function Sync({online,snapshot=1,loading=false,error,scope='source'}:{online:boolean;snapshot?:number;loading?:boolean;error?:string;scope?:string}){
 const notice=useConversationSyncNotice(scope,online,snapshot,loading,error);return <Text>{notice??'实时状态'}</Text>;
}
test('disconnect never claims a stopped task and reconnect waits for a fresh successful snapshot',async()=>{
 const view=await render(<Sync online/>);expect(view.getByText('实时状态')).toBeTruthy();
 await view.rerender(<Sync online={false}/>);expect(view.getByText('连接中断 · 状态待同步')).toBeTruthy();
 await view.rerender(<Sync online/>);expect(view.getByText('连接已恢复 · 正在同步')).toBeTruthy();
 await view.rerender(<Sync online snapshot={2} loading/>);expect(view.getByText('连接已恢复 · 正在同步')).toBeTruthy();
 await view.rerender(<Sync online snapshot={2} error="failure"/>);expect(view.getByText('同步失败 · 显示上次记录')).toBeTruthy();
 await view.rerender(<Sync online snapshot={2}/>);expect(view.getByText('实时状态')).toBeTruthy();await view.unmount();
});
