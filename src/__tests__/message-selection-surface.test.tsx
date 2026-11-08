import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import { MessageSelectionSurface } from '../components/MessageSelectionSurface';
import { validSelection, type SelectionSnapshot } from '../components/message-text-selection';
import { selectionToolbarLeft } from '../components/message-selection-dom';

jest.mock('../components/message-selection-native', () => {
  const listeners = new Set<Function>();
  return { nativeMessageSelection: {
    attach: jest.fn(async () => true), detach: jest.fn(async () => undefined), highlight: jest.fn(async () => true),
    addListener: jest.fn((_name: string, listener: Function) => { listeners.add(listener); return { remove: () => listeners.delete(listener) }; }),
    emit: (event: unknown) => listeners.forEach(listener => listener(event)),
  } };
});
jest.mock('../components/ui', () => ({
  Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? children : null,
}));
jest.mock('../theme', () => ({ useDesk: () => ({ text: '#111111', muted: '#666666' }) }));
jest.mock('react-native', () => {
  const descriptors = Object.getOwnPropertyDescriptors(jest.requireActual('react-native'));
  descriptors.findNodeHandle = { enumerable: true, configurable: true, value: () => 42 };
  return Object.defineProperties({}, descriptors);
});
const native = jest.requireMock('../components/message-selection-native').nativeMessageSelection;
const token = () => native.attach.mock.calls.at(-1)[1];
const snapshot = (extra: Partial<SelectionSnapshot> = {}): SelectionSnapshot => ({ action: 'add', text: '重复🙂', start: 5, end: 9, blockIndex: 0, renderedText: '重复🙂 重复🙂', ...extra });
beforeEach(() => { native.attach.mockClear(); native.detach.mockClear(); native.highlight.mockClear(); Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' }); });

test('keeps the exact repeated-text occurrence and UTF-16 emoji offsets; rejects split surrogates', () => {
  expect(validSelection(snapshot(), '重复🙂 重复🙂', 'source', false)).toBe(true);
  expect(validSelection(snapshot({ start: 7, end: 8, text: '\uD83D' }), '重复🙂 重复🙂', 'source', false)).toBe(false);
  expect(validSelection(snapshot({ start: 0, end: 4, text: '重复🙂' }), 'different source', 'source', false)).toBe(false);
  expect(validSelection(snapshot({ action: 'ask' }), '重复🙂 重复🙂', 'source', false)).toBe(false);
  expect(validSelection(snapshot({ action: 'ask' }), '重复🙂 重复🙂', 'source', true)).toBe(true);
});

test('selection toolbar remains within a narrow viewport at the right edge', () => {
  expect(selectionToolbarLeft(319, 320, 120)).toBe(192);
  expect(selectionToolbarLeft(319, 320, 300)).toBe(12);
  expect(selectionToolbarLeft(10, 320, 120)).toBe(10);
});

test('native menu emits only validated selected characters from the current scope', async () => {
  const selected = jest.fn();
  const view = await render(<MessageSelectionSurface sourceText="**重复🙂 重复🙂**" scopeKey="codex:a" onSelectText={selected}><Text selectable>重复🙂 重复🙂</Text></MessageSelectionSurface>);
  await fireEvent(view.getByTestId('message-selection-surface'), 'layout');
  const first = token();
  await act(() => native.emit({ token: first, ...snapshot() }));
  expect(selected).toHaveBeenLastCalledWith({ action: 'add', text: '重复🙂', start: 5, end: 9, blockIndex: 0, textBasis: 'rendered', sourceText: '**重复🙂 重复🙂**' });
  selected.mockClear();
  await act(() => native.emit({ token: first, ...snapshot({ text: 'different' }) }));
  await act(() => native.emit({ token: first, ...snapshot({ action: 'ask' }) }));
  expect(selected).not.toHaveBeenCalled();
  await view.rerender(<MessageSelectionSurface sourceText="**重复🙂 重复🙂**" scopeKey="claude:b" onSelectText={selected}><Text selectable>重复🙂 重复🙂</Text></MessageSelectionSurface>);
  await fireEvent(view.getByTestId('message-selection-surface'), 'layout');
  expect(token()).not.toBe(first);
  await act(() => native.emit({ token: first, ...snapshot() }));
  expect(selected).not.toHaveBeenCalled();
});

test('source updates, backgrounding, and unmounting discard queued native selections', async () => {
  const selected = jest.fn();
  const view = await render(<MessageSelectionSurface sourceText="old" scopeKey="a" onSelectText={selected}><Text selectable>old</Text></MessageSelectionSurface>);
  await fireEvent(view.getByTestId('message-selection-surface'), 'layout');
  const oldToken = token(), savedListener = native.addListener.mock.calls.at(-1)[1];
  await view.rerender(<MessageSelectionSurface sourceText="new" scopeKey="a" onSelectText={selected}><Text selectable>new</Text></MessageSelectionSurface>);
  await fireEvent(view.getByTestId('message-selection-surface'), 'layout');
  await act(() => savedListener({ token: oldToken, action: 'add', text: 'old', renderedText: 'old', start: 0, end: 3, blockIndex: 0 }));
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
  await act(() => native.emit({ token: token(), action: 'add', text: 'new', renderedText: 'new', start: 0, end: 3, blockIndex: 0 }));
  const lastListener = native.addListener.mock.calls.at(-1)[1], lastToken = token();
  await view.unmount();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  await act(() => lastListener({ token: lastToken, action: 'add', text: 'new', renderedText: 'new', start: 0, end: 3, blockIndex: 0 }));
  expect(selected).not.toHaveBeenCalled();
  expect(native.detach).toHaveBeenCalledWith(lastToken);
});

test('full-text selection preserves multiline code and stays separate from the rendered block', async () => {
  const source = '第一段🙂\n\n```ts\nconst a = 1;\n```', selected = jest.fn();
  const view = await render(<MessageSelectionSurface sourceText={source} scopeKey="a" onSelectText={selected}><Text selectable>第一段🙂</Text></MessageSelectionSurface>);
  await fireEvent.press(view.getByLabelText('选择文本'));
  const surfaces = view.getAllByTestId('message-selection-surface');
  expect(surfaces).toHaveLength(2);
  await fireEvent(surfaces[1], 'layout');
  await act(() => native.emit({ token: token(), action: 'add', text: source, renderedText: source, start: 0, end: source.length, blockIndex: 0 }));
  expect(selected).toHaveBeenCalledWith({ action: 'add', text: source, start: 0, end: source.length, blockIndex: 0, textBasis: 'source', sourceText: source });
  expect(view.getAllByTestId('message-selection-surface')).toHaveLength(1);
});

test('module-unavailable fallback stays selectable while attempted edits clear the selection and preserve source', async () => {
  const mocked = jest.requireMock('../components/message-selection-native');
  mocked.nativeMessageSelection = null;
  try {
    const selected = jest.fn(), source = '第一段🙂\n第二段';
    const view = await render(<MessageSelectionSurface sourceText={source} scopeKey="a" onSelectText={selected}><Text selectable>{source}</Text></MessageSelectionSurface>);
    await fireEvent.press(view.getByLabelText('选择文本'));
    const input = view.getByLabelText('选择消息正文');
    expect(input.props.editable).not.toBe(false);
    expect(input.props.showSoftInputOnFocus).toBe(false);
    await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: source.length } } });
    expect(view.getByText('添加到对话')).toBeTruthy();
    await fireEvent.changeText(input, 'replacement');
    expect(view.queryByText('添加到对话')).toBeNull();
    expect(view.getByLabelText('选择消息正文').props.value).toBe(source);
    await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: source.length } } });
    await fireEvent.press(view.getByText('添加到对话'));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ text: source, sourceText: source, textBasis: 'source' }));
    await view.unmount();
  } finally { mocked.nativeMessageSelection = native; }
});

