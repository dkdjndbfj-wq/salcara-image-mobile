import React from 'react';
import { Image, View, type ImageSourcePropType } from 'react-native';

import { Icon } from '../components/Icon';
import { useDesk } from '../theme';

// Original, unmodified official assets. See assets/agent-brand/README.md.
const CODEX_ICON: ImageSourcePropType = require('../../assets/agent-brand/codex-app-official.png');
const CLAUDE_ICON: ImageSourcePropType = require('../../assets/agent-brand/claude-app-official.png');
const ADDITIONAL_ICONS: Record<string, { source: ImageSourcePropType; label: string } | undefined> = {
  'deepseek-harness': { source: require('../../assets/agent-brand/deepseek-harness-app-official.png'), label: 'DeepSeek Harness' },
  hermes: { source: require('../../assets/agent-brand/hermes-app-official.png'), label: 'Hermes Agent' },
};

export type AgentBrandProps = { tool: string; client?: string; size?: number };

/** Identify the integrated product, without drawing or recolouring its trademark. */
export function AgentBrand({ tool, client, size = 36 }: AgentBrandProps) {
  const dk = useDesk();
  const desktop = tool === 'claude-desktop' || (tool === 'claude' && /desktop/i.test(client ?? ''));
  const family = tool === 'codex-desktop' ? 'codex' : tool === 'claude-desktop' ? 'claude' : tool;
  const additional = ADDITIONAL_ICONS[family];
  const source = family === 'codex' ? CODEX_ICON : family === 'claude' ? CLAUDE_ICON : additional?.source;
  const label = family === 'codex' ? 'Codex' : family === 'claude' ? desktop ? 'Claude Desktop' : 'Claude Code' : additional?.label;

  if (source) {
    return <Image testID={`agent-brand-${family}`} source={source}
      accessibilityRole="image" accessibilityLabel={label} resizeMode="contain"
      style={{ width: size, height: size }} />;
  }

  return <View testID="agent-brand-neutral" accessibilityRole="image" accessibilityLabel={tool || 'Agent'}
    style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <Icon name="terminal" size={size * 0.56} color={dk.muted} />
  </View>;
}
