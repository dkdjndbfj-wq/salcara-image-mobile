import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { ModelPopover } from '../remote/ModelPopover';

jest.mock('../components/Icon', () => ({ Icon: () => null }));
type Props = React.ComponentProps<typeof ModelPopover>;
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
let listeners: Set<(state: string) => void>;
async function mount(extra: Partial<Props> = {}) {
  const props: Props = { visible: true, anchor: null, value: MODELS[0], fallback: '', models: MODELS, loading: false,
    onRefresh: jest.fn(), onSelect: jest.fn(), onClose: jest.fn(), scopeKey: 'pc|api-main', ...extra };
  return { props, view: await render(<ModelPopover {...props}/>) };
}
type Mounted = Awaited<ReturnType<typeof mount>>;
async function rerender(mounted: Mounted, extra: Partial<Props>) {
  mounted.props = { ...mounted.props, ...extra }; await mounted.view.rerender(<ModelPopover {...mounted.props}/>);
}
function pressHandler(view: Mounted['view'], label: string) {
  let fiber = view.getByLabelText(label, { includeHiddenElements: true }).unstable_fiber;
  while (fiber) { if (typeof fiber.memoizedProps?.onPress === 'function') return fiber.memoizedProps.onPress as () => void; fiber = fiber.return; }
  throw new Error(`Missing handler: ${label}`);
}
async function confirm(view: Mounted['view']) { await fireEvent.press(view.getByLabelText('关闭模型选择', { includeHiddenElements: true })); }
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); AppState.currentState = 'active'; listeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    const change = callback as (state: string) => void; listeners.add(change); return { remove: () => listeners.delete(change) };
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('compact model rows contain only model settings and preserve the exact selected ID', async () => {
  const { view, props } = await mount();
  expect(view.getByText('模型 · Claude')).toBeTruthy();
  expect(view.queryByTestId('remote-model-orbit')).toBeNull(); expect(view.queryByTestId('remote-model-blur')).toBeNull();
  expect(view.queryByText('推理强度')).toBeNull(); expect(view.queryByLabelText('更换对话 API')).toBeNull();
  await fireEvent.press(view.getByRole('radio', { name: 'sonnet-5-5' }));
  expect(props.onSelect).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  expect(view.getByRole('radio', { name: 'sonnet-5-5' }).props.accessibilityState.checked).toBe(true);
  await confirm(view);
  expect(props.onSelect).toHaveBeenCalledWith(MODELS[1]); expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});