test('rendered highlights use exact block offsets and detach when the source scope changes', async () => {
  const selected = jest.fn();
  const highlight = { nonce: 1, textBasis: 'rendered' as const, blockIndex: 2, start: 5, end: 9, text: '重复🙂' };
  const view = await render(<MessageSelectionSurface sourceText="**重复🙂 重复🙂**" scopeKey="a" onSelectText={selected} highlight={highlight}><Text selectable>重复🙂 重复🙂</Text></MessageSelectionSurface>);
  await fireEvent(view.getByTestId('message-selection-surface'), 'layout');
  const first = token();
  expect(native.highlight).toHaveBeenCalledWith(first, 2, 5, 9, '重复🙂');
  await view.rerender(<MessageSelectionSurface sourceText="changed" scopeKey="b" onSelectText={selected}><Text selectable>changed</Text></MessageSelectionSurface>);
  expect(native.detach).toHaveBeenCalledWith(first);
  expect(selected).not.toHaveBeenCalled();
});

test('source highlight opens complete source instead of applying raw offsets to Markdown', async () => {
  const source = '**第一段🙂**\n\n第二段', selected = jest.fn();
  const highlight = { nonce: 2, textBasis: 'source' as const, start: 2, end: 7, text: '第一段🙂' };
  const view = await render(<MessageSelectionSurface sourceText={source} scopeKey="a" onSelectText={selected} highlight={highlight}><Text selectable>第一段🙂</Text></MessageSelectionSurface>);
  const surfaces = view.getAllByTestId('message-selection-surface');
  expect(surfaces).toHaveLength(2);
  await fireEvent(surfaces[1], 'layout');
  expect(native.highlight).toHaveBeenCalledWith(token(), 0, 2, 7, '第一段🙂');
  expect(selected).not.toHaveBeenCalled();
});
