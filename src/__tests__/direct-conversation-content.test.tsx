import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DirectConversation } from '../remote/DirectConversation';
import type { TimelineItem } from '../remote/store';
import type {AttachmentRef} from '../remote/client';
import {cachedAttachment} from '../remote/attachment-cache';
import {RemoteSidebar} from '../remote/RemoteSidebar';

const mockScrollToEnd = jest.fn(), mockScrollToIndex=jest.fn(), mockScrollToOffset=jest.fn(), mockBlockRow = jest.fn(), mockClock = jest.fn(), mockFrame = jest.fn();
let mockWidth = 1194, mockGeneration = 1, mockConnectionStatus = 'connected';
jest.mock('react-native', () => {
  const React = require('react'), actual = jest.requireActual('react-native'), replacement = Object.create(actual);
  Object.defineProperty(replacement, 'useWindowDimensions', { value: () => ({ width: mockWidth, height: 844, scale: 1, fontScale: 1 }) });
  Object.defineProperty(replacement, 'FlatList', { value: React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({ scrollToEnd: mockScrollToEnd,scrollToIndex:mockScrollToIndex,scrollToOffset:mockScrollToOffset }));
    return React.createElement(actual.View, { ...props, style: props.contentContainerStyle }, props.ListHeaderComponent,
      props.data.length ? props.data.map((item: any, index: number) => React.createElement(React.Fragment, { key: item.id }, props.renderItem({ item, index }))) : props.ListEmptyComponent,
      props.ListFooterComponent);
  }) });
  return replacement;
});
jest.mock('../remote/direct-pairing', () => ({ directDeliveryScope: () => 'pairing', directConnectionGeneration: () => mockGeneration,
  getDirectConnectionState: () => ({ status: mockConnectionStatus, deviceId: 'pc' }) }));
jest.mock('../remote/direct-api', () => ({ requestDirect: jest.fn() }));
jest.mock('../remote/attachment-cache', () => ({cachedAttachment:jest.fn(),parseAttachmentPage:jest.fn()}));
jest.mock('../remote/direct-session-services', () => ({ captureDirectSessionServices: () => ({ scope: 'paired-session', isCurrent: () => true, guard: jest.fn() }) }));
jest.mock('../remote/RemoteSidebar', () => ({ RemoteSidebar: () => null }));
jest.mock('../remote/TabletThreadFrame', () => ({ TabletThreadFrame: (props: any) => {mockFrame(props);return props.children;} }));
jest.mock('../remote/DirectComposer', () => ({ DirectComposer: () => null }));
jest.mock('../remote/QuestionDock', () => ({ QuestionDock: ({ children }: any) => children }));
jest.mock('../remote/thread-rows', () => {
  const React = require('react'), { Text } = require('react-native');
  return { ThreadUi: React.createContext({}), ApprovalCard: () => null,
    BlockRow: (props: any) => { mockBlockRow(props); return React.createElement(Text, null, props.block.item?.text || props.block.type); },
    ThreadClockProvider: ({ startedAt, children }: any) => { mockClock(startedAt); return children; },
    ThreadClockLabel: ({ prefix }: any) => React.createElement(Text, null, prefix) };
});
jest.mock('../remote/thread-extras', () => {
  const React = require('react'), { View, Text } = require('react-native');
  return { SearchBar:jest.requireActual('../remote/thread-extras').SearchBar, ImageViewer: () => null, JumpToLatest: ({ visible, unseen, onPress }: any) => visible
    ? React.createElement(View, { accessible: true, accessibilityRole: 'button', accessibilityLabel: unseen ? '有新消息，回到最新' : '回到最新', onPress }, React.createElement(Text, null, '最新')) : null };
});

