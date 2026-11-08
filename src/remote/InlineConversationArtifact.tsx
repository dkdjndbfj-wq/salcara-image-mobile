import React,{useMemo,useRef} from 'react';
import {Pressable,StyleSheet,Text,View} from 'react-native';
import {useDesk} from '../theme';
import {AnnotatedArtifact} from '../components/AnnotatedArtifact';
import {InteractiveArtifact} from '../components/InteractiveArtifact';
import {Icon} from '../components/Icon';
import {conversationArtifactRevision,conversationArtifactTitle,type ConversationArtifactTarget} from './conversation-artifact-target';
export function InlineConversationArtifact({scopeKey,messageId,index,source,onCompose,onOpen,inline=true,active=true}:{scopeKey:string;messageId:string;index:number;source:string;onCompose?:(text:string)=>boolean;onOpen?:(target:ConversationArtifactTarget)=>void;inline?:boolean;active?:boolean}) {
  const d=useDesk();
  const revision=useMemo(()=>conversationArtifactRevision(source),[source]),artifactId=JSON.stringify([messageId,index]);
  const identity=JSON.stringify([scopeKey,artifactId,revision]),current=useRef(identity);current.current=identity;
  if(onOpen){
    const title=conversationArtifactTitle(source);
    const target:ConversationArtifactTarget={scopeKey,messageId,index,source,revision,title};
    return <Pressable testID="conversation-artifact-card" accessibilityRole="button" accessibilityLabel={`打开界面预览 ${title}`} onPress={()=>{if(current.current===identity)onOpen(target);}} style={{borderWidth:1,borderColor:d.line,borderRadius:12,overflow:'hidden',backgroundColor:d.surface}}>
      <View style={{padding:12,flexDirection:'row',alignItems:'center',gap:8,borderBottomWidth:StyleSheet.hairlineWidth,borderColor:d.line}}><Icon name="code" size={16} color={d.muted}/><Text numberOfLines={1} style={{flex:1,color:d.text,fontSize:13,fontWeight:'500'}}>{title}</Text><Icon name="maximize" size={15} color={d.muted}/></View>
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{height:220,overflow:'hidden'}}><InteractiveArtifact scopeKey={scopeKey} artifactId={artifactId} revision={revision} source={source} inline readOnlyState title={`${title}缩略预览`}/></View>
    </Pressable>;
  }
  return <View testID="inline-conversation-artifact" style={{gap:10}}>
    {onCompose?<AnnotatedArtifact scopeKey={scopeKey} artifactId={artifactId} revision={revision} source={source} inline={inline} active={active} title="交互预览"
      origin={`原消息：${messageId}\n代码块：${index+1}\n版本：${revision}`} onCompose={text=>current.current===identity&&onCompose(text)}/>
      :<InteractiveArtifact scopeKey={scopeKey} artifactId={artifactId} revision={revision} source={source} inline={inline} active={active} title="交互预览"/>}
  </View>;
}
