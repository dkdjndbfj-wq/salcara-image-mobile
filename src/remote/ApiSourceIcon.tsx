import React from 'react';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import type { RemoteApiOption } from './client';

/** A credential's kind comes from metadata, never its user-defined name. */
export function ApiSourceIcon({ sourceType, followComputer = false, size = 17, color }: {
  sourceType?: RemoteApiOption['sourceType']; followComputer?: boolean; size?: number; color?: string;
}) {
  const d = useDesk();
  const name = followComputer ? 'laptop' : sourceType === 'official_account' || sourceType === 'oauth' ? 'user'
    : sourceType === 'reverse_proxy' ? 'server' : 'key';
  return <Icon name={name} size={size} color={color ?? d.muted} strokeWidth={1.6} />;
}
