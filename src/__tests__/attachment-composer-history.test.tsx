import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AttachmentComposerInput } from '../remote/AttachmentComposerInput';
import type { PromptHistoryHandle } from '../remote/PromptHistorySheet';
import { joinPastedText, splitPastedText } from '../remote/pasted-text';
import {promptHistory} from '../remote/prompt-history';

const mockToast = jest.fn();
let mockHistorySheet: { onPick: (entry: typeof history[number]) => void };
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => ({ Sheet: ({ visible, children }: any) => visible ? children : null, showToast: (...args: any[]) => mockToast(...args) }));
jest.mock('../theme', () => ({ useDesk: () => ({ text: '#222', muted: '#888', line: '#ddd', surface2: '#eee' }) }));
jest.mock('../remote/SkillComposerInput', () => ({ SkillComposerInput: require('react').forwardRef((props: object, ref: unknown) => require('react').createElement(require('react-native').TextInput, { ...props, ref, testID: 'history-input' })) }));
jest.mock('../remote/PromptHistorySheet', () => {
  const actual = jest.requireActual('../remote/PromptHistorySheet');
  return { ...actual, PromptHistorySheet: (props: any) => { mockHistorySheet = props;return require('react').createElement(actual.PromptHistorySheet, props); } };
});
const history = [{ id: 'latest', text: 'Most recent request', hasImages: true }, { id: 'older', text: 'Previous request', hasImages: false }];
const key = (name: string, extra: object = {}) => ({ nativeEvent: { key: name, ...extra }, preventDefault: jest.fn() });
beforeEach(() => jest.clearAllMocks());

const richHistory=promptHistory([{kind:'message',id:'rich',role:'user',text:'Original input',final:true,ts:1,attachments:[{id:'att_picture',mime:'image/png',width:20,height:20}],skills:[{name:'review',path:'/review'}]}]);
test('rich input invokes full recovery once and never the text-only fallback or send',async()=>{
 const change=jest.fn(),send=jest.fn(),restore=jest.fn(async(_entry:unknown,_signal:AbortSignal)=>true),historyRef={current:undefined as PromptHistoryHandle|undefined};
 const view=await render(<AttachmentComposerInput scopeKey="rich" value="Draft" mentions={[]} history={richHistory} historyRef={historyRef} onRestoreHistory={restore} onChangeText={change} onSubmitEditing={send}/>);
 await act(async()=>historyRef.current!.open());await fireEvent.press(view.getByLabelText('复用输入 rich'));expect(restore).toHaveBeenCalledTimes(1);expect(restore.mock.calls[0][0]).toEqual(richHistory[0]);expect(change).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(view.queryByLabelText('复用输入 rich')).toBeNull();
});
test('ArrowUp with images opens the chooser rather than dropping original images',async()=>{
 const change=jest.fn(),restore=jest.fn(async()=>true),view=await render(<AttachmentComposerInput scopeKey="rich-key" value="" mentions={[]} history={richHistory} onRestoreHistory={restore} onChangeText={change}/>);
 await fireEvent(view.getByTestId('history-input'),'keyPress',key('ArrowUp'));expect(view.getByLabelText('复用输入 rich')).toBeTruthy();expect(change).not.toHaveBeenCalled();expect(restore).not.toHaveBeenCalled();
});
test('failed complete recovery leaves the existing draft untouched and offers retry',async()=>{
 const change=jest.fn(),restore=jest.fn(async()=>{throw new Error('Original image unavailable');}),historyRef={current:undefined as PromptHistoryHandle|undefined};
 const view=await render(<AttachmentComposerInput scopeKey="rich-fail" value="Keep draft" mentions={[]} history={richHistory} historyRef={historyRef} onRestoreHistory={restore} onChangeText={change}/>);
 await act(async()=>historyRef.current!.open());await fireEvent.press(view.getByLabelText('复用输入 rich'));expect(view.getByText('Original image unavailable')).toBeTruthy();expect(change).not.toHaveBeenCalled();expect(view.getByTestId('history-input').props.value).toBe('Keep draft');
});
test('leaving the source aborts its pending history recovery',async()=>{
 let finish!:(value:boolean)=>void;const restore=jest.fn((_entry:unknown,_signal:AbortSignal)=>new Promise<boolean>(resolve=>{finish=resolve;})),historyRef={current:undefined as PromptHistoryHandle|undefined};
 const props={value:'',mentions:[],history:richHistory,historyRef,onRestoreHistory:restore};
 const view=await render(<AttachmentComposerInput {...props} scopeKey="first"/>);await act(async()=>historyRef.current!.open());await fireEvent.press(view.getByLabelText('复用输入 rich'));
 const signal=restore.mock.calls[0][1];await view.rerender(<AttachmentComposerInput {...props} scopeKey="second"/>);expect(signal.aborted).toBe(true);await act(async()=>finish(true));expect(view.queryByLabelText('复用输入 rich')).toBeNull();
});

