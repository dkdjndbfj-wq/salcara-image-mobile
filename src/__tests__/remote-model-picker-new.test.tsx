import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState, PanResponder } from 'react-native';
import { MODEL_HOLD_STEP_MS, ModelPopover } from '../remote/ModelPopover';

jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => ({ useReducedMotion: () => true }));

type Props = React.ComponentProps<typeof ModelPopover>;
type Mounted = Awaited<ReturnType<typeof mount>>;
type PanConfig = Parameters<typeof PanResponder.create>[0];
let mockPan: PanConfig;
let mockAppState: (state: string) => void;
const mockRemoveListener = jest.fn();
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
const LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

async function mount(extra: Partial<Props> = {}) {
  const props: Props = {
    visible: true, anchor: null, value: CLAUDE_MODELS[0], fallback: '', models: CLAUDE_MODELS,
    loading: false, onRefresh: jest.fn(), onSelect: jest.fn(), onClose: jest.fn(),
    effort: 'xhigh', effortLevels: LEVELS, scopeKey: 'paired|pc|codex|api-main', ...extra,
  };
  const view = await render(<ModelPopover {...props} />);
  return { view, props };
}

function node(mounted: Mounted, id = mounted.props.models[0]) {
  const found = mounted.view.getAllByRole('radio').find((item) => item.props.accessibilityHint === id);
  if (!found) throw new Error(`No visible model: ${id}`);
  return found;
}

async function perform(action: () => unknown) { await act(async () => { action(); }); }
async function advance(ms: number) { await perform(() => jest.advanceTimersByTime(ms)); }
async function begin(mounted: Mounted, id?: string) { await fireEvent(node(mounted, id), 'pressIn'); }
async function physicalEnd(mounted: Mounted) { await perform(() => mounted.view.getByTestId('remote-model-orbit').props.onTouchEnd()); }
async function choose(mounted: Mounted, id?: string) { await fireEvent.press(node(mounted, id)); }
async function rerender(mounted: Mounted, extra: Partial<Props>) {
  mounted.props = { ...mounted.props, ...extra };
  await mounted.view.rerender(<ModelPopover {...mounted.props} />);
}

beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks();
  AppState.currentState = 'active';
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
  jest.spyOn(PanResponder, 'create').mockImplementation((config) => { mockPan = config; return { panHandlers: {} }; });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    mockAppState = listener as (state: string) => void; return { remove: mockRemoveListener };
  });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('single-family labels are shortened but selected commands keep the exact full ID', async () => {
  const mounted = await mount();
  expect(mounted.view.getByText('Claude')).toBeTruthy();
  expect(mounted.view.getByRole('radio', { name: 'opus-5-5' })).toBeTruthy();
  expect(mounted.view.getByRole('radio', { name: 'sonnet-5-5' })).toBeTruthy();
  await begin(mounted); expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('Low');
  await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith('claude-opus-5-5', 'low');
  expect(mounted.props.onSelect).toHaveBeenCalledTimes(1);
});

test.each([
  ['mixed providers', ['claude-opus-5-5', 'gpt-5.5'], 'claude-opus-5-5', null],
  ['unknown deployment alias', ['claude-opus-5-5', 'company-claude-main'], 'claude-opus-5-5', null],
  ['custom namespace', ['deployment/claude-opus-5-5'], 'deployment/claude-opus-5-5', null],
  ['provider namespace', ['anthropic/claude-opus-5-5'], 'opus-5-5', 'Claude'],
  ['date and mode suffix', ['claude-sonnet-4-5-20260917-thinking'], 'sonnet-4-5-20260917-thinking', 'Claude'],
] as const)('%s is displayed conservatively and never rewritten when selected', async (_name, ids, label, family) => {
  const mounted = await mount({ models: [...ids], value: ids[0] });
  expect(mounted.view.getByRole('radio', { name: label })).toBeTruthy();
  if (family) expect(mounted.view.getByText(family)).toBeTruthy(); else expect(mounted.view.queryByText('Claude')).toBeNull();
  await begin(mounted); await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(ids[0], 'low');
});

