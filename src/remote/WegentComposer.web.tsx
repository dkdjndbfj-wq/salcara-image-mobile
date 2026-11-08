import React, { useLayoutEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Icon } from '../components/Icon';
import { ProjectChatComposerSurface } from './wegent/ProjectChatComposerSurface.web';
import { ActionMenu } from './wegent/ActionMenu.web';
import { composerCss, workbenchContainerCss } from './wegent/composer-styles';
import type { WegentMenuProps, WegentSurfaceProps, WegentToolbarProps } from './WegentComposer';

export function WegentComposerSurface({ children, enabled = true, fallbackStyle }: WegentSurfaceProps) {
  if (!enabled) return <View style={fallbackStyle}>{children}</View>;
  return <><style>{composerCss + workbenchContainerCss}</style><ProjectChatComposerSurface formProps={{ onSubmit: event => event.preventDefault() }} canCollapseInShortPane>{children}</ProjectChatComposerSurface></>;
}

/** JSX groups and ResizeObserver behavior from shared ComposerToolbar.tsx.
 * Existing host controls own models, attachment permissions and task dispatch. */
export function WegentComposerToolbar({ features, actions }: WegentToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null), [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || typeof ResizeObserver === 'undefined') return;
    const updateCompact = (width: number) => setCompact(width < 475);
    updateCompact(toolbar.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => { const entry = entries[0]; if (entry) updateCompact(entry.contentRect.width); });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);
  return <><style>{composerCss}</style><div ref={toolbarRef} data-testid="composer-toolbar" data-compact={compact ? 'true' : 'false'} className="wegent-toolbar">
    <div data-composer-toolbar-group="features">{features}</div>
    <div data-composer-toolbar-group="actions">{actions}</div>
  </div></>;
}

export function WegentActionMenu({ label, icon = 'more', title, disabled, items }: WegentMenuProps) {
  return <><style>{composerCss}</style><ActionMenu ariaLabel={label} testId={`wegent-menu-${label}`} disabled={disabled} placement="bottom-end" triggerClassName="wegent-menu-trigger"
    icon={() => <Icon name={icon} size={15} color="#666666" />} triggerLabel={title}
    items={items.map(item => ({ label: item.label, testId: item.id, onSelect: item.onSelect, checked: item.checked, disabled: item.disabled }))} /></>;
}
