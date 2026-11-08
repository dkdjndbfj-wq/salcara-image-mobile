import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { LimitRetryNotice, limitRetryTime } from '../remote/LimitRetryNotice';

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-07T04:00:00Z')); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
test('only real quota/rate errors with explicit valid reset timestamps expose the option', () => {
  expect(limitRetryTime({ id: 'e', errorCode: 'upstream_unauthorized', retryAt: Date.now() + 5000 })).toBeUndefined();
  expect(limitRetryTime({ id: 'e', errorCode: 'usage_limit' })).toBeUndefined();
  expect(limitRetryTime({ id: 'e', errorCode: 'usage_limit', retryAt: Date.now() + 8 * 86400_000 })).toBeUndefined();
});
test('a reset is informational until the user opts in, then retries exactly once', async () => {
  const retry = jest.fn(), failure = { id: 'e', errorCode: 'usage_limit', retryAt: Date.now() + 3000 };
  const view = await render(<LimitRetryNotice failure={failure} scopeKey="pc:a" cancelKey="draft" enabled onRetry={retry} />);
  await act(async () => { jest.advanceTimersByTime(1000); }); expect(retry).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('额度恢复后重试一次'));
  await act(async () => { jest.advanceTimersByTime(3000); }); expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(10_000); }); expect(retry).toHaveBeenCalledTimes(1);
});
test.each(['scope', 'draft', 'disabled', 'cancel'])('changing %s cancels the scheduled action', async kind => {
  const retry = jest.fn(), failure = { id: 'e', errorCode: 'upstream_rate_limit', retryAt: Date.now() + 5000 };
  const props = { failure, scopeKey: 'pc:a', cancelKey: 'draft', enabled: true, onRetry: retry };
  const view = await render(<LimitRetryNotice {...props} />);
  await fireEvent.press(view.getByLabelText('额度恢复后重试一次'));
  if (kind === 'cancel') await fireEvent.press(view.getByLabelText('取消到时重试'));
  else await view.rerender(<LimitRetryNotice {...props} scopeKey={kind === 'scope' ? 'pc:b' : 'pc:a'} cancelKey={kind === 'draft' ? 'new draft' : 'draft'} enabled={kind !== 'disabled'} />);
  await act(async () => { jest.advanceTimersByTime(10_000); }); expect(retry).not.toHaveBeenCalled();
});

test.each(['background', 'unmount'])('%s cancels the timer without resuming a later retry', async kind => {
  let listener: (state: AppStateStatus) => void = () => {};
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, change) => { listener = change; return { remove: jest.fn() }; });
  const retry = jest.fn();
  const view = await render(<LimitRetryNotice failure={{ id: 'e', errorCode: 'usage_limit', retryAt: Date.now() + 5000 }} scopeKey="pc:a" cancelKey="draft" enabled onRetry={retry} />);
  await fireEvent.press(view.getByLabelText('额度恢复后重试一次'));
  if (kind === 'unmount') await view.unmount();
  else await act(async () => { listener('background'); });
  await act(async () => { jest.advanceTimersByTime(6000); });
  if (kind === 'background') await act(async () => { listener('active'); jest.advanceTimersByTime(6000); });
  expect(retry).not.toHaveBeenCalled();
});
