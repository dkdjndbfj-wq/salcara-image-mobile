/** @jest-environment jsdom */
import React, { act, useState } from 'react';
const { createRoot } = require('react-dom/client') as { createRoot: (container: Element) => { render: (node: React.ReactNode) => void; unmount: () => void } };
type Root = ReturnType<typeof createRoot>;
import { SkillComposerInput } from '../remote/SkillComposerInput.web';
import { reconcileSkillMentions, type SkillMention } from '../remote/skill-mentions';

jest.mock('react-native', () => {
  const descriptors = Object.getOwnPropertyDescriptors(jest.requireActual('react-native'));
  descriptors.StyleSheet = { enumerable: true, configurable: true, value: { flatten: (value: unknown) => value ?? {} } };
  return Object.defineProperties({}, descriptors);
});
jest.mock('../theme', () => ({ useScheme: () => 'light' }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const editor = () => host.querySelector('[role="textbox"]') as HTMLDivElement;
const caret = (position: number) => {
  const input = editor(); input.focus();
  const range = document.createRange(); range.setStart(input.firstChild!, position); range.collapse(true);
  const selected = window.getSelection()!; selected.removeAllRanges(); selected.addRange(range);
};
const caretOffset = () => {
  const selected = window.getSelection()!, range = document.createRange();
  range.selectNodeContents(editor()); range.setEnd(selected.focusNode!, selected.focusOffset); return range.toString().length;
};
function Harness({ initial = 'abcd', mentions: initialMentions = [], maxLength }: { initial?: string; mentions?: SkillMention[]; maxLength?: number }) {
  const [state, setState] = useState({ text: initial, mentions: initialMentions });
  return <SkillComposerInput value={state.text} mentions={state.mentions} maxLength={maxLength} accessibilityLabel="编辑消息"
    onChangeText={value => setState(current => reconcileSkillMentions(current.text, value, current.mentions))} onSkillEdit={setState} />;
}

test('paste inserts plain text at the caret and advances the caret for the next edit', async () => {
  await act(async () => root.render(<Harness />)); caret(2);
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'X' } });
  await act(async () => { editor().dispatchEvent(event); });
  expect(editor().textContent).toBe('abXcd'); expect(caretOffset()).toBe(3);
  expect(event.defaultPrevented).toBe(true);
});

test('Enter creates one newline and moves the caret, while menu confirmation prevents insertion', async () => {
  await act(async () => root.render(<Harness />)); caret(2);
  await act(async () => { editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  expect(editor().textContent).toBe('ab\ncd'); expect(caretOffset()).toBe(3);
  const changed = jest.fn();
  await act(async () => root.render(<SkillComposerInput value="/plan" mentions={[]} onChangeText={changed} onKeyPress={event => event.preventDefault()} />));
  await act(async () => { editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  expect(changed).not.toHaveBeenCalled();
});

test('keyboard modifiers reach the owner and Shift+Enter remains a newline when the owner accepts plain Enter', async () => {
  const changed = jest.fn(), pressed = jest.fn(event => {
    if (event.nativeEvent.key === 'Enter' && !event.nativeEvent.shiftKey) event.preventDefault();
  });
  await act(async () => root.render(<SkillComposerInput value="/plan" mentions={[]} onChangeText={changed} onKeyPress={pressed} />));
  caret(5);
  const shifted = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => editor().dispatchEvent(shifted));
  expect(pressed.mock.calls[0][0].nativeEvent).toMatchObject({ key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false });
  expect(changed).toHaveBeenLastCalledWith('/plan\n'); changed.mockClear();
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(changed).not.toHaveBeenCalled();
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, altKey: true, metaKey: true, bubbles: true, cancelable: true })));
  expect(pressed.mock.calls.at(-1)?.[0].nativeEvent).toMatchObject({ key: 'a', shiftKey: false, ctrlKey: true, altKey: true, metaKey: true });
});

test('the trailing newline has a browser caret target that never becomes extra draft text', async () => {
  await act(async () => root.render(<Harness initial="中文" />));caret(2);
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })));
  expect(editor().textContent).toBe('中文\n');expect(caretOffset()).toBe(3);
  expect(editor().querySelector('br[data-composer-caret]')).not.toBeNull();
  editor().firstChild!.textContent += '下一行';caret(6);
  await act(async () => editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' })));
  expect(editor().textContent).toBe('中文\n下一行');expect(caretOffset()).toBe(6);
  expect(editor().querySelector('br[data-composer-caret]')).toBeNull();
});

