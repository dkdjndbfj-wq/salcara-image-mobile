import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, Platform, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle} from 'react-native';
import {Icon} from '../components/Icon';
import {useDesk, useScheme} from '../theme';

/** Motion is local to navigation rows; it never delays or owns a session action. */
export function SidebarSessionRow({motion,selected,reduced,index=0,style,children,onPressIn,onPressOut,...props}:Omit<PressableProps,'style'|'children'> & {
  motion:boolean;selected:boolean;reduced:boolean;index?:number;style:(state:{pressed:boolean})=>StyleProp<ViewStyle>;children:React.ReactNode;
}) {
  const d=useDesk(),dark=useScheme()==='dark',[hovered,setHovered]=useState(false);
  const scale=useRef(new Animated.Value(1)).current;
  const entrance=useRef(new Animated.Value(motion&&!reduced?0:1)).current;
  const selection=useRef(new Animated.Value(selected?1:0)).current;
  const pressAnimation=useRef<Animated.CompositeAnimation|null>(null);
  const motionDisabled=Boolean(props.disabled||props.accessibilityState?.disabled);
  const order=useRef(index).current;
  useEffect(()=>{
    if(!motion||reduced){entrance.setValue(1);return;}
    const animation=Animated.timing(entrance,{toValue:1,duration:200,delay:Math.min(order,5)*22,easing:Easing.out(Easing.cubic),useNativeDriver:true,isInteraction:false});
    animation.start();return()=>animation.stop();
  },[motion,reduced,entrance,order]);
  useEffect(()=>{
    if(!motion||reduced){selection.setValue(selected?1:0);return;}
    const animation=Animated.timing(selection,{toValue:selected?1:0,duration:150,useNativeDriver:true,isInteraction:false});
    animation.start();return()=>animation.stop();
  },[motion,reduced,selected,selection]);
  useEffect(()=>()=>pressAnimation.current?.stop(),[]);
  useEffect(()=>{
    if(!motion||reduced||motionDisabled){pressAnimation.current?.stop();scale.setValue(1);}
  },[motion,reduced,motionDisabled,scale]);
  const press=(down:boolean)=>{
    pressAnimation.current?.stop();
    if(!motion||reduced||motionDisabled){scale.setValue(1);return;}
    const animation=Animated.spring(scale,{toValue:down?.985:1,stiffness:420,damping:34,mass:.7,overshootClamping:true,useNativeDriver:true,isInteraction:false});
    pressAnimation.current=animation;animation.start();
  };
  if(!motion)return <Pressable {...props} style={style} onPressIn={onPressIn} onPressOut={onPressOut}>{children}</Pressable>;
  return <Animated.View testID="sidebar-row-motion" style={{opacity:entrance,transform:[{translateY:entrance.interpolate({inputRange:[0,1],outputRange:[5,0]})},{scale}]}}>
    <Pressable {...props} onHoverIn={()=>setHovered(true)} onHoverOut={()=>setHovered(false)}
      onPressIn={event=>{press(true);onPressIn?.(event);}} onPressOut={event=>{press(false);onPressOut?.(event);}}
      style={state=>[style(state),hovered&&!selected&&{backgroundColor:d.press}]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill,styles.selection,{opacity:selection,backgroundColor:dark?'#282632':'#FFFFFF',borderColor:dark?'#3C374B':'#E8E5EF'}]}>
        <View style={[styles.marker,{backgroundColor:dark?'#B4A3DF':'#8C79B5'}]}/>
      </Animated.View>
      {children}
    </Pressable>
  </Animated.View>;
}

export function SidebarChevron({collapsed,reduced,color}:{collapsed:boolean;reduced:boolean;color:string}) {
  const progress=useRef(new Animated.Value(collapsed?0:1)).current;
  useEffect(()=>{
    if(reduced){progress.setValue(collapsed?0:1);return;}
    const animation=Animated.timing(progress,{toValue:collapsed?0:1,duration:180,easing:Easing.out(Easing.cubic),useNativeDriver:true,isInteraction:false});
    animation.start();return()=>animation.stop();
  },[collapsed,reduced,progress]);
  return <Animated.View testID="sidebar-project-chevron" style={{transform:[{rotate:progress.interpolate({inputRange:[0,1],outputRange:['-90deg','0deg']})}]}}><Icon name="chevronDown" size={13} color={color}/></Animated.View>;
}

export function SidebarTaskIndicator({active,reduced,label}:{active:boolean;reduced:boolean;label:string}) {
  const d=useDesk();
  const rotation=useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    rotation.setValue(0);
    if(!active||reduced)return;
    // RN Web cannot repeat a loop delegated to a nonexistent native driver.
    const animation=Animated.loop(Animated.timing(rotation,{toValue:1,duration:900,easing:Easing.linear,useNativeDriver:Platform.OS!=='web',isInteraction:false}));
    animation.start();return()=>animation.stop();
  },[active,reduced,rotation]);
  return <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={styles.status}>
    <Animated.View testID="sidebar-session-spinner" style={[styles.spinner,{borderColor:d.line,borderTopColor:d.muted,borderRightColor:d.muted,transform:[{rotate:rotation.interpolate({inputRange:[0,1],outputRange:['0deg','360deg']})}]}]}/>
  </View>;
}

const styles=StyleSheet.create({selection:{borderRadius:10,borderWidth:StyleSheet.hairlineWidth},marker:{position:'absolute',left:9,top:13,bottom:13,width:3,borderRadius:2},status:{width:16,height:16,alignItems:'center',justifyContent:'center'},spinner:{width:14,height:14,borderRadius:7,borderWidth:1.5}});
