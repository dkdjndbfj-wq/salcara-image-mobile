import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { BlockRow } from '../remote/thread-rows';
import { SkillComposerInput } from '../remote/SkillComposerInput';
import { setAppearancePreference } from '../theme';
import { restoreSkillMentions } from '../remote/skill-mentions';
import type { TimelineItem } from '../remote/store';

const mockCopy = jest.fn();
jest.mock('../remote/thread-extras', () => ({ ...jest.requireActual('../remote/thread-extras'), copyUserMessage: (text: string) => mockCopy(text) }));
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
beforeEach(() => { mockCopy.mockClear(); setAppearancePreference('light'); });
const skill = { name: 'review', path: '/fixture/review/SKILL.md' };
const item: Extract<TimelineItem, { kind: 'message' }> = { kind: 'message', id: 'fixture', role: 'user', text: '保留普通 $review /review', skills: [skill], ts: 1, final: true };

test.each(['codex', 'claude'] as const)('%s sent skill names share the composer accent in both themes without recoloring literal text', async tool => {
  const view = await render(<BlockRow block={{ type: 'user', id: item.id, item }} tool={tool} onOpenChild={jest.fn()} />);
  expect(view.getAllByTestId('remote-message-skill')).toHaveLength(1);
  expect(view.getByTestId('remote-message-skill')).toHaveStyle({ color: '#2E82D2', fontWeight: '500' });
  expect(view.getByLabelText('技能 review，/fixture/review/SKILL.md')).toBeTruthy();
  await act(() => setAppearancePreference('dark'));
  expect(view.getByTestId('remote-message-skill')).toHaveStyle({ color: '#A7D1F9' });
  await fireEvent.press(view.getByRole('button', { name: '复制消息' }));
  expect(mockCopy).toHaveBeenCalledWith(item.text);
});

test('a skill-only message remains visible, ordinary and assistant text never acquire skill labels', async () => {
  const view = await render(<BlockRow block={{ type: 'user', id: item.id, item: { ...item, text: '' } }} tool="codex" onOpenChild={jest.fn()} />);
  expect(view.getByTestId('remote-message-skill')).toBeTruthy();
  expect(view.queryByRole('button', { name: '复制消息' })).toBeNull();
  await view.rerender(<BlockRow block={{ type: 'user', id: item.id, item: { ...item, skills: undefined } }} tool="codex" onOpenChild={jest.fn()} />);
  expect(view.queryByTestId('remote-message-skill')).toBeNull();
  expect(view.getByText(item.text)).toBeTruthy();
});

test('a reference-only sent message displays and expands the exact snapshot', async () => {
  const reference = { kind: 'file' as const, projectPath: 'C:/fixture', label: 'main.ts', path: 'main.ts', text: 'const selected = 1;', capturedAt: 1, startLine: 7, endLine: 7 };
  const view = await render(<BlockRow block={{ type: 'user', id: item.id, item: { ...item, text: '', skills: undefined, contextReferences: [reference] } }} tool="codex" onOpenChild={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('查看引用 main.ts'));
  expect(view.getByText(reference.text)).toBeTruthy();
});

test('native named spans map selections and atomic deletion back to the canonical draft', async () => {
  const state = restoreSkillMentions('继续', [skill]), edit = jest.fn(), selection = jest.fn();
  const view = await render(<SkillComposerInput accessibilityLabel="编辑消息" value={state.text} mentions={state.mentions}
    selection={{ start: 8, end: 8 }} onSkillEdit={edit} onSelectionChange={selection} />);
  expect(view.getByText('review')).toHaveStyle({ color: '#2E82D2' });
  const input = view.getByLabelText('编辑消息');
  expect(input.props.selection).toEqual({ start: 7, end: 7 });
  await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 7, end: 9 } } });
  expect(selection.mock.calls[0][0].nativeEvent.selection).toEqual({ start: 8, end: 10 });
  await fireEvent.changeText(input, 'revie 继续');
  expect(edit).toHaveBeenCalledWith({ text: ' 继续', mentions: [], caret: 0 });
});