test.each(['Enter','ArrowUp','Escape'])('IME keyCode 229 keeps %s inside the input method instead of triggering composer shortcuts',async key=>{
  const changed=jest.fn(),shortcut=jest.fn(event=>event.preventDefault());
  await act(async()=>root.render(<SkillComposerInput value="中文" mentions={[]} onChangeText={changed} onKeyPress={shortcut}/>));
  caret(2);
  const event=new KeyboardEvent('keydown',{key,keyCode:229,isComposing:false,bubbles:true,cancelable:true});
  await act(async()=>editor().dispatchEvent(event));
  expect(shortcut).not.toHaveBeenCalled();expect(changed).not.toHaveBeenCalled();expect(event.defaultPrevented).toBe(false);
  await act(async()=>editor().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
  expect(shortcut).toHaveBeenCalledTimes(1);
});

test.each([
  ['first<div>second</div>', 'first\nsecond'],
  ['<div>first</div><div>second</div>', 'first\nsecond'],
  ['first<br>second', 'first\nsecond'],
  ['first<div><br></div>', 'first\n'],
  ['<div>first</div><div><br></div><div>third</div>', 'first\n\nthird'],
  ['<div>first</div><div>second<br>third</div>', 'first\nsecond\nthird'],
  ['<br>', ''],
])('soft keyboard DOM %s retains its line boundaries without a keydown event', async (html, expected) => {
  await act(async () => root.render(<Harness initial="" />));
  await act(async () => {
    editor().innerHTML = html;
    editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertParagraph' }));
  });
  expect(editor().textContent).toBe(expected);
});

test('a soft keyboard paragraph after a skill retains its identity and the caret on the new line', async () => {
  await act(async () => root.render(<Harness initial="$review first" mentions={[{ start: 0, end: 7, skill: { name: 'review', path: '/a/SKILL.md' } }]} />));
  const line = document.createElement('div'); line.textContent = 'second'; editor().append(line); editor().focus();
  const range = document.createRange(); range.setStart(line.firstChild!, 6); range.collapse(true);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  await act(async () => editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertParagraph' })));
  expect(editor().textContent).toBe('review first\nsecond');
  expect(editor().querySelector('[data-skill-mention]')?.getAttribute('title')).toBe('/a/SKILL.md');
  expect(caretOffset()).toBe('review first\nsecond'.length);
});

test('composition commits paragraph boundaries once and keeps uncommitted text with the browser', async () => {
  const changed = jest.fn();
  await act(async () => root.render(<SkillComposerInput value="first" mentions={[]} onChangeText={changed} />));
  await act(async () => {
    editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    editor().innerHTML = 'first<div>第二行</div>';
    editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
  });
  expect(changed).not.toHaveBeenCalled();
  await act(async () => editor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  expect(changed).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledWith('first\n第二行');
});

test('selected skills render non-editable inline tokens with the exact path', async () => {
  await act(async () => root.render(<Harness initial="$review task" mentions={[{ start: 0, end: 7, skill: { name: 'review', path: '/a/SKILL.md' } }]} />));
  const token = editor().querySelector('[data-skill-mention]') as HTMLSpanElement;
  expect(token.contentEditable).toBe('false'); expect(token.textContent).toBe('review'); expect(token.title).toBe('/a/SKILL.md');
  expect(editor().textContent).toBe('review task');
  expect(token.style.color).toBe('rgb(46, 130, 210)'); expect(token.style.backgroundColor).toBe('');
});

test.each(['R', '远程代码检查 with long label'])('custom label %s keeps canonical selection for typing and atomic delete', async displayName => {
  await act(async () => root.render(<Harness initial="$review task" mentions={[{ start: 0, end: 7, skill: { name: 'review', path: '/a/SKILL.md', displayName, brandColor: '#8A42EF' } }]} />));
  const token = editor().querySelector('[data-skill-mention]') as HTMLSpanElement;
  expect(token.textContent).toBe(displayName); expect(token.style.color).toBe('rgb(138, 66, 239)');
  editor().focus(); const range = document.createRange(); range.setStartAfter(token); range.collapse(true);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
  await act(async () => { editor().dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true); expect(editor().textContent).toBe(' task'); expect(caretOffset()).toBe(0);
});

test('native numeric line height stays pixel-sized on the web without changing the other input styles', async () => {
  await act(async () => root.render(<SkillComposerInput value="first\nsecond" mentions={[]}
    style={{ fontSize: 15, lineHeight: 21, paddingTop: 8, paddingBottom: 4, minHeight: 40, maxHeight: 150, fontWeight: '500', opacity: 0.75 }} />));
  expect(editor().style.lineHeight).toBe('21px'); expect(editor().style.fontSize).toBe('15px');
  expect(editor().style.paddingTop).toBe('8px'); expect(editor().style.paddingBottom).toBe('4px');
  expect(editor().style.minHeight).toBe('40px'); expect(editor().style.maxHeight).toBe('150px');
  expect(editor().style.fontWeight).toBe('500'); expect(editor().style.opacity).toBe('0.75');
  await act(async () => root.render(<SkillComposerInput value="first\nsecond" mentions={[]} style={{ fontSize: 14 }} />));
  expect(editor().style.lineHeight).toBe(''); expect(editor().style.fontSize).toBe('14px');
});

test('native horizontal and vertical spacing applies to the DOM while explicit edge values take precedence', async () => {
  await act(async () => root.render(<SkillComposerInput value="first\nsecond" mentions={[]} style={{
    paddingHorizontal: 12, paddingVertical: 8, paddingLeft: 4, paddingBottom: 6,
    marginHorizontal: 5, marginVertical: 3, marginRight: 2, textAlignVertical: 'top',
  }} />));
  expect(editor().style.paddingLeft).toBe('4px'); expect(editor().style.paddingRight).toBe('12px');
  expect(editor().style.paddingTop).toBe('8px'); expect(editor().style.paddingBottom).toBe('6px');
  expect(editor().style.marginLeft).toBe('5px'); expect(editor().style.marginRight).toBe('2px');
  expect(editor().style.marginTop).toBe('3px'); expect(editor().style.marginBottom).toBe('3px');
});

const pasteText = async (text: string) => {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  await act(async () => editor().dispatchEvent(event));
};

test('maxLength limits new input at the caret and preserves the original suffix', async () => {
  await act(async () => root.render(<Harness initial="abcd" maxLength={6} />));
  await act(async () => {
    editor().textContent = 'abXYZcd'; caret(5);
    editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  expect(editor().textContent).toBe('abXYcd'); expect(caretOffset()).toBe(4);
  await act(async () => {
    editor().textContent = 'abXY!cd'; caret(5);
    editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  });
  expect(editor().textContent).toBe('abXYcd');
});

test('a paste replacing a selection uses only the remaining capacity and retains following text', async () => {
  await act(async () => root.render(<Harness initial="abcdef" maxLength={7} />));
  setRange(2, 4); await pasteText('XYZW');
  expect(editor().textContent).toBe('abXYZef'); expect(caretOffset()).toBe(5);
});

test.each([[4, 'a😀b'], [3, 'ab']])('a maxLength of %i never pastes half of a surrogate pair', async (maxLength, expected) => {
  await act(async () => root.render(<Harness initial="ab" maxLength={maxLength} />));
  caret(1); await pasteText('😀X');
  expect(editor().textContent).toBe(expected);
});

test('composition respects maxLength only on commit and preserves both sides of the composed text', async () => {
  await act(async () => root.render(<Harness initial="abCD" maxLength={6} />));
  await act(async () => {
    editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    editor().textContent = 'ab中文三CD'; caret(5);
    editor().dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' }));
  });
  expect(editor().textContent).toBe('ab中文三CD');
  await act(async () => editor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  expect(editor().textContent).toBe('ab中文CD'); expect(caretOffset()).toBe(4);
});

test('maxLength counts canonical skill invocations and preserves a long skill label and suffix', async () => {
  const displayName = '远程代码检查 with long label';
  await act(async () => root.render(<Harness initial="$review tail" maxLength={14} mentions={[{ start: 0, end: 7, skill: { name: 'review', path: '/a/SKILL.md', displayName } }]} />));
  editor().focus(); const range = document.createRange(); range.setStart(editor().lastChild!, 1); range.collapse(true);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  await pasteText('XYZ');
  expect(editor().textContent).toBe(`${displayName} XYtail`);
  expect(editor().querySelector('[data-skill-mention]')?.getAttribute('title')).toBe('/a/SKILL.md');
});

test('restored text longer than maxLength remains intact and can be reduced without further growth', async () => {
  await act(async () => root.render(<Harness initial="abcdefgh" maxLength={4} />));
  expect(editor().textContent).toBe('abcdefgh');
  caret(2); await pasteText('X'); expect(editor().textContent).toBe('abcdefgh');
  await act(async () => {
    editor().textContent = 'abdefgh'; caret(2);
    editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentForward' }));
  });
  expect(editor().textContent).toBe('abdefgh');
  caret(2); await pasteText('X'); expect(editor().textContent).toBe('abdefgh');
  await act(async () => {
    editor().textContent = 'abc'; caret(3);
    editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentForward' }));
  });
  await pasteText('XY'); expect(editor().textContent).toBe('abcX');
});

test('a zero maxLength blocks typing, paste and Enter without discarding an existing draft', async () => {
  await act(async () => root.render(<Harness initial="" maxLength={0} />));
  caret(0); await pasteText('x');
  await act(async () => editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(editor().textContent).toBe('');
  await act(async () => root.render(<SkillComposerInput value="restored" mentions={[]} maxLength={0} />));
  expect(editor().textContent).toBe('restored');
});

test('readonly input and composition events cannot commit late browser mutations', async () => {
  const changed = jest.fn(), key = jest.fn();
  await act(async () => root.render(<SkillComposerInput value="LOCKED" mentions={[]} editable={false} onChangeText={changed} onKeyPress={key} />));
  await act(async () => {
    editor().textContent = 'late input'; editor().dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  expect(editor().textContent).toBe('LOCKED');
  await act(async () => {
    editor().textContent = '迟到中文'; editor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  expect(editor().textContent).toBe('LOCKED'); expect(changed).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
});

test('disabling an unfinished composition retires its eventual commit even after editing is enabled again', async () => {
  const changed = jest.fn();
  await act(async () => root.render(<SkillComposerInput value="draft" mentions={[]} onChangeText={changed} />));
  await act(async () => {
    editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); editor().textContent = '未提交中文';
  });
  await act(async () => root.render(<SkillComposerInput value="draft" mentions={[]} editable={false} onChangeText={changed} />));
  expect(editor().textContent).toBe('draft');
  await act(async () => root.render(<SkillComposerInput value="draft" mentions={[]} onChangeText={changed} />));
  await act(async () => {
    editor().textContent = '迟到中文'; editor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  expect(editor().textContent).toBe('draft'); expect(changed).not.toHaveBeenCalled();
});

test('changing the owner unmounts an unfinished composition instead of copying it into the new source', async () => {
  const oldChange = jest.fn(), newChange = jest.fn();
  await act(async () => root.render(<SkillComposerInput key="codex:a" value="old" mentions={[]} onChangeText={oldChange} />));
  const old = editor();
  await act(async () => { old.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); old.textContent = '旧输入'; });
  await act(async () => root.render(<SkillComposerInput key="claude:b" value="new" mentions={[]} onChangeText={newChange} />));
  await act(async () => { old.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
  expect(editor().textContent).toBe('new'); expect(newChange).not.toHaveBeenCalled();
});

const reviewMention = (start = 0): SkillMention => ({ start, end: start + 7, skill: { name: 'review', path: '/a/SKILL.md' } });
const setRange = (start: number, end = start, backward = false) => {
  const input = editor(); input.focus();
  const point = (offset: number): [Node, number] => {
    for (const token of Array.from(input.querySelectorAll<HTMLElement>('[data-skill-mention]')).reverse()) {
      const start = Number(token.dataset.sourceStart);
      if (offset > start) offset--;
    }
    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
    let node: Node | null, remaining = offset;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return [node, remaining];
      remaining -= length;
    }
    return [input, input.childNodes.length];
  };
  const [a, x] = point(start), [b, y] = point(end), selected = window.getSelection()!;
  selected.setBaseAndExtent(backward ? b : a, backward ? y : x, backward ? a : b, backward ? x : y);
};
const keydown = async (key: string, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  await act(async () => { editor().dispatchEvent(event); });
  return event;
};

test('two Backspaces remove the trailing separator first and then a token at the browser DIV boundary', async () => {
  await act(async () => root.render(<Harness initial="$review " mentions={[reviewMention()]} />));
  setRange(8);
  // jsdom does not perform native text editing. The first ordinary-character
  // key is intentionally left to the browser, followed by its input event.
  expect((await keydown('Backspace')).defaultPrevented).toBe(false);
  await act(async () => { editor().lastChild!.textContent = ''; editor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); });
  expect(editor().textContent).toBe('review');
  const input = editor(), range = document.createRange();
  range.setStart(input, 2); range.collapse(true);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  expect((await keydown('Backspace')).defaultPrevented).toBe(true);
  expect(editor().textContent).toBe(''); expect(editor().querySelector('[data-skill-mention]')).toBeNull(); expect(caretOffset()).toBe(0);
});

test.each(['Backspace', 'Delete'])('%s removes only the adjacent token and retains both surrounding text runs', async key => {
  await act(async () => root.render(<Harness initial="before $review after" mentions={[reviewMention(7)]} />));
  setRange(key === 'Backspace' ? 14 : 7);
  expect((await keydown(key)).defaultPrevented).toBe(true);
  expect(editor().textContent).toBe('before  after'); expect(editor().querySelector('[data-skill-mention]')).toBeNull(); expect(caretOffset()).toBe(7);
});

test.each(['Backspace', 'Delete'])('%s expands a backward selection through a token while preserving text outside the selection', async key => {
  await act(async () => root.render(<Harness initial="left $review right" mentions={[reviewMention(5)]} />));
  setRange(8, 14, true);
  expect((await keydown(key)).defaultPrevented).toBe(true);
  expect(editor().textContent).toBe('left ight'); expect(caretOffset()).toBe(5);
});

test.each(['Backspace', 'Delete'])('%s leaves ordinary text selections and literal dollar tokens to native editing', async key => {
  const changed = jest.fn();
  await act(async () => root.render(<SkillComposerInput value="left $review right" mentions={[reviewMention(5)]} onChangeText={changed} />));
  setRange(0, 4);
  expect((await keydown(key)).defaultPrevented).toBe(false); expect(changed).not.toHaveBeenCalled();
  await act(async () => root.render(<SkillComposerInput value="$review" mentions={[]} onChangeText={changed} />));
  setRange(key === 'Backspace' ? 7 : 0);
  expect((await keydown(key)).defaultPrevented).toBe(false); expect(changed).not.toHaveBeenCalled();
});

test.each(['composition', 'native-composition', 'prevented', 'readonly'] as const)('token deletion respects %s ownership', async blocked => {
  const changed = jest.fn();
  await act(async () => root.render(<SkillComposerInput value="$review" mentions={[reviewMention()]} onChangeText={changed}
    editable={blocked !== 'readonly'} onKeyPress={blocked === 'prevented' ? event => event.preventDefault() : undefined} />));
  setRange(7);
  if (blocked === 'composition') await act(async () => { editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
  await keydown('Backspace', { isComposing: blocked === 'native-composition' });
  expect(changed).not.toHaveBeenCalled(); expect(editor().textContent).toBe('review');
});

test('pasting a literal invocation over a selected skill removes its authority even when canonical text is equal', async () => {
  await act(async () => root.render(<Harness initial="$review" mentions={[reviewMention()]} />));
  setRange(0, 7);
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => '$review' } });
  await act(async () => editor().dispatchEvent(event));
  expect(editor().textContent).toBe('$review'); expect(editor().querySelector('[data-skill-mention]')).toBeNull();
});

test('Chinese IME after a skill preserves its identity and does not emit uncommitted text', async () => {
  await act(async () => root.render(<Harness initial="$review " mentions={[reviewMention()]} />));
  setRange(8);
  await act(async () => {
    editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    editor().lastChild!.textContent = ' 中文';
    editor().dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  });
  expect(editor().querySelector('[data-skill-mention]')).not.toBeNull();
  await act(async () => editor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  expect(editor().textContent).toBe('review 中文'); expect(editor().querySelector('[data-skill-mention]')?.textContent).toBe('review');
});

test.each(['Delete', 'paste'])('%s of the first same-name skill preserves the other exact path', async method => {
  await act(async () => root.render(<Harness initial="$review $review task" mentions={[reviewMention(), { start: 8, end: 15, skill: { name: 'review', path: '/b/SKILL.md' } }]} />));
  setRange(0, 8);
  if (method === 'Delete') await keydown('Delete');
  else {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => '' } });
    await act(async () => editor().dispatchEvent(event));
  }
  expect(editor().textContent).toBe('review task');
  expect(editor().querySelectorAll('[data-skill-mention]')).toHaveLength(1);
  expect(editor().querySelector('[data-skill-mention]')?.getAttribute('title')).toBe('/b/SKILL.md');
});

test.each(['readonly', 'composition'])('paste respects %s ownership', async blocked => {
  const changed = jest.fn(), edit = jest.fn();
  await act(async () => root.render(<SkillComposerInput value="LOCKED" mentions={[]} editable={blocked !== 'readonly'} onChangeText={changed} onSkillEdit={edit} />));
  caret(6);
  if (blocked === 'composition') await act(async () => editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'PASTE' } });
  await act(async () => editor().dispatchEvent(event));
  expect(changed).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
});
