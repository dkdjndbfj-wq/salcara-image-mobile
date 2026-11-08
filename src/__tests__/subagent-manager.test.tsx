import React from 'react';
import {act,fireEvent,render,waitFor,within} from '@testing-library/react-native';
import {SubagentManager} from '../remote/SubagentManager';
import type {SubagentSelection,SubagentSnapshot} from '../remote/subagent-controls';

let mockCurrent=true;
const mockRead=jest.fn(),mockStop=jest.fn(),mockContinue=jest.fn();
jest.mock('../remote/store',()=>({}));
jest.mock('../remote/WorkspaceRuntimeContext',()=>({useWorkspaceRuntime:()=>null}));
jest.mock('../remote/subagent-controls',()=>({...jest.requireActual('../remote/subagent-controls'),captureHubSubagents:()=>({isCurrent:()=>mockCurrent,read:mockRead,stop:mockStop,continue:mockContinue})}));
const selection:SubagentSelection={deviceId:'pc',parentSessionKey:'codex:parent',surface:'cli',children:['codex:a','codex:b','codex:c'],agent:{id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,api:{accountId:'one'} as any,capabilities:{interrupt:true,preciseInterrupt:true,continue:true} as any}};
function snapshot(key:string,nickname:string,status:'running'|'idle'|'failed'|'unknown'='running'):SubagentSnapshot{
  const session={sessionKey:key,tool:'codex',client:'Codex',cwd:'/project',title:'Child',agentNickname:nickname,agentRole:'reviewer',status,updatedAt:1,controllable:true,controlSurface:'cli',parentSessionKey:'codex:parent',...(status==='running'?{activeTurnId:`${key}-turn`}:{lastTerminalTurnId:`${key}-finished`})} as const;
  return{session,timeline:{items:[],session,loading:false,snapshotAt:1} as any};
}
beforeEach(()=>{jest.clearAllMocks();mockCurrent=true;mockRead.mockImplementation(async(key:string)=>{if(key==='codex:c')throw new Error('状态读取失败');return snapshot(key,key==='codex:a'?'Atlas':'Nova',key==='codex:a'?'running':'idle');});mockStop.mockResolvedValue('stopped');mockContinue.mockResolvedValue(undefined);});

