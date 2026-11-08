// Platform boundary for the upstream browser shortcut hook.
export function getPlatform(): 'mac' | 'win' {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'win';
}
