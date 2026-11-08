/**
 * Copyright Wegent contributors. Licensed under Apache-2.0.
 * Source: wecode-ai/Wegent @ ac8951007b336c573ee8d34517e31ecfed047cbd.
 * See THIRD_PARTY_NOTICES.md and licenses/Wegent-APACHE-2.0.txt.
 */
// Unmodified parsing/editable-target helpers from wework/src/lib/keybindings.ts.
export function normalizeKeybinding(value: string): string {
  const parts = value
    .split('+')
    .map(part => normalizeKeyPart(part.trim()))
    .filter(Boolean)
  const key = parts.pop()
  if (!key) return ''

  const modifiers = ['Control', 'Alt', 'Shift', 'Command'].filter(modifier =>
    parts.includes(modifier)
  )
  return [...modifiers, key].join('+')
}

export function keybindingFromKeyboardEvent(event: KeyboardEvent): string {
  const key = normalizeKeyPart(
    event.altKey ? keybindingKeyFromPhysicalCode(event.code) || event.key : event.key
  )
  const mainKey = key && !['Command', 'Control', 'Alt', 'Shift'].includes(key) ? key : null
  if (!mainKey) return ''

  const includeShift = event.shiftKey && key !== 'Plus' && key !== 'Minus'
  return [
    event.ctrlKey ? 'Control' : null,
    event.altKey ? 'Alt' : null,
    includeShift ? 'Shift' : null,
    event.metaKey ? 'Command' : null,
    mainKey,
  ]
    .filter(Boolean)
    .join('+')
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.xterm')) return false
  const tagName = target.tagName.toLowerCase()
  return (
    target.isContentEditable ||
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select'
  )
}

export function shouldIgnoreWorkbenchShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing) return true
  if (!isEditableShortcutTarget(event.target)) return false
  // Conversation autofocus must not disable workbench commands. Keep typing
  // and Option-only text input in the editor, including custom bare-key bindings.
  return (
    (!event.metaKey && !event.ctrlKey) ||
    !(event.target instanceof HTMLElement) ||
    !event.target.closest('[data-testid="chat-message-input"]')
  )
}

function normalizeKeyPart(value: string): string {
  const lower = value.toLowerCase()
  if (['cmd', 'command', 'meta', '⌘'].includes(lower)) return 'Command'
  if (['ctrl', 'control', '⌃'].includes(lower)) return 'Control'
  if (['alt', 'option', 'opt', '⌥'].includes(lower)) return 'Alt'
  if (['shift', '⇧'].includes(lower)) return 'Shift'
  if (lower === ' ') return 'Space'
  if (lower === 'escape') return 'Esc'
  if (lower === '+' || lower === '=' || lower === 'plus') return 'Plus'
  if (lower === '-' || lower === '_' || lower === 'minus') return 'Minus'
  if (value.length === 1) return value.toUpperCase()
  return value
}

function keybindingKeyFromPhysicalCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)

  return (
    {
      Space: 'Space',
      Equal: 'Plus',
      Minus: 'Minus',
      Backquote: '`',
      BracketLeft: '[',
      BracketRight: ']',
      Backslash: '\\',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/',
    }[code] ?? ''
  )
}
