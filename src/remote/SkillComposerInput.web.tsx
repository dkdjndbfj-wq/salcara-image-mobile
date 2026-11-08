import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, type TextInput } from 'react-native';
import type { SkillComposerInputProps } from './SkillComposerInput';
import { editSkillPresentation, replaceSkillComposerRange, skillComposerPresentation, skillDisplayOffset, skillSourceOffset } from './skill-composer-presentation';
import type { SkillMentionEdit } from './skill-mentions';
import { skillKey } from './agent-features';
import { SKILL_ICON_PATH, skillMentionColor, useSkillMentionColor } from './skill-appearance';
import { skillDisplayName } from './skill-display-metadata';

const editingBlock = (node: Node) => node.nodeType === Node.ELEMENT_NODE && /^(DIV|P|LI)$/.test((node as Element).tagName);
/** Soft keyboards can insert paragraphs without keydown. textContent omits
 * both paragraph boundaries and BRs, so preserve those before reconciling. */
function editingText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') return (node as Element).hasAttribute('data-composer-caret') ? '' : '\n';
  const children = Array.from(node.childNodes);
  // Browsers leave a BR in an otherwise empty editing line as a caret target.
  if (children.length === 1 && children[0].nodeType === Node.ELEMENT_NODE && (children[0] as Element).tagName === 'BR') return '';
  let result = '', previous: { block: boolean; text: string } | undefined;
  for (const child of children) {
    const block = editingBlock(child), text = editingText(child);
    if (!block && !text) continue;
    if (previous && (block || previous.block) && (!result.endsWith('\n') || previous.block && !previous.text)) result += '\n';
    result += text; previous = { block, text };
  }
  return result;
}

/** RN counts UTF-16 units, but never leave half of a surrogate pair behind. */
function inputPrefix(value: string, length: number): string {
  let end = Math.max(0, Math.min(value.length, length));
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
  return value.slice(0, end);
}
function fitInsertion(text: string, build: (inserted: string) => SkillMentionEdit, limit: number) {
  let inserted = text, edit = build(inserted);
  while (edit.text.length > limit && inserted.length) {
    inserted = inputPrefix(inserted, inserted.length - (edit.text.length - limit));
    edit = build(inserted);
  }
  return { edit, inserted, limited: inserted !== text, fits: edit.text.length <= limit };
}

/** Web uses real inline, non-editable mentions. Text and references still have
 * one owner in ThreadView, including paste, IME, and native selection changes. */