const base: any = {
  runtime: { scope: 'pairing', remote: { devices: [{ deviceId: 'pc', capabilities: [] }] } }, deviceId: 'pc',
  profile: { id: 'codex', name: 'Codex', tool: 'codex', api: { accountId: 'api' }, capabilities: {} },
  session: { sessionKey: 'codex:main', title: 'Task', cwd: '/project', status: 'idle', controlSurface: 'cli' },
  workspaceMode: 'code', text: '', onText: jest.fn(), loading: false, loadingMore: false, sending: false, canSend: true, uncertain: false, error: '',
  onSend: jest.fn(), onStop: jest.fn(), onRespond: jest.fn(), onEarlier: jest.fn(), onRefresh: jest.fn(), onBack: jest.fn(), onOpenSession: jest.fn(), onNew: jest.fn(),
};
const prompt: TimelineItem = { kind: 'message', id: 'prompt', role: 'user', text: '请检查', final: true, ts: 100 };
const start: TimelineItem = { kind: 'turn', id: 'start', turnId: 'turn', status: 'started', ts: 1000 };
const answer: TimelineItem = { kind: 'message', id: 'answer', role: 'assistant', text: '最终回答', final: true, ts: 16_000 };
function page(items: TimelineItem[], props: Record<string, unknown> = {}) {
  return <DirectConversation {...base} timeline={{ items, loading: false }} {...props}/>;
}
const position = (y: number, height = 1200) => ({ nativeEvent: { layoutMeasurement: { height: 500 }, contentOffset: { y }, contentSize: { height } } });
beforeEach(() => { jest.clearAllMocks(); mockWidth = 1194; mockGeneration = 1; mockConnectionStatus = 'connected';jest.mocked(cachedAttachment).mockReset(); });

test('a completed Direct answer receives its actual turn duration and token usage, keyed by message identity', async () => {
  const view = await render(page([prompt, start, answer, { kind: 'turn', id: 'done', turnId: 'turn', status: 'completed', ts: 17_000, durationMs: 16_000, usage: { inputTokens: 10, outputTokens: 20 } }]));
  expect(mockBlockRow.mock.calls.find(([props]) => props.block.type === 'assistant')?.[0].stat).toEqual({ durationMs: 16_000, tokens: 30 });
  expect(mockBlockRow.mock.calls.find(([props]) => props.block.type === 'user')?.[0].stat).toBeUndefined();
  expect(view.queryByRole('progressbar', { name: '正在处理' })).toBeNull();
  await view.unmount();
});

test('a running Direct turn before its first token shows processing and passes only a reported start time', async () => {
  const running = { session: { ...base.session, status: 'running' } };
  const view = await render(page([prompt, start], running));
  expect(view.getByRole('progressbar', { name: '正在处理' })).toBeTruthy(); expect(mockClock).toHaveBeenLastCalledWith(1000);
  await view.rerender(page([prompt], running));
  expect(view.getByRole('progressbar', { name: '正在处理' })).toBeTruthy(); expect(mockClock).toHaveBeenLastCalledWith(undefined);
  await view.unmount();
});

test('streaming text and active execution already show their own progress without a duplicate waiting footer', async () => {
  const running = { session: { ...base.session, status: 'running' } };
  const view = await render(page([prompt, start, { ...answer, final: false }], running));
  expect(view.queryByRole('progressbar', { name: '正在处理' })).toBeNull();
  await view.rerender(page([prompt, start, { kind: 'tool', id: 'tool', tool: 'command', title: '检查项目', status: 'running', ts: 2000 }], running));
  expect(view.queryByRole('progressbar', { name: '正在处理' })).toBeNull();
  await view.rerender(page([prompt, start], { ...running, loading: true }));
  expect(view.queryByRole('progressbar', { name: '正在处理' })).toBeNull();
  await view.unmount();
});

test('the running heading belongs to the first current-turn answer and never invents a missing start time', async () => {
  const running={session:{...base.session,status:'running'}};
  const commentary:TimelineItem={...answer,id:'progress',final:true,messagePhase:'commentary',turnId:'turn'};
  const view=await render(page([prompt,start,commentary,{...answer,turnId:'turn',final:false}],running));
  expect(mockBlockRow.mock.calls.find(([props])=>props.block.item?.id==='progress')?.[0].runningTurnStartedAt).toBe(1000);
  expect(mockBlockRow.mock.calls.find(([props])=>props.block.item?.id==='answer')?.[0].runningTurnStartedAt).toBeUndefined();
  mockBlockRow.mockClear();await view.rerender(page([prompt,commentary],running));
  expect(mockBlockRow.mock.calls.find(([props])=>props.block.item?.id==='progress')?.[0].runningTurnStartedAt).toBeUndefined();
  await view.unmount();
});