test.each([
  ['mixed providers', ['claude-opus-5-5', 'gpt-5.5'], 'claude-opus-5-5'],
  ['unknown alias', ['company-claude-main'], 'company-claude-main'],
  ['custom namespace', ['deployment/claude-opus-5-5'], 'deployment/claude-opus-5-5'],
  ['provider namespace', ['anthropic/claude-opus-5-5'], 'opus-5-5'],
] as const)('%s keeps the exact selected ID', async (_name, ids, label) => {
  const { view, props } = await mount({ models: [...ids], value: '', fallback: '' });
  await fireEvent.press(view.getByRole('radio', { name: label })); await confirm(view); expect(props.onSelect).toHaveBeenCalledWith(ids[0]);
});
test('short-name collisions remain separately identifiable', async () => {
  const { view, props } = await mount({ models: ['claude-opus-5-5', 'anthropic/claude-opus-5-5'] });
  expect(view.getByRole('radio', { name: 'claude-opus-5-5' })).toBeTruthy();
  await fireEvent.press(view.getByRole('radio', { name: 'anthropic/claude-opus-5-5' })); await confirm(view); expect(props.onSelect).toHaveBeenCalledWith('anthropic/claude-opus-5-5');
});
test.each(['scopeKey', 'models', 'loading', 'selectionEnabled', 'interactionBlocked', 'value'] as const)('stale selection after %s changes cannot write', async changed => {
  const mounted = await mount(), select = pressHandler(mounted.view, 'sonnet-5-5'), dismiss = pressHandler(mounted.view, '关闭模型选择');
  await fireEvent.press(mounted.view.getByRole('radio', { name: 'sonnet-5-5' }));
  const updates: Record<typeof changed, Partial<Props>> = {
    scopeKey: { scopeKey: 'pc-b' }, models: { models: [MODELS[0]] }, loading: { loading: true }, selectionEnabled: { selectionEnabled: false },
    interactionBlocked: { interactionBlocked: true }, value: { value: MODELS[1] },
  };
  await rerender(mounted, updates[changed]); await act(() => { select(); dismiss(); }); await confirm(mounted.view); expect(mounted.props.onSelect).not.toHaveBeenCalled();
});
test('dismiss, reopen and returning to the same scope cannot replay an old action', async () => {
  const mounted = await mount(), select = pressHandler(mounted.view, 'sonnet-5-5'), dismiss = pressHandler(mounted.view, '关闭模型选择');
  await fireEvent.press(mounted.view.getByLabelText('关闭模型选择', { includeHiddenElements: true }));
  await rerender(mounted, { visible: false, scopeKey: 'pc-b' }); await rerender(mounted, { visible: true, scopeKey: 'pc|api-main' });
  await act(() => { select(); dismiss(); }); expect(mounted.props.onSelect).not.toHaveBeenCalled(); expect(mounted.props.onClose).toHaveBeenCalledTimes(1);
  await fireEvent.press(mounted.view.getByRole('radio', { name: 'sonnet-5-5' })); await confirm(mounted.view); expect(mounted.props.onSelect).toHaveBeenCalledWith(MODELS[1]);
});
test('backgrounding dismisses and retires the current menu', async () => {
  const mounted = await mount(), select = pressHandler(mounted.view, 'sonnet-5-5');
  await fireEvent.press(mounted.view.getByRole('radio', { name: 'sonnet-5-5' }));
  await act(() => { AppState.currentState = 'background'; listeners.forEach(change => change('background')); });
  await act(() => { AppState.currentState = 'active'; select(); });
  expect(mounted.props.onClose).toHaveBeenCalledTimes(1); expect(mounted.props.onSelect).not.toHaveBeenCalled();
});
test('refresh invalidates pending choices and does not run twice while loading', async () => {
  const mounted = await mount(), select = pressHandler(mounted.view, 'sonnet-5-5');
  await fireEvent.press(mounted.view.getByRole('radio', { name: 'sonnet-5-5' }));
  await fireEvent.press(mounted.view.getByLabelText('刷新模型列表')); await act(() => select());
  expect(mounted.props.onRefresh).toHaveBeenCalledTimes(1); expect(mounted.props.onSelect).not.toHaveBeenCalled();
  await rerender(mounted, { loading: true }); await fireEvent.press(mounted.view.getByLabelText('刷新模型列表')); expect(mounted.props.onRefresh).toHaveBeenCalledTimes(1);
  await rerender(mounted, { loading: false }); await confirm(mounted.view); expect(mounted.props.onSelect).not.toHaveBeenCalled();
});
test('managed catalogs never offer retired saved IDs or an unverified fallback', async () => {
  const mounted = await mount({ value: 'retired', fallback: 'retired-default', catalogOnly: true, catalogReady: false });
  expect(mounted.view.queryAllByRole('radio')).toHaveLength(0);
  await rerender(mounted, { catalogReady: true }); expect(mounted.view.getAllByRole('radio')).toHaveLength(3);
  expect(mounted.view.queryByRole('radio', { name: 'retired' })).toBeNull();
});
test('read-only model selection only delegates its default-model action', async () => {
  const follow = jest.fn(), { view, props } = await mount({ selectionEnabled: false, onFollowComputer: follow });
  await fireEvent.press(view.getByRole('radio', { name: 'opus-5-5' })); expect(props.onSelect).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('使用默认模型')); expect(follow).not.toHaveBeenCalled();
  await confirm(view); expect(follow).toHaveBeenCalledTimes(1);
});
test('model selection commits once and unmounted handlers never commit', async () => {
  const { view, props } = await mount(), select = pressHandler(view, 'sonnet-5-5'), dismiss = pressHandler(view, '关闭模型选择');
  await act(() => { select(); select(); }); expect(props.onSelect).not.toHaveBeenCalled();
  await act(() => { dismiss(); dismiss(); }); expect(props.onSelect).toHaveBeenCalledTimes(1);
  await view.unmount(); await act(() => { select(); dismiss(); }); expect(props.onSelect).toHaveBeenCalledTimes(1); expect(listeners.size).toBe(0);
});
test('StrictMode effect replay keeps deliberate model selection available', async () => {
  const onSelect = jest.fn();
  const view = await render(<React.StrictMode><ModelPopover visible value="first" fallback="" models={['first', 'second']} loading={false}
    onRefresh={jest.fn()} onClose={jest.fn()} onSelect={onSelect}/></React.StrictMode>);
  await fireEvent.press(view.getByRole('radio', { name: 'second' })); await confirm(view); expect(onSelect).toHaveBeenCalledWith('second');
});

