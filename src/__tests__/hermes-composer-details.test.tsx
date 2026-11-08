import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { AttachmentComposerInput } from '../remote/AttachmentComposerInput';
import { currentTaskPlan, TaskProgressDock } from '../remote/TaskProgressDock';
import { joinPastedText, splitPastedText, nextPastedText } from '../remote/pasted-text';
import type { TimelineItem } from '../remote/store';
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../remote/SkillComposerInput', () => ({ SkillComposerInput: require('react').forwardRef((props: object, ref: unknown) => require('react').createElement(require('react-native').TextInput, { ...props, ref, testID: 'attachment-input' })) }));

test('text attachments round-trip arbitrary delimiters, Unicode and whitespace and remain readable to older clients', () => {
  const body = '  你好🙂\n[文本附件结束]\n\n[文本附件：粘贴内容-2.txt；字符数：4]\nbody\n  ';
  const attachments = [nextPastedText(body, [])], value = joinPastedText('请分析', attachments);
  expect(splitPastedText(value)).toEqual({ prompt: '请分析', attachments });
  expect(value).toContain(body);
  expect(splitPastedText(joinPastedText('', attachments))).toEqual({ prompt: '', attachments });
  expect(splitPastedText(value.slice(0, -1))).toEqual({ prompt: value.slice(0, -1), attachments: [] });
});
test('large native paste becomes a previewable attachment while edits preserve its exact bytes', async () => {
  const body = '代码\n'.repeat(1001), change = jest.fn();
  const view = await render(<AttachmentComposerInput scopeKey="pc:a" value="分析：" mentions={[]} onChangeText={change} />);
  await fireEvent.changeText(view.getByTestId('attachment-input'), '分析：' + body);
  const saved = change.mock.calls[0][0] as string;
  expect(splitPastedText(saved)).toEqual({ prompt: '分析：', attachments: [{ name: '粘贴内容-1.txt', text: body }] });
  await view.rerender(<AttachmentComposerInput scopeKey="pc:a" value={saved} mentions={[]} onChangeText={change} />);
  expect(view.getByTestId('attachment-input').props.value).toBe('分析：');
  await fireEvent.press(view.getByLabelText('预览文本附件 粘贴内容-1.txt'));
  expect(view.getByText(body)).toBeTruthy();
  await fireEvent.press(view.getByLabelText('将文本附件转回正文'));
  expect(change).toHaveBeenLastCalledWith('分析：\n\n' + body);
});
test('a web paste replaces the selection and does not remove the rest of the instruction', async () => {
  const change = jest.fn(), body = 'X'.repeat(3001);
  const view = await render(<AttachmentComposerInput scopeKey="pc:a" value="before selected after" mentions={[]} onChangeText={change} />);
  await fireEvent(view.getByTestId('attachment-input'), 'pasteText', body, 7, 15);
  expect(splitPastedText(change.mock.calls[0][0])).toEqual({ prompt: 'before  after', attachments: [{ name: '粘贴内容-1.txt', text: body }] });
});
const turn = (id: string, status: 'started' | 'completed'): TimelineItem => ({ kind: 'turn', id, turnId: id, status, ts: 1 });
const plan: TimelineItem = { kind: 'tool', tool: 'plan', id: 'plan', turnId: 'live', title: '任务', status: 'done', output: '✓ 读取\n▸ 修改\n○ 验证', ts: 2 };
test('task progress excludes completed turns, older turns and child-agent plans', () => {
  expect(currentTaskPlan([turn('live', 'completed'), plan], 'live')).toBeUndefined();
  expect(currentTaskPlan([plan, turn('next', 'started')], 'next')).toBeUndefined();
  expect(currentTaskPlan([turn('live', 'started'), { ...plan, parentId: 'child' }], 'live')).toBeUndefined();
});
test('task progress expands inside a bounded list and disappears when the task ends', async () => {
  const items = [turn('live', 'started'), plan];
  const view = await render(<TaskProgressDock items={items} activeTurnId="live" running scopeKey="pc:a" />);
  expect(view.queryByText('验证')).toBeNull();
  await fireEvent.press(view.getByLabelText('展开当前任务进度'));
  expect(view.getByText('验证')).toBeTruthy();
  await view.rerender(<TaskProgressDock items={items} activeTurnId="live" running={false} scopeKey="pc:a" />);
  expect(view.queryByTestId('task-progress-dock')).toBeNull();
});