test('direct and namespaced short-name collisions remain separately identifiable', async () => {
  const mounted = await mount({ models: ['claude-opus-5-5', 'anthropic/claude-opus-5-5'] });
  expect(mounted.view.getByRole('radio', { name: 'claude-opus-5-5' })).toBeTruthy();
  expect(mounted.view.getByRole('radio', { name: 'anthropic/claude-opus-5-5' })).toBeTruthy();
  await begin(mounted, 'anthropic/claude-opus-5-5'); await physicalEnd(mounted); await choose(mounted, 'anthropic/claude-opus-5-5');
  expect(mounted.props.onSelect).toHaveBeenCalledWith('anthropic/claude-opus-5-5', 'low');
});

test('each new physical press starts at Low, including the selected model with a saved XHigh', async () => {
  const mounted = await mount();
  expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('XHigh');
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS * 2);
  expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('High');
  await perform(() => mounted.view.getByTestId('remote-model-orbit').props.onTouchCancel());
  expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('XHigh');
  await begin(mounted); expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('Low');
  await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0], 'low');
});

test('models with the same family get only their own reported effort options', async () => {
  const mounted = await mount({ modelCapabilities: {
    [CLAUDE_MODELS[0]]: { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['low', 'high'] },
    [CLAUDE_MODELS[1]]: { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['medium'] },
  } });
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS);
  expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('High');
  await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0], 'high');
  const sibling = await mount({ modelCapabilities: {
    [CLAUDE_MODELS[0]]: { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['low', 'high'] },
    [CLAUDE_MODELS[1]]: { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['medium'] },
  } });
  await begin(sibling, CLAUDE_MODELS[1]); await advance(MODEL_HOLD_STEP_MS * 8);
  expect(sibling.view.queryByTestId('remote-model-effort-preview')).toBeNull();
  await physicalEnd(sibling); await choose(sibling, CLAUDE_MODELS[1]);
  expect(sibling.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[1]);
});

test('metadata changes invalidate a held XHigh release even if the model ID is unchanged', async () => {
  const mounted = await mount({ modelCapabilities: { [CLAUDE_MODELS[0]]: { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: [...LEVELS] } } });
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS * 3);
  expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('XHigh');
  await rerender(mounted, { modelCapabilities: { [CLAUDE_MODELS[0]]: { source: 'relay-model-list', reasoningKnown: false } } });
  await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).not.toHaveBeenCalled();
  await begin(mounted); await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0]);
});

test('holding advances every 850ms, stops at the supported maximum, and commits only once on release', async () => {
  const mounted = await mount();
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS - 1);
  expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('Low');
  await advance(1); expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('Medium');
  await advance(MODEL_HOLD_STEP_MS); expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('High');
  await advance(MODEL_HOLD_STEP_MS * 8); expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('XHigh');
  expect(mounted.props.onSelect).not.toHaveBeenCalled();
  await physicalEnd(mounted); await choose(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledTimes(1);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0], 'xhigh');
});

test('a model capability cap prevents inventing a higher strength', async () => {
  const mounted = await mount({ effortLevels: ['low', 'medium'] });
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS * 8); await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0], 'medium');
});

test('physical touchEnd stops the timer before delayed onPress, without losing the completed tier', async () => {
  const mounted = await mount();
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS); await physicalEnd(mounted);
  await advance(MODEL_HOLD_STEP_MS * 10);
  expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('Medium');
  await choose(mounted); expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0], 'medium');
});

test('upper/backdrop dismiss cancels a held preview and never selects on its late release', async () => {
  const mounted = await mount();
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS);
  await fireEvent.press(mounted.view.getByTestId('remote-model-backdrop'));
  await advance(MODEL_HOLD_STEP_MS * 4); await choose(mounted);
  expect(mounted.props.onClose).toHaveBeenCalledTimes(1); expect(mounted.props.onSelect).not.toHaveBeenCalled();
  expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('XHigh');
});

