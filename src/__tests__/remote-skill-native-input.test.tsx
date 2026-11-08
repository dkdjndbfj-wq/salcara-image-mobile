import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { SkillComposerInput } from '../remote/SkillComposerInput';
import { restoreSkillMentions } from '../remote/skill-mentions';
import {StyleSheet} from 'react-native';

jest.mock('../remote/skill-input-native', () => ({ nativeSkillInput: { setMentions: jest.fn(async () => ({ height: 42 })) } }));
jest.mock('../theme', () => ({ useScheme: () => 'light' }));
jest.mock('react-native', () => {
  const descriptors = Object.getOwnPropertyDescriptors(jest.requireActual('react-native'));
  descriptors.findNodeHandle = { enumerable: true, configurable: true, value: () => 42 };
  return Object.defineProperties({}, descriptors);
});
const skill = { name: 'review', path: '/a/SKILL.md', displayName: '代码检查🙂', brandColor: '#8A42EF' };

test('Android decoration keeps canonical text and native UTF-16 selection without placeholder characters', async () => {
  const state = restoreSkillMentions('你好🙂', [skill]), edit = jest.fn(), selection = jest.fn();
  const view = await render(<SkillComposerInput accessibilityLabel="编辑消息" value={state.text} mentions={state.mentions}
    selection={{ start: 8, end: 8 }} onSkillEdit={edit} onSelectionChange={selection} />);
  const input = view.getByLabelText('编辑消息');
  expect(input.props.value).toBe('$review 你好🙂'); expect(input.props.children).toBeUndefined();
  expect(input.props.accessibilityValue).toEqual({ text: '代码检查🙂 你好🙂' });
  expect(input.props.selection).toEqual({ start: 8, end: 8 });
  await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 8, end: 12 } } });
  expect(selection.mock.calls[0][0].nativeEvent.selection).toEqual({ start: 8, end: 12 });
  await fireEvent.changeText(input, '$review 你好🙂检查');
  expect(edit).toHaveBeenLastCalledWith({ text: '$review 你好🙂检查', mentions: state.mentions });
  await fireEvent.changeText(input, '$revie 你好🙂');
  expect(edit).toHaveBeenLastCalledWith({ text: ' 你好🙂', mentions: [], caret: 0 });
});

test('replacing canonical token text never creates another authorized skill', async () => {
  const state = restoreSkillMentions('继续', [skill]), edit = jest.fn();
  const view = await render(<SkillComposerInput accessibilityLabel="编辑消息" value={state.text} mentions={state.mentions} onSkillEdit={edit} />);
  await fireEvent.changeText(view.getByLabelText('编辑消息'), '$reviewX 继续');
  expect(edit).toHaveBeenCalledWith({ text: '$reviewX 继续', mentions: [] });
});

test('multiline native composers grow to their limit and return to a compact height when cleared',async()=>{
  const onSize=jest.fn(),props={accessibilityLabel:'编辑消息',mentions:[],multiline:true,style:{minHeight:52,maxHeight:180},onContentSizeChange:onSize};
  const view=await render(<SkillComposerInput {...props} value="第一行"/>);
  await fireEvent(view.getByLabelText('编辑消息'),'contentSizeChange',{nativeEvent:{contentSize:{width:280,height:104.2}}});
  expect(StyleSheet.flatten(view.getByLabelText('编辑消息').props.style).height).toBe(105);expect(onSize).toHaveBeenCalledTimes(1);
  await fireEvent(view.getByLabelText('编辑消息'),'contentSizeChange',{nativeEvent:{contentSize:{width:280,height:510}}});
  expect(StyleSheet.flatten(view.getByLabelText('编辑消息').props.style).height).toBe(180);
  await view.rerender(<SkillComposerInput {...props} value=""/>);
  expect(StyleSheet.flatten(view.getByLabelText('编辑消息').props.style).height).toBe(52);await view.unmount();
});
