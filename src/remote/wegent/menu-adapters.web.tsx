import React, { useEffect, type ReactNode, type RefObject } from 'react';

// Host adapters for the upstream ActionMenu; its positioning, focus, submenu,
// outside-click and pointer/keyboard selection logic remain in ActionMenu.web.
export function useEscapeKey(close: () => void, active: boolean, _ref?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [active, close]);
}
const Svg = ({ path, className }: { path: string; className?: string }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}><path d={path} /></svg>;
export const Check = ({ className }: { className?: string }) => <Svg className={className} path="m5 12 4 4L19 6" />;
export const ChevronDown = ({ className }: { className?: string }) => <Svg className={className} path="m6 9 6 6 6-6" />;
export const ChevronRight = ({ className }: { className?: string }) => <Svg className={className} path="m9 6 6 6-6 6" />;
export const MoreHorizontal = ({ className }: { className?: string }) => <Svg className={className} path="M5 12h.01M12 12h.01M19 12h.01" />;
export function Tooltip({ children, label }: { children: ReactNode; label: string; testId?: string }) { return <span title={label} style={{ display: 'contents' }}>{children}</span>; }
export function KeyboardShortcut({ value, className }: { value: string; className?: string }) { return <kbd className={className}>{value.replace('Command', '⌘').replace('Control', 'Ctrl').replace('Alt', '⌥')}</kbd>; }
export function useCollaborationPortalTheme() { return { className: 'wegent-menu', style: {} }; }
