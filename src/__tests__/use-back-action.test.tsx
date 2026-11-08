import React from 'react';
import { act, render } from '@testing-library/react-native';
import { BackHandler, Keyboard } from 'react-native';
import { useBackAction, useChildBackAction, type BackAction, type RegisterBackAction } from '../remote/useBackAction';

type NativeBack = Parameters<typeof BackHandler.addEventListener>[1];
const subscriptions = new Set<NativeBack>();
const defaultBack = jest.fn();

function Child({ action, register, enabled = true }: { action: BackAction; register?: RegisterBackAction; enabled?: boolean }) {
  useBackAction(action, register, enabled);
  return null;
}
function Page({ action, childAction, showChild = true, enabled = true }: { action: BackAction; childAction: BackAction; showChild?: boolean; enabled?: boolean }) {
  const child = useChildBackAction();
  useBackAction(() => child.handle() || action(), undefined, enabled);
  return showChild ? <Child action={childAction} register={child.register} /> : null;
}
async function pressBack() {
  let handled = false;
  await act(async () => {
    for (const subscription of [...subscriptions].reverse()) {
      if (subscription({ type: 'hardwareBackPress', timeStamp: Date.now() })) { handled = true; break; }
    }
    if (!handled) defaultBack();
  });
  return handled;
}

beforeEach(() => {
  subscriptions.clear(); defaultBack.mockClear();
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    subscriptions.add(handler);
    return { remove: () => { subscriptions.delete(handler); } };
  });
});
afterEach(() => jest.restoreAllMocks());

test('explicit child delegation keeps priority after parent and child rerenders without reordering native listeners', async () => {
  const originalParent = jest.fn(() => true), originalChild = jest.fn(() => true);
  const view = await render(<Page action={originalParent} childAction={originalChild} />);
  expect(BackHandler.addEventListener).toHaveBeenCalledTimes(1);
  expect(await pressBack()).toBe(true);
  expect(originalChild).toHaveBeenCalledTimes(1);
  expect(originalParent).not.toHaveBeenCalled();

  const updatedParent = jest.fn(() => true), updatedChild = jest.fn(() => true);
  await view.rerender(<Page action={updatedParent} childAction={updatedChild} />);
  expect(await pressBack()).toBe(true);
  expect(updatedChild).toHaveBeenCalledTimes(1);
  expect(updatedParent).not.toHaveBeenCalled();
  updatedChild.mockReturnValue(false);
  expect(await pressBack()).toBe(true);
  expect(updatedParent).toHaveBeenCalledTimes(1);
  expect(originalChild).toHaveBeenCalledTimes(1);
  expect(originalParent).not.toHaveBeenCalled();
  expect(BackHandler.addEventListener).toHaveBeenCalledTimes(1);
  expect(defaultBack).not.toHaveBeenCalled();
});

test('a visible keyboard consumes back before either page action is invoked', async () => {
  const parent = jest.fn(() => true), child = jest.fn(() => true);
  await render(<Page action={parent} childAction={child} />);
  jest.mocked(Keyboard.isVisible).mockReturnValue(true);
  expect(await pressBack()).toBe(true);
  expect(Keyboard.dismiss).toHaveBeenCalledTimes(1);
  expect(parent).not.toHaveBeenCalled();
  expect(child).not.toHaveBeenCalled();
  jest.mocked(Keyboard.isVisible).mockReturnValue(false);
  expect(await pressBack()).toBe(true);
  expect(child).toHaveBeenCalledTimes(1);
  expect(parent).not.toHaveBeenCalled();
});

test('unmounting a delegated child clears registration and invalidates its captured callback', async () => {
  const action = jest.fn(() => true), register = jest.fn<void, [BackAction | null]>();
  const view = await render(<Child action={action} register={register} />);
  const oldCallback = register.mock.calls[0][0]!;
  expect(oldCallback()).toBe(true);
  expect(action).toHaveBeenCalledTimes(1);
  expect(BackHandler.addEventListener).not.toHaveBeenCalled();
  await view.unmount();
  expect(register).toHaveBeenLastCalledWith(null);
  jest.mocked(Keyboard.isVisible).mockReturnValue(true);
  expect(oldCallback()).toBe(false);
  expect(action).toHaveBeenCalledTimes(1);
  expect(Keyboard.dismiss).not.toHaveBeenCalled();
});

test('removing a child delegates to the parent and disabling the page removes the native subscription', async () => {
  const parent = jest.fn(() => true), child = jest.fn(() => true);
  const view = await render(<Page action={parent} childAction={child} />);
  const nativeCallback = [...subscriptions][0];
  await view.rerender(<Page action={parent} childAction={child} showChild={false} />);
  expect(await pressBack()).toBe(true);
  expect(parent).toHaveBeenCalledTimes(1);
  expect(child).not.toHaveBeenCalled();
  await view.rerender(<Page action={parent} childAction={child} showChild={false} enabled={false} />);
  expect(subscriptions.size).toBe(0);
  expect(nativeCallback({ type: 'hardwareBackPress', timeStamp: Date.now() })).toBe(false);
  expect(parent).toHaveBeenCalledTimes(1);
  expect(await pressBack()).toBe(false);
  expect(defaultBack).toHaveBeenCalledTimes(1);
});

test('a root action returning false allows Android default back and unmount removes the listener', async () => {
  const action = jest.fn(() => false);
  const view = await render(<Child action={action} />);
  expect(await pressBack()).toBe(false);
  expect(action).toHaveBeenCalledTimes(1);
  expect(defaultBack).toHaveBeenCalledTimes(1);
  await view.unmount();
  expect(subscriptions.size).toBe(0);
});