test('incoming tokens cannot pull a user away while dragging near the latest message', async () => {
  const view = await render(page([prompt, answer]));
  const list = view.getByTestId('direct-conversation');
  await fireEvent(list, 'contentSizeChange', 700, 1200); expect(mockScrollToEnd).toHaveBeenCalledTimes(1); mockScrollToEnd.mockClear();
  await fireEvent(list, 'scrollBeginDrag');
  await fireEvent.scroll(list, position(650)); // Still within the old 100-pixel follow threshold.
  await fireEvent(list, 'contentSizeChange', 700, 1240); expect(mockScrollToEnd).not.toHaveBeenCalled();
  await fireEvent(list, 'scrollEndDrag', position(100, 1240));
  await fireEvent.scroll(list, position(100, 1240));
  await fireEvent(list, 'contentSizeChange', 700, 1300); expect(mockScrollToEnd).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: '有新消息，回到最新' }));
  expect(mockScrollToEnd).toHaveBeenLastCalledWith({ animated: true });
  await fireEvent(list, 'contentSizeChange', 700, 1340); expect(mockScrollToEnd).toHaveBeenLastCalledWith({ animated: false });
  await view.unmount();
});

test('loading older records preserves the reader position and does not treat prepended history as a new reply', async () => {
  const view = await render(page([prompt, answer], { timeline: { items: [prompt, answer], nextCursor: 'earlier', loading: false } }));
  const list = view.getByTestId('direct-conversation');
  expect(list.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
  await fireEvent.press(view.getByLabelText('加载更早记录')); expect(base.onEarlier).toHaveBeenCalledTimes(1);
  await view.rerender(page([prompt, answer], { loadingMore: true }));
  await fireEvent(view.getByTestId('direct-conversation'), 'contentSizeChange', 700, 1800);
  expect(mockScrollToEnd).not.toHaveBeenCalled(); expect(view.queryByRole('button', { name: '有新消息，回到最新' })).toBeNull();
  await view.unmount();
});

test('switching the actual conversation resets follow state instead of inheriting the previous reading position', async () => {
  const view = await render(page([prompt, answer]));
  await fireEvent.scroll(view.getByTestId('direct-conversation'), position(50));
  await view.rerender(page([prompt], { session: { ...base.session, sessionKey: 'codex:other' } }));
  await act(async () => {});
  await fireEvent(view.getByTestId('direct-conversation'), 'contentSizeChange', 700, 800);
  expect(mockScrollToEnd).toHaveBeenCalledWith({ animated: false });
  expect(view.queryByRole('button', { name: '回到最新' })).toBeNull();
  await view.unmount();
});

test('refreshing API metadata in the same conversation does not pull the reader to the bottom', async () => {
  const view = await render(page([prompt, answer]));
  await fireEvent.scroll(view.getByTestId('direct-conversation'), position(50));
  await view.rerender(page([prompt, answer], { profile: { ...base.profile, api: { ...base.profile.api, model: 'refreshed-model' } } }));
  await fireEvent(view.getByTestId('direct-conversation'), 'contentSizeChange', 700, 1300);
  expect(mockScrollToEnd).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: '有新消息，回到最新' })).toBeTruthy();
  await view.unmount();
});

