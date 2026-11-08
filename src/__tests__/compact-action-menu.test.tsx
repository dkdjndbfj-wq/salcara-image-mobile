import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { CompactActionMenu, type CompactAction } from '../remote/CompactActionMenu';

jest.mock('../components/Icon', () => ({ Icon: () => null }));

let listeners: Set<(state: string) => void>;
beforeEach(() => {
  jest.useFakeTimers(); AppState.currentState = 'active'; listeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    const listener = callback as (state: string) => void;
    listeners.add(listener); return { remove: () => listeners.delete(listener) };
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

function retainedPress(node: { unstable_fiber: any }): () => void {
  let fiber = node.unstable_fiber;
  while (fiber && typeof fiber.memoizedProps?.onPress !== 'function') fiber = fiber.return;
  return fiber.memoizedProps.onPress;
}
function setup() {
  const selected = jest.fn(), closed = jest.fn();
  const actions: CompactAction[] = [{ id: 'gallery', label: '选择图片', icon: 'image', onPress: selected }];
  return { selected, closed, props: { visible: true, actions, onClose: closed, scopeKey: 'source-a' } };
}

test('selecting retires the opening before closing and dispatches only once, including after an unrelated render', async () => {
  const { selected, closed, props } = setup();
  const view = await render(<CompactActionMenu {...props}/>);
  const press = retainedPress(view.getByRole('button', { name: '选择图片' }));
  await act(() => { press(); press(); });
  expect(closed).toHaveBeenCalledTimes(1); expect(selected).toHaveBeenCalledTimes(1);
  expect(closed.mock.invocationCallOrder[0]).toBeLessThan(selected.mock.invocationCallOrder[0]);
  await view.rerender(<CompactActionMenu {...props} width={188}/>);
  await fireEvent.press(view.getByRole('button', { name: '选择图片' }));
  expect(selected).toHaveBeenCalledTimes(1);
});

test('retained callbacks cannot select or close after switching away from and back to the same source', async () => {
  const { selected, closed, props } = setup();
  const view = await render(<CompactActionMenu {...props}/>);
  const press = retainedPress(view.getByRole('button', { name: '选择图片' }));
  const dismiss = retainedPress(view.getByTestId('compact-action-menu-backdrop'));
  await view.rerender(<CompactActionMenu {...props} scopeKey="source-b"/>);
  await view.rerender(<CompactActionMenu {...props}/>);
  await act(() => { press(); dismiss(); });
  expect(closed).not.toHaveBeenCalled(); expect(selected).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: '选择图片' }));
  expect(selected).toHaveBeenCalledTimes(1);
});

test('backdrop dismissal cancels selection and old callbacks remain inactive after reopening', async () => {
  const { selected, closed, props } = setup();
  const view = await render(<CompactActionMenu {...props}/>);
  const press = retainedPress(view.getByRole('button', { name: '选择图片' }));
  const dismiss = retainedPress(view.getByTestId('compact-action-menu-backdrop'));
  await act(() => { dismiss(); press(); dismiss(); });
  expect(closed).toHaveBeenCalledTimes(1); expect(selected).not.toHaveBeenCalled();
  await view.rerender(<CompactActionMenu {...props} visible={false}/>);
  await view.rerender(<CompactActionMenu {...props}/>);
  await act(() => { press(); dismiss(); });
  expect(closed).toHaveBeenCalledTimes(1); expect(selected).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: '选择图片' }));
  expect(selected).toHaveBeenCalledTimes(1);
});

test('disabled and removed actions invalidate retained callbacks, including a disable-enable cycle', async () => {
  const { selected, props } = setup();
  const view = await render(<CompactActionMenu {...props}/>);
  const press = retainedPress(view.getByRole('button', { name: '选择图片' }));
  await view.rerender(<CompactActionMenu {...props} actions={[{ ...props.actions[0], disabled: true }]}/>);
  await act(() => press());
  await fireEvent.press(view.getByRole('button', { name: '选择图片' }));
  expect(selected).not.toHaveBeenCalled();
  await view.rerender(<CompactActionMenu {...props} actions={[]}/>);
  await act(() => press());
  await view.rerender(<CompactActionMenu {...props}/>);
  await act(() => press());
  expect(selected).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: '选择图片' }));
  expect(selected).toHaveBeenCalledTimes(1);
});

test('background closes once with the latest callback and returning foreground does not revive a selection', async () => {
  const { selected, closed, props } = setup(), latestClose = jest.fn();
  const view = await render(<CompactActionMenu {...props}/>);
  const press = retainedPress(view.getByRole('button', { name: '选择图片' }));
  await view.rerender(<CompactActionMenu {...props} onClose={latestClose}/>);
  await act(() => {
    AppState.currentState = 'background';
    listeners.forEach(change => { change('inactive'); change('background'); });
    press();
  });
  expect(closed).not.toHaveBeenCalled(); expect(latestClose).toHaveBeenCalledTimes(1);
  await act(() => { AppState.currentState = 'active'; listeners.forEach(change => change('active')); });
  await view.rerender(<CompactActionMenu {...props}/>);
  await fireEvent.press(view.getByRole('button', { name: '选择图片' }));
  expect(selected).not.toHaveBeenCalled();
  await view.rerender(<CompactActionMenu {...props} visible={false}/>);
  await view.rerender(<CompactActionMenu {...props}/>);
  await fireEvent.press(view.getByRole('button', { name: '选择图片' }));
  expect(selected).toHaveBeenCalledTimes(1);
});

test('unchanged action descriptors use the current handler while unmounted callbacks are inert', async () => {
  const { selected, closed, props } = setup(), currentSelected = jest.fn();
  const view = await render(<CompactActionMenu {...props}/>);
  const press = retainedPress(view.getByRole('button', { name: '选择图片' }));
  await view.rerender(<CompactActionMenu {...props} actions={[{ ...props.actions[0], onPress: currentSelected }]}/>);
  await act(() => press());
  expect(selected).not.toHaveBeenCalled(); expect(currentSelected).toHaveBeenCalledTimes(1);
  await view.rerender(<CompactActionMenu {...props} visible={false}/>);
  await view.rerender(<CompactActionMenu {...props}/>);
  const nextPress = retainedPress(view.getByRole('button', { name: '选择图片' }));
  await view.unmount(); await act(() => nextPress());
  expect(selected).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});
