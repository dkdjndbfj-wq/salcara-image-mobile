import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';

/** The count is the live queue size, not a prediction of future requests. */
export function ApprovalQueueBar({ count, disabled, onMove }: { count: number; disabled: boolean; onMove: (offset: number) => void }) {
  const styles = useStyles(), dk = useDesk();
  if (count < 2) return null;
  return <View style={styles.bar} testID="remote-approval-queue">
    <Text style={styles.label} accessibilityLiveRegion="polite">待处理 {count} 项</Text>
    <View style={{ flex: 1 }} />
    <Pressable accessibilityRole="button" accessibilityLabel="上一个待处理请求" disabled={disabled} onPress={() => onMove(-1)} style={styles.button}>
      <Icon name="chevronLeft" size={16} color={disabled ? dk.faint : dk.text2} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="下一个待处理请求" disabled={disabled} onPress={() => onMove(1)} style={styles.button}>
      <Icon name="chevronRight" size={16} color={disabled ? dk.faint : dk.text2} />
    </Pressable>
  </View>;
}
const useStyles = themed((_c, d) => StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 18, gap: 4 },
  label: { fontSize: 12, color: d.muted },
  button: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18 },
}));