test('the Direct menu keeps the conversation and search without reading settings or message navigation', async () => {
  mockWidth = 390;
  const view = await render(page([prompt, answer]));
  expect(view.getByText('请检查')).toBeTruthy();
  expect(view.getByText('最终回答')).toBeTruthy();
  expect(view.queryByTestId('conversation-reading-panel')).toBeNull();
  await fireEvent.press(view.getByLabelText('更多'));
  expect(view.getByLabelText('搜索对话')).toBeTruthy();
  expect(view.getByLabelText('刷新会话')).toBeTruthy();
  expect(view.queryByLabelText('阅读设置与消息导航')).toBeNull();
  expect(view.queryByTestId('conversation-reading-panel')).toBeNull();
  await fireEvent.press(view.getByLabelText('搜索对话'));
  expect(view.getByLabelText('搜索这个对话')).toBeTruthy();
  expect(view.getByText('最终回答')).toBeTruthy();
  expect(view.queryByTestId('conversation-reading-panel')).toBeNull();
  await view.unmount();
});

test('Direct search shows match counts, wraps previous/next and resets when the API account changes',async()=>{
  mockWidth=390;
  const items=[prompt,{...answer,text:'检查结果'}, {...answer,id:'last',text:'结束'}];
  const view=await render(page(items,{timeline:{items,nextCursor:'older',loading:false}}));
  await fireEvent.press(view.getByLabelText('更多'));
  await fireEvent.press(view.getByLabelText('搜索对话'));
  await fireEvent.changeText(view.getByLabelText('搜索这个对话'),'检查');
  expect(view.getByText('1/2')).toBeTruthy();expect(view.getByText('搜索已加载的消息 · 加载更早记录可继续查找')).toBeTruthy();
  expect(mockScrollToIndex).toHaveBeenLastCalledWith({index:0,viewPosition:.25,animated:true});
  await fireEvent.press(view.getByLabelText('下一个'));expect(view.getByText('2/2')).toBeTruthy();
  expect(mockScrollToIndex).toHaveBeenLastCalledWith({index:1,viewPosition:.25,animated:true});
  await fireEvent.press(view.getByLabelText('下一个'));expect(view.getByText('1/2')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('上一个'));expect(view.getByText('2/2')).toBeTruthy();
  expect(mockBlockRow.mock.calls.some(([props])=>props.searchQuery==='检查')).toBe(true);
  await view.rerender(page(items,{profile:{...base.profile,api:{...base.profile.api,accountId:'other-api'}}}));
  expect(view.queryByLabelText('搜索这个对话')).toBeNull();await view.unmount();
});

const screenshot:AttachmentRef={id:`att_${'a'.repeat(32)}`,mime:'image/png'};
function computerFrame(ref:AttachmentRef):TimelineItem {
  return {kind:'tool',id:'computer-frame',tool:'mcp',title:'返回截图',status:'done',turnId:'turn',ts:2000,computer:{version:1,surface:'computer',action:'screenshot',provider:'cua_repl'},attachments:[ref]};
}
type ScreenshotWorkspaceProps=Required<Pick<React.ComponentProps<typeof RemoteSidebar>,'toolActivities'|'onComputerUseAttachment'>>;
function screenshotWorkspace():ScreenshotWorkspaceProps{
  const find=(node:React.ReactNode):React.ComponentProps<typeof RemoteSidebar>|undefined=>{
    for(const child of React.Children.toArray(node)){
      if(!React.isValidElement<{children?:React.ReactNode;mode?:string}>(child))continue;
      if(child.type===RemoteSidebar&&child.props.mode==='tools')return child.props as React.ComponentProps<typeof RemoteSidebar>;
      const nested=find(child.props.children);if(nested)return nested;
    }
  };
  const sidebar=find(mockFrame.mock.calls.at(-1)![0].workspace);
  if(!sidebar?.toolActivities||!sidebar.onComputerUseAttachment)throw new Error('The tools workspace must contain its actual RemoteSidebar screenshot props');
  return {toolActivities:sidebar.toolActivities,onComputerUseAttachment:sidebar.onComputerUseAttachment};
}
function displayedScreenshot(){const image=screenshotWorkspace().toolActivities.find(item=>item.id==='computer-frame')?.attachments?.[0];if(!image)throw new Error('The screenshot activity must expose its attachment');return image;}
async function requestScreenshot(ref:AttachmentRef){await act(async()=>{screenshotWorkspace().onComputerUseAttachment(ref);});}

