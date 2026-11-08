import { canReviseSentMessage, latestRevisableMessage, sentMessageRevisionIdentity, type SentUserMessage } from '../remote/sent-message-revision';
import type { ContextReference } from '../remote/context-references';

const message = (changes: Partial<SentUserMessage> = {}): SentUserMessage => ({ kind: 'message', id: 'user-1', role: 'user', text: 'Original message', final: true, ts: 1, ...changes });
const attachment = { id: `att_${'1'.repeat(32)}`, mime: 'image/png', size: 24, width: 1, height: 1, sha256: 'a'.repeat(64), name: 'original.png' };
const reference = (id: string): ContextReference => ({ kind: 'message', sessionKey: 'codex:original', label: id, messageId: id, text: 'abc', startOffset: 0, endOffset: 3, capturedAt: 1 });

test('only confirmed original user messages are revisable', () => {
  expect(canReviseSentMessage(message())).toBe(true);
  expect(canReviseSentMessage(message({ text: '', attachments: [attachment] }))).toBe(true);
  for (const changes of [{ local: true }, { final: false }, { streamState: 'terminal-unconfirmed' }, { streamState: 'incomplete' }, { parentId: 'child' }, { messageOrigin: { type: 'agent' } }, { role: 'assistant' }, { text: ' \n' }]) {
    expect(canReviseSentMessage(message(changes as Partial<SentUserMessage>))).toBe(false);
  }
});

test('only the latest ordinary user message is offered and newer unconfirmed input blocks older revisions', () => {
  const first = message(), last = message({ id: 'last', text: 'Newest input' });
  expect(latestRevisableMessage([first, last, message({ role: 'assistant' }), message({ parentId: 'child' }), message({ messageOrigin: { type: 'agent' } as any })])).toBe(last);
  for (const pending of [message({ id: 'pending', local: true }), message({ id: 'partial', final: false }), message({ id: 'unknown', streamState: 'terminal-unconfirmed' })]) {
    expect(latestRevisableMessage([first, pending])).toBeUndefined();
  }
});

test('identity ignores cached image paths and object property order while retaining authoritative attachment data', () => {
  const first = message({ attachments: [{ ...attachment, uri: 'file://cache/one.png' }], images: ['file://cache/one.png'] });
  const refreshed = message({ attachments: [{ name: attachment.name, sha256: attachment.sha256, height: 1, width: 1, size: 24, mime: 'image/png', id: attachment.id, uri: 'file://cache/two.png' }], images: ['file://cache/two.png'] });
  expect(sentMessageRevisionIdentity(first)).toBe(sentMessageRevisionIdentity(refreshed));
  expect(sentMessageRevisionIdentity(first)).toBe(sentMessageRevisionIdentity({ ...first, ts: 500, seq: 2 }));
  for (const revised of [{ ...first, text: 'Changed' }, { ...first, attachments: [{ ...attachment, sha256: 'b'.repeat(64) }] }, { ...first, attachments: [] }, { ...first, skills: [{ name: 'review' }] }, { ...first, contextReferences: [reference('r')] }]) {
    expect(sentMessageRevisionIdentity(revised)).not.toBe(sentMessageRevisionIdentity(first));
  }
  expect(sentMessageRevisionIdentity(message({ images: ['file://original.png'] }))).not.toBe(sentMessageRevisionIdentity(message({ images: ['file://different.png'] })));
});

