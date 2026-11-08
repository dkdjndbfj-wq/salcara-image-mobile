import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { MessageContent } from '../components/MessageContent';
import { WorkbenchPresentationProvider } from '../remote/workbench-presentation';
import { CommandOutput } from '../remote/CommandOutput';
import { commandLogPayload, commandLogText } from '../remote/command-output-actions';
import { exportArtifact } from '../remote/artifact-export';

jest.mock('../remote/artifact-export', () => ({ exportArtifact: jest.fn(async () => {}) }));
jest.mock('../components/ui', () => ({ showToast: jest.fn() }));
jest.mock('../remote/CompactActionMenu', () => {
  const React = require('react'), { View, Pressable, Text } = require('react-native');
  return { CompactActionMenu: ({ visible, actions, onClose }: any) => visible ? <View>{actions.map((action: any) => <Pressable key={action.id} accessibilityRole="button" accessibilityLabel={action.label} disabled={action.disabled} onPress={() => { onClose(); action.onPress(); }}><Text>{action.label}</Text></Pressable>)}</View> : null };
});
jest.mock('../components/RichRenderedSurface', () => ({ RichRenderedSurface: () => null }));

beforeEach(() => jest.clearAllMocks());

test('remote long code keeps every line and exact copy in a bounded two-axis frame; ordinary chat stays natural', async () => {
  const code = Array.from({ length: 130 }, (_, i) => `  line ${i + 1}: ${'very_long_column '.repeat(12)} `).join('\n') + '\n\n';
  const markdown = '```text\n' + code + '\n```';
  const view = await render(<WorkbenchPresentationProvider presentation="phone"><MessageContent text={markdown}/></WorkbenchPresentationProvider>);
  expect(StyleSheet.flatten(view.getByTestId('message-code-scroll').props.style).height).toBe(240);
  expect(view.getByTestId('message-selectable-text').props.children).toContain(code);
  const copy = jest.spyOn(Clipboard, 'setStringAsync');
  await fireEvent.press(view.getByLabelText('复制代码')); expect(copy).toHaveBeenCalledWith(code);
  await view.rerender(<MessageContent text={markdown}/>);
  expect(view.queryByTestId('message-code-scroll')).toBeNull();
});

test('short remote code keeps its natural height without an enlarge action', async () => {
  const view = await render(<MessageContent desktop text={'```js\nconst n = 1;\n```'}/>);
  expect(StyleSheet.flatten(view.getByTestId('message-code-scroll').props.style).height).toBeLessThan(80);
  expect(view.queryByLabelText(/放大|全屏/)).toBeNull();
});

test('command menu copies the raw command and complete output without executing them', async () => {
  const command = 'echo "literal $(anything)"', output = '  first\n' + '中间日志\n'.repeat(500) + 'last  \n\n';
  const view = await render(<CommandOutput scopeKey="pc:a:tool" command={command} output={output} exitCode={7}/>);
  const copy = jest.spyOn(Clipboard, 'setStringAsync');
  await fireEvent.press(view.getByRole('button', { name: '命令输出操作' }));
  await fireEvent.press(view.getByLabelText('复制命令')); expect(copy).toHaveBeenLastCalledWith(command);
  await fireEvent.press(view.getByRole('button', { name: '命令输出操作' }));
  await fireEvent.press(view.getByLabelText('复制完整输出')); expect(copy).toHaveBeenLastCalledWith(output);
  expect(view.getByText('$ ' + command).props.onPress).toBeUndefined();
});

test('saved text contains exact output and source command/exit code, with a safe .txt filename', async () => {
  const input = { command: 'rg "名字" .', output: '  a\n\n结束  \n', exitCode: 0 };
  const payload = commandLogPayload(input, Date.UTC(2026, 10, 7));
  expect(payload.content).toBe(commandLogText(input)); expect(payload.content).toContain(input.output);
  expect(payload.artifact.name).toMatch(/^command-output-[^:]+\.txt$/);
  expect(payload.artifact.size).toBe(new TextEncoder().encode(payload.content).length);
  const view = await render(<CommandOutput {...input} scopeKey="pc:a:tool"/>);
  await fireEvent.press(view.getByRole('button', { name: '命令输出操作' })); await fireEvent.press(view.getByLabelText('保存日志'));
  expect(exportArtifact).toHaveBeenCalledWith(expect.objectContaining({ content: payload.content }), 'download', expect.any(AbortSignal));
});

test('changing source aborts a pending export and closes the previous menu', async () => {
  let finish!: () => void;
  jest.mocked(exportArtifact).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = await render(<CommandOutput scopeKey="pc:a:tool" output="first output"/>);
  await fireEvent.press(view.getByRole('button', { name: '命令输出操作' })); await fireEvent.press(view.getByLabelText('保存日志'));
  const signal = jest.mocked(exportArtifact).mock.calls[0][2]; expect(signal.aborted).toBe(false);
  await view.rerender(<CommandOutput scopeKey="other-pc:b:tool" output="other output"/>);
  expect(signal.aborted).toBe(true); expect(view.queryByLabelText('保存日志')).toBeNull();
  await act(async () => finish());
  await fireEvent.press(view.getByRole('button', { name: '命令输出操作' }));
  expect(view.getByLabelText('复制完整输出')).toBeTruthy();
});
