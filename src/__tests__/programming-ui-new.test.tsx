import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { ProgrammingAction, ProgrammingCard, ProgrammingField, ProgrammingHeading, ProgrammingSheet } from '../remote/ProgrammingUi';
import { desk } from '../theme';

const mockDismiss = jest.fn();
const mockBrandFill = jest.fn(() => null);
const mockSheen = jest.fn(() => null);
jest.mock('../components/Icon', () => {
  const React = require('react'); const { View } = require('react-native');
  return { Icon: (props: Record<string, unknown>) => React.createElement(View, { testID: `icon-${props.name}`, ...props }) };
});
jest.mock('react-native-svg', () => {
  const React = require('react'); const { View } = require('react-native');
  const mockSvg = ({ children, ...props }: Record<string, unknown>) => React.createElement(View, { ...props, testID: 'programming-action-svg' }, children);
  const pass = ({ children, ...props }: Record<string, unknown>) => React.createElement(View, props, children);
  return {
    __esModule: true, default: mockSvg, Svg: mockSvg, Defs: pass, Rect: pass,
    LinearGradient: ({ children, ...props }: Record<string, unknown>) => React.createElement(View, { ...props, testID: 'programming-action-gradient' }, children),
    Stop: (props: Record<string, unknown>) => React.createElement(View, { ...props, testID: 'programming-action-gradient-stop' }),
  };
});
jest.mock('../components/ui', () => {
  const React = require('react'); const { View, Text } = require('react-native');
  return {
    dismissKeyboardAndBlur: () => mockDismiss(),
    BrandFill: () => mockBrandFill(), Sheen: () => mockSheen(),
    Sheet: ({ visible, title, children, headerRight, onClose, dismissible }: Record<string, unknown>) => visible
      ? React.createElement(View, { testID: 'programming-sheet', onClose, dismissible }, React.createElement(Text, null, title), headerRight, children) : null,
  };
});

beforeEach(() => jest.clearAllMocks());

test('heading has one title, an optional step progress, and an optional concise subtitle', async () => {
  const view = await render(<ProgrammingHeading title="绑定电脑" step="01 / 02" subtitle="填写电脑使用的中转站地址" />);
  expect(view.queryByText('SALCARA')).toBeNull();
  expect(view.getByLabelText('第 1 步，共 2 步')).toBeTruthy();
  expect(view.getByText('绑定电脑')).toBeTruthy();
  expect(view.getByText('01 / 02')).toBeTruthy();
  expect(view.getByText('填写电脑使用的中转站地址')).toBeTruthy();
});

test('action is accessible, dismisses keyboard, and calls only its own handler', async () => {
  const handler = jest.fn();
  const view = await render(<ProgrammingAction label="下一步" icon="chevronRight" onPress={handler} />);
  await fireEvent.press(view.getByRole('button', { name: '下一步' }));
  expect(mockDismiss).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(mockDismiss.mock.invocationCallOrder[0]).toBeLessThan(handler.mock.invocationCallOrder[0]);
});

test.each([{ disabled: true, loading: false }, { disabled: false, loading: true }, { disabled: true, loading: true }])(
  'disabled/loading action does not submit again (%j)', async (state) => {
    const handler = jest.fn();
    const view = await render(<ProgrammingAction label="保存" onPress={handler} {...state} />);
    const action = view.getByRole('button', { name: '保存' });
    expect(action.props.accessibilityState).toEqual({ disabled: true, busy: state.loading });
    await fireEvent.press(action);
    expect(handler).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  },
);

test('loading action shows one indicator instead of the trailing chevron', async () => {
  const view = await render(<ProgrammingAction label="正在保存" loading onPress={() => undefined} />);
  const indicators: unknown[] = [];
  const visit = (node: ReturnType<typeof view.toJSON>) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ActivityIndicator') indicators.push(node);
    node.children?.forEach(child => { if (typeof child !== 'string') visit(child); });
  };
  visit(view.toJSON());
  expect(indicators).toHaveLength(1);
  expect(view.queryByTestId('icon-chevronRight')).toBeNull();
});

