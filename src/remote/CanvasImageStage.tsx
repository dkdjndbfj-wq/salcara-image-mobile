import React,{forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useRef,useState} from 'react';
import {Image,Platform,Pressable,Text,View,type GestureResponderEvent} from 'react-native';
import {useDesk} from '../theme';
import {canvasImageKey,normalizedRegion,type CanvasImage,type ImageNote,type ImageRegion} from './conversation-images';
import {retainCachedAttachment} from './attachment-cache-policy';
import {useManagedImage} from './useManagedImage';
import {canvasDetailRegion} from './canvas-image-detail';
import type {ImagePixelRegion} from './image-dimensions';

export interface CanvasImageView { zoom:number|null;x:number;y:number }
export type CanvasZoomAction='in'|'out'|'fit'|'original';
export interface CanvasImageStageHandle {imageKey:string;zoom:(action:CanvasZoomAction)=>void}
export const fittedCanvasImageView:CanvasImageView={zoom:null,x:0,y:0};
export function canvasImageGeometry(image:{width:number;height:number},stage:{width:number;height:number},view:CanvasImageView) {
  const fit=Math.min(stage.width/image.width,stage.height/image.height);
  const zoom=view.zoom===null?fit:Math.max(Math.min(.25,fit),Math.min(8,view.zoom));
  const width=image.width*zoom,height=image.height*zoom;
  const boundX=Math.max(0,(width-stage.width)/2),boundY=Math.max(0,(height-stage.height)/2);
  const x=boundX?Math.max(-boundX,Math.min(boundX,view.x)):0,y=boundY?Math.max(-boundY,Math.min(boundY,view.y)):0;
  return {fit,zoom,width,height,x,y,left:(stage.width-width)/2+x,top:(stage.height-height)/2+y};
}