test('arrow history starts only from an empty input and returns to empty without sending', async () => {
  const change = jest.fn(), submit = jest.fn(), keyboard = jest.fn();
  const props = { scopeKey: 'pc-a/session-a/api-a', mentions: [], history, onChangeText: change, onSubmitEditing: submit, onKeyPress: keyboard };
  const view = await render(<AttachmentComposerInput {...props} value="" />);
  const first = key('ArrowUp');await fireEvent(view.getByTestId('history-input'), 'keyPress', first);
  expect(change).toHaveBeenLastCalledWith(history[0].text);expect(first.preventDefault).toHaveBeenCalledTimes(1);
  await view.rerender(<AttachmentComposerInput {...props} value={history[0].text} />);
  await fireEvent(view.getByTestId('history-input'), 'keyPress', key('ArrowUp'));expect(change).toHaveBeenLastCalledWith(history[1].text);
  await view.rerender(<AttachmentComposerInput {...props} value={history[1].text} />);
  await fireEvent(view.getByTestId('history-input'), 'keyPress', key('ArrowDown'));expect(change).toHaveBeenLastCalledWith(history[0].text);
  await view.rerender(<AttachmentComposerInput {...props} value={history[0].text} />);
  await fireEvent(view.getByTestId('history-input'), 'keyPress', key('ArrowDown'));expect(change).toHaveBeenLastCalledWith('');
  expect(submit).not.toHaveBeenCalled();expect(keyboard).not.toHaveBeenCalled();
});

test.each([{ isComposing: true }, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }])('history leaves IME and modified arrow events to the input: %o', async extra => {
  const change = jest.fn(), keyboard = jest.fn(), event = key('ArrowUp', extra);
  const view = await render(<AttachmentComposerInput scopeKey="pc-a/session" value="" mentions={[]} history={history} onChangeText={change} onKeyPress={keyboard} />);
  await fireEvent(view.getByTestId('history-input'), 'keyPress', event);
  expect(change).not.toHaveBeenCalled();expect(keyboard).toHaveBeenCalledWith(event);expect(event.preventDefault).not.toHaveBeenCalled();
});

test('keyboard history never replaces an existing draft or resumes after a manual edit', async () => {
  const change = jest.fn(), props = { scopeKey: 'pc-a/session', mentions: [], history, onChangeText: change };
  const view = await render(<AttachmentComposerInput {...props} value="Unsent draft" />);
  await fireEvent(view.getByTestId('history-input'), 'keyPress', key('ArrowUp'));expect(change).not.toHaveBeenCalled();
  await view.rerender(<AttachmentComposerInput {...props} value="" />);
  await fireEvent(view.getByTestId('history-input'), 'keyPress', key('ArrowUp'));
  await view.rerender(<AttachmentComposerInput {...props} value={history[0].text} />);
  await fireEvent.changeText(view.getByTestId('history-input'), 'Edited recalled request');
  await view.rerender(<AttachmentComposerInput {...props} value="Edited recalled request" />);change.mockClear();
  await fireEvent(view.getByTestId('history-input'), 'keyPress', key('ArrowDown'));expect(change).not.toHaveBeenCalled();
});

test('explicit history appends to an existing draft and warns that old images must be added again', async () => {
  const change = jest.fn(), submit = jest.fn(), historyRef = { current: undefined as PromptHistoryHandle | undefined };
  const view = await render(<AttachmentComposerInput scopeKey="pc-a/session" value="Existing draft" mentions={[]} history={history} historyRef={historyRef} onChangeText={change} onSubmitEditing={submit} />);
  await act(async () => historyRef.current!.open());expect(view.getByText('原消息含图片，需要重新添加')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('复用输入 latest'));
  expect(change).toHaveBeenCalledWith('Existing draft\n\nMost recent request');expect(submit).not.toHaveBeenCalled();
});

test('reusing history preserves existing text attachment chips and the exact attachment body', async () => {
  const body = 'Keep these bytes\n🙂\r\n', value = joinPastedText('Existing prompt', [{ name: 'keep.ts', text: body }]);
  const change = jest.fn(), historyRef = { current: undefined as PromptHistoryHandle | undefined };
  const view = await render(<AttachmentComposerInput scopeKey="pc-a/session" value={value} mentions={[]} history={history} historyRef={historyRef} onChangeText={change} />);
  await act(async () => historyRef.current!.open());await fireEvent.press(view.getByLabelText('复用输入 latest'));
  expect(splitPastedText(change.mock.calls[0][0])).toEqual({ prompt: 'Existing prompt\n\nMost recent request', attachments: [{ name: 'keep.ts', text: body }] });
});

