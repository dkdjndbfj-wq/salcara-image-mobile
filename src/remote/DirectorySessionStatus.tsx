import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import { SidebarTaskIndicator } from './SidebarMotion';
import { conversationFontFamily } from './conversation-typography';
import type { DirectorySessionActivity } from './directory-session-activity';
import {UnreadResultDot,type ConversationResultSource} from './ConversationUnread';

export function DirectorySessionStatus({ activity, title, active, reduced, fallback, result }: {
  activity: DirectorySessionActivity; title: string; active: boolean; reduced: boolean; fallback?: string;result?:ConversationResultSource;
}) {
  const d = useDesk(), subject = activity.includesChildren ? `${title}及其子任务` : title;
  const status=activity.status === 'running' ? <SidebarTaskIndicator active={active} reduced={reduced} label={`${subject}${active ? '运行中' : '上次运行中'}`} />
  :activity.status === 'waiting_approval' ? <View accessible accessibilityRole="text" accessibilityLabel={`${subject}待回复`} style={styles.status}>
    <Icon name="clock" size={13} color={d.muted}/><Text style={[styles.text,{color:d.muted}]}>待回复</Text>
  </View>
  :activity.status === 'failed'?<Text style={[styles.text,{color:d.bad}]}>失败</Text>
  :fallback ? <Text style={[styles.text,{color:d.muted}]}>{fallback}</Text> : null;
  return <View style={styles.status}>{result?<UnreadResultDot source={result} title={title} status={activity.status}/>:null}{status}</View>;
}
const styles = StyleSheet.create({status:{flexDirection:'row',alignItems:'center',gap:4},text:{fontFamily:conversationFontFamily,fontSize:10.5}});
