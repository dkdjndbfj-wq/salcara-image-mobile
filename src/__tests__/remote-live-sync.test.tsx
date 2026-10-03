import React from 'react';
import { AppState } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { useLiveSync } from '../remote/useLiveSync';

let change: ((next: string) => void) | undefined;
let subscription: jest.SpyInstance;
function Harness({ sync, enabled = true, wake = 0 }: { sync: (wait: number) => Promise<void>; enabled?: boolean; wake?: number }) {
  useLiveSync(enabled, enabled, false, sync, wake);
  return null;
}
beforeEach(() => {
  jest.useFakeTimers();
  AppState.currentState = 'active';
  change = undefined;
  subscription = jest.spyOn(AppState, 'addEventListener').mockImplementation((_kind, callback) => {
    change = callback as (next: string) => void;
    return { remove: () => { change = undefined; } };
  });
});
afterEach(() => { subscription.mockRestore(); jest.useRealTimers(); });
async function advance(ms: number) { await act(async () => { jest.advanceTimersByTime(ms); }); }

test('background and hidden threads do not keep retrying, foreground tries immediately', async () => {
  const sync = jest.fn(async () => { throw new Error('offline fixture'); });
  const view = await render(<Harness sync={sync} />);
  expect(sync).toHaveBeenCalledTimes(1);
  await advance(1999); expect(sync).toHaveBeenCalledTimes(1);
  await advance(1); expect(sync).toHaveBeenCalledTimes(2);
  await act(async () => { AppState.currentState = 'background'; change?.('background'); });
  await advance(600_000); expect(sync).toHaveBeenCalledTimes(2);
  await act(async () => { AppState.currentState = 'active'; change?.('active'); });
  expect(sync).toHaveBeenCalledTimes(3);
  await advance(1999); expect(sync).toHaveBeenCalledTimes(3);
  await advance(1); expect(sync).toHaveBeenCalledTimes(4);
  await view.rerender(<Harness sync={sync} enabled={false} />);
  await advance(600_000); expect(sync).toHaveBeenCalledTimes(4);
  await view.unmount();
});

test('a new send or successful manual refresh wakes a backed-off thread immediately', async () => {
  const sync = jest.fn(async () => { throw new Error('offline fixture'); });
  const view = await render(<Harness sync={sync} wake={0} />);
  expect(sync).toHaveBeenCalledTimes(1);
  await view.rerender(<Harness sync={sync} wake={1} />);
  expect(sync).toHaveBeenCalledTimes(2);
  await advance(1999); expect(sync).toHaveBeenCalledTimes(2);
  await advance(1); expect(sync).toHaveBeenCalledTimes(3);
  await view.unmount();
  await advance(600_000); expect(sync).toHaveBeenCalledTimes(3);
});

test('one successful synchronization resets failed-request backoff', async () => {
  const sync = jest.fn<Promise<void>, [number]>()
    .mockRejectedValueOnce(new Error('offline fixture'))
    .mockRejectedValueOnce(new Error('offline fixture'))
    .mockResolvedValueOnce(undefined)
    .mockImplementation(() => new Promise(() => undefined));
  const view = await render(<Harness sync={sync} />);
  await advance(2000); expect(sync).toHaveBeenCalledTimes(2);
  await advance(4000); expect(sync).toHaveBeenCalledTimes(3);
  // The normal short-read cadence after three attempts is four seconds,
  // rather than the failed-request delay of eight seconds.
  await advance(3999); expect(sync).toHaveBeenCalledTimes(3);
  await advance(1); expect(sync).toHaveBeenCalledTimes(4);
  await view.unmount();
});
