import { Linking } from 'react-native';
import { showToast } from '../components/ui';
import { workspaceRelativePath } from './workspace-files';
import { sessionKeyAgentId } from './projection';

export type RemoteLink = { kind: 'web'; url: string } | { kind: 'local-service' } | { kind: 'file'; path: string; line?: number; column?: number }
  | { kind: 'task'; sessionKey: string; connectionId?: string; deviceId?: string; agentId?: string; surface?: 'cli' | 'desktop' | 'read-only'; sessionScope?: 'desktop-chat' | 'desktop-cowork' } | { kind: 'blocked' };

export interface SalcaraThreadLink { connectionId: string; deviceId: string; agentId: string; sessionKey: string; surface?: 'cli' | 'desktop' | 'read-only'; sessionScope?: 'desktop-chat' | 'desktop-cowork' }

/** Parse only links produced by this app. A link is a navigation hint, never authorization. */
export function parseSalcaraThreadLink(target: string): SalcaraThreadLink | undefined {
  if (typeof target !== 'string' || !target || target.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(target)) return;
  try {
    const url = new URL(target);
    const keys = [...url.searchParams.keys()];
    const sortedKeys = [...keys].sort();
    const currentKeys = sortedKeys.join(',');
    if (new Set(keys).size !== keys.length || url.protocol !== 'salcara:' || url.hostname !== 'remote' || url.pathname !== '/thread' || url.username || url.password || url.port || url.hash
      || !['agent,connection,device,session', 'agent,connection,device,session,surface', 'agent,connection,device,scope,session,surface'].includes(currentKeys)) return;
    const connectionId = url.searchParams.get('connection') ?? '', deviceId = url.searchParams.get('device') ?? '';
    const agentId = url.searchParams.get('agent') ?? '', sessionKey = url.searchParams.get('session') ?? '';
    const surface = url.searchParams.get('surface');
    const rawScope = url.searchParams.get('scope');
    if (!/^[a-f0-9]{64}$/.test(connectionId) || !/^[A-Za-z0-9._-]{1,128}$/.test(deviceId)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agentId) || agentId === 'codex-desktop'
      || !/^[^|\s\p{Cc}\p{Cf}]{3,512}$/u.test(sessionKey)) return;
    if (surface !== null && surface !== 'cli' && surface !== 'desktop' && surface !== 'read-only'
      || rawScope !== null && rawScope !== 'desktop-chat' && rawScope !== 'desktop-cowork'
      || (surface === 'read-only') !== (rawScope !== null)
      || surface === 'desktop' && agentId !== 'codex' || surface === 'read-only' && agentId !== 'claude-desktop') return;
    const namespace = sessionKeyAgentId(sessionKey);
    if (!namespace || !(namespace === agentId || agentId === 'claude-desktop' && (namespace === 'claude' || namespace === 'claude-desktop'))) return;
    return { connectionId, deviceId, agentId, sessionKey, ...(surface ? { surface } : {}), ...(rawScope ? { sessionScope: rawScope } : {}) };
  } catch { return; }
}

function localHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (!name || !name.includes('.') && !name.startsWith('[') || name === 'localhost' || /\.(?:localhost|local|internal|lan|home|home\.arpa|ts\.net|test|invalid)$/.test(name)) return true;
  if (name.startsWith('[')) {
    // Only ordinary global unicast IPv6 literals; deny loopback, mapped IPv4,
    // link-local, ULA, multicast, zone IDs and special-purpose prefixes.
    return !/^\[[23][0-9a-f]{0,3}:/i.test(name) || /^\[2001:(?:0{1,4}:|0{0,3}2:|0{0,2}(?:10|20|db8):)/i.test(name) || /^\[(?:2002|3fff):/i.test(name);
  }
  if (/^[0-9.]+$/.test(name)) {
    const parts = name.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0;
  }
  return false;
}

export function resolveRemoteLink(target: string, cwd?: string): RemoteLink {
  if (typeof target !== 'string' || !target || target.length > 4096 || target.trim() !== target || /[\p{Cc}\p{Cf}]/u.test(target)) return { kind: 'blocked' };
  const salcaraThread = parseSalcaraThreadLink(target);
  if (salcaraThread) return { kind: 'task', ...salcaraThread };
  if (/^https?:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || target.includes('\\') || /%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(target)) return { kind: 'blocked' };
      if (localHost(url.hostname)) return { kind: 'local-service' };
      return { kind: 'web', url: url.toString() };
    } catch { return { kind: 'blocked' }; }
  }
  const task = target.match(/^codex:\/\/threads\/([A-Za-z0-9_-]{1,160})$/);
  if (task && task[1] !== 'new') return { kind: 'task', sessionKey: `codex:${task[1]}` };
  let path = target, line: number | undefined, column: number | undefined;
  const location = path.match(/(?::([0-9]+)(?::([0-9]+))?|#L([0-9]+)(?:C([0-9]+))?)$/);
  if (location) {
    line = Number(location[1] ?? location[3]);
    column = location[2] || location[4] ? Number(location[2] ?? location[4]) : undefined;
    if (!Number.isSafeInteger(line) || line < 1 || line > 1_000_000 || column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > 1_000_000)) return { kind: 'blocked' };
    path = path.slice(0, -location[0].length);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return { kind: 'blocked' };
  if (path.includes('%') || path.includes('?') || path.includes('#')) return { kind: 'blocked' };
  path = path.replace(/\\/g, '/');
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
    const root = cwd?.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!root || path.startsWith('//') || root.startsWith('//') || root.split('/').some(part => part === '.' || part === '..')) return { kind: 'blocked' };
    const windows = /^[A-Za-z]:\//.test(root);
    // Only the drive letter is case-insensitive here. NTFS projects can enable
    // per-directory case sensitivity; guessing a different absolute root
    // would silently open the same-named file from the wrong project.
    const candidate = windows ? path[0].toLowerCase() + path.slice(1) : path;
    const prefix = windows ? root[0].toLowerCase() + root.slice(1) : root;
    if (!candidate.startsWith(`${prefix}/`)) return { kind: 'blocked' };
    path = path.slice(root.length + 1);
  }
  if (path.startsWith('./')) path = path.slice(2);
  if (!workspaceRelativePath(path)) return { kind: 'blocked' };
  return { kind: 'file', path, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

/** Conservative inline-code activation; command/code fragments stay inert. */
export function inlineRemoteReference(target: string): boolean {
  if (!target || target.length > 4096) return false;
  if (parseSalcaraThreadLink(target)) return true;
  const base = target.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '');
  return /^codex:\/\/threads\/[A-Za-z0-9_-]{1,160}$/.test(target) && !target.endsWith('/new')
    || !/[\n\r(){};=<>]/.test(base) && /(?:\.(?:txt|md|mdx|rst|go|rs|c|h|cpp|hpp|cs|java|kt|swift|py|rb|php|js|jsx|ts|tsx|vue|svelte|html|css|scss|less|json|yaml|yml|toml|xml|sql|sh|ps1|bat|cmd|gradle)|(?:^|[\\/])(?:Dockerfile|Makefile|LICENSE|README))$/i.test(base);
}

/** No credentials, embedded browser, downloads, tunnels or automatic fetch. */
export function openRemoteWebsite(target: string): void {
  const link = resolveRemoteLink(target);
  if (link.kind === 'web') void Linking.openURL(link.url).catch(() => showToast('无法打开浏览器', 'alert'));
  else showToast(link.kind === 'local-service' ? '这是电脑本地地址，手机无法直接打开' : '此链接请在对应电脑会话中查看', 'alert');
}

/**
 * Open a service that is reachable from the phone's current LAN/VPN.
 *
 * This is deliberately separate from `openRemoteWebsite`: public links use
 * the normal browser action, while a local service is opened only after an
 * explicit tap from the tool panel.  Loopback names still point at the phone
 * itself and are therefore rejected with a useful message.  No request is
 * sent through Salcara Hub and no automatic fetch is performed.
 */
export function localServiceCanOpenOnPhone(target: string): boolean {
  const link = resolveRemoteLink(target);
  if (link.kind !== 'local-service') return false;
  try {
    // A link classified as local can still be a reserved, link-local or
    // otherwise non-routable address. Only allow ordinary private LAN ranges,
    // the CGNAT range commonly used by VPNs (including Tailscale), IPv6 ULA,
    // and explicit local/VPN DNS suffixes after the user taps the action.
    const host = new URL(target).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.includes('%')) return false;
    if (host.includes(':')) return /^f[cd][0-9a-f]{2}:/i.test(host);
    if (/^[0-9.]+$/.test(host)) {
      const parts = host.split('.').map(Number);
      if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
      const [a, b] = parts;
      return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
        || a === 100 && b >= 64 && b <= 127;
    }
    return /\.(?:local|home\.arpa|lan|internal|ts\.net)$/.test(host);
  } catch { return false; }
}

/** Explicit, direct-device action for a LAN/VPN service shown in the tool panel. */
export function openLocalRemoteWebsite(target: string): void {
  const link = resolveRemoteLink(target);
  if (link.kind !== 'local-service') {
    showToast('这个地址不是局域网或 VPN 服务', 'alert');
    return;
  }
  if (!localServiceCanOpenOnPhone(target)) {
    showToast('这是电脑本机地址，手机无法直接访问', 'alert');
    return;
  }
  try {
    const url = new URL(target).toString();
    void Linking.openURL(url).catch(() => showToast('无法打开局域网服务', 'alert'));
  } catch { showToast('无法打开局域网服务', 'alert'); }
}
