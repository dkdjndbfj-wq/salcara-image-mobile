import React,{useEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {ActivityIndicator,AppState,Pressable,StyleSheet,Text,useWindowDimensions,View} from 'react-native';
import Slider from './MainEffortSlider';
import {Icon,type IconName} from '../components/Icon';
import {IconButton} from '../components/ui';
import {themed,colors,useDesk} from '../theme';
import {effortLabel} from './effort';
import {EffortScrubChip,type ScrubEvent,type ScrubLevel} from './EffortScrub';
import {hapticEffort} from './haptics';
import {ComposerPopover,ComposerPermissionIcon} from './ComposerPopover';

/** Main conversation chrome only. Capability checks remain with its caller. */
export function MainComposerSurface({children}:{children:ReactNode}) {
  const s=useStyles();return <View testID="main-composer" style={s.surface}>{children}</View>;
}
export function MainComposerToolbar({features,actions}:{features:ReactNode;actions:ReactNode}) {
  const s=useStyles(),{width}=useWindowDimensions(),compact=width<360;
  return <View testID="composer-toolbar" style={[s.toolbar,compact&&{gap:0}]}><View testID="main-composer-leading" style={[s.leading,compact&&{gap:0}]}>{features}</View><View testID="main-composer-trailing" style={[s.trailing,compact&&{gap:2}]}>{actions}</View></View>;
}
/** Keep the context indicator beside its model when the toolbar wraps. */
export function MainComposerModelGroup({children}:{children:ReactNode}) {
  const s=useStyles();return <View testID="composer-context-model" style={s.modelGroup}>{children}</View>;
}
export function MainComposerPermission({label,onPress,disabled=false,danger=false,accessibilityLabel,anchorRef}:{label:string;onPress:()=>void;disabled?:boolean;danger?:boolean;accessibilityLabel?:string;anchorRef?:RefObject<View|null>}) {
  const s=useStyles(),{width}=useWindowDimensions(),color=danger?'#F45B0B':colors.textMuted;
  return <Pressable ref={anchorRef} collapsable={false} accessibilityRole="button" accessibilityLabel={accessibilityLabel??label} accessibilityState={{disabled}} disabled={disabled} onPress={onPress} style={[s.permission,disabled&&s.disabled]}>
    <ComposerPermissionIcon kind={label==='请求批准'?'hand':label==='帮我批准'?'review':'shield'} color={color}/>
    {width>=360?<Text numberOfLines={1} style={[s.permissionText,{color}]}>{label==='完全访问权限'?'完全访问':label}</Text>:null}
  </Pressable>;
}
export function MainComposerModelButton({label,onPress,disabled=false,accessibilityLabel,anchorRef}:{label:string;onPress:()=>void;disabled?:boolean;accessibilityLabel?:string;anchorRef?:RefObject<View|null>}) {
  const s=useStyles(),{width}=useWindowDimensions();return <Pressable ref={anchorRef} collapsable={false} accessibilityRole="button" accessibilityLabel={accessibilityLabel??`模型：${label}`} accessibilityHint="选择模型" disabled={disabled} accessibilityState={{disabled}} onPress={onPress} style={[s.model,{maxWidth:width<360?76:112},disabled&&s.disabled]}>
    <Text numberOfLines={1} style={s.modelLabel}>{label}</Text><Icon name="chevronDown" size={11} color={colors.textMuted}/>
  </Pressable>;
}
export function MainComposerAction({icon,label,onPress,disabled=false,busy=false}:{icon:IconName;label:string;onPress:()=>void;disabled?:boolean;busy?:boolean}) {
  const s=useStyles(),d=useDesk();return <View style={[s.action,disabled&&s.disabled]}><View pointerEvents="none" style={s.actionBackground}/><IconButton icon={icon} label={label} onPress={onPress} disabled={disabled} size={44} iconSize={17} color={busy?'transparent':d.onInk}/>{busy?<View pointerEvents="none" style={[StyleSheet.absoluteFill,{alignItems:'center',justifyContent:'center'}]}><ActivityIndicator size="small" color={d.onInk}/></View>:null}</View>;
}

export type MainEffortControlProps={levels:readonly ScrubLevel[];value:ScrubLevel;scopeKey:string;disabled?:boolean;onSelect:(value:ScrubLevel)=>void;onScrub?:(event:ScrubEvent)=>void;open?:boolean;onClose?:()=>void;accessibilityLabel?:string};
/** Taps expose explicit controls; the existing native hold-and-scrub remains available. */
export function MainEffortControl({levels,value,scopeKey,disabled=false,onSelect,onScrub,open:requestedOpen,onClose,accessibilityLabel}:MainEffortControlProps) {
  const s=useStyles();
  const anchor=useRef<View>(null),[open,setOpen]=useState(false),[preview,setPreview]=useState(0),previewRef=useRef(0);
  const signature=JSON.stringify([scopeKey,levels,value,disabled]),owner=useRef({signature,epoch:0});
  if(owner.current.signature!==signature)owner.current={signature,epoch:owner.current.epoch+1};
  const epoch=owner.current.epoch,opened=useRef(''),alive=useRef(true),generation=useRef(0),[popupGeneration,setPopupGeneration]=useState(0);
  const requestPending=useRef(false),latestClose=useRef(onClose);latestClose.current=onClose;
  const usable=()=>alive.current&&owner.current.epoch===epoch&&!disabled&&AppState.currentState!=='background'&&AppState.currentState!=='inactive';
  useEffect(()=>{alive.current=true;const sub=AppState.addEventListener('change',state=>{if(state!=='active'){requestPending.current=false;opened.current='';++generation.current;setOpen(false);latestClose.current?.();}});return()=>{alive.current=false;opened.current='';++generation.current;sub.remove();};},[]);
  useEffect(()=>{if(open&&opened.current!==signature){requestPending.current=false;opened.current='';++generation.current;setOpen(false);latestClose.current?.();}},[signature,open]);
  const close=()=>{requestPending.current=false;opened.current='';++generation.current;setOpen(false);latestClose.current?.();};
  const popupCurrent=()=>usable()&&opened.current===signature&&generation.current===popupGeneration;
  const dismiss=()=>{if(popupCurrent()){const chosen=levels[previewRef.current];close();if(chosen!==undefined&&chosen!==value){hapticEffort(chosen);onSelect(chosen);}}};
  const show=()=>{
    if(!usable()||!levels.length)return;
    requestPending.current=false;
    const next=++generation.current;setPopupGeneration(next);opened.current=signature;previewRef.current=Math.max(0,levels.indexOf(value));setPreview(previewRef.current);setOpen(true);
  };
  useEffect(()=>{requestPending.current=requestedOpen===true;if(requestedOpen)show();else if(requestedOpen===false&&opened.current)close();},[requestedOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{if(requestPending.current&&requestedOpen)show();},[JSON.stringify(levels),disabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const previewAt=(index:number)=>{
    if(!popupCurrent()||!Number.isInteger(index)||index<0||index>=levels.length)return;
    previewRef.current=index;setPreview(index);
  };
  const handleScrub=(event:ScrubEvent)=>{
    if(!usable())return;
    if(onScrub){onScrub(event);return;}
    if(event.phase==='end'&&levels[event.index]!==undefined&&levels[event.index]!==value)onSelect(levels[event.index]);
  };
  const level=levels[preview]??value;
  const progress=preview/Math.max(1,levels.length-1)*100;
  return <View ref={anchor} collapsable={false}>
    <EffortScrubChip levels={levels} value={value} disabled={disabled} scopeKey={scopeKey} onScrub={handleScrub} appearance="composer" onOpen={show} accessibilityLabel={accessibilityLabel}/>
    <ComposerPopover visible={open&&opened.current===signature} anchorRef={anchor} onClose={dismiss} width={256} accessibilityLabel="推理强度选择" testID="main-effort-popover">
        <View style={s.popover}>
          <View style={s.effortHeader}><Text style={s.effortHeading}>推理强度</Text><Text testID="main-effort-preview" style={s.effortTitle}>{level?effortLabel(level):'默认'}</Text></View>
          <View style={s.sliderWrap}>
            <View pointerEvents="none" style={s.effortTrack}><View style={[s.effortFill,{width:`${progress}%`}]} />{levels.map((item,index)=><View key={item||'default'} style={[s.effortTick,{left:`${index/Math.max(1,levels.length-1)*100}%`},index<=preview&&s.effortTickActive]}/>)}</View>
            <Slider testID="main-effort-slider" accessibilityLabel="推理强度滑杆" accessibilityRole="adjustable" accessibilityValue={{min:0,max:Math.max(0,levels.length-1),now:preview,text:effortLabel(level)}}
              minimumValue={0} maximumValue={Math.max(1,levels.length-1)} step={1} value={preview} disabled={disabled||levels.length<2} minimumTrackTintColor="transparent" maximumTrackTintColor="transparent" thumbTintColor="transparent" style={s.slider}
              onValueChange={previewAt} onSlidingComplete={previewAt}/>
            <View pointerEvents="none" style={[s.thumb,{left:`${progress}%`}]} />
          </View>
          <View pointerEvents="none" style={s.effortScale}><Text style={s.effortScaleLabel}>{levels[0]?effortLabel(levels[0]):'默认'}</Text><Text style={s.effortScaleLabel}>{levels.length>1?effortLabel(levels[levels.length-1]):''}</Text></View>
        </View>
    </ComposerPopover>
  </View>;
}

const useStyles=themed((c,d,scheme)=>StyleSheet.create({
  surface:{position:'relative',minWidth:0,minHeight:108,borderRadius:20,borderWidth:StyleSheet.hairlineWidth,borderColor:c.border,backgroundColor:c.card,paddingHorizontal:10,paddingTop:10,paddingBottom:8,shadowColor:'#000',shadowOpacity:.03,shadowRadius:10,shadowOffset:{width:0,height:2}},
  toolbar:{minHeight:44,flexDirection:'row',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:4,paddingTop:4},
  leading:{minWidth:0,flexDirection:'row',alignItems:'center',gap:3,flexShrink:1},trailing:{marginLeft:'auto',minWidth:0,maxWidth:'100%',flexDirection:'row',flexWrap:'wrap',alignItems:'center',justifyContent:'flex-end',gap:4,flexShrink:0},
  modelGroup:{minWidth:0,flexDirection:'row',alignItems:'center',flexShrink:1},
  permission:{minHeight:44,minWidth:44,maxWidth:138,flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:2,flexShrink:1},permissionText:{fontSize:12,lineHeight:18,flexShrink:1},model:{minWidth:44,height:44,flexDirection:'row',gap:4,alignItems:'center',justifyContent:'center',paddingHorizontal:4,flexShrink:1},modelLabel:{fontSize:12,lineHeight:18,color:c.textSecondary,flexShrink:1},action:{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center'},actionBackground:{position:'absolute',width:36,height:36,borderRadius:18,backgroundColor:scheme==='light'?'#191B1D':d.ink},disabled:{opacity:.4},
  popover:{paddingHorizontal:12,paddingTop:4,paddingBottom:8},
  effortHeader:{height:28,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8},effortHeading:{fontSize:12,lineHeight:16,color:c.textMuted,fontWeight:'500'},
  effortTitle:{fontSize:14,lineHeight:20,fontWeight:'600',color:c.text},
  sliderWrap:{height:34,marginHorizontal:10,marginTop:2,justifyContent:'center'},effortTrack:{height:5,borderRadius:3,backgroundColor:c.tint},effortFill:{position:'absolute',left:0,top:0,bottom:0,borderRadius:3,backgroundColor:c.textSecondary},effortTick:{position:'absolute',width:3,height:3,borderRadius:2,top:1,marginLeft:-1.5,backgroundColor:c.faint},effortTickActive:{backgroundColor:c.card},
  slider:{position:'absolute',left:-10,right:-10,height:36},thumb:{position:'absolute',width:20,height:20,borderRadius:10,marginLeft:-10,borderWidth:1,borderColor:c.border,backgroundColor:c.card,shadowColor:'#000',shadowOpacity:.12,shadowRadius:3,shadowOffset:{width:0,height:1}},
  effortScale:{flexDirection:'row',justifyContent:'space-between',paddingHorizontal:10},effortScaleLabel:{fontSize:10,lineHeight:14,color:c.subtle},
}));
