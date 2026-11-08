import React, { useRef } from 'react';
import type { PreviewCanvasProps } from './RemotePreviewCanvas';

export function RemotePreviewCanvas({frame, width, disabled, onInput, onCopySelection, elementPicking}: PreviewCanvasProps) {
  const down = useRef(false), lastMove = useRef(0);
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(frame.width - 1, Math.max(0, Math.floor((event.clientX - bounds.left) * frame.width / bounds.width))), y: Math.min(frame.height - 1, Math.max(0, Math.floor((event.clientY - bounds.top) * frame.width / bounds.width))) };
  };
  const box = frame.element?.documentId === frame.documentId ? frame.element?.rect : undefined, scale = width / frame.width;
  return <div role="application" aria-label={elementPicking ? '选择网页元素' : '电脑网页内容'} tabIndex={disabled ? -1 : 0} style={{width,position:'relative',overflow:'hidden',outline:'none',lineHeight:0,touchAction:'none',userSelect:'none',cursor:elementPicking?'crosshair':'default'}}
    onPointerDown={event => { if (disabled || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); if(elementPicking){down.current=false;if(frame.domSupported&&frame.documentId)onInput({action:'element-pick',documentId:frame.documentId,...point(event)});return;} event.currentTarget.setPointerCapture(event.pointerId); down.current=true; onInput({action:'mouse',phase:'down',...point(event)}); }}
    onPointerMove={event => { if (disabled || !down.current || Date.now()-lastMove.current<90) return; lastMove.current=Date.now(); onInput({action:'mouse',phase:'move',...point(event)}); }}
    onPointerUp={event => { if (!down.current) return; down.current=false; if (!disabled) onInput({action:'mouse',phase:'up',...point(event)}); }}
    onPointerCancel={event => { if (!down.current) return; down.current=false; if (!disabled) onInput({action:'mouse',phase:'up',...point(event)}); }}
    onWheel={event => { if (!disabled) onInput({action:'scroll',deltaY:Math.max(-2000,Math.min(2000,Math.round(event.deltaY)))}); }}
    onPaste={event => { if (!disabled && !elementPicking) { event.preventDefault(); const text=event.clipboardData.getData('text'); if(text) onInput({action:'text',text:text.slice(0,4096)}); } }}
    onCompositionEnd={event=>{if(!disabled&&!elementPicking&&event.data)onInput({action:'text',text:event.data.slice(0,4096)});}}
    onKeyDown={event => {
      if(disabled || elementPicking || event.nativeEvent.isComposing) return;
      const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if(command && key==='c') {event.preventDefault();onCopySelection?.();return;}
      if(command && key==='v') return;
      if(command && ['a','x','z','y'].includes(key)) {event.preventDefault();const input={action:'key' as const,key,modifiers:2|(event.shiftKey?8:0)};if(key==='x')void Promise.resolve(onCopySelection?.()).then(()=>onInput(input));else onInput(input);return;}
      if(event.ctrlKey||event.metaKey||event.altKey)return;
      if(event.key.length === 1) {event.preventDefault(); onInput({action:'text',text:event.key});}
      else if(['Enter','Tab','Escape','Backspace','Delete','Home','End','PageUp','PageDown','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();onInput({action:'key',key:event.key,modifiers:event.shiftKey?8:0});}
    }}><img alt="电脑网页实时预览" draggable={false} src={`data:image/jpeg;base64,${frame.imageBase64}`} style={{width:'100%',display:'block'}} />
    {box ? <div data-testid="preview-element-outline" style={{pointerEvents:'none',position:'absolute',boxSizing:'border-box',left:box.x*scale,top:box.y*scale,width:box.width*scale,height:box.height*scale,border:'2px solid #2F6BFF',background:'rgba(47,107,255,0.08)'}}/> : null}</div>;
}

