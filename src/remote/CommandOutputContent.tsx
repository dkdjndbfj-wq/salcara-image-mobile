import React, {useMemo} from 'react';
import {Platform, StyleSheet, Text, View, type TextStyle} from 'react-native';
import {useDesk} from '../theme';
import {conversationFontFamily} from './conversation-typography';

export type CommandOutputProps = {
  command?:string; output?:string; exitCode?:number; onOpenLink?:(target:string)=>void; scopeKey?:string;
};

/** Full, selectable output. Only explicit web links are actionable. */
export function CommandOutputContent({command,output,exitCode,onOpenLink}:CommandOutputProps) {
  const d=useDesk();
  const parts=useMemo(()=>output?.split(/(https?:\/\/[^\s<>()（）「」"'，。；！？]+)/gi),[output]);
  return <View style={styles.content}>
    {command?<Text selectable style={[styles.text,styles.command,{color:d.text2}]}>{`$ ${command}`}</Text>:null}
    {output?<Text selectable style={[styles.text,{color:d.text2}]}>{onOpenLink?parts?.map((part,index)=>{
      if(!/^https?:\/\//i.test(part))return part;
      const url=part.replace(/[.,:;!?)\]]+$/,'');
      return <React.Fragment key={index}><Text accessibilityRole="link" style={{color:d.accentText,textDecorationLine:'underline'}} onPress={()=>onOpenLink(url)}>{url}</Text>{part.slice(url.length)}</React.Fragment>;
    }):output}</Text>:null}
    {typeof exitCode==='number'?<Text selectable style={[styles.text,{color:exitCode===0?d.muted:d.bad}]}>{`退出码 ${exitCode}`}</Text>:null}
    {!command&&!output&&exitCode===undefined?<Text style={[styles.text,{color:d.muted}]}>等待命令输出…</Text>:null}
  </View>;
}

const styles=StyleSheet.create({
  content:{gap:8,flexShrink:0},
  text:{fontFamily:conversationFontFamily,fontSize:13,lineHeight:20,fontWeight:'400',flexShrink:0,
    ...(Platform.OS==='web'?{whiteSpace:'pre',overflowWrap:'normal',wordBreak:'normal'} as TextStyle:{})},
  command:{fontWeight:'500'},
});
