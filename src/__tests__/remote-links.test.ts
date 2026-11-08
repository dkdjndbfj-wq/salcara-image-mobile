import { Linking } from 'react-native';
import { showToast } from '../components/ui';
import { inlineRemoteReference, localServiceCanOpenOnPhone, openLocalRemoteWebsite, openRemoteWebsite, resolveRemoteLink } from '../remote/remote-links';

jest.mock('../components/ui', () => ({ showToast: jest.fn() }));
jest.mock('../remote/workspace-files', () => ({ workspaceRelativePath: jest.requireActual('../remote/workspace-files').workspaceRelativePath }));
jest.mock('../remote/store', () => ({ getRemoteState: jest.fn(), onRemoteChange: jest.fn(), remoteDeliveryScope: jest.fn(), timelineKey: jest.fn(), watchCredentials: jest.fn() }));

test.each([
  ['src/app.ts', undefined, { kind: 'file', path: 'src/app.ts' }],
  ['./src/app.ts:12:3', undefined, { kind: 'file', path: 'src/app.ts', line: 12, column: 3 }],
  ['src/app.ts#L12C3', undefined, { kind: 'file', path: 'src/app.ts', line: 12, column: 3 }],
  ['C:\\project\\src\\app.ts:12', 'C:\\project', { kind: 'file', path: 'src/app.ts', line: 12 }],
  ['/C:/project/src/app.ts#L20', 'c:/project', { kind: 'file', path: 'src/app.ts', line: 20 }],
  ['/home/project/src/app.ts', '/home/project/', { kind: 'file', path: 'src/app.ts' }],
  ['C:/My Project/dir with spaces/app.ts:2', 'C:/My Project', { kind: 'file', path: 'dir with spaces/app.ts', line: 2 }],
  ['folder/my file.ts', undefined, { kind: 'file', path: 'folder/my file.ts' }],
])('local path normalizes without trusting a new root: %s', (input, cwd, expected) => { expect(resolveRemoteLink(input as string, cwd as string | undefined)).toEqual(expected); });

test.each([
  '../secret.txt', '/home/project-other/file.ts', '/home/Project/file.ts', 'C:/project-other/file.ts', 'D:/project/file.ts',
  'C:/project/../private.ts', 'C:/Project/src/app.ts', '//server/share/file.ts', '\\\\server\\share\\file.ts', 'file:///home/project/file.ts',
  'javascript:alert(1)', 'data:text/html,<b>x</b>', 'mailto:person@example.com', 'vscode://file/path', 'intent://example',
  'src/a.ts:0', 'src/a.ts:1000001', 'src/a.ts:1:0', 'src/a.ts#L2C1000001', 'src/%2e%2e/private.ts', 'src/a.ts?x',
  'src/a.ts#unknown', ' src/a.ts', 'src/a.ts ', 'src/\u202eevil.ts', 'src/\u0000evil.ts',
  'https://user:password@example.com', 'https://example.com/a%0Aevil', 'https://example.com\\evil',
])('unsafe URI, root escape or ambiguous location stays inert: %s', input => {
  expect(resolveRemoteLink(input, input.startsWith('/home') ? '/home/project' : 'C:/project')).toEqual({ kind: 'blocked' });
});

test.each(['https://example.com/path?q=value#fragment', 'http://8.8.8.8:8080/', 'https://[2606:4700:4700::1111]/'])('public website remains a system-browser URL: %s', input => {
  expect(resolveRemoteLink(input)).toEqual({ kind: 'web', url: new URL(input).toString() });
});
test.each([
  'http://localhost:3000', 'http://127.0.0.1:5173', 'http://127.1:3000', 'http://2130706433:3000',
  'http://0x7f000001/', 'http://10.0.0.1/', 'http://172.16.0.2/', 'http://192.168.0.2/', 'http://169.254.169.254/',
  'http://100.64.0.1/', 'http://192.0.2.1/', 'http://198.51.100.1/', 'http://203.0.113.1/', 'http://224.0.0.1/',
  'http://computer/', 'http://computer.local/', 'http://local.internal/', 'http://example.invalid/',
  'http://[::1]:3000', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fc00::1]/', 'http://[ff02::1]/',
  'http://[2001:db8::1]/', 'http://[2001:2::1]/', 'http://[2001:10::1]/', 'http://[2001:20::1]/', 'http://[3fff::1]/', 'http://[2002:7f00:1::]/',
])('PC-local/private/special endpoint is not opened as a public phone website: %s', input => {
  expect(resolveRemoteLink(input)).toEqual({ kind: 'local-service' });
});
test('IPv6 zone identifiers and invalid literals are blocked', () => {
  expect(resolveRemoteLink('http://[fe80::1%25eth0]/')).toEqual({ kind: 'blocked' });
  expect(resolveRemoteLink('http://[not-an-address]/')).toEqual({ kind: 'blocked' });
});