test('a failed Direct screenshot can be explicitly retried and the successful bytes replace its placeholder',async()=>{
  const cache=jest.mocked(cachedAttachment);cache.mockRejectedValueOnce(new Error('temporary 503')).mockResolvedValueOnce('file:///screenshots/recovered.png');
  const view=await render(page([computerFrame(screenshot)]));
  await requestScreenshot(screenshot);expect(cache).toHaveBeenCalledTimes(1);expect(displayedScreenshot().uri).toBeUndefined();
  await requestScreenshot(screenshot);await waitFor(()=>expect(displayedScreenshot().uri).toBe('file:///screenshots/recovered.png'));expect(cache).toHaveBeenCalledTimes(2);
  expect(cache.mock.calls[1][0]).toBe(`pairing\u0000${JSON.stringify(['pc','codex:main'])}`);
  await requestScreenshot(screenshot);expect(cache).toHaveBeenCalledTimes(2);await view.unmount();
});

test('Direct screenshot metadata changes cannot reuse an earlier URI for the same attachment ID',async()=>{
  const cache=jest.mocked(cachedAttachment);cache.mockResolvedValueOnce('file:///screenshots/original.png').mockResolvedValueOnce('file:///screenshots/size-confirmed.png').mockResolvedValueOnce('file:///screenshots/new-mime.webp');
  const view=await render(page([computerFrame(screenshot)]));await requestScreenshot(screenshot);
  await waitFor(()=>expect(displayedScreenshot().uri).toBe('file:///screenshots/original.png'));
  const sized={...screenshot,size:4321};await view.rerender(page([computerFrame(sized)]));expect(displayedScreenshot().uri).toBeUndefined();
  await requestScreenshot(sized);await waitFor(()=>expect(displayedScreenshot().uri).toBe('file:///screenshots/size-confirmed.png'));
  const typed={...sized,mime:'image/webp'};await view.rerender(page([computerFrame(typed)]));expect(displayedScreenshot().uri).toBeUndefined();
  await requestScreenshot(typed);await waitFor(()=>expect(displayedScreenshot().uri).toBe('file:///screenshots/new-mime.webp'));
  expect(cache.mock.calls.map(call=>call[1])).toEqual([screenshot,sized,typed]);await view.unmount();
});

test('late Direct screenshot results cannot enter a replacement session or a later connection generation',async()=>{
  for(const change of ['session','generation','disconnect'] as const){
    mockGeneration=1;mockConnectionStatus='connected';const cache=jest.mocked(cachedAttachment);cache.mockReset();
    let complete!:(uri:string)=>void;cache.mockImplementationOnce(()=>new Promise<string>(resolve=>{complete=resolve;}));
    const view=await render(page([computerFrame(screenshot)]));await requestScreenshot(screenshot);
    const priorRead=screenshotWorkspace().onComputerUseAttachment,priorSignal=cache.mock.calls[0][3];
    if(change==='session')await view.rerender(page([computerFrame(screenshot)],{session:{...base.session,sessionKey:'codex:replacement'}}));
    else if(change==='generation')mockGeneration=2;
    else mockConnectionStatus='disconnected';
    await act(async()=>complete(`file:///screenshots/stale-${change}.png`));expect(displayedScreenshot().uri).toBeUndefined();
    if(change==='session')expect(priorSignal?.aborted).toBe(true);
    await act(async()=>priorRead({...screenshot,id:`att_${'b'.repeat(32)}`}));expect(cache).toHaveBeenCalledTimes(1);
    if(change==='generation')await view.rerender(page([computerFrame(screenshot)]));
    if(change!=='disconnect'){
      cache.mockResolvedValueOnce(`file:///screenshots/current-${change}.png`);await requestScreenshot(screenshot);
      await waitFor(()=>expect(displayedScreenshot().uri).toBe(`file:///screenshots/current-${change}.png`));expect(cache).toHaveBeenCalledTimes(2);
    }
    await view.unmount();
  }
});