test('default child rows show source statuses and open sessions, with controls behind long press',async()=>{
  const open=jest.fn(),view=await render(<SubagentManager visible selection={selection} onOpenSession={open}/>);
  await waitFor(()=>expect(view.getByText('Atlas')).toBeTruthy());
  expect(within(view.getByTestId('subagent-group-running')).getByText('Atlas')).toBeTruthy();expect(within(view.getByTestId('subagent-group-ended')).getByText('Nova')).toBeTruthy();
  expect(within(view.getByTestId('subagent-group-unconfirmed')).getByTestId('subagent-row:codex:c')).toBeTruthy();
  expect(view.queryByLabelText('停止Atlas')).toBeNull();expect(view.queryByLabelText('刷新Atlas')).toBeNull();expect(view.queryByLabelText('停止所有已确认运行的子智能体')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开Atlas'));expect(open).toHaveBeenCalledWith('codex:a');
  await fireEvent(view.getByLabelText('打开Atlas'),'longPress');expect(view.getByLabelText('刷新Atlas')).toBeTruthy();await fireEvent.press(view.getByLabelText('停止Atlas'));
  expect(mockStop).toHaveBeenCalledTimes(1);expect(mockStop.mock.calls[0][0].session.activeTurnId).toBe('codex:a-turn');await waitFor(()=>expect(within(view.getByTestId('subagent-group-unconfirmed')).getByTestId('subagent-row:codex:a')).toBeTruthy());await view.unmount();
});
test('all-stop is contained in management and freezes only exact confirmed runnable children',async()=>{
  const a=snapshot('codex:a','Atlas'),b=snapshot('codex:b','Nova');mockRead.mockImplementation(async(key:string)=>key==='codex:a'?a:key==='codex:b'?b:snapshot(key,'Idle','idle'));
  const view=await render(<SubagentManager visible selection={selection} onOpenSession={jest.fn()}/>);await waitFor(()=>expect(view.getByText('Nova')).toBeTruthy());
  await fireEvent.press(view.getByLabelText('子智能体管理操作'));await fireEvent.press(view.getByLabelText('停止所有已确认运行的子智能体'));
  await waitFor(()=>expect(mockStop).toHaveBeenCalledTimes(2));expect(mockStop.mock.calls.map(call=>call[0])).toEqual([a,b]);expect(mockContinue).not.toHaveBeenCalled();await view.unmount();
});
test('a failed refresh retires the old running snapshot and cannot authorize a stop',async()=>{
  const view=await render(<SubagentManager visible selection={{...selection,children:['codex:a']}} onOpenSession={jest.fn()}/>);await waitFor(()=>expect(view.getByText('Atlas')).toBeTruthy());
  await fireEvent(view.getByLabelText('打开Atlas'),'longPress');mockRead.mockRejectedValueOnce(new Error('offline now'));await fireEvent.press(view.getByLabelText('刷新Atlas'));
  await waitFor(()=>expect(view.getByText('offline now')).toBeTruthy());expect(view.getByText('已开启 · 0')).toBeTruthy();expect(view.getByText('没有已开启的子代理')).toBeTruthy();expect(view.queryByLabelText('停止Atlas')).toBeNull();expect(mockStop).not.toHaveBeenCalled();await view.unmount();
});
test('continue stays behind more and late old-computer reads cannot populate a replacement group',async()=>{
  const view=await render(<SubagentManager visible selection={{...selection,children:['codex:b']}} onOpenSession={jest.fn()}/>);await waitFor(()=>expect(view.getByText('Nova')).toBeTruthy());
  expect(view.queryByLabelText('继续Nova会话')).toBeNull();await fireEvent(view.getByLabelText('打开Nova'),'longPress');await fireEvent.press(view.getByLabelText('继续Nova会话'));expect(mockContinue).toHaveBeenCalledWith(expect.objectContaining({session:expect.objectContaining({sessionKey:'codex:b',lastTerminalTurnId:'codex:b-finished'})}));
  let finish!:(value:SubagentSnapshot)=>void;mockRead.mockImplementation(()=>new Promise(done=>{finish=done;}));await view.rerender(<SubagentManager visible selection={{...selection,children:['codex:a']}} onOpenSession={jest.fn()}/>);
  const resolveOld=finish;mockRead.mockResolvedValue(snapshot('codex:new','New host','idle'));await view.rerender(<SubagentManager visible selection={{...selection,deviceId:'other',children:['codex:new']}} onOpenSession={jest.fn()}/>);
  await act(async()=>resolveOld(snapshot('codex:a','Old host')));await waitFor(()=>expect(view.getByText('New host')).toBeTruthy());expect(view.queryByText('Old host')).toBeNull();expect(view.queryByLabelText('继续Nova会话')).toBeNull();await view.unmount();
});


test('empty active group stays visible and failed children never appear completed',async()=>{
  mockRead.mockImplementation(async(key:string)=>snapshot(key,key==='codex:a'?'Failed child':'Done child',key==='codex:a'?'failed':'idle'));
  const view=await render(<SubagentManager visible selection={{...selection,children:['codex:a','codex:b']}} onOpenSession={jest.fn()}/>);
  await waitFor(()=>expect(view.getByText('Done child')).toBeTruthy());
  expect(view.getByText('已开启 · 0')).toBeTruthy();expect(view.getByText('没有已开启的子代理')).toBeTruthy();
  expect(view.getByText('完成 · 1')).toBeTruthy();
  expect(within(view.getByTestId('subagent-group-failed')).getByText('Failed child')).toBeTruthy();
  expect(within(view.getByTestId('subagent-group-ended')).queryByText('Failed child')).toBeNull();
  expect(view.queryByText('reviewer')).toBeNull();expect(view.queryByLabelText('更多Done child操作')).toBeNull();
  await view.unmount();
});
