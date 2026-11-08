import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { EffortScrubChip } from '../remote/EffortScrub';
import { hapticEffort } from '../remote/haptics';

jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => ({ useReducedMotion: () => true }));
jest.mock('../remote/haptics', () => ({ hapticEffort: jest.fn(), hapticModelTick: jest.fn(), hapticModelCommit: jest.fn() }));

type Props = React.ComponentProps<typeof EffortScrubChip>;
let appChange: (next: string) => void;
const remove = jest.fn();
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    appChange = callback as (next: string) => void; return { remove };
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

async function mount(extra: Partial<Props> = {}) {
  const props: Props = { levels: ['', 'low', 'medium', 'high'], value: 'low', scopeKey: 'paired|pc|key-a|model-a', onScrub: jest.fn(), ...extra };
  return { props, view: await render(<EffortScrubChip {...props} />) };
}
type Mounted = Awaited<ReturnType<typeof mount>>;
async function begin({ view }: Mounted) {
  await fireEvent(view.getByTestId('remote-effort-touch'), 'touchStart', { nativeEvent: { pageX: 100 } });
  await fireEvent(view.getByTestId('remote-effort-chip'), 'longPress');
}
async function move({ view }: Mounted) {
  await fireEvent(view.getByTestId('remote-effort-touch'), 'touchMove', { nativeEvent: { pageX: 168 } });
}
async function end({ view }: Mounted) { await fireEvent(view.getByTestId('remote-effort-touch'), 'touchEnd'); }

test('a physical hold and slide commits exactly the displayed effort once', async () => {
  const mounted = await mount(); await begin(mounted); await move(mounted); await end(mounted); await end(mounted);
  expect(mounted.props.onScrub).toHaveBeenNthCalledWith(1, { phase: 'start', index: 1 });
  expect(mounted.props.onScrub).toHaveBeenNthCalledWith(2, { phase: 'move', index: 3 });
  expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'end', index: 3 });
  expect(mounted.props.onScrub).toHaveBeenCalledTimes(3);
  expect(hapticEffort).toHaveBeenNthCalledWith(1, 'low');
  expect(hapticEffort).toHaveBeenNthCalledWith(2, 'high');
});

test('an ordinary tap changes exactly one reported level with tactile feedback', async () => {
  const mounted = await mount({ levels: ['', 'none', 'minimal', 'low'], value: 'none' });
  await fireEvent.press(mounted.view.getByTestId('remote-effort-chip'));
  expect(mounted.props.onScrub).toHaveBeenNthCalledWith(1, { phase: 'start', index: 1 });
  expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'end', index: 2 });
  expect(hapticEffort).toHaveBeenCalledWith('minimal');
});

test('tapping the highest available level returns to following the computer without inventing another level', async () => {
  const mounted = await mount({ levels: ['', 'low', 'high'], value: 'high' });
  await fireEvent.press(mounted.view.getByTestId('remote-effort-chip'));
  expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'end', index: 0 });
  expect(hapticEffort).toHaveBeenCalledWith('');
});

test('a native trailing press after hold-release cannot advance a second time', async () => {
  const mounted = await mount(); await begin(mounted); await move(mounted); await end(mounted);
  await fireEvent.press(mounted.view.getByTestId('remote-effort-chip'));
  expect(mounted.props.onScrub).toHaveBeenCalledTimes(3);
  expect(hapticEffort).toHaveBeenCalledTimes(2);
});

test('a cancelled short touch cannot become a tap through a late native press callback', async () => {
  const mounted = await mount();
  await fireEvent(mounted.view.getByTestId('remote-effort-touch'), 'touchStart', { nativeEvent: { pageX: 100 } });
  await fireEvent(mounted.view.getByTestId('remote-effort-touch'), 'touchCancel');
  await fireEvent.press(mounted.view.getByTestId('remote-effort-chip'));
  expect(mounted.props.onScrub).not.toHaveBeenCalled(); expect(hapticEffort).not.toHaveBeenCalled();
});

