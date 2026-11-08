import React from 'react';
import {act,fireEvent,render,within} from '@testing-library/react-native';
import {BlockRow,ThreadUi} from '../remote/thread-rows';
import {buildBlocks,conversationBlocks} from '../remote/blocks';
import type {TimelineItem} from '../remote/store';

const mockCopy=jest.fn();
jest.mock('../storage/database',()=>({getSetting:async()=>null,setSetting:async()=>undefined}));
jest.mock('../remote/thread-extras',()=>({...jest.requireActual('../remote/thread-extras'),copyUserMessage:(text:string)=>mockCopy(text)}));
const ui={openDiff:jest.fn(),openImage:jest.fn(),requestAttachment:jest.fn(),presentation:'tablet' as const};
const user=(text:string):Extract<TimelineItem,{kind:'message'}>=>({kind:'message',id:'user',role:'user',text,final:true,ts:1});
const renderUser=(text:string)=><ThreadUi.Provider value={ui}><BlockRow tool="codex" block={{type:'user',id:'m:user',item:user(text)}} onOpenChild={jest.fn()}/></ThreadUi.Provider>;

beforeEach(()=>mockCopy.mockClear());

test('a long character count does not fold when the measured message fits two lines',async()=>{
  const text='short words '.repeat(15),view=await render(renderUser(text));
  await fireEvent(view.getByTestId('user-message-measure-full',{includeHiddenElements:true}),'layout',{nativeEvent:{layout:{width:500,height:54}}});
  await fireEvent(view.getByTestId('user-message-measure-clipped',{includeHiddenElements:true}),'layout',{nativeEvent:{layout:{width:500,height:54}}});
  expect(view.queryByLabelText('展开消息')).toBeNull();
  expect(within(view.getByTestId('remote-user-message-bubble')).queryByRole('button',{name:'复制消息'})).toBeNull();
  expect(view.queryByText('复制')).toBeNull();
  await fireEvent(view.getByTestId('message-selectable-text'),'longPress');
  expect(mockCopy).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('复制消息'));expect(mockCopy).toHaveBeenCalledWith(text);
});

test('real overflow reveals show-more and resizing never copies or changes the source',async()=>{
  const text='保留原始正文与标点。'.repeat(12),view=await render(renderUser(text));
  const measure=(kind:'full'|'clipped',height:number,width=320)=>fireEvent(view.getByTestId(`user-message-measure-${kind}`,{includeHiddenElements:true}),'layout',{nativeEvent:{layout:{width,height}}});
  await measure('full',162);await measure('clipped',54);
  expect(view.getByText('显示更多')).toBeTruthy();
  expect(view.getByTestId('message-selectable-text').props.numberOfLines).toBe(2);
  await fireEvent.press(view.getByLabelText('展开消息'));
  expect(view.getByTestId('message-selectable-text').props.numberOfLines).toBeUndefined();
  expect(view.getByText('收起')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('收起消息'));
  await measure('full',54,800);await measure('clipped',54,800);
  expect(view.queryByLabelText('展开消息')).toBeNull();
  await fireEvent.press(view.getByLabelText('复制消息'));expect(mockCopy).toHaveBeenLastCalledWith(text);
});

test('completed duration appears before the final body exactly once while commentary has no completion header',async()=>{
  const item:Extract<TimelineItem,{kind:'message'}>={kind:'message',id:'answer',role:'assistant',text:'验证通过。',final:true,messagePhase:'final_answer',ts:2};
  const renderReply=(message=item,stat:{durationMs?:number;tokens?:number}={durationMs:26000,tokens:40})=><BlockRow block={{type:'assistant',id:'m:answer',item:message}} tool="codex" onOpenChild={jest.fn()} stat={stat}/>;
  const view=await render(renderReply());
  expect(view.getAllByText('用时 26 秒')).toHaveLength(1);
  expect(view.getByText('40 tokens')).toBeTruthy();
  const tree=JSON.stringify(view.toJSON());expect(tree.indexOf('completed-turn-header')).toBeLessThan(tree.indexOf('验证通过。'));
  await view.rerender(renderReply({...item,messagePhase:'commentary'}));expect(view.queryByTestId('completed-turn-header')).toBeNull();
  await view.rerender(renderReply(item,{tokens:40}));expect(view.queryByTestId('completed-turn-header')).toBeNull();
});

test('a running command previews actual detail and keeps output behind its own disclosure',async()=>{
  const item:TimelineItem={kind:'tool',id:'cmd',tool:'command',title:'运行命令',detail:'rg -n "TODO" src\n  --glob *.tsx',output:'src/App.tsx:3 TODO',status:'running',ts:1};
  const [block]=conversationBlocks(buildBlocks([item],true),'codex');
  const view=await render(<BlockRow block={block} tool="codex" onOpenChild={jest.fn()}/>);
  expect(view.getByText('正在运行 rg -n "TODO" src --glob *.tsx')).toBeTruthy();
  expect(view.queryByText('src/App.tsx:3 TODO')).toBeNull();
  await fireEvent.press(view.getByLabelText('查看命令详情：运行命令'));
  expect(view.getByText('src/App.tsx:3 TODO')).toBeTruthy();
  expect(view.getByText('$ rg -n "TODO" src\n  --glob *.tsx')).toBeTruthy();
});

test('live elapsed header updates above commentary and disappears when no longer running',async()=>{
  jest.useFakeTimers();
  jest.setSystemTime(30_000);
  try {
    const item:Extract<TimelineItem,{kind:'message'}>={kind:'message',id:'progress',role:'assistant',text:'正在检查。',final:true,messagePhase:'commentary',ts:10_000};
    const reply=(startedAt?:number)=><BlockRow block={{type:'assistant',id:'m:progress',item}} tool="codex" onOpenChild={jest.fn()} runningTurnStartedAt={startedAt}/>;
    const view=await render(reply(4_000));
    expect(view.getByText('已处理 26 秒')).toBeTruthy();
    const tree=JSON.stringify(view.toJSON());expect(tree.indexOf('running-turn-header')).toBeLessThan(tree.indexOf('正在检查。'));
    await act(async()=>{jest.advanceTimersByTime(1_000);});
    expect(view.getByText('已处理 27 秒')).toBeTruthy();
    await view.rerender(reply());
    expect(view.queryByTestId('running-turn-header')).toBeNull();
  } finally { jest.useRealTimers(); }
});
