import React, {useCallback, useEffect, useRef, useState, type RefObject} from 'react';
import {AppState, Platform, Pressable, StyleSheet, Text, View} from 'react-native';
import {Icon, type IconName} from '../components/Icon';
import {dismissKeyboardAndBlur, showToast} from '../components/ui';
import {useDesk} from '../theme';
import {ComposerPopover} from './ComposerPopover';

// RN Web filters the HTML title prop on Pressable; set it on its host for hover help.
function useToolbarRef(label:string,anchorRef?:RefObject<View|null>) {
  return useCallback((node:View|null)=>{
    if(anchorRef)anchorRef.current=node;
    if(Platform.OS==='web')(node as unknown as {setAttribute?:(name:string,value:string)=>void}|null)?.setAttribute?.('title',label);
  },[anchorRef,label]);
}

/** Keep the glyph quiet while reserving a real, non-overlapping touch target. */
export function ToolbarButton({icon,label,onPress,disabled=false,selected=false,anchorRef,testID,color}: {
  icon:IconName;label:string;onPress:()=>void;disabled?:boolean;selected?:boolean;anchorRef?:RefObject<View|null>;testID?:string;color?:string;
}) {
  const d=useDesk(),explaining=useRef(false),ink=color??(selected?d.text:d.text2);
  const ref=useToolbarRef(label,anchorRef);
  return <Pressable ref={ref} collapsable={false} testID={testID} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{disabled,selected}} disabled={disabled} onPressIn={()=>{explaining.current=false;}}
    onLongPress={()=>{explaining.current=true;showToast(label,icon);}}
    onPress={()=>{if(explaining.current)return;dismissKeyboardAndBlur();onPress();}}
    style={({pressed})=>[styles.button,{opacity:disabled ? .4 : 1,backgroundColor:pressed||selected?d.surface2:'transparent'}]}>
    <Icon name={icon} size={18} strokeWidth={1.6} color={ink} accent={ink}/>
  </Pressable>;
}

export type ToolbarAction={label:string;accessibilityLabel?:string;onPress?:()=>void;icon?:IconName;disabled?:boolean;tone?:'primary'|'secondary'|'danger'};
const needsActionLabel=(action:ToolbarAction)=>!action.icon||action.tone==='danger';
export function ToolbarMenu({visible,anchorRef,onClose,actions,message,label='工具菜单',testID='workbench-toolbar-menu'}:{
  visible:boolean;anchorRef:RefObject<View|null>;onClose:()=>void;actions:ToolbarAction[];message?:string;label?:string;testID?:string;
}) {
  const d=useDesk(),current=useRef({visible,onClose});current.current={visible,onClose};
  const [hint,setHint]=useState('');
  useEffect(()=>{if(!visible)setHint('');},[visible]);
  useEffect(()=>{const subscription=AppState.addEventListener('change',state=>{if(state!=='active'&&current.current.visible)current.current.onClose();});return()=>subscription.remove();},[]);
  const columns=Math.min(3,Math.max(1,actions.length)),width=message||actions.some(needsActionLabel)?208:columns*44+(columns-1)*2+14;
  const rows:ToolbarAction[][]=[];
  for(const action of actions){
    const previous=rows[rows.length-1];
    if(needsActionLabel(action)||!previous||needsActionLabel(previous[0])||previous.length===3)rows.push([action]);
    else previous.push(action);
  }
  return <ComposerPopover visible={visible} anchorRef={anchorRef} onClose={onClose} width={width} testID={testID} accessibilityLabel={label}>
    <View style={styles.options}>{rows.map(row=><View key={row[0].accessibilityLabel??row[0].label} style={[styles.grid,needsActionLabel(row[0])&&styles.labelledGrid]}>{row.map(action=><ToolbarMenuAction key={action.accessibilityLabel??action.label} action={action} onExplain={setHint}
      onActivate={()=>{if(!current.current.visible||action.disabled)return;current.current.visible=false;onClose();action.onPress?.();}}/>)}</View>)}
      {hint?<Text accessibilityLiveRegion="polite" style={[styles.hint,{color:d.text2}]}>{hint}</Text>:null}
      {message?<Text style={[styles.message,{color:d.muted}]}>{message}</Text>:null}</View>
  </ComposerPopover>;
}

function ToolbarMenuAction({action,onActivate,onExplain}:{action:ToolbarAction;onActivate:()=>void;onExplain:(label:string)=>void}) {
  const d=useDesk(),explaining=useRef(false),label=action.accessibilityLabel??action.label,ink=action.tone==='danger'?d.bad:d.text2;
  const ref=useToolbarRef(label);
  return <Pressable ref={ref} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{disabled:Boolean(action.disabled)}} disabled={action.disabled}
    onPressIn={()=>{explaining.current=false;}} onLongPress={()=>{explaining.current=true;onExplain(label);}}
    onPress={()=>{if(!explaining.current)onActivate();}}
    style={({pressed})=>[styles.button,needsActionLabel(action)&&styles.textOption,{opacity:action.disabled ? .4 : 1,backgroundColor:pressed?d.surface2:'transparent'}]}>
    {action.icon?<Icon name={action.icon} size={18} strokeWidth={1.6} color={ink} accent={ink}/>:null}
    {needsActionLabel(action)?<Text style={[styles.label,{color:ink}]}>{action.label}</Text>:null}
  </Pressable>;
}

const styles=StyleSheet.create({button:{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center',borderRadius:8},
  options:{padding:6,gap:2},grid:{flexDirection:'row',gap:2,maxWidth:136},labelledGrid:{maxWidth:'100%',width:'100%'},textOption:{width:'100%',height:'auto',minHeight:44,paddingHorizontal:8,paddingVertical:10,flexDirection:'row',gap:9,justifyContent:'flex-start'},
  label:{flex:1,minWidth:0,fontSize:13,lineHeight:20},hint:{fontSize:11,lineHeight:16,padding:4,paddingTop:7},message:{fontSize:12,lineHeight:18,padding:6,paddingTop:10}});
