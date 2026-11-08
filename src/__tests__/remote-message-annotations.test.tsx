import React, { useState } from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ContextReferenceChips } from '../remote/ContextReferenceChips';
import { appendContextReference, contextReferenceKey, copyContextReferences, hasResponseAnnotations, validContextReferences, type ContextReference } from '../remote/context-references';
import { messageSourceRevision, selectedMessageReference } from '../remote/message-selection';
import { copyComposerFeatureIntent, type ComposerFeatureIntent } from '../remote/composer-feature-intent';
import { copyTurnFeatures } from '../remote/agent-features';
import { decodeNewTask, encodeNewTask } from '../remote/new-task';

const source = { sessionKey: 'codex:one', id: 'reply', text: '重复😀\n重复😀\n```ts\nconst a = 1;\n```', role: 'assistant' as const };
const selection = { text: '重复😀', start: 5, end: 9, blockIndex: 0, textBasis: 'source' as const, sourceText: source.text };
const reference = (): ContextReference => ({ ...selectedMessageReference(selection, source), annotation: '解释第二处\n保留代码' });

test('selected text retains the exact repeated occurrence and UTF16 range', () => {
  const ref = reference();
  expect(ref.startOffset).toBe(5); expect(ref.endOffset).toBe(9);
  expect(ref.sourceRevision).toBe(messageSourceRevision(source.text));
  expect(validContextReferences([ref])).toBe(true);
  expect(hasResponseAnnotations([ref])).toBe(true);
  expect(() => selectedMessageReference({ ...selection, start: 0 }, source)).toThrow('选区已变化');
  expect(() => selectedMessageReference(selection, { ...source, text: source.text + '新内容' })).toThrow('选区已变化');
});

test('rendered offsets are a different coordinate space and block identity is retained', () => {
  const first = selectedMessageReference({ ...selection, textBasis: 'rendered', start: 0, end: 4, blockIndex: 0 }, source);
  const second = { ...first, blockIndex: 1 };
  expect(contextReferenceKey(first)).not.toBe(contextReferenceKey(second));
  expect(appendContextReference([first], second)).toHaveLength(2);
  expect(contextReferenceKey(first)).not.toBe(contextReferenceKey({ ...first, sourceRevision: 'a'.repeat(64) }));
});

test.each([
  { textBasis: 'other' }, { sourceRevision: undefined }, { sourceRevision: 'x'.repeat(64) },
  { textBasis: 'rendered', blockIndex: undefined }, { textBasis: 'rendered', blockIndex: -1 },
  { textBasis: 'rendered', blockIndex: 100001 }, { blockIndex: 0 }, { annotation: '\u0000' },
  { annotation: '中'.repeat(2731) }, { textBasis: undefined },
])('malformed annotation is rejected: %j', patch => {
  expect(validContextReferences([{ ...reference(), ...patch }])).toBe(false);
});

test('comment bytes contribute to the combined budget and file references reject annotation fields', () => {
  const ref = { ...reference(), startOffset: 0, endOffset: 32768, text: 'x'.repeat(32768), annotation: '' };
  expect(validContextReferences([ref, { ...ref, messageId: 'two' }])).toBe(true);
  expect(validContextReferences([ref, { ...ref, messageId: 'two', annotation: '一' }])).toBe(false);
  const file = { kind: 'file', sessionKey: 'codex:one', label: 'a.ts', path: 'a.ts', startLine: 1, endLine: 1, capturedAt: 1, text: 'code' };
  expect(validContextReferences([{ ...file, annotation: '' }])).toBe(false);
  expect(validContextReferences([{ ...file, textBasis: 'source', sourceRevision: 'a'.repeat(64) }])).toBe(false);
});

test('draft, frozen delivery and a new-task receipt preserve comments without body text', () => {
  const ref = reference();
  const intent: ComposerFeatureIntent = { version: 1, source: { scope: 'station', deviceId: 'pc', tool: 'codex', runtimeId: 'codex', surface: 'cli', apiIdentity: 'api', cwd: '/project' }, contextReferences: [ref] };
  const draft = copyComposerFeatureIntent(intent, ''), send = copyTurnFeatures(draft);
  draft.contextReferences![0].annotation = 'later edit';
  expect(send.contextReferences![0].annotation).toBe(ref.annotation);
  const input = { version: 1 as const, tool: 'codex', cwd: '/project', prompt: '', approval: 'ask' as const, images: [], ...send };
  expect(decodeNewTask(encodeNewTask(input))).toEqual(input);
});

test('annotation count opens exact text, edits comments, navigates and deletes independently', async () => {
  const refs = [reference(), { ...reference(), messageId: 'other', text: '其它文字', startOffset: 0, endOffset: 4 }];
  const navigate = jest.fn(), changed = jest.fn();
  function Harness() {
    const [items, setItems] = useState(refs);
    return <ContextReferenceChips references={items} onNavigate={navigate}
      onAnnotationChange={(index, annotation) => { changed(annotation); setItems(values => values.map((item, i) => i === index ? { ...item, annotation } : item)); }}
      onRemove={index => setItems(values => values.filter((_, i) => i !== index))} />;
  }
  const view = await render(<Harness />);
  await fireEvent.press(view.getByLabelText('查看 2 条注释'));
  expect(view.getByText(selection.text)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('编辑注释 1'));
  await fireEvent.changeText(view.getByLabelText('注释 1 的评论'), '新的评论');
  expect(changed).toHaveBeenLastCalledWith('新的评论');
  await fireEvent.press(view.getByLabelText('完成编辑注释 1'));
  expect(view.getByText('新的评论')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看注释 1 的原消息'));
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ messageId: source.id, startOffset: 5, annotation: '新的评论' }));
  await fireEvent.press(view.getByLabelText('删除注释 1'));
  expect(view.getByLabelText('查看 1 条注释')).toBeTruthy();
  expect(view.queryByText(selection.text)).toBeNull();
  await view.unmount();
});

test('saved sent annotations stay previewable with no edit/remove controls', async () => {
  const refs = copyContextReferences([reference()])!;
  const view = await render(<ContextReferenceChips references={refs} />);
  await fireEvent.press(view.getByLabelText('查看 1 条注释'));
  expect(view.getByText(refs[0].text)).toBeTruthy(); expect(view.getByText(refs[0].annotation!)).toBeTruthy();
  expect(view.queryByLabelText('编辑注释 1')).toBeNull(); expect(view.queryByLabelText('删除注释 1')).toBeNull();
  await view.unmount();
});
