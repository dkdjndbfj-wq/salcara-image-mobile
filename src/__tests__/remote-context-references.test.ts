import { appendContextReference, copyContextReferences, parseContextQuery, referenceLineRange, validContextReferences, type ContextReference } from '../remote/context-references';
import { copyTurnFeatures, validTurnFeatures } from '../remote/agent-features';
import { copyComposerFeatureIntent, isComposerFeatureIntent, type ComposerFeatureIntent } from '../remote/composer-feature-intent';
import { decodeNewTask, encodeNewTask } from '../remote/new-task';

const ref: ContextReference = { kind: 'message', sessionKey: 'codex:one', label: '原消息', messageId: 'msg-1', text: '代码\n😀', startOffset: 10, endOffset: 15, capturedAt: 1 };
const intent: ComposerFeatureIntent = { version: 1, source: { scope: 'station', deviceId: 'pc', tool: 'codex', runtimeId: 'codex', surface: 'cli', apiIdentity: 'api', cwd: '/project' }, contextReferences: [ref] };

test('explicit message range retains code and UTF16 offsets without a 160 character summary', () => {
  expect(validContextReferences([ref])).toBe(true);
  const text = 'intro\n```ts\n' + 'const x = 1;\n'.repeat(50) + '```\n尾';
  const range = referenceLineRange(text, 2, 53);
  expect(range.text).toContain('```ts'); expect(range.text.length).toBeGreaterThan(160);
  expect(text.slice(range.start, range.end)).toBe(range.text);
});

test.each([
  { ...ref, endOffset: 14 }, { ...ref, capturedAt: 0 }, { ...ref, sessionKey: 'bad' }, { ...ref, messageId: 'x\n' },
  { ...ref, text: '' }, { ...ref, unknown: true }, { ...ref, text: 'x'.repeat(32769), startOffset: 0, endOffset: 32769 },
  { kind: 'file', sessionKey: 'codex:one', label: 'file', path: '../key', text: 'x', startLine: 1, endLine: 1, capturedAt: 1 },
  { kind: 'file', sessionKey: 'codex:one', label: 'file', path: 'a.ts', text: 'x\ny', startLine: 1, endLine: 1, capturedAt: 1 },
])('malformed or oversized reference is rejected without a text-only downgrade', value => {
  expect(validContextReferences([value])).toBe(false);
  expect(() => copyTurnFeatures({ contextReferences: [value] })).toThrow();
});

test('reference-only draft intent and frozen send copies preserve independent snapshots', () => {
  expect(isComposerFeatureIntent(intent, '处理引用')).toBe(true);
  const draft = copyComposerFeatureIntent(intent, '处理引用');
  const send = copyTurnFeatures(draft);
  draft.contextReferences![0].text = 'mutated';
  expect(send.contextReferences).toEqual([ref]);
  expect(validTurnFeatures(send, 'desktop')).toBe(false);
  expect(isComposerFeatureIntent({ ...intent, contextReferences: [{ ...ref, path: 'bad' }] }, '')).toBe(false);
});

test('snapshot budget and duplicate range replacement are explicit', () => {
  const updated = { ...ref, text: '新消息xx', endOffset: 15, capturedAt: 2 };
  expect(appendContextReference([ref], updated)).toEqual([updated]);
  expect(() => appendContextReference(Array.from({ length: 8 }, (_, i) => ({ ...ref, messageId: `${i}` })), ref)).toThrow('最多引用');
  expect(copyContextReferences([ref])?.[0]).not.toBe(ref);
  const big = { ...ref, text: 'x'.repeat(32768), startOffset: 0, endOffset: 32768 };
  expect(validContextReferences([big, big])).toBe(true);
  expect(validContextReferences([big, big, ref])).toBe(false);
});

test('@ only consumes the current token and leaves text after the caret intact', () => {
  expect(parseContextQuery('分析 @src/a.ts 后面', 12)).toMatchObject({ query: 'src/a.ts', start: 3, end: 12 });
  expect(parseContextQuery('mail@example.com')).toBeUndefined();
  expect(parseContextQuery('plain @')).toMatchObject({ query: '' });
});

test('a new-task receipt can preserve the full bounded body plus multiple reference snapshots', () => {
  const big = { ...ref, text: 'x'.repeat(32768), startOffset: 0, endOffset: 32768 };
  const input = { version: 1 as const, tool: 'codex', cwd: '/project', prompt: 'y'.repeat(65536), approval: 'ask' as const, images: [], contextReferences: [big, { ...big, messageId: 'another' }] };
  const encoded = encodeNewTask(input);
  expect(encoded.length).toBeGreaterThan(100_000);
  expect(decodeNewTask(encoded)).toEqual(input);
});

test('new-project file reference has a real project source and never fabricates a session', () => {
  const file: ContextReference = { kind: 'file', projectPath: 'C:/project', label: 'main.ts', path: 'src/main.ts', text: 'const x = 1;', startLine: 1, endLine: 1, capturedAt: 1 };
  expect(validContextReferences([file])).toBe(true);
  expect(validContextReferences([{ ...file, sessionKey: 'codex:invented' }])).toBe(false);
  expect(validContextReferences([{ ...file, projectPath: undefined }])).toBe(false);
  expect(validContextReferences([{ ...ref, projectPath: '/project' }])).toBe(false);
});
