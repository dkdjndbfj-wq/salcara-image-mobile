import { Linking } from 'react-native';
import { showToast } from '../components/ui';

// Temporary GitHub homepage placeholder, not the computer app's download repository.
// Replace only after the official Salcara desktop repository is verified.
export const DESKTOP_GITHUB_URL: string = 'https://github.com/';

function desktopGithubUrl(value: string): boolean {
  if (value === 'https://github.com/') return true;
  if (!/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+(?:\/releases(?:\/latest)?)?\/?$/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com'
      && !parsed.port && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      && /^\/[a-z0-9-]+\/[a-z0-9_.-]+(?:\/releases(?:\/latest)?)?\/?$/i.test(parsed.pathname);
  } catch { return false; }
}

/** Opens GitHub, never a station URL or credential-bearing link. */
export async function openDesktopGithub(url = DESKTOP_GITHUB_URL): Promise<void> {
  if (!url) { showToast('下载地址尚未配置', 'alert'); return; }
  if (!desktopGithubUrl(url)) { showToast('无法打开 GitHub', 'alert'); return; }
  try { await Linking.openURL(url); } catch { showToast('无法打开 GitHub', 'alert'); }
}