test('a re-entering press-in does not discard an active scrub, and accessibility changes vibrate', async () => {
  const mounted = await mount(); await begin(mounted); await move(mounted);
  await fireEvent(mounted.view.getByTestId('remote-effort-chip'), 'pressIn', { nativeEvent: { pageX: 168 } });
  await end(mounted);
  expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'end', index: 3 });
  jest.mocked(hapticEffort).mockClear();
  await fireEvent(mounted.view.getByTestId('remote-effort-chip'), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
  expect(hapticEffort).toHaveBeenCalledWith('medium');
});

test.each(['scopeKey', 'levels', 'value', 'disabled'] as const)('%s changes cancel an old gesture instead of applying it to another model', async changed => {
  const mounted = await mount(); await begin(mounted); await move(mounted);
  const updates: Record<typeof changed, Partial<Props>> = {
    scopeKey: { scopeKey: 'paired|pc|key-b|model-b' }, levels: { levels: ['', 'low', 'high'] }, value: { value: 'medium' }, disabled: { disabled: true },
  };
  await mounted.view.rerender(<EffortScrubChip {...mounted.props} {...updates[changed]} />);
  await end(mounted);
  expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'cancel', index: 3 });
  expect((mounted.props.onScrub as jest.Mock).mock.calls.some(([event]) => event.phase === 'end')).toBe(false);
});

test('backgrounding cancels active and not-yet-long-pressed touches; a new touch still works', async () => {
  const mounted = await mount(); await begin(mounted); await move(mounted);
  await act(async () => { AppState.currentState = 'background'; appChange('background'); });
  await act(async () => { AppState.currentState = 'active'; appChange('active'); });
  await end(mounted);
  expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'cancel', index: 3 });
  (mounted.props.onScrub as jest.Mock).mockClear();
  await fireEvent(mounted.view.getByTestId('remote-effort-touch'), 'touchStart', { nativeEvent: { pageX: 100 } });
  await act(async () => { AppState.currentState = 'background'; appChange('background'); });
  await act(async () => { AppState.currentState = 'active'; appChange('active'); });
  await fireEvent(mounted.view.getByTestId('remote-effort-chip'), 'longPress'); await end(mounted);
  expect(mounted.props.onScrub).not.toHaveBeenCalled();
  await begin(mounted); await move(mounted); await end(mounted);
  expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'end', index: 3 });
});

test('a queued accessibility callback cannot apply an old owner after a rerender', async () => {
  const mounted = await mount();
  const activate = mounted.view.getByTestId('remote-effort-chip').props.onAccessibilityAction;
  await mounted.view.rerender(<EffortScrubChip {...mounted.props} scopeKey="new-key" />);
  await act(async () => { activate({ nativeEvent: { actionName: 'increment' } }); });
  expect(mounted.props.onScrub).not.toHaveBeenCalled();
  await fireEvent(mounted.view.getByTestId('remote-effort-chip'), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
  expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'end', index: 2 });
});

test('unmount cancels rather than commits a held value', async () => {
  const mounted = await mount(); await begin(mounted); await mounted.view.unmount();
  expect(remove).toHaveBeenCalled(); expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'cancel', index: 1 });
});

test('a queued previous-owner touch cannot end or cancel the replacement gesture', async () => {
  const mounted = await mount(); await begin(mounted);
  const oldTouch = mounted.view.getByTestId('remote-effort-touch').props;
  await mounted.view.rerender(<EffortScrubChip {...mounted.props} scopeKey="replacement-model" />);
  await begin(mounted); await move(mounted);
  (mounted.props.onScrub as jest.Mock).mockClear();
  await act(async () => {
    oldTouch.onTouchStart({ nativeEvent: { pageX: 10 } });
    oldTouch.onTouchMove({ nativeEvent: { pageX: 10 } });
    oldTouch.onTouchEnd(); oldTouch.onTouchCancel();
  });
  expect(mounted.props.onScrub).not.toHaveBeenCalled();
  await end(mounted);
  expect(mounted.props.onScrub).toHaveBeenLastCalledWith({ phase: 'end', index: 3 });
});