test('task links classify only exact existing-thread references without auto-navigation', () => {
  expect(resolveRemoteLink('codex://threads/task_123-abc')).toEqual({ kind: 'task', sessionKey: 'codex:task_123-abc' });
  for (const target of ['codex://threads/new', 'codex://threads/task?prompt=send', 'codex://threads/task#fragment', 'codex://threads/../task', 'codex://threads/']) expect(resolveRemoteLink(target)).toEqual({ kind: 'blocked' });
});
test('inline references activate filenames but leave shell/code expressions inert', () => {
  for (const target of ['src/app.ts', 'my file.ts:2:3', 'Dockerfile', 'Makefile', 'LICENSE', 'codex://threads/task']) expect(inlineRemoteReference(target)).toBe(true);
  for (const target of ['run(foo.ts)', 'echo file.ts; rm x', 'const a = file.ts', 'hello\nfile.ts', 'https://example.com/', 'codex://threads/new']) expect(inlineRemoteReference(target)).toBe(false);
});
test('website opening uses system Linking only and never opens local/unsafe targets', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  (showToast as jest.Mock).mockClear();
  openRemoteWebsite('https://example.com/path'); expect(open).toHaveBeenCalledWith('https://example.com/path');
  openRemoteWebsite('http://localhost:3000'); openRemoteWebsite('javascript:alert(1)');
  expect(open).toHaveBeenCalledTimes(1); expect(showToast).toHaveBeenCalledTimes(2);
  open.mockRejectedValueOnce(new Error('synthetic browser unavailable'));
  openRemoteWebsite('https://example.com/other'); await Promise.resolve();
  expect(showToast).toHaveBeenLastCalledWith('无法打开浏览器', 'alert'); open.mockRestore();
});

test('LAN/VPN service opens only after an explicit direct-device action', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  (showToast as jest.Mock).mockClear();
  expect(localServiceCanOpenOnPhone('http://192.168.1.8:3000')).toBe(true);
  expect(localServiceCanOpenOnPhone('http://10.8.0.4:3000')).toBe(true);
  expect(localServiceCanOpenOnPhone('http://100.100.10.4:3000')).toBe(true);
  expect(localServiceCanOpenOnPhone('http://[fd12::8]:3000')).toBe(true);
  expect(localServiceCanOpenOnPhone('http://devbox.local:3000')).toBe(true);
  expect(localServiceCanOpenOnPhone('http://workstation.tailnet.ts.net:3000')).toBe(true);
  expect(localServiceCanOpenOnPhone('http://localhost:3000')).toBe(false);
  expect(localServiceCanOpenOnPhone('http://127.0.0.1:3000')).toBe(false);
  expect(localServiceCanOpenOnPhone('http://0.0.0.0:3000')).toBe(false);
  expect(localServiceCanOpenOnPhone('http://169.254.169.254/latest/meta-data')).toBe(false);
  expect(localServiceCanOpenOnPhone('http://192.0.2.10:3000')).toBe(false);
  expect(localServiceCanOpenOnPhone('http://[fe80::1]:3000')).toBe(false);
  openLocalRemoteWebsite('http://192.168.1.8:3000');
  expect(open).toHaveBeenCalledWith('http://192.168.1.8:3000/');
  openLocalRemoteWebsite('http://localhost:3000');
  expect(open).toHaveBeenCalledTimes(1);
  expect(showToast).toHaveBeenLastCalledWith('这是电脑本机地址，手机无法直接访问', 'alert');
  open.mockRestore();
});
