import React from 'react';
import {render,fireEvent} from '@testing-library/react-native';
import {ComputerUsePage} from '../remote/ComputerUsePage';
import type {TimelineItem} from '../remote/store';
type Tool=Extract<TimelineItem,{kind:'tool'}>;
const image={id:`att_${'a'.repeat(32)}`,mime:'image/png',width:800,height:600};
const item:Tool={kind:'tool',id:'step-1',tool:'mcp',title:'real call',status:'done',ts:1000,computer:{version:1,surface:'browser',action:'screenshot',provider:'playwright'},attachments:[image]};
test('hidden pages do not read screenshots; visible pages request once and show returned bytes',async()=>{
 const onAttachment=jest.fn(),onImage=jest.fn();const props={items:[item],connected:true,sessionRunning:false,onAttachment,onImage};
 const view=await render(<ComputerUsePage {...props} active={false}/>);expect(onAttachment).not.toHaveBeenCalled();
 await view.rerender(<ComputerUsePage {...props} active/>);expect(onAttachment).toHaveBeenCalledTimes(1);
 await view.rerender(<ComputerUsePage {...props} active items={[{...item,attachments:[{...image,uri:'file:///safe/actual.png'}]}]}/>);
 await fireEvent.press(view.getByLabelText('放大电脑操作画面'));expect(onImage).toHaveBeenCalledWith('file:///safe/actual.png');expect(onAttachment).toHaveBeenCalledTimes(1);
});
test('stop is a real parent callback only for connected running work; disconnect does not imply completion',async()=>{
 const onStop=jest.fn(),items=[{...item,status:'running' as const,attachments:undefined}];
 const liveActivityIds=new Set(['step-1']);
 const view=await render(<ComputerUsePage items={items} active connected sessionRunning liveActivityIds={liveActivityIds} onStop={onStop}/>);
 await fireEvent.press(view.getByLabelText('停止AI当前回合'));expect(onStop).toHaveBeenCalledTimes(1);
 await view.rerender(<ComputerUsePage items={items} active connected={false} sessionRunning liveActivityIds={liveActivityIds} onStop={onStop}/>);
 expect(view.queryByLabelText('停止AI当前回合')).toBeNull();expect(view.getByText('连接中断')).toBeTruthy();expect(view.getByText('状态待确认')).toBeTruthy();
});
test('unresolved old calls never advertise current operation or a stop button',async()=>{
 const view=await render(<ComputerUsePage items={[{...item,status:'running',turnId:'old-turn'}]} active connected sessionRunning liveActivityIds={new Set()} onStop={jest.fn()}/>);
 expect(view.getByText('状态待确认')).toBeTruthy();expect(view.queryByText('AI 正在操作')).toBeNull();expect(view.queryByLabelText('停止AI当前回合')).toBeNull();
});
test('approval pauses the current operation label while preserving explicit stop',async()=>{
 const view=await render(<ComputerUsePage items={[{...item,status:'running'}]} active connected sessionRunning liveActivityIds={new Set(['step-1'])} waitingApproval onStop={jest.fn()}/>);
 expect(view.getAllByText('等待确认')).toHaveLength(2);expect(view.queryByText('AI 正在操作')).toBeNull();expect(view.getByLabelText('停止AI当前回合')).toBeTruthy();
});
test('selecting history prevents a new screenshot from replacing the selected step',async()=>{
 const newer={...item,id:'step-2',ts:2000,computer:{...item.computer!,action:'click' as const},attachments:undefined};
 const view=await render(<ComputerUsePage items={[item,newer]} active connected sessionRunning={false}/>);
 await fireEvent.press(view.getByLabelText('查看电脑操作 step-2'));expect(view.getByText('此操作未返回画面')).toBeTruthy();
 await view.rerender(<ComputerUsePage items={[item,newer,{...item,id:'step-3'}]} active connected sessionRunning={false}/>);
 expect(view.getByText('此操作未返回画面')).toBeTruthy();await fireEvent.press(view.getByLabelText('跟随最新电脑操作'));
 expect(view.getByText('操作截图尚未加载')).toBeTruthy();
});
test('following a new call resets its frame choice before requesting any image',async()=>{
 const second={...image,id:`att_${'b'.repeat(32)}`},newFirst={...image,id:`att_${'c'.repeat(32)}`},newSecond={...image,id:`att_${'d'.repeat(32)}`};
 const onAttachment=jest.fn(),first={...item,attachments:[image,second]};
 const view=await render(<ComputerUsePage items={[first]} active connected sessionRunning={false} onAttachment={onAttachment}/>);
 await fireEvent.press(view.getByLabelText('电脑操作截图 2'));expect(onAttachment).toHaveBeenLastCalledWith(second);onAttachment.mockClear();
 await view.rerender(<ComputerUsePage items={[first,{...item,id:'new-call',attachments:[newFirst,newSecond]}]} active connected sessionRunning={false} onAttachment={onAttachment}/>);
 expect(onAttachment).toHaveBeenCalledTimes(1);expect(onAttachment).toHaveBeenCalledWith(newFirst);
});
