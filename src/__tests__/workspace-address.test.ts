import { workspaceAddressTarget } from '../remote/workspace-address';

jest.mock('../components/ui', () => ({ showToast: jest.fn() }));
jest.mock('../remote/store', () => ({ getRemoteState: jest.fn(), onRemoteChange: jest.fn(), remoteDeliveryScope: jest.fn(), timelineKey: jest.fn(), watchCredentials: jest.fn() }));

test.each([
  ['https://example.com/docs?q=one#two', 'web', 'https://example.com/docs?q=one#two'],
  ['http://example.com:8080/docs', 'web', 'http://example.com:8080/docs'],
  ['https://localhost:3000/', 'local-service', 'https://localhost:3000/'],
  ['  example.com  ', 'web', 'https://example.com/'],
  ['example.com:8080/docs?q=one#two', 'web', 'https://example.com:8080/docs?q=one#two'],
  ['www.example.com/a b', 'web', 'https://www.example.com/a%20b'],
  ['例子.中国', 'web', new URL('https://例子.中国').toString()],
  ['localhost', 'local-service', 'http://localhost/'],
  ['localhost:3000', 'local-service', 'http://localhost:3000/'],
  ['LOCALHOST:5173/path', 'local-service', 'http://localhost:5173/path'],
  ['app.localhost:3000', 'local-service', 'http://app.localhost:3000/'],
  ['devbox:3000/path', 'local-service', 'http://devbox:3000/path'],
  ['127.0.0.1:5173/', 'local-service', 'http://127.0.0.1:5173/'],
  ['192.168.1.2:8080', 'local-service', 'http://192.168.1.2:8080/'],
  ['8.8.8.8:8080', 'web', 'https://8.8.8.8:8080/'],
  ['[::1]:3000/path', 'local-service', 'http://[::1]:3000/path'],
  ['::1', 'local-service', 'http://[::1]/'],
  ['[fd12::8]:8080', 'local-service', 'http://[fd12::8]:8080/'],
  ['[2606:4700:4700::1111]:443/dns-query', 'web', 'https://[2606:4700:4700::1111]/dns-query'],
  ['2606:4700:4700::1111', 'web', 'https://[2606:4700:4700::1111]/'],
] as const)('address input %s opens the expected public or computer-local page', (input, kind, url) => {
  expect(workspaceAddressTarget(input)).toEqual({ kind, url });
});

test.each([
  'React hooks', '如何运行本地项目', 'hello', 'example.com documentation',
  'what is 127.0.0.1?', 'two + two?', 'https documentation', 'bad_domain.com',
])('ordinary text remains a search: %s', input => {
  expect(workspaceAddressTarget(`  ${input}  `)).toEqual({ kind: 'web', url: `https://www.google.com/search?q=${encodeURIComponent(input)}` });
});

test.each([
  '', '   ', 'file:///C:/private/config', 'javascript:alert(1)', 'javascript: alert(1)',
  'data:text/html,hello', 'ftp://example.com', 'mailto:person@example.com', 'codex://threads/task',
  'https://user:secret@example.com', 'user:secret@example.com', 'user@example.com/path',
  'https:example.com', '//example.com', 'localhost:70000', 'example.com:70000',
  '[::1]:70000', '[not-an-ip]:3000', '[fe80::1%25eth0]:3000', 'http://example.com/\nsecret',
  'https://example.com/%0a', 'example.com/\\secret', 'C:\\private\\config', 'example.com/\u202Ehidden',
])('unsafe, unsupported or malformed navigation stays inert: %s', input => {
  expect(workspaceAddressTarget(input)).toBeUndefined();
});
