import React, { memo, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useDesk } from '../theme';
import { RichRenderedSurface } from './RichRenderedSurface';
import type { RichRenderKind } from './rich-render-document';

export const InlineMath=memo(function InlineMath({source}:{source:string}) {
 const dk=useDesk();
 return <RichRenderedSurface kind="math" source={source} inline color={dk.text} background={dk.surface}/>;
});
export const RichMessageBlock=memo(function RichMessageBlock({kind,source}:{kind:RichRenderKind;source:string}) {
 const dk=useDesk(),[showSource,setShowSource]=useState(false),[copied,setCopied]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
 const copy=()=>{void Clipboard.setStringAsync(source).then(()=>{setCopied(true);if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>setCopied(false),1600);});};
 return <View style={{width:'100%',gap:8}}>
  <View style={{flexDirection:'row',alignItems:'center',gap:14}}><Text style={{flex:1,color:dk.muted,fontSize:11}}>{kind==='math'?'公式':'Mermaid'}</Text>
   <Pressable accessibilityRole="button" accessibilityLabel={showSource?'显示渲染内容':'查看渲染源码'} onPress={()=>setShowSource(value=>!value)}><Text style={{color:dk.muted,fontSize:11}}>{showSource?'预览':'源码'}</Text></Pressable>
   <Pressable accessibilityRole="button" accessibilityLabel="复制渲染源码" onPress={copy}><Text style={{color:dk.muted,fontSize:11}}>{copied?'已复制':'复制'}</Text></Pressable></View>
  {showSource?<ScrollView horizontal><Text selectable style={{fontFamily:'monospace',fontSize:12,lineHeight:19,color:dk.text2}}>{source}</Text></ScrollView>:null}
  <View style={{display:showSource?'none':'flex'}} accessibilityElementsHidden={showSource} importantForAccessibility={showSource?'no-hide-descendants':'auto'}>
   <RichRenderedSurface kind={kind} source={source} color={dk.text} background={dk.surface}/>
  </View>
 </View>;
});
