/** @jest-environment jsdom */
import React, { act } from 'react';
import { useWorkspaceShortcuts, type WorkspaceShortcutActions } from '../remote/useWorkspaceShortcuts.web';
const { createRoot } = require('react-dom/client') as {
  createRoot(container: Element): { render(node: React.ReactNode): void; unmount(): void };
};

let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
let actions: WorkspaceShortcutActions;
function Harness({ value }: { value: WorkspaceShortcutActions }) {
  useWorkspaceShortcuts(value);
  return <input aria-label="composer" />;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  actions = { active: true, visible: true, onBrowser: jest.fn(), onReview: jest.fn(), onSideChat: jest.fn(),
    onFiles: jest.fn(), onTerminal: jest.fn(), onClose: jest.fn(), onRestore: jest.fn(), onPrevious: jest.fn(),
    onNext: jest.fn(), onCloseOthers: jest.fn(), onCycleLayout: jest.fn(), onToggleFull: jest.fn(), onTogglePanel: jest.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); jest.restoreAllMocks(); });
async function mount(value = actions) { await act(async () => root.render(<Harness value={value} />)); }
async function key(key: string, modifiers: KeyboardEventInit = {}, target: EventTarget = host.querySelector('input')!) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...modifiers });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

test.each<[string, KeyboardEventInit, keyof WorkspaceShortcutActions]>([
  ['t', {}, 'onBrowser'], ['T', { shiftKey: true }, 'onRestore'],
  ['G', { shiftKey: true }, 'onReview'], ['s', { altKey: true }, 'onSideChat'],
  ['E', { shiftKey: true }, 'onFiles'], ['p', {}, 'onFiles'], ['`', {}, 'onTerminal'],
  ['B', { shiftKey: true }, 'onCycleLayout'], ['b', { altKey: true }, 'onTogglePanel'],
  ['F', { shiftKey: true }, 'onToggleFull'], ['w', {}, 'onClose'],
  ['w', { altKey: true }, 'onCloseOthers'], ['Tab', {}, 'onNext'], ['Tab', { shiftKey: true }, 'onPrevious'],
])('%s dispatches only the mapped workspace action with modifiers %j', async (name, modifiers, action) => {
  await mount(); const event = await key(name, modifiers);
  expect(actions[action]).toHaveBeenCalledTimes(1);
  for (const [other, value] of Object.entries(actions)) if (typeof value === 'function' && other !== action) expect(value).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(true);
});

test('a hidden workspace can open new content but cannot close or cycle hidden pages', async () => {
  await mount({ ...actions, visible: false });
  expect((await key('w')).defaultPrevented).toBe(false);
  expect((await key('Tab')).defaultPrevented).toBe(false);
  await key('t'); expect(actions.onBrowser).toHaveBeenCalledTimes(1);
  expect(actions.onClose).not.toHaveBeenCalled(); expect(actions.onNext).not.toHaveBeenCalled();
});

test('dialog inputs retain their keyboard events', async () => {
  await mount(); const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
  const input = document.createElement('input'); dialog.append(input); host.append(dialog);
  expect((await key('t', {}, input)).defaultPrevented).toBe(false);
  expect(actions.onBrowser).not.toHaveBeenCalled();
});

test('a whole-screen native Modal allows workspace shortcuts while its nested dialogs do not', async () => {
  await mount();
  const outer = document.createElement('div'); outer.setAttribute('role', 'dialog');
  const workspace = document.createElement('div'); workspace.id = 'remote-workspace-root';
  const composer = document.createElement('input'); workspace.append(composer); outer.append(workspace); host.append(outer);
  expect((await key('t', {}, composer)).defaultPrevented).toBe(true);
  expect(actions.onBrowser).toHaveBeenCalledTimes(1);
  const inner = document.createElement('div'); inner.setAttribute('role', 'dialog');
  const modalInput = document.createElement('input'); inner.append(modalInput); workspace.append(inner);
  expect((await key('t', {}, modalInput)).defaultPrevented).toBe(false);
  expect(actions.onBrowser).toHaveBeenCalledTimes(1);
});

test('IME composition and AltGraph text entry do not invoke workspace commands', async () => {
  await mount();
  expect((await key('t', { isComposing: true })).defaultPrevented).toBe(false);
  expect((await key('t', { keyCode: 229 })).defaultPrevented).toBe(false);
  const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'getModifierState', { value: (name: string) => name === 'AltGraph' });
  await act(async () => { host.querySelector('input')!.dispatchEvent(event); });
  expect(actions.onBrowser).not.toHaveBeenCalled(); expect(actions.onSideChat).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

test('rerender uses the latest callbacks and deactivation removes its listener', async () => {
  await mount(); const replacement = jest.fn(); await mount({ ...actions, onBrowser: replacement });
  await key('t'); expect(replacement).toHaveBeenCalledTimes(1); expect(actions.onBrowser).not.toHaveBeenCalled();
  await mount({ ...actions, active: false });
  expect((await key('t')).defaultPrevented).toBe(false); expect(actions.onBrowser).not.toHaveBeenCalled();
});

test('an already captured callback cannot dispatch after its conversation becomes inactive', async () => {
  const added = jest.spyOn(window, 'addEventListener'); await mount();
  const listener = added.mock.calls.find(call => call[0] === 'keydown')![1] as (event: KeyboardEvent) => void;
  await mount({ ...actions, active: false });
  const event = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, cancelable: true });
  await act(async () => listener(event));
  expect(actions.onBrowser).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
});

test('unrelated shortcuts and already handled events remain untouched', async () => {
  await mount();
  expect((await key('r', { altKey: true })).defaultPrevented).toBe(false);
  expect((await key('t', { ctrlKey: false })).defaultPrevented).toBe(false);
  const event = new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true, cancelable: true });
  event.preventDefault(); await act(async () => { host.dispatchEvent(event); });
  expect(actions.onBrowser).not.toHaveBeenCalled();
});
