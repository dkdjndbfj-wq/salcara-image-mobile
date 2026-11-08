import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { SpaceSwitch } from '../companion/SpaceSwitch';
import type { Space } from '../state/AppContext';
import { colors, themed } from '../theme';
import { BrandMark } from './Brand';
import { IconButton } from './ui';

export function AssistantTopBar({ onOpenConversations, onNewChat, newChatDisabled, onSwitchSpace }: {
  onOpenConversations: () => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
  onSwitchSpace: (space: Space) => void;
}) {
  const styles = useStyles();
  const compact = useWindowDimensions().width < 390;

  return <View style={styles.row}>
    <IconButton icon="menu" label="打开侧边栏" onPress={onOpenConversations} size={36} iconSize={20} />
    <View style={styles.brand}>
      <BrandMark size={22} />
      {!compact ? <Text style={styles.brandName}>Salcara</Text> : null}
    </View>
    <View style={styles.spacer} />
    <IconButton icon="compose" label="新对话" disabled={newChatDisabled} onPress={onNewChat} size={36} iconSize={19} />
    <View pointerEvents="box-none" style={styles.center}>
      <SpaceSwitch space="assistant" onSwitch={onSwitchSpace} />
    </View>
  </View>;
}

const useStyles = themed((c) => StyleSheet.create({
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 5, backgroundColor: c.canvas },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  brandName: { color: c.text, fontSize: 13.5, fontWeight: '600' },
  spacer: { flex: 1, minWidth: 0 },
  center: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
}));
