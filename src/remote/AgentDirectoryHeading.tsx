import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import type { WorkspaceMode } from './client';
import { conversationFontFamily } from './conversation-typography';

export function AgentDirectoryHeading({ agentName, deviceName, mode, onNew, disabled }: {
  agentName: string; deviceName?: string; mode: WorkspaceMode; onNew?: () => void; disabled?: boolean;
}) {
  const d = useDesk(), label = mode === 'code' ? 'Code' : 'Work';
  return <View testID="agent-directory-heading" style={styles.heading}>
    <View style={styles.copy}>
      <Text accessibilityRole="header" numberOfLines={1} style={[styles.title,{color:d.text}]}>{agentName}</Text>
      <View style={styles.detail}>
        {deviceName ? <Text numberOfLines={1} style={[styles.device,{color:d.muted}]}>{deviceName}</Text> : null}
        {deviceName ? <Text style={[styles.mode,{color:d.faint}]}>·</Text> : null}
        <Text style={[styles.mode,{color:d.muted}]}>{label} 会话</Text>
      </View>
    </View>
    {onNew ? <Pressable testID="agent-directory-new" accessibilityRole="button" accessibilityLabel={`新建 ${label} 对话`}
      accessibilityState={{disabled:Boolean(disabled)}} disabled={disabled} onPress={onNew}
      style={({pressed})=>[styles.newButton,{opacity:disabled ? 0.4 : 1,backgroundColor:pressed?d.surface2:'transparent'}]}>
      <Icon name="compose" size={19} color={d.text2}/>
    </Pressable> : null}
  </View>;
}
const styles=StyleSheet.create({heading:{minHeight:64,paddingVertical:8,flexDirection:'row',alignItems:'center',gap:12,marginBottom:6},copy:{flex:1,minWidth:0,gap:4},
  title:{fontFamily:conversationFontFamily,fontSize:20,lineHeight:26,fontWeight:'600'},detail:{flexDirection:'row',alignItems:'center',gap:6},
  device:{fontFamily:conversationFontFamily,fontSize:11.5,lineHeight:17,flexShrink:1},mode:{fontFamily:conversationFontFamily,fontSize:11.5,lineHeight:17},
  newButton:{width:44,height:44,alignItems:'center',justifyContent:'center',borderRadius:12}});
