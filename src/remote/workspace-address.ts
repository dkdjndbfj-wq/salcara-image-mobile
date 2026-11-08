import { workspaceBrowserTarget } from './workspace-browser';

function bareAddressTarget(address: string) {
  const target = workspaceBrowserTarget(`https://${address}`);
  // Reuse the existing local-service boundary; development servers usually
  // speak HTTP. An explicitly typed protocol is handled before this helper.
  return target?.kind === 'local-service' ? workspaceBrowserTarget(`http://${address}`) : target;
}

/** Address-bar input permits HTTP(S) navigation and otherwise ordinary search. */
export function workspaceAddressTarget(value: string) {
  const input = value.trim();
  if (!input || input.length > 4096 || /[\p{Cc}\p{Cf}\\]/u.test(input) || input.startsWith('//')) return;
  if (/^https?:\/\//i.test(input)) return workspaceBrowserTarget(input);
  // Host:port is not a URI scheme, but reserved URI names must stay inert even
  // with numeric payloads (for example javascript:123 or tel:123).
  if (/^(?:https?|file|javascript|vbscript|data|blob|ftp|ftps|sftp|ws|wss|mailto|tel|sms|intent|about|chrome|edge|codex|salcara):/i.test(input)) return;

  const authority = input.split(/[/?#]/, 1)[0];
  const suffix = input.slice(authority.length);
  if (!/\s/.test(authority)) {
    if (authority.includes('@')) return;
    if (authority.startsWith('[')) return bareAddressTarget(input);
    // A bare IPv6 literal has no port; an IPv6 port must follow a closing ].
    if ((authority.match(/:/g)?.length ?? 0) > 1 && /^[\da-f:.]+$/i.test(authority)) {
      return bareAddressTarget(`[${authority}]${suffix}`);
    }
    const hostPort = authority.match(/^([^:]+)(?::(\d+))?$/);
    if (hostPort && (hostPort[1].includes('.') || /^localhost$/i.test(hostPort[1]) || hostPort[2])) {
      let hostname: string;
      try { hostname = new URL(`https://${input}`).hostname.replace(/\.$/, ''); }
      catch { return; }
      // Expo's URL parser may retain Unicode hostnames. Accept domain letters
      // and digits, but not punctuation from ordinary search text.
      if (hostname.length <= 253 && hostname.split('.').every(label => /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?$/u.test(label))) {
        return bareAddressTarget(input);
      }
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(input)) return;
  }
  return workspaceBrowserTarget(`https://www.google.com/search?q=${encodeURIComponent(input)}`);
}