test.each(['untouched', 'same-model', 'changed-back'] as const)('%s dismissal only closes and writes no preference', async mode => {
  const { view, props } = await mount();
  if (mode === 'changed-back') await fireEvent.press(view.getByRole('radio', { name: 'sonnet-5-5' }));
  if (mode !== 'untouched') await fireEvent.press(view.getByRole('radio', { name: 'opus-5-5' }));
  await confirm(view); expect(props.onClose).toHaveBeenCalledTimes(1); expect(props.onSelect).not.toHaveBeenCalled();
});

test('the last preview is committed, not an intermediate model choice', async () => {
  const { view, props } = await mount();
  await fireEvent.press(view.getByRole('radio', { name: 'sonnet-5-5' }));
  await fireEvent.press(view.getByRole('radio', { name: 'haiku-4-5' }));
  expect(props.onSelect).not.toHaveBeenCalled(); await confirm(view);
  expect(props.onSelect).toHaveBeenCalledTimes(1); expect(props.onSelect).toHaveBeenCalledWith(MODELS[2]);
});

test('choosing the default again while following it does not update', async () => {
  const follow = jest.fn(), { view, props } = await mount({ value: '', fallback: MODELS[0], onFollowComputer: follow });
  await fireEvent.press(view.getByLabelText('使用默认模型')); await confirm(view);
  expect(follow).not.toHaveBeenCalled(); expect(props.onSelect).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('explicit model selection can be discarded by choosing the current default', async () => {
  const follow = jest.fn(), { view, props } = await mount({ value: '', fallback: MODELS[0], onFollowComputer: follow });
  await fireEvent.press(view.getByRole('radio', { name: 'sonnet-5-5' }));
  await fireEvent.press(view.getByLabelText('使用默认模型')); await confirm(view);
  expect(follow).not.toHaveBeenCalled(); expect(props.onSelect).not.toHaveBeenCalled();
});

test('selecting the effective default model by name does not create an explicit override', async () => {
  const follow = jest.fn(), { view, props } = await mount({ value: '', fallback: MODELS[0], onFollowComputer: follow });
  await fireEvent.press(view.getByRole('radio', { name: 'opus-5-5' })); await confirm(view);
  expect(follow).not.toHaveBeenCalled(); expect(props.onSelect).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledTimes(1);
});

test.each(['hidden', 'unmount'] as const)('%s retires a preview without committing', async action => {
  const mounted = await mount();
  await fireEvent.press(mounted.view.getByRole('radio', { name: 'sonnet-5-5' }));
  const dismiss = pressHandler(mounted.view, '关闭模型选择');
  if (action === 'hidden') await rerender(mounted, { visible: false }); else await mounted.view.unmount();
  await act(() => dismiss()); expect(mounted.props.onSelect).not.toHaveBeenCalled(); expect(mounted.props.onClose).not.toHaveBeenCalled();
});

test('the native back request confirms exactly like clicking outside', async () => {
  const { view, props } = await mount();
  await fireEvent.press(view.getByRole('radio', { name: 'sonnet-5-5' }));
  let fiber = view.getByTestId('remote-model-popover').unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onRequestClose !== 'function') fiber = fiber.return;
  if (!fiber) throw new Error('Missing native dismiss handler');
  await act(() => fiber!.memoizedProps.onRequestClose());
  expect(props.onSelect).toHaveBeenCalledWith(MODELS[1]); expect(props.onClose).toHaveBeenCalledTimes(1);
});
