import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, Text, View, useWindowDimensions, type ImageProps } from 'react-native';
import {Icon} from '../components/Icon';
import {useDesk} from '../theme';
import { useManagedImage } from './useManagedImage';

const measurements = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function observe(measure: () => void) {
  measurements.add(measure);
  if (!timer) timer = setInterval(() => { for (const read of measurements) read(); }, 500);
  return () => { measurements.delete(measure); if (!measurements.size && timer) { clearInterval(timer); timer = undefined; } };
}
/** Shared visibility checks also cover the canvas's scrollable image grid.
 * Native list virtualization remains the first boundary in conversations. */
export function ManagedImage({ uri, style, onRetry, ...props }: Omit<ImageProps, 'source'> & { uri: string;onRetry?:()=>void|Promise<unknown> }) {
  const d=useDesk(),[retry,setRetry]=useState(0),[failed,setFailed]=useState<string>(),[retrying,setRetrying]=useState(false);
  const owner=useRef({uri,epoch:0});if(owner.current.uri!==uri)owner.current={uri,epoch:owner.current.epoch+1};const source=owner.current;
  const alive=useRef(true),flight=useRef<object|undefined>(undefined);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{setFailed(undefined);setRetrying(false);flight.current=undefined;},[source]);
  const view = useRef<View>(null), window = useWindowDimensions();
  const [visible, setVisible] = useState(true);
  const image = useManagedImage(uri, 'thumbnail', visible,undefined,retry);
  const attempt=useRef({source,retry});attempt.current={source,retry};
  const failure=image.error||failed;
  const retryImage=async()=>{
    if(flight.current||!image.active||owner.current!==source)return;
    const token={};flight.current=token;setRetrying(true);
    try{await onRetry?.();if(alive.current&&owner.current===source){setFailed(undefined);setRetry(value=>value+1);}}
    catch{if(alive.current&&owner.current===source)setFailed('原图片尚未恢复');}
    finally{if(flight.current===token){flight.current=undefined;if(alive.current&&owner.current===source)setRetrying(false);}}
  };
  useEffect(() => {
    if (!image.foreground) return;
    let live = true;
    const measure = () => view.current?.measureInWindow((x, y, width, height) => {
      if (live && width > 0 && height > 0) setVisible(y + height > -window.height / 2 && y < window.height * 1.5 && x + width > 0 && x < window.width);
    });
    measure(); const remove = observe(measure);
    return () => { live = false; remove(); };
  }, [window.height, window.width, image.foreground]);
  return <View ref={view} style={style} collapsable={false}>
    {failure?<Pressable accessibilityRole="button" accessibilityLabel="重新加载图片预览" accessibilityHint={failure} disabled={retrying||!image.active} onPress={event=>{event.stopPropagation();void retryImage();}} style={{width:'100%',height:'100%',alignItems:'center',justifyContent:'center',gap:3}}>
      {retrying?<ActivityIndicator size="small" color={d.muted}/>:<Icon name="regenerate" size={15} color={d.muted}/>}
      <Text numberOfLines={1} style={{fontSize:10,color:d.muted}}>{retrying?'重试中':'重试'}</Text>
    </Pressable>:image.uri?<Image {...props} key={`${uri}:${retry}`} onError={event=>{if(alive.current&&attempt.current.source===source&&attempt.current.retry===retry){setFailed('图片显示失败');props.onError?.(event);}}} source={{uri:image.uri}} style={{width:'100%',height:'100%'}}/>:image.loading?<View style={{width:'100%',height:'100%',alignItems:'center',justifyContent:'center'}}><ActivityIndicator size="small" color={d.muted}/></View>:null}
  </View>;
}