test('a dismissed overlay cannot reactivate from loading-only rerenders', async () => {
  const mounted = await mount();
  await fireEvent.press(mounted.view.getByTestId('remote-model-backdrop'));
  await rerender(mounted, { loading: true }); await rerender(mounted, { loading: false });
  await begin(mounted); await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).not.toHaveBeenCalled();
});

test('the Key entry abandons the model preview and invokes only API selection', async () => {
  const api = jest.fn(); const mounted = await mount({ onApi: api, apiName: '主力' });
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS * 2);
  await fireEvent.press(mounted.view.getByLabelText('更换对话 API'));
  await advance(MODEL_HOLD_STEP_MS * 4); await choose(mounted);
  expect(mounted.view.getByText('API：主力')).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(1); expect(mounted.props.onSelect).not.toHaveBeenCalled(); expect(mounted.props.onClose).not.toHaveBeenCalled();
});

test('horizontal swipe cancels holding and previews the newly browsed model at Low without committing', async () => {
  const mounted = await mount();
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS);
  expect(mockPan.onMoveShouldSetPanResponderCapture?.({} as never, { dx: 20, dy: 2 } as never)).toBe(true);
  expect(mockPan.onMoveShouldSetPanResponderCapture?.({} as never, { dx: 2, dy: 20 } as never)).toBe(false);
  await perform(() => mockPan.onPanResponderGrant?.({} as never, {} as never));
  await perform(() => mockPan.onPanResponderMove?.({} as never, { dx: -78, dy: 0 } as never));
  await perform(() => mockPan.onPanResponderRelease?.({} as never, {} as never));
  await advance(MODEL_HOLD_STEP_MS * 4); await choose(mounted);
  expect(mounted.view.getByText('2 / 3')).toBeTruthy();
  expect(mounted.view.getByTestId('remote-model-effort-preview').props.children).toBe('Low');
  expect(mounted.props.onSelect).not.toHaveBeenCalled();
});

test('vertical or diagonal touch movement beyond 16px also cancels pending selection', async () => {
  const mounted = await mount(); await begin(mounted);
  const fan = mounted.view.getByTestId('remote-model-orbit');
  await perform(() => fan.props.onTouchStart({ nativeEvent: { pageX: 100, pageY: 100 } }));
  await perform(() => fan.props.onTouchMove({ nativeEvent: { pageX: 102, pageY: 120 } }));
  await advance(MODEL_HOLD_STEP_MS * 4); await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).not.toHaveBeenCalled();
});

test('small movement keeps a deliberate press valid', async () => {
  const mounted = await mount(); await begin(mounted);
  const fan = mounted.view.getByTestId('remote-model-orbit');
  await perform(() => fan.props.onTouchStart({ nativeEvent: { pageX: 100, pageY: 100 } }));
  await perform(() => fan.props.onTouchMove({ nativeEvent: { pageX: 104, pageY: 104 } }));
  await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0], 'low');
});

test.each(['scopeKey', 'models', 'loading', 'selectionEnabled', 'effortLevels'] as const)('%s invalidation leaves a cancellation tombstone for late releases', async (changed) => {
  const mounted = await mount(); await begin(mounted); await advance(MODEL_HOLD_STEP_MS);
  const updates: Record<typeof changed, Partial<Props>> = {
    scopeKey: { scopeKey: 'paired|pc|codex|api-new' },
    models: { models: [...CLAUDE_MODELS, 'claude-sonnet-5-5-fast'] },
    loading: { loading: true }, selectionEnabled: { selectionEnabled: false }, effortLevels: { effortLevels: ['low', 'high'] },
  };
  await rerender(mounted, updates[changed]);
  if (changed === 'loading') await rerender(mounted, { loading: false });
  if (changed === 'selectionEnabled') await rerender(mounted, { selectionEnabled: true });
  await choose(mounted); await advance(MODEL_HOLD_STEP_MS * 4);
  expect(mounted.props.onSelect).not.toHaveBeenCalled();
});