test.each([
  ['primary', desk.onInk, desk.ink],
  ['secondary', desk.text, desk.surface],
  ['danger', desk.bad, desk.badSoft],
] as const)('action %s uses the desktop palette: near-black primary, no gradient', async (tone, foreground, background) => {
  const view = await render(<ProgrammingAction label="操作" tone={tone} onPress={() => undefined} />);
  const actionStyle = StyleSheet.flatten(view.getByRole('button', { name: '操作' }).props.style);
  expect(actionStyle.backgroundColor).toBe(background);
  expect(view.queryByTestId('programming-action-svg')).toBeNull();
  expect(view.queryByTestId('programming-action-gradient')).toBeNull();
  expect(actionStyle.elevation).toBeUndefined();
  expect(StyleSheet.flatten(view.getByText('操作').props.style).color).toBe(foreground);
  expect(mockBrandFill).not.toHaveBeenCalled();
  expect(mockSheen).not.toHaveBeenCalled();
});

test.each(['plain', 'icon', 'loading'] as const)('action label and its optional leading glyph are centred together, without a chevron (%s)', async state => {
  const view = await render(<ProgrammingAction label="下一步" icon={state === 'icon' ? 'check' : undefined} loading={state === 'loading'} onPress={() => undefined} />);
  expect(StyleSheet.flatten(view.getByText('下一步').props.style)).toMatchObject({ textAlign: 'center' });
  expect(view.queryByTestId('icon-chevronRight')).toBeNull();
  if (state === 'icon') expect(view.getByTestId('icon-check')).toBeTruthy();
});

test('busy programming sheets forward a gesture and dismissal lock to the host', async () => {
  const view = await render(<ProgrammingSheet visible title="连接电脑" dismissible={false} onClose={() => undefined}><Text>正在连接</Text></ProgrammingSheet>);
  expect(view.getByTestId('programming-sheet').props.dismissible).toBe(false);
});

test('field preserves input metadata, masks a key, and forwards user text without transformation', async () => {
  const change = jest.fn();
  const view = await render(<ProgrammingField label="API Key" value="masked-fixture" secureTextEntry editable={false} keyboardType="ascii-capable" onChangeText={change} />);
  const field = view.getByLabelText('API Key');
  expect(field.props).toMatchObject({ value: 'masked-fixture', secureTextEntry: true, editable: false, keyboardType: 'ascii-capable' });
  expect(view.getByText('API Key')).toBeTruthy();
  await view.rerender(<ProgrammingField label="API Key" value="" secureTextEntry onChangeText={change} />);
  await fireEvent.changeText(view.getByLabelText('API Key'), '  fixture-text  ');
  expect(change).toHaveBeenCalledWith('  fixture-text  ');
});

test('field can retain a stable explicit accessibility label independent of visual text', async () => {
  const view = await render(<ProgrammingField label="地址" accessibilityLabel="中转站地址" first />);
  expect(view.getByLabelText('中转站地址')).toBeTruthy();
  expect(view.getByText('地址')).toBeTruthy();
});

test('programming sheet mounts no hidden page and renders one page heading and footer', async () => {
  const close = jest.fn();
  const content = <Text>手机 API 内容</Text>;
  const props = { title: 'API 管理', onClose: close, footer: <Text>保存</Text> };
  const view = await render(<ProgrammingSheet {...props} visible={false}>{content}</ProgrammingSheet>);
  expect(view.queryByText('API 管理')).toBeNull();
  await view.rerender(<ProgrammingSheet {...props} visible>{content}</ProgrammingSheet>);
  expect(view.getAllByText('API 管理')).toHaveLength(1);
  expect(view.getByText('手机 API 内容')).toBeTruthy();
  expect(view.getByText('保存')).toBeTruthy();
  view.getByTestId('programming-sheet').props.onClose();
  expect(close).toHaveBeenCalledTimes(1);
});

test('cards accept layout styles without changing their shared rounded surface', async () => {
  const view = await render(<ProgrammingCard style={{ marginTop: 10 }}><Text>已保存</Text></ProgrammingCard>);
  const card = view.root;
  expect(card).toBeTruthy();
  expect(StyleSheet.flatten(card?.props.style)).toMatchObject({ backgroundColor: desk.surface, marginTop: 10, borderRadius: 16 });
});