export const SkillComposerInput = forwardRef<TextInput, SkillComposerInputProps>(function SkillComposerInput(props, ref) {
  const { value, mentions, onChangeText, onSkillEdit, onSelectionChange, selection, onKeyPress, editable = true } = props;
  const color = useSkillMentionColor(), root = useRef<HTMLDivElement>(null), composing = useRef(false);
  const [domRevision, setDomRevision] = useState(0);
  const editability = useRef({ editable, revision: 0 }), compositionOwner = useRef<number | undefined>(undefined);
  if (editability.current.editable !== editable) editability.current = { editable, revision: editability.current.revision + 1 };
  const presentation = skillComposerPresentation(value, mentions);
  const pendingSelection = useRef<{ start: number; end: number } | undefined>(undefined);
  const current = useRef(props); current.current = props;
  const readSelection = () => {
    const element = root.current, selected = window.getSelection();
    if (!element || !selected?.rangeCount || !element.contains(selected.anchorNode) || !element.contains(selected.focusNode)) return undefined;
    const offset = (node: Node, at: number) => {
      const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, at);
      // Count each rendered reference's hidden invocation prefix, including
      // after ordinary browser edits have moved it from its previous offset.
      const contents = range.cloneContents();
      return editingText(contents).length + [...contents.querySelectorAll<HTMLElement>('[data-skill-mention]')]
        .reduce((delta, token) => {
          const length = token.textContent?.length ?? 0, full = Number(token.dataset.displayLength), canonical = Number(token.dataset.canonicalLength);
          if (!length) return delta;
          const mapped = length >= full ? canonical : Math.max(1, Math.min(canonical - 1, Math.round(length * canonical / full)));
          return delta + mapped - length;
        }, 0);
    };
    const a = offset(selected.anchorNode!, selected.anchorOffset), b = offset(selected.focusNode!, selected.focusOffset);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  };
  const writeSelection = (start: number, end: number) => {
    const element = root.current;
    if (!element || document.activeElement !== element) return;
    const point = (requested: number): [Node, number] => {
      let remaining = skillDisplayOffset(presentation, Math.max(0, requested));
      for (const node of Array.from(element.childNodes)) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) {
          if (node.nodeType === Node.TEXT_NODE) return [node, remaining];
          const index = Array.from(element.childNodes).indexOf(node);
          return [element, index + (remaining > 0 ? 1 : 0)];
        }
        remaining -= length;
      }
      return [element, element.childNodes.length];
    };
    const [a, x] = point(start), [b, y] = point(end), range = document.createRange();
    range.setStart(a, x); range.setEnd(b, y);
    const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range);
  };
  useImperativeHandle(ref, () => ({ focus: () => root.current?.focus(), blur: () => root.current?.blur() } as TextInput), []);
  useLayoutEffect(() => {
    const element = root.current;
    if (!editable) { composing.current = false; compositionOwner.current = undefined; }
    if (!element || composing.current) return;
    const before = readSelection(), fragment = document.createDocumentFragment();
    let at = 0;
    for (const mention of presentation.mentions) {
      fragment.append(document.createTextNode(presentation.text.slice(at, mention.start)));
      const token = document.createElement('span'); token.contentEditable = 'false'; token.textContent = skillDisplayName(mention.skill);
      token.dataset.skillMention = 'true'; token.title = mention.skill.path ?? mention.skill.name;
      token.setAttribute('aria-label', `技能 ${mention.skill.name}`);
      token.dataset.sourceStart = String(mention.sourceStart); token.dataset.sourceEnd = String(mention.sourceEnd);
      token.dataset.canonicalLength = String(mention.sourceEnd - mention.sourceStart);
      token.dataset.displayLength = String(mention.end - mention.start);
      Object.assign(token.style, { color: skillMentionColor(color, mention.skill.brandColor), fontWeight: '500' });
      const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="${SKILL_ICON_PATH}" fill="none" stroke="black" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
      const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}") center / contain no-repeat`;
      Object.assign(icon.style, { display: 'inline-block', width: '16px', height: '16px', marginRight: '3px', verticalAlign: '-3px', backgroundColor: 'currentColor', mask, WebkitMask: mask });
      if (mention.skill.iconSmall) Object.assign(icon.style, { backgroundColor: 'transparent', mask: 'none', WebkitMask: 'none', backgroundImage: `url("${mention.skill.iconSmall}")`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat' });
      token.prepend(icon);
      fragment.append(token); at = mention.end;
    }
    fragment.append(document.createTextNode(presentation.text.slice(at)));
    // Chromium otherwise places the next character before a trailing text-node
    // newline. Give the empty last line a caret target, excluded from draft text.
    if (presentation.text.endsWith('\n')) {
      const caretLine = document.createElement('br'); caretLine.dataset.composerCaret = 'true'; fragment.append(caretLine);
    }
    element.replaceChildren(fragment);
    const target = selection ?? pendingSelection.current ?? before;
    pendingSelection.current = undefined;
    if (target) writeSelection(Math.min(value.length, target.start), Math.min(value.length, target.end ?? target.start));
  }, [value, mentions, selection?.start, selection?.end, color, editable, domRevision]);
  useEffect(() => {
    const changed = () => {
      const next = readSelection();
      if (next) current.current.onSelectionChange?.({ nativeEvent: { selection: next } } as Parameters<NonNullable<typeof onSelectionChange>>[0]);
    };
    document.addEventListener('selectionchange', changed);
    return () => document.removeEventListener('selectionchange', changed);
  }, []);
  const restoreDom = () => { setDomRevision(revision => revision + 1); };
  const limit = Number.isInteger(props.maxLength) && props.maxLength! >= 0 ? Math.max(props.maxLength!, value.length) : Infinity;
  const publish = (edit: SkillMentionEdit, normalize = false) => {
    if (!editable) { restoreDom(); return; }
    const unchanged = edit.text === value && edit.mentions.length === mentions.length && edit.mentions.every((mention, index) =>
      mention.start === mentions[index].start && mention.end === mentions[index].end && skillKey(mention.skill) === skillKey(mentions[index].skill));
    if (edit.caret !== undefined) pendingSelection.current = { start: edit.caret, end: edit.caret };
    if (!unchanged) { if (onSkillEdit) onSkillEdit(edit); else onChangeText?.(edit.text); }
    if (normalize || unchanged) restoreDom();
  };
  const insertText = (text: string) => {
    if (!editable) { restoreDom(); return; }
    const at = readSelection() ?? { start: value.length, end: value.length };
    const result = fitInsertion(text, inserted => replaceSkillComposerRange(value, mentions, at.start, at.end, inserted), limit);
    if (result.fits) publish(result.edit, result.limited); else restoreDom();
  };
  const deleteMention = (key: string): boolean => {
    const at = readSelection();
    // Browser deletion at a contenteditable=false sibling can do nothing.
    // Only take over a range that touches an authoritative, rendered token;
    // surrounding ordinary text keeps the browser's usual deletion behavior.
    if (!at || root.current?.textContent !== presentation.text) return false;
    const touched = mentions.filter(mention => value.slice(mention.start, mention.end) === `$${mention.skill.name}`
      && (at.start === at.end ? key === 'Backspace'
        ? mention.start < at.start && mention.end >= at.start
        : mention.start <= at.start && mention.end > at.start
        : mention.start < at.end && mention.end > at.start));
    if (!touched.length) return false;
    const start = Math.min(at.start, ...touched.map(mention => mention.start));
    const end = Math.max(at.end, ...touched.map(mention => mention.end));
    const edit = replaceSkillComposerRange(value, mentions, start, end, '');
    publish(edit);
    return true;
  };
  const nativeStyle = (StyleSheet.flatten(props.style) ?? {}) as React.CSSProperties & {
    paddingHorizontal?: React.CSSProperties['paddingLeft']; paddingVertical?: React.CSSProperties['paddingTop'];
    marginHorizontal?: React.CSSProperties['marginLeft']; marginVertical?: React.CSSProperties['marginTop'];
    textAlignVertical?: string; includeFontPadding?: boolean;
  };
  const { paddingHorizontal, paddingVertical, marginHorizontal, marginVertical, textAlignVertical: _vertical, includeFontPadding: _fontPadding, ...cssStyle } = nativeStyle;
  const inputStyle: React.CSSProperties = { ...cssStyle,
    ...(paddingHorizontal === undefined ? {} : { paddingLeft: cssStyle.paddingLeft ?? paddingHorizontal, paddingRight: cssStyle.paddingRight ?? paddingHorizontal }),
    ...(paddingVertical === undefined ? {} : { paddingTop: cssStyle.paddingTop ?? paddingVertical, paddingBottom: cssStyle.paddingBottom ?? paddingVertical }),
    ...(marginHorizontal === undefined ? {} : { marginLeft: cssStyle.marginLeft ?? marginHorizontal, marginRight: cssStyle.marginRight ?? marginHorizontal }),
    ...(marginVertical === undefined ? {} : { marginTop: cssStyle.marginTop ?? marginVertical, marginBottom: cssStyle.marginBottom ?? marginVertical }),
  };
  const input = (text: string) => {
    if (!editable) { restoreDom(); return; }
    let start = 0, end = text.length, previousEnd = presentation.text.length;
    while (start < text.length && start < presentation.text.length && text[start] === presentation.text[start]) start++;
    while (end > start && previousEnd > start && text[end - 1] === presentation.text[previousEnd - 1]) { end--; previousEnd--; }
    const result = fitInsertion(text.slice(start, end), inserted => editSkillPresentation(value, presentation, text.slice(0, start) + inserted + text.slice(end)), limit);
    if (!result.fits) { restoreDom(); return; }
    if (result.limited) result.edit.caret = skillSourceOffset(skillComposerPresentation(result.edit.text, result.edit.mentions), start + result.inserted.length);
    publish(result.edit, result.limited);
  };
  return <><style>{'.salcara-skill-composer:empty::before{content:attr(data-placeholder);color:var(--composer-placeholder,#9BA0A6);pointer-events:none;position:absolute;}'}</style><div ref={root} className="salcara-skill-composer" role="textbox" aria-label={props.accessibilityLabel} aria-placeholder={props.placeholder} aria-multiline="true" aria-disabled={!editable}
    data-testid={props.testID} contentEditable={editable} suppressContentEditableWarning spellCheck={false}
    data-placeholder={props.placeholder}
    style={{ ...inputStyle, position:'relative', ...{'--composer-placeholder':props.placeholderTextColor??'#9BA0A6'} as React.CSSProperties,
      // React Native uses pixels here; a bare DOM number is a font-size multiplier.
      ...(typeof inputStyle?.lineHeight === 'number' ? { lineHeight: `${inputStyle.lineHeight}px` } : {}),
      outline: 'none', overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', boxSizing: 'border-box' }}
    onInput={event => {
      if (!editable || !composing.current && (event.nativeEvent as InputEvent).isComposing) { restoreDom(); return; }
      if (!composing.current) input(editingText(event.currentTarget));
    }}
    onCompositionStart={() => { if (editable) { composing.current = true; compositionOwner.current = editability.current.revision; } else restoreDom(); }}
    onCompositionEnd={event => {
      const owned = editable && composing.current && compositionOwner.current === editability.current.revision;
      composing.current = false; compositionOwner.current = undefined;
      if (owned) input(editingText(event.currentTarget)); else restoreDom();
    }}
    onPaste={event => { event.preventDefault(); if (editable && !composing.current) {
      const text = event.clipboardData.getData('text/plain'), range = readSelection() ?? { start: value.length, end: value.length };
      if (!props.onPasteText?.(text, range.start, range.end)) insertText(text);
    } }}
    onKeyDown={event => {
      // Some IMEs release isComposing before the confirming keydown. Code 229
      // still belongs to the IME; leave it untouched and do not forward shortcuts.
      if (!editable || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      onKeyPress?.({ nativeEvent: { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey,
        isComposing: false }, preventDefault: () => event.preventDefault() } as unknown as Parameters<NonNullable<typeof onKeyPress>>[0]);
      if (event.defaultPrevented) return;
      if ((event.key === 'Backspace' || event.key === 'Delete') && deleteMention(event.key)) event.preventDefault();
      else if (event.key === 'Enter') { event.preventDefault(); insertText('\n'); }
    }} /></>;
});