/** A single coordinate space drives panning, region selection and saved pins. */
export const CanvasImageStage=forwardRef<CanvasImageStageHandle,{
  image:CanvasImage;height:number;view:CanvasImageView;onView:(value:CanvasImageView)=>void;marking:boolean;region?:ImageRegion;onRegion:(region?:ImageRegion)=>void;
  notes:Array<{note:ImageNote;number:number}>;activeNoteId?:string;onLocate:(note:ImageNote)=>void;onRetry:()=>void;
  disabled?:boolean;onZoomChange?:(zoom:number|undefined)=>void;
}>(function CanvasImageStage({image,height,view,onView,marking,region,onRegion,notes,activeNoteId,onLocate,onRetry,disabled=false,onZoomChange},ref) {
  const d=useDesk(),[size,setSize]=useState({width:1,height}),[intrinsic,setIntrinsic]=useState({width:image.width||640,height:image.height||480,known:Boolean(image.width&&image.height)}),[failure,setFailure]=useState(false);
  const imageKey=canvasImageKey(image),alive=useRef(true);
  const preview=useManagedImage(image.uri,'preview');
  useEffect(()=>retainCachedAttachment(image.uri),[image.uri]);
  useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{setFailure(false);if(!preview.uri)return;if(preview.resource){const {originalWidth:width,originalHeight:height}=preview.resource;setIntrinsic(current=>current.known&&current.width===width&&current.height===height?current:{width,height,known:true});return;}let live=true;Image.getSize(preview.uri,(width,height)=>{if(live&&width>0&&height>0)setIntrinsic(current=>current.known&&current.width===width&&current.height===height?current:{width,height,known:true});},()=>{if(live)setFailure(true);});return()=>{live=false;};},[preview.uri,preview.resource]);
  const geometry=canvasImageGeometry(intrinsic,size,view),gesture=useRef<{x:number;y:number;view:CanvasImageView;distance?:number;point?:{x:number;y:number}}|undefined>(undefined);
  const [detailRequest,setDetailRequest]=useState<{owner:string;region:ImagePixelRegion}>(),[detailRetry,setDetailRetry]=useState(0),[detailFailure,setDetailFailure]=useState('');
  const detailOwner=JSON.stringify([imageKey,image.uri]);
  const wanted=preview.resource&&!failure&&geometry.width>preview.resource.width*1.1
    ?canvasDetailRegion(intrinsic,size,geometry):undefined;
  const wantedKey=wanted?JSON.stringify([detailOwner,wanted]):'';
  useEffect(()=>{
    if(!wanted){setDetailRequest(undefined);return;}
    const timer=setTimeout(()=>setDetailRequest({owner:detailOwner,region:wanted}),180);
    return()=>clearTimeout(timer);
  },[wantedKey]);
  const detailRegion=wanted&&detailRequest?.owner===detailOwner?detailRequest.region:undefined;
  const detailKey=JSON.stringify([detailOwner,detailRegion,detailRetry]);
  const detail=useManagedImage(image.uri,'detail',Boolean(detailRegion),detailRegion,detailRetry);
  const detailImage=detail.resource?.region&&detail.uri&&detailFailure!==detailKey?detail.resource:undefined;
  const latest=useRef({imageKey,intrinsic,size,geometry,onView,disabled});latest.current={imageKey,intrinsic,size,geometry,onView,disabled};
  // Header commands always use this mounted stage's measured coordinate space.
  useImperativeHandle(ref,()=>({imageKey,zoom:action=>{
    const current=latest.current;if(!alive.current||current.disabled||current.imageKey!==imageKey)return;
    if(action==='fit'){current.onView(fittedCanvasImageView);return;}
    if(action==='original'){current.onView({zoom:1,x:0,y:0});return;}
    if(!current.intrinsic.known||current.size.width<=1)return;
    const next={zoom:current.geometry.zoom*(action==='in'?1.25:1/1.25),x:current.geometry.x,y:current.geometry.y};
    const bounded=canvasImageGeometry(current.intrinsic,current.size,next);current.onView({...next,x:bounded.x,y:bounded.y});
  }}),[imageKey]);
  const reportedZoom=view.zoom!==null||intrinsic.known&&size.width>1?geometry.zoom:undefined;
  useLayoutEffect(()=>{onZoomChange?.(reportedZoom);},[reportedZoom,onZoomChange]);
  const point=(event:GestureResponderEvent)=>({x:(event.nativeEvent.locationX-geometry.left)/geometry.width,y:(event.nativeEvent.locationY-geometry.top)/geometry.height});
  const distance=(event:GestureResponderEvent)=>{const touches=event.nativeEvent.touches;return touches?.length>=2?Math.hypot(touches[0].pageX-touches[1].pageX,touches[0].pageY-touches[1].pageY):undefined;};
  const setView=(next:CanvasImageView)=>{if(!alive.current||latest.current.disabled)return;const bounded=canvasImageGeometry(intrinsic,size,next);onView({...next,x:bounded.x,y:bounded.y});};
  const move=(event:GestureResponderEvent)=>{
    const started=gesture.current;if(!started||!alive.current||latest.current.disabled)return;
    if(marking){if(started.point)onRegion(normalizedRegion(started.point,point(event)));return;}
    const span=distance(event);
    if(span){if(!started.distance){gesture.current={...started,distance:span,view:{zoom:geometry.zoom,x:geometry.x,y:geometry.y}};return;}setView({...started.view,zoom:(started.view.zoom??geometry.fit)*span/started.distance});}
    else if(!started.distance)setView({...started.view,x:started.view.x+event.nativeEvent.pageX-started.x,y:started.view.y+event.nativeEvent.pageY-started.y});
  };
  const button=(label:string,text:string,action:()=>void)=><Pressable accessibilityRole="button" accessibilityLabel={label} onPress={action} style={{minWidth:44,minHeight:44,paddingHorizontal:10,alignItems:'center',justifyContent:'center'}}><Text style={{color:d.text,fontSize:13}}>{text}</Text></Pressable>;
  const selected=region??notes.find(entry=>entry.note.id===activeNoteId)?.note.region;
  return <View testID="canvas-image-viewport" onLayout={event=>{const layout=event.nativeEvent.layout;if(layout.width>0&&layout.height>0)setSize(layout);}}
      style={{height,overflow:'hidden',position:'relative',backgroundColor:d.surface2,borderWidth:1,borderColor:d.line,borderRadius:12,...(Platform.OS==='web'?{touchAction:'none',userSelect:'none'} as object:{})}}>
      {preview.uri&&!failure?<>
        <Image testID="canvas-focused-image" source={{uri:preview.uri}} style={{position:'absolute',width:geometry.width,height:geometry.height,left:geometry.left,top:geometry.top}} resizeMode="contain" onError={()=>setFailure(true)}/>
        {detailImage?.region?<View pointerEvents="none" style={{position:'absolute',left:geometry.left+detailImage.region.originX*geometry.zoom,top:geometry.top+detailImage.region.originY*geometry.zoom,width:detailImage.region.width*geometry.zoom,height:detailImage.region.height*geometry.zoom}}>
          <Image testID="canvas-detail-image" source={{uri:detailImage.uri}} resizeMode="stretch" style={{width:'100%',height:'100%'}} onError={()=>setDetailFailure(detailKey)}/></View>:null}
        <View testID="image-region-surface" style={{position:'absolute',left:0,right:0,top:0,bottom:0}}
          onStartShouldSetResponder={()=>!disabled} onMoveShouldSetResponder={()=>!disabled}
          onResponderGrant={event=>{if(!alive.current||latest.current.disabled)return;gesture.current={x:event.nativeEvent.pageX,y:event.nativeEvent.pageY,view:{zoom:view.zoom,x:geometry.x,y:geometry.y},distance:distance(event),point:marking?point(event):undefined};if(marking)onRegion(undefined);}}
          onResponderMove={move} onResponderRelease={event=>{move(event);gesture.current=undefined;}} onResponderTerminate={()=>{gesture.current=undefined;}}/>
        {selected?<View pointerEvents="none" testID="image-region-selection" style={{position:'absolute',left:geometry.left+selected.x*geometry.width,top:geometry.top+selected.y*geometry.height,width:selected.width*geometry.width,height:selected.height*geometry.height,borderWidth:2,borderColor:d.text,backgroundColor:'rgba(127,127,127,.12)'}}/>:null}
        {!marking?notes.filter(entry=>entry.note.region).map(({note,number})=><Pressable key={note.id} accessibilityRole="button" accessibilityLabel={`定位图片批注 ${number}`} disabled={disabled} hitSlop={8} onPress={()=>{if(alive.current&&!latest.current.disabled)onLocate(note);}}
          style={{position:'absolute',left:geometry.left+note.region!.x*geometry.width-14,top:geometry.top+note.region!.y*geometry.height-14,width:28,height:28,borderRadius:14,borderWidth:1,borderColor:d.line,backgroundColor:note.id===activeNoteId?d.text:d.surface,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:12,fontWeight:'600',color:note.id===activeNoteId?d.surface:d.text}}>{number}</Text></Pressable>):null}
        {detailRegion&&(detail.error||detailFailure===detailKey)?<Pressable accessibilityRole="button" accessibilityLabel="重试高清查看" disabled={disabled} onPress={()=>{setDetailFailure('');setDetailRetry(value=>value+1);}} style={{position:'absolute',left:8,right:8,bottom:8,minHeight:36,paddingHorizontal:10,justifyContent:'center',backgroundColor:d.surface,borderRadius:6}}><Text style={{color:d.muted,fontSize:11}}>高清未能读取，已保留预览 · 重试</Text></Pressable>
          :detailRegion&&detail.loading?<View pointerEvents="none" style={{position:'absolute',right:8,bottom:8,padding:7,backgroundColor:d.surface,borderRadius:6}}><Text style={{color:d.muted,fontSize:11}}>正在读取清晰细节…</Text></View>:null}
      </>:<View style={{flex:1,padding:24,gap:12,alignItems:'center',justifyContent:'center'}}><Text style={{color:d.muted,fontSize:13}}>{preview.error??(failure?'图片未能加载':preview.foreground?'正在读取图片…':'图片预览已暂停')}</Text>{button('重新读取图片','重新读取图片',()=>{setFailure(false);onRetry();})}</View>}
  </View>;
});
