import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildRichRenderDocument, parseRichRenderReport, type RichRenderKind } from './rich-render-document';

export interface RichSurfaceProps { kind: RichRenderKind; source: string; color: string; background: string; inline?: boolean }
export function useRichRenderDocument({kind,source,color,background,inline}: RichSurfaceProps) {
  const token=useMemo(()=>`render_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,12)}`,[kind,source,color,background,inline]);
  const [document,setDocument]=useState<{token:string;html:string}|null>(null),[failure,setFailure]=useState<{token:string;message:string}|null>(null);
  const [size,setSize]=useState<{token:string;width:number;height:number}|null>(null);
  useEffect(()=>{
    let stopped=false;
    void buildRichRenderDocument({kind,source,color,background,inline,token}).then(html=>{if(!stopped)setDocument({token,html});}).catch(error=>{if(!stopped)setFailure({token,message:error instanceof Error?error.message:'无法渲染，已保留源码'});});
    return()=>{stopped=true;};
  },[kind,source,color,background,inline,token]);
  const report=useCallback((raw:unknown)=>{
    const value=parseRichRenderReport(raw,token);if(!value)return;
    if(value.type==='error')setFailure({token,message:value.message});
    else setSize(previous=>previous?.token===token&&previous.width===value.width&&previous.height===value.height?previous:{token,width:value.width,height:value.height});
  },[token]);
  return {token,html:document?.token===token?document.html:undefined,error:failure?.token===token?failure.message:undefined,width:size?.token===token?size.width:Math.min(500,Math.max(60,source.length*9)),height:size?.token===token?size.height:inline?30:kind==='math'?80:240,report};
}
