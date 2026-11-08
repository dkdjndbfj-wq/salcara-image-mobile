import React, {useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useDesk} from '../theme';
import {CommandOutputContent,type CommandOutputProps} from './CommandOutputContent';
import {CommandOutputActions} from './CommandOutputActions';

/** A fixed-height viewport; native nested scroll views own one axis each. */
export function CommandOutput(props:CommandOutputProps) {
  const d=useDesk(),[width,setWidth]=useState(0);
  return <View testID="command-output-frame" style={[styles.frame,{backgroundColor:d.surface2}]} onLayout={event=>setWidth(event.nativeEvent.layout.width)}>
    <CommandOutputActions {...props}/>
    <ScrollView testID="command-output-scroll" accessibilityLabel="命令输出，支持上下左右滚动" nestedScrollEnabled showsVerticalScrollIndicator persistentScrollbar
      style={styles.vertical} contentContainerStyle={styles.verticalContent} keyboardShouldPersistTaps="handled">
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator persistentScrollbar keyboardShouldPersistTaps="handled"
        style={styles.horizontal} contentContainerStyle={[styles.content,{minWidth:width}]}>
        <CommandOutputContent {...props}/>
      </ScrollView>
    </ScrollView>
  </View>;
}

const styles=StyleSheet.create({
  frame:{height:200,minWidth:0,borderRadius:8,overflow:'hidden'},
  vertical:{flex:1},verticalContent:{flexGrow:1},horizontal:{flexGrow:0,flexShrink:0},
  content:{padding:12},
});
