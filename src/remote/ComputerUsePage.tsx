import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Image, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Icon} from '../components/Icon';
import {themed, useDesk} from '../theme';
import type {AttachmentRef} from './client';
import type {TimelineItem} from './store';
import {attachmentContentKey} from './attachment-ref';
import {computerActionLabel, parseComputerActivity} from './computer-activity';
import {ToolbarButton} from './WorkbenchToolbar';

type Tool = Extract<TimelineItem,{kind:'tool'}>;
export function ComputerUsePage({items,active,connected,sessionRunning,liveActivityIds,waitingApproval,onStop,stopPending,onImage,onAttachment}: {
  items:Tool[];active:boolean;connected:boolean;sessionRunning:boolean;
  liveActivityIds?:ReadonlySet<string>;waitingApproval?:boolean;
  onStop?:()=>void;stopPending?:boolean;onImage?:(uri:string)=>void;onAttachment?:(ref:AttachmentRef)=>void;
}) {
  const styles=useStyles(),dk=useDesk();
  const activities=useMemo(()=>items.filter(item=>parseComputerActivity(item.computer)).slice(-100),[items]);
  const [selected,setSelected]=useState<string|null>(null),[imageSelection,setImageSelection]=useState<{owner:string;index:number}|null>(null);
  const latest=activities.at(-1),selectedItem=activities.find(item=>item.id===selected),focused=selectedItem??latest;
  const pictureItem=selectedItem??[...activities].reverse().find(item=>item.attachments?.length);
  const imageIndex=imageSelection?.owner===pictureItem?.id?Math.min(imageSelection?.index??0,Math.max(0,(pictureItem?.attachments?.length??1)-1)):0;
  const picture=pictureItem?.attachments?.[imageIndex];
  const requested=useRef(new Set<string>());
  const isLive=(item:Tool)=>connected&&sessionRunning&&item.status==='running'&&liveActivityIds?.has(item.id)===true;
  const running=activities.some(isLive);
  const status=(item:Tool)=>item.status==='running'?(isLive(item)?waitingApproval?'等待确认':'正在执行':'状态待确认'):item.status==='done'?'已完成':item.status==='failed'?'失败':'已中断';
  useEffect(()=>{
    if(!active||!connected||!picture||picture.uri||!onAttachment)return;
    const key=attachmentContentKey(picture);if(requested.current.has(key))return;
    requested.current.add(key);if(requested.current.size>512)requested.current=new Set([key]);onAttachment(picture);
  },[active,connected,picture,onAttachment]);
  return <View testID="computer-use-page" style={styles.root}>
    <View style={styles.toolbar}><Icon name="laptop" size={18} color={dk.muted} accent={dk.muted}/><Text style={styles.heading}>电脑操作</Text><View style={styles.spacer}/><Text numberOfLines={1} accessibilityLiveRegion="polite" style={styles.status}>{!connected?'连接中断':running?stopPending?'正在停止…':waitingApproval?'等待确认':'AI 正在操作':activities.length?'操作记录':'等待操作'}</Text>
      {onStop&&running?<ToolbarButton icon="stop" label="停止AI当前回合" disabled={!active||stopPending} onPress={onStop} color={dk.bad}/>:null}
    </View>
    {!activities.length?<View style={styles.empty}><Icon name="laptop" size={38} color={dk.muted} accent={dk.muted}/><Text style={styles.emptyTitle}>查看 AI 的电脑操作</Text><Text style={styles.hint}>操作开始后，这里显示执行步骤和工具返回的画面。</Text></View>:<ScrollView style={styles.body} contentContainerStyle={styles.content}>
      <View style={styles.frameHeader}><Text style={styles.caption}>{selectedItem?'所选操作画面':'最新返回画面'}</Text>{selectedItem?<Pressable accessibilityRole="button" accessibilityLabel="跟随最新电脑操作" onPress={()=>{setSelected(null);setImageSelection(null);}}><Text style={styles.link}>跟随最新</Text></Pressable>:null}</View>
      {picture?.uri?<Pressable accessibilityRole="button" accessibilityLabel="放大电脑操作画面" disabled={!active||!onImage} onPress={()=>onImage?.(picture.uri!)}><Image accessibilityLabel="AI操作返回的截图" source={{uri:picture.uri}} resizeMode="contain" style={[styles.image,{aspectRatio:picture.width&&picture.height?picture.width/picture.height:16/10}]}/></Pressable>:<View style={styles.noFrame}><Icon name="image" size={30} color={dk.muted} accent={dk.muted}/><Text style={styles.hint}>{picture?'操作截图尚未加载':'此操作未返回画面'}</Text>{picture&&onAttachment?<Pressable accessibilityRole="button" accessibilityLabel="重新读取电脑操作画面" disabled={!active||!connected} onPress={()=>onAttachment(picture)}><Text style={styles.link}>重新读取</Text></Pressable>:null}</View>}
      <Text style={styles.hint}>{pictureItem?`${computerActionLabel(pictureItem.computer!)} · ${status(pictureItem)} · ${new Date(pictureItem.ts).toLocaleTimeString()}`:running?'等待工具返回截图':'没有可查看的操作截图'}{running?' · 画面随新截图更新':''}</Text>
      {(pictureItem?.attachments?.length??0)>1?<View style={styles.images}>{pictureItem!.attachments!.map((item,index)=><Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`电脑操作截图 ${index+1}`} accessibilityState={{selected:index===imageIndex}} onPress={()=>setImageSelection({owner:pictureItem!.id,index})} style={styles.imageChoice}><Text style={styles.caption}>{index+1}</Text></Pressable>)}</View>:null}
      <View style={styles.rule}/>
      {[...activities].reverse().map(item=><Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`查看电脑操作 ${item.id}`} accessibilityState={{selected:item.id===focused?.id}} onPress={()=>{setSelected(item.id);setImageSelection(null);}} style={[styles.row,item.id===focused?.id&&styles.selected]}>
        <Icon name={item.computer?.surface==='browser'?'globe':'laptop'} size={16} color={dk.muted} accent={dk.muted}/><View style={styles.rowText}><Text style={styles.label}>{computerActionLabel(item.computer!)}</Text><Text numberOfLines={1} style={styles.caption}>{item.computer!.provider}{item.parentId?' · 子任务':''}</Text></View><Text style={[styles.caption,item.status==='failed'&&styles.failed]}>{status(item)}</Text>
      </Pressable>)}
    </ScrollView>}
  </View>;
}
const useStyles=themed((c,d)=>StyleSheet.create({
  root:{flex:1,minHeight:0,backgroundColor:c.background},toolbar:{minHeight:58,paddingHorizontal:16,flexDirection:'row',alignItems:'center',gap:8,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:c.border},heading:{fontSize:16,color:d.text},spacer:{flex:1},status:{fontSize:12,color:d.muted,flexShrink:1},body:{flex:1},content:{padding:16,gap:12},frameHeader:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},caption:{fontSize:12,color:d.muted},link:{fontSize:13,color:d.accentText},image:{width:'100%',backgroundColor:c.surfaceStrong,borderRadius:8},noFrame:{minHeight:180,alignItems:'center',justifyContent:'center',gap:14,backgroundColor:c.surfaceStrong,borderRadius:8},hint:{fontSize:12,lineHeight:20,color:d.muted},rule:{height:StyleSheet.hairlineWidth,backgroundColor:c.border,marginVertical:6},row:{minHeight:54,flexDirection:'row',gap:12,alignItems:'center',paddingHorizontal:8,borderRadius:8},rowText:{flex:1,gap:4},label:{fontSize:15,color:d.text},selected:{backgroundColor:c.surfaceStrong},failed:{color:d.bad},empty:{flex:1,justifyContent:'center',alignItems:'center',padding:30,gap:18},emptyTitle:{fontSize:20,color:d.text},images:{flexDirection:'row',flexWrap:'wrap',gap:8},imageChoice:{paddingHorizontal:12,paddingVertical:8,borderWidth:StyleSheet.hairlineWidth,borderColor:c.border,borderRadius:6},
}));
