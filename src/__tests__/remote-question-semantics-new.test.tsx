import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { QuestionCard } from '../remote/QuestionCard';
import { questionValidation } from '../remote/questions';
import type { RemoteQuestion } from '../remote/client';

jest.mock('../components/ui', () => {
  const React = require('react'); const { Pressable, Text } = require('react-native');
  return { PrimaryButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) =>
    React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: label, disabled, onPress }, React.createElement(Text, null, label)) };
});
const textQuestion: RemoteQuestion = { id: 'value', header: '文字', question: '填写文字', inputType: 'text', required: true, preserveWhitespace: true, allowEmpty: true };
const mount = async (question: RemoteQuestion = textQuestion, initialAnswers?: Record<string, string[]>) => {
  const onAnswer = jest.fn();
  const view = await render(<QuestionCard id="request" title="需要回答" questions={[question]} busy={false} onAnswer={onAnswer} onCancel={jest.fn()} initialAnswers={initialAnswers} />);
  return { view, onAnswer };
};

test.each(['  padded  ', '\n  code\n  ', '   ', ''])('MCP text preserves the exact submitted value %p', async value => {
  const { view, onAnswer } = await mount();
  await fireEvent.changeText(view.getByLabelText('文字：回答'), value);
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(onAnswer).toHaveBeenCalledWith({ value: [value] });
});

test('required MCP string accepts a present empty value but rejects an absent property', async () => {
  expect(questionValidation([textQuestion], {})).toBeTruthy();
  expect(questionValidation([textQuestion], { value: [] })).toBeTruthy();
  expect(questionValidation([textQuestion], { value: [''] })).toBeNull();
  const { view, onAnswer } = await mount();
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(onAnswer).toHaveBeenCalledWith({ value: [''] });
});

test('an untouched optional property stays absent, while explicitly cleared text stays present', async () => {
  const { view, onAnswer } = await mount({ ...textQuestion, required: false });
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(onAnswer).toHaveBeenLastCalledWith({ value: [] });
  await fireEvent.changeText(view.getByLabelText('文字：回答'), 'temporary');
  await fireEvent.changeText(view.getByLabelText('文字：回答'), '');
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(onAnswer).toHaveBeenLastCalledWith({ value: [''] });
});

test('restoring a submitted optional empty value does not turn it into an absent answer', async () => {
  const { view, onAnswer } = await mount({ ...textQuestion, required: false }, { value: [''] });
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(onAnswer).toHaveBeenCalledWith({ value: [''] });
});

test('ordinary tool questions retain trim and required nonblank compatibility', async () => {
  const { view, onAnswer } = await mount({ ...textQuestion, preserveWhitespace: false, allowEmpty: false });
  await fireEvent.changeText(view.getByLabelText('文字：回答'), '   ');
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(onAnswer).not.toHaveBeenCalled();
  await fireEvent.changeText(view.getByLabelText('文字：回答'), '  tool answer  ');
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(onAnswer).toHaveBeenCalledWith({ value: ['tool answer'] });
});

test('an empty MCP enum option remains its real value rather than its display caption', async () => {
  const { view, onAnswer } = await mount({ ...textQuestion, inputType: 'enum', options: [{ label: '', description: '空值' }, { label: 'other' }] });
  await fireEvent.press(view.getByText('空值'));
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(onAnswer).toHaveBeenCalledWith({ value: [''] });
  expect(questionValidation([{ ...textQuestion, inputType: 'enum', options: [{ label: '' }] }], { value: ['not-an-option'] })).toBeTruthy();
});

test('late persisted answers restore an unedited same question without stripping whitespace', async () => {
  const onAnswer = jest.fn();
  const props = { id: 'restoring', title: '需要回答', questions: [textQuestion], busy: false, onAnswer, onCancel: jest.fn() };
  const view = await render(<QuestionCard {...props} />);
  await view.rerender(<QuestionCard {...props} initialAnswers={{ value: ['  original  '] }} />);
  expect(view.getByLabelText('文字：回答').props.value).toBe('  original  ');
  await fireEvent.press(view.getByLabelText('提交回答'));
  expect(onAnswer).toHaveBeenCalledWith({ value: ['  original  '] });
});

test('late persisted answers do not overwrite user edits but a new question resets the edit guard', async () => {
  const props = { id: 'editing', title: '需要回答', questions: [textQuestion], busy: false, onAnswer: jest.fn(), onCancel: jest.fn() };
  const view = await render(<QuestionCard {...props} />);
  await fireEvent.changeText(view.getByLabelText('文字：回答'), 'my draft');
  await view.rerender(<QuestionCard {...props} initialAnswers={{ value: ['old receipt'] }} />);
  expect(view.getByLabelText('文字：回答').props.value).toBe('my draft');
  await view.rerender(<QuestionCard {...props} id="new-question" initialAnswers={{ value: ['new receipt'] }} />);
  expect(view.getByLabelText('文字：回答').props.value).toBe('new receipt');
});
