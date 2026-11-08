import { DESKTOP_GITHUB_URL, openDesktopGithub } from '../remote/RemoteDownloads';
import { Linking } from 'react-native';

const mockOpen = jest.spyOn(Linking, 'openURL');
const mockToast = jest.fn();
jest.mock('../components/ui', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));

beforeEach(() => { jest.clearAllMocks(); mockOpen.mockResolvedValue(undefined); });

test('the download entry opens the verified desktop repository latest release', async () => {
  expect(DESKTOP_GITHUB_URL).toBe('https://github.com/dkdjndbfj-wq/salcara-desktop/releases/latest');
  await openDesktopGithub();
  expect(mockOpen).toHaveBeenCalledWith(DESKTOP_GITHUB_URL);
  expect(mockToast).not.toHaveBeenCalled();
});

test('an empty download address only gives a concise notice', async () => {
  await openDesktopGithub('');
  expect(mockOpen).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('下载地址尚未配置', 'alert');
});

test.each(['https://github.com/example/desktop', 'https://github.com/example/desktop/releases', 'https://github.com/example/desktop/releases/latest'])('opens only the supplied verified-shaped GitHub repository/release link: %s', async (url) => {
  await openDesktopGithub(url);
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockOpen).toHaveBeenCalledWith(url);
  expect(mockToast).not.toHaveBeenCalled();
});

test.each([
  'https://github.com/',
  'http://github.com/example/desktop', 'https://github.com.attacker.example/example/desktop',
  'https://example.github.com/example/desktop', 'https://token@github.com/example/desktop',
  'https://github.com/example/desktop?key=fixture-secret', 'https://github.com/example/desktop#fixture-secret',
  'https://github.com:8443/example/desktop', 'https://github.com/example/desktop/releases/download/file.exe',
  'https://github.com/example/desktop/../private', 'https://github.com/example/%2e%2e',
  'https://relay.example/salcara-hub', 'javascript:alert(1)', 'sk-fixture-secret',
])('invalid links never open and never reveal the supplied value: %s', async (url) => {
  await openDesktopGithub(url);
  expect(mockOpen).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledTimes(1);
  expect(mockToast).toHaveBeenCalledWith('无法打开 GitHub', 'alert');
  expect(JSON.stringify(mockToast.mock.calls)).not.toContain(url);
  expect(JSON.stringify(mockToast.mock.calls)).not.toContain('fixture-secret');
});

test('an open failure does not leak exception details, URLs or keys and does not retry', async () => {
  mockOpen.mockRejectedValueOnce(new Error('fixture-secret https://private.example/?key=fixture-secret'));
  await openDesktopGithub('https://github.com/example/desktop/releases/latest');
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(mockToast).toHaveBeenCalledWith('无法打开 GitHub', 'alert');
  expect(JSON.stringify(mockToast.mock.calls)).not.toMatch(/fixture-secret|private\.example|key=/);
});
