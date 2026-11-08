import { parseBrowserNavigation } from '../remote/browser-navigation';
import { parseHubEvent, type HubEvent } from '../remote/client';
import { applyEvent, EMPTY_TIMELINE } from '../remote/store';

jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => null }));

const browser = { action: 'navigate' as const, url: 'https://example.com/docs?q=layout#tabs', pageId: 'playwright:page-1' };
const event = (extra: Record<string, unknown> = {}) => ({ type: 'tool', deviceId: 'pc-1', sessionKey: 'codex:one', tool: 'codex', ts: 1,
  id: 'open-1', kind: 'mcp', title: '调用 playwright.browser_navigate', status: 'done', ...extra });

test('a completed explicit browser operation survives the event parser and timeline reducer', () => {
  const parsed = parseHubEvent(event({ browser }));
  expect(parsed).toMatchObject({ browser });
  const result = applyEvent(EMPTY_TIMELINE, parsed!);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ kind: 'tool', id: 'open-1', browser });
  expect(applyEvent(result, parsed!).items).toHaveLength(1);
});

test.each(['running', 'failed', 'interrupted'])('an unsuccessful or pending %s operation cannot open a browser page', status => {
  const parsed = parseHubEvent(event({ status, browser }));
  expect(parsed).not.toHaveProperty('browser');
  expect(applyEvent(EMPTY_TIMELINE, event({ status, browser }) as HubEvent).items[0]).not.toHaveProperty('browser');
});

test.each([
  'javascript:alert(1)', 'file:///private/config', 'data:text/html,hello', '//example.com',
  'https://user:password@example.com', 'https://example.com/\nsecret', 'https://example.com/%0a',
  'https://example.com/\\path', 'https://example.com/\u202Ehidden', ' https://example.com',
  'https://example.com:99999', 'https:///example.com', 'https://example.com/%zz', 'https://example.com/a b', `https://example.com/${'a'.repeat(4096)}`,
])('unsafe browser URL metadata is discarded without losing the tool event: %s', url => {
  const parsed = parseHubEvent(event({ browser: { ...browser, url } }));
  expect(parsed).toMatchObject({ type: 'tool', id: 'open-1' });
  expect(parsed).not.toHaveProperty('browser');
});

test.each([
  null, [], { ...browser, action: 'execute' }, { ...browser, pageId: 1 },
  { ...browser, pageId: '' }, { ...browser, pageId: 'old\npage' }, { ...browser, pageId: 'a'.repeat(257) },
])('unknown or malformed navigation metadata remains an ordinary tool operation', value => {
  expect(parseBrowserNavigation(value)).toBeUndefined();
  expect(parseHubEvent(event({ browser: value }))).not.toHaveProperty('browser');
});

test('URLs in regular tool descriptions and web searches never imply a browser operation', () => {
  for (const kind of ['command', 'web', 'mcp']) {
    const parsed = parseHubEvent(event({ kind, title: browser.url, detail: browser.url, output: browser.url }));
    expect(applyEvent(EMPTY_TIMELINE, parsed!).items[0]).not.toHaveProperty('browser');
  }
});

test('a reduced duplicate tool snapshot preserves the completed browser operation', () => {
  const first = applyEvent(EMPTY_TIMELINE, parseHubEvent(event({ browser, output: 'Opened page', seq: 1 }))!);
  const duplicate = applyEvent(first, parseHubEvent(event({ seq: 2 }))!);
  expect(duplicate.items[0]).toMatchObject({ browser, output: 'Opened page' });
});

test('local service URLs retain identity for the phone reachability gate', () => {
  expect(parseBrowserNavigation({ action: 'open', url: 'http://127.0.0.1:8083' })).toEqual({ action: 'open', url: 'http://127.0.0.1:8083/' });
});