test('background then foreground cancels the old press, but permits a new physical activation', async () => {
  const mounted = await mount(); await begin(mounted); await advance(MODEL_HOLD_STEP_MS);
  AppState.currentState = 'background'; await perform(() => mockAppState('background'));
  await advance(MODEL_HOLD_STEP_MS * 3);
  AppState.currentState = 'active'; await perform(() => mockAppState('active')); await choose(mounted);
  expect(mounted.props.onSelect).not.toHaveBeenCalled();
  await begin(mounted); await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0], 'low');
});

test('accessibility activation starts a new generation after a cancelled physical gesture', async () => {
  const mounted = await mount(); await begin(mounted); await advance(MODEL_HOLD_STEP_MS);
  await perform(() => mounted.view.getByTestId('remote-model-orbit').props.onTouchCancel());
  await fireEvent(node(mounted), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0], 'low');
  expect(mounted.props.onSelect).toHaveBeenCalledTimes(1);
});

test('unsupported Claude tools submit only the model ID and show no fabricated effort selector', async () => {
  const mounted = await mount({ effortLevels: [] });
  expect(mounted.view.queryByTestId('remote-model-effort-preview')).toBeNull();
  await begin(mounted); await advance(MODEL_HOLD_STEP_MS * 10); await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0]);
});

test('levels that cannot accept Low do not invent a Low override', async () => {
  const mounted = await mount({ effortLevels: ['medium', 'high'] });
  expect(mounted.view.queryByTestId('remote-model-effort-preview')).toBeNull();
  await begin(mounted); await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).toHaveBeenCalledWith(CLAUDE_MODELS[0]);
});

test('native desktop Live disables selection and delegates only the computer-settings action', async () => {
  const follow = jest.fn(); const mounted = await mount({ selectionEnabled: false, effortLevels: [], onFollowComputer: follow });
  expect(mounted.view.getByText('跟随电脑')).toBeTruthy();
  expect(mounted.view.getByRole('radio', { name: 'opus-5-5' }).props.accessibilityState.disabled).toBe(true);
  await begin(mounted); await physicalEnd(mounted); await choose(mounted);
  expect(mounted.props.onSelect).not.toHaveBeenCalled();
  await fireEvent.press(mounted.view.getByLabelText('使用电脑设置'));
  expect(follow).toHaveBeenCalledTimes(1); expect(mounted.props.onSelect).not.toHaveBeenCalled();
});

test('refresh cancels the model preview and is disabled during a pending catalog request', async () => {
  const mounted = await mount(); await begin(mounted); await advance(MODEL_HOLD_STEP_MS);
  await fireEvent.press(mounted.view.getByLabelText('刷新模型列表'));
  expect(mounted.props.onRefresh).toHaveBeenCalledTimes(1); await choose(mounted); expect(mounted.props.onSelect).not.toHaveBeenCalled();
  await rerender(mounted, { loading: true });
  await fireEvent.press(mounted.view.getByLabelText('刷新模型列表'));
  expect(mounted.props.onRefresh).toHaveBeenCalledTimes(1);
});

test('managed catalogs never offer retired saved IDs or an unverified fallback', async () => {
  const mounted = await mount({ value: 'retired', fallback: 'retired-default', models: ['claude-opus-5-5'], catalogOnly: true, catalogReady: false });
  expect(mounted.view.queryAllByRole('radio')).toHaveLength(0);
  await rerender(mounted, { catalogReady: true });
  expect(mounted.view.getAllByRole('radio')).toHaveLength(1);
  expect(mounted.view.queryByRole('radio', { name: 'retired' })).toBeNull();
  expect(mounted.view.queryByRole('radio', { name: 'retired-default' })).toBeNull();
});

test('unmount clears a pending hold and removes the AppState listener', async () => {
  const mounted = await mount(); await begin(mounted);
  await mounted.view.unmount(); await advance(MODEL_HOLD_STEP_MS * 10);
  expect(mockRemoveListener).toHaveBeenCalledTimes(1);
  expect(mounted.props.onSelect).not.toHaveBeenCalled();
});