test('history attachment names stay distinct and exceeding the attachment limit leaves the draft intact', async () => {
  const change = jest.fn(), historyRef = { current: undefined as PromptHistoryHandle | undefined };
  const incoming = [{ id: 'file', text: joinPastedText('Recalled prompt', [{ name: 'same.ts', text: 'recalled bytes' }]), hasImages: false }];
  const props = { scopeKey: 'pc-a/session', mentions: [], history: incoming, historyRef, onChangeText: change };
  const view = await render(<AttachmentComposerInput {...props} value={joinPastedText('Current prompt', [{ name: 'same.ts', text: 'current bytes' }])} />);
  await act(async () => historyRef.current!.open());await fireEvent.press(view.getByLabelText('复用输入 file'));
  expect(splitPastedText(change.mock.calls[0][0])).toEqual({ prompt: 'Current prompt\n\nRecalled prompt', attachments: [{ name: 'same.ts', text: 'current bytes' }, { name: 'same.ts (2)', text: 'recalled bytes' }] });
  const fullDraft = joinPastedText('Current prompt', Array.from({ length: 8 }, (_, index) => ({ name: `${index}.ts`, text: `${index}` })));
  await view.rerender(<AttachmentComposerInput {...props} value={fullDraft} />);change.mockClear();
  await act(async () => historyRef.current!.open());await fireEvent.press(view.getByLabelText('复用输入 file'));
  expect(change).not.toHaveBeenCalled();expect(mockToast).toHaveBeenCalled();
});

test('old history handles and callbacks cannot apply after computer, session or API scope changes', async () => {
  const change = jest.fn(), historyRef = { current: undefined as PromptHistoryHandle | undefined };
  const props = { value: '', mentions: [], history, historyRef, onChangeText: change };
  const view = await render(<AttachmentComposerInput {...props} scopeKey="pc-a/session-a/api-a" />);
  const oldHandle = historyRef.current!, oldKey = view.getByTestId('history-input').props.onKeyPress;
  await act(async () => oldHandle.open());const oldPick = mockHistorySheet.onPick;
  await view.rerender(<AttachmentComposerInput {...props} scopeKey="pc-b/session-b/api-b" />);
  await act(async () => { oldHandle.open();oldKey(key('ArrowUp'));oldPick(history[0]); });
  expect(change).not.toHaveBeenCalled();expect(view.queryByLabelText('复用输入 latest')).toBeNull();
  await view.unmount();expect(historyRef.current).toBeUndefined();
});

test.each(['scope-return','hide-return'] as const)('history handles and input callbacks from before %s remain retired',async changeKind=>{
  const change=jest.fn(),shortcut=jest.fn(),historyRef={current:undefined as PromptHistoryHandle|undefined};
  const props={scopeKey:'pc-a/session',value:'',mentions:[],history,historyRef,onChangeText:change,onKeyPress:shortcut};
  const view=await render(<AttachmentComposerInput {...props}/>);
  const oldHandle=historyRef.current!,oldInput=view.getByTestId('history-input').props;
  await act(async()=>oldHandle.open());const oldPick=mockHistorySheet.onPick;
  await view.rerender(<AttachmentComposerInput {...props} scopeKey={changeKind==='scope-return'?'pc-b/session':props.scopeKey} active={changeKind!=='hide-return'}/>);
  await view.rerender(<AttachmentComposerInput {...props}/>);
  await act(async()=>{oldHandle.open();oldPick(history[0]);oldInput.onChangeText('旧会话迟到输入');oldInput.onKeyPress(key('ArrowUp'));});
  expect(change).not.toHaveBeenCalled();expect(shortcut).not.toHaveBeenCalled();expect(view.queryByLabelText('复用输入 latest')).toBeNull();
  await act(async()=>historyRef.current!.open());await fireEvent.press(view.getByLabelText('复用输入 latest'));
  expect(change).toHaveBeenCalledWith(history[0].text);
});

test('inactive input is readonly and ignores late typing but a temporary send lock preserves the active draft',async()=>{
  const change=jest.fn(),props={scopeKey:'pc-a/session',value:'draft',mentions:[],onChangeText:change};
  const view=await render(<AttachmentComposerInput {...props} active={false}/>);
  expect(view.getByTestId('history-input').props.editable).toBe(false);
  await act(async()=>view.getByTestId('history-input').props.onChangeText('late inactive'));expect(change).not.toHaveBeenCalled();
  await view.rerender(<AttachmentComposerInput {...props}/>);
  const queuedChange=view.getByTestId('history-input').props.onChangeText;
  await view.rerender(<AttachmentComposerInput {...props} editable={false}/>);
  await act(async()=>queuedChange('draft last key'));expect(change).toHaveBeenLastCalledWith('draft last key');
  change.mockClear();await view.unmount();
  await act(async()=>queuedChange('late unmounted'));expect(change).not.toHaveBeenCalled();
});

test('locked and inactive composers cannot open history and oversized recalls retain the draft', async () => {
  const change = jest.fn(), historyRef = { current: undefined as PromptHistoryHandle | undefined };
  const props = { scopeKey: 'pc-a/session', value: '', mentions: [], history, historyRef, onChangeText: change };
  const view = await render(<AttachmentComposerInput {...props} editable={false} />);
  await act(async () => historyRef.current!.open());expect(view.queryByLabelText('复用输入 latest')).toBeNull();
  await view.rerender(<AttachmentComposerInput {...props} active={false} />);
  await act(async () => historyRef.current!.open());expect(view.queryByLabelText('复用输入 latest')).toBeNull();
  await view.rerender(<AttachmentComposerInput {...props} maxLength={5} />);
  await fireEvent(view.getByTestId('history-input'), 'keyPress', key('ArrowUp'));expect(change).not.toHaveBeenCalled();expect(mockToast).toHaveBeenCalled();
});
