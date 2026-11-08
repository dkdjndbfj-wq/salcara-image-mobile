import React, { useEffect, useRef } from 'react';
import { useRichRenderDocument, type RichSurfaceProps } from './useRichRenderDocument';

export function RichRenderedSurface(props: RichSurfaceProps) {
  const {html,error,width,height,report}=useRichRenderDocument(props),frame=useRef<HTMLIFrameElement>(null);
  useEffect(()=>{const listener=(event:MessageEvent)=>{if(event.source===frame.current?.contentWindow)report(event.data);};window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);},[report]);
  if(error)return <span role="alert" style={{color:props.color,fontSize:12,whiteSpace:'pre-wrap'}}>{error}{'\n'}{props.source}</span>;
  // Mount with the complete document. Updating a just-created empty srcdoc
  // during the same browser navigation can leave an opaque frame blank.
  if(!html)return <span style={{color:props.color,fontSize:12}}>{props.inline?props.source:'正在渲染…'}</span>;
  return <iframe ref={frame} title={props.kind==='math'?`公式：${props.source}`:'Mermaid 图表'} data-testid="rich-rendered-content" srcDoc={html}
    sandbox="allow-scripts" referrerPolicy="no-referrer" style={{display:props.inline?'inline-block':'block',verticalAlign:'middle',width:props.inline?width:'100%',maxWidth:'100%',height,border:0,background:props.background}}/>;
}
