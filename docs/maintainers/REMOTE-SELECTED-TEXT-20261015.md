# Remote selected text, annotations and side questions

The transcript exposes two independent actions on a real native/DOM selection. `Add to chat` creates a structured context annotation, opens its optional comment editor, and does not send. `Ask in side chat` opens a separate temporary conversation and never calls the parent composer's send function.

## Selection and annotation contract

`MessageSelectionSurface` owns its exact scope, source text and native/DOM selection. It rejects stale, background, detached and changed ranges. Android adds actions through the public TextView selection callback; Web uses the actual DOM Range. The full source sheet permits selections across Markdown paragraphs and fenced code. No substring search is used to infer which repeated phrase was selected.

`ContextReference` records the exact message ID, snapshot, UTF-16 offsets and source SHA256. `textBasis: source` addresses the canonical source and has no blockIndex. `textBasis: rendered` addresses a specific rendered block and requires blockIndex. Coordinates never grant permission to read a message or file. On navigation, the current source hash must match before highlighting; unavailable or changed originals keep their saved snapshot and show an explanation.

The composer aggregates response annotations as `N 条注释`. Each has an optional comment, edit/delete and source navigation. Annotations and skill appearance survive the existing immutable draft/queue/receipt/history path. Sending requires explicit `contextAnnotations` capability, so an older Bridge cannot silently drop comments. Limits are eight references, 32 KiB per quoted snapshot, 8 KiB per comment and 64 KiB total quoted text plus comments.

Long press is reserved for text selection. User messages provide a separate accessible `复制消息` button that copies the complete original body, excluding source badges, skills and annotation chrome.

## Independent questions

`SideQuestionPanel` receives an injected transport with capability reading, source validation and ask functions. It owns questions and answers, freezes the initial selection, follows only the last confirmed operationId, and blocks duplicate or unconfirmed sends. Closing, switching scope and leaving the foreground invalidate queued UI work. The panel uses `KeyboardSafeView` because Android edge-to-edge modal windows do not reliably resize for the keyboard.

The actual store requires the Hub side-question capability and request idempotency, the exact computer/account/session source and an advertised provider adapter. Backend capability reading freezes a bounded snapshot of loaded parent user/assistant messages. The UI explicitly says `基于已加载对话`; it does not claim full native context. Provider calls use the existing exact API source with no tools and do not append to the parent timeline. Limits and TTL come from the backend contract, including at most six confirmed rounds per pane.

Official Claude Code side questions and ordinary Claude Chat are different product surfaces. This mobile UI follows the requested Codex interaction design for supported remote Codex and Claude adapters; it does not assert that the native Claude Chat selection menu is identical.

## Verification

Meaningful coverage includes exact repeated text and emoji offsets, rendered/source coordinate separation, immutable comment restoration, old Bridge capability gating, preserved main draft, independent follow-ups, duplicate presses, foreground/scope changes, and unknown results. Android keyboard positioning, native selection handles and initial skill spans additionally require installation checks; passing Web or synthetic component tests does not establish those native behaviors.
