import React from 'react';
import { Image, View, type ImageSourcePropType } from 'react-native';

import { Icon } from '../components/Icon';
import { colors, desk, themed, useDesk } from '../theme';

// Original, unmodified official assets. See assets/agent-brand/README.md.
const CODEX_ICON: ImageSourcePropType = require('../../assets/agent-brand/codex-app-official.png');
const CLAUDE_ICON: ImageSourcePropType = require('../../assets/agent-brand/claude-app-official.png');

export type AgentBrandProps = { tool: string; client?: string; size?: number };

/** Identify the integrated product, without drawing or recolouring its trademark. */
export function AgentBrand({ tool, client, size = 36 }: AgentBrandProps) {
  const dk = useDesk();
  const desktop = tool === 'claude-desktop' || (tool === 'claude' && /desktop/i.test(client ?? ''));
  const source = tool === 'codex' ? CODEX_ICON : tool === 'claude' || tool === 'claude-desktop' ? CLAUDE_ICON : null;
  const label = tool === 'codex' ? 'Codex' : desktop ? 'Claude Desktop' : 'Claude Code';

  if (source) {
    return <Image testID={`agent-brand-${tool === 'codex' ? 'codex' : 'claude'}`} source={source}
      accessibilityRole="image" accessibilityLabel={label} resizeMode="contain"
      style={{ width: size, height: size }} />;
  }

  return <View testID="agent-brand-neutral" accessibilityRole="image" accessibilityLabel={tool || 'Agent'}
    style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <Icon name="terminal" size={size * 0.56} color={dk.muted} />
  </View>;
}
