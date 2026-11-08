import { artifactScriptJSON, escapeArtifactHTML } from '../remote/artifact-content';
import { boundedArtifactState } from '../remote/artifact-state';
import {parseElementSelection,type ArtifactElementSelection} from '../remote/artifact-annotations';
import {artifactAnnotationBootstrap} from './artifact-annotation-script';
import captureRuntime from './artifact-renderer-assets/html2canvas.json';
import { parsePreviewLog, type PreviewLogEntry } from '../remote/preview-logs';
import { previewLogScript } from './preview-log-script';

export interface ArtifactSelection extends ArtifactElementSelection {}
export function parseArtifactSelection(value: unknown): ArtifactSelection | undefined {
  return parseElementSelection(value);
}
export function parseInteractiveMessage(value: unknown, token: string): { type: 'height'; height: number } | { type: 'state'; state: Record<string, unknown> } | { type: 'error'; message: string } | { type: 'log'; entry: PreviewLogEntry } | { type:'annotation-focus';id:string } | { type: 'annotation'; selection: ArtifactSelection } | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (data.channel !== 'salcara-artifact' || data.token !== token) return;
  if (data.type === 'height' && typeof data.height === 'number' && Number.isFinite(data.height)) return { type: 'height', height: Math.max(180, Math.min(1200, data.height)) };
  if (data.type === 'state') { const state = boundedArtifactState(data.state); if (state) return { type: 'state', state }; }
  if (data.type === 'error' && typeof data.message === 'string') return { type: 'error', message: data.message.slice(0, 1000) };
  if (data.type === 'log') { const entry = parsePreviewLog(data.entry); if (entry) return { type: 'log', entry }; }
  if (data.type === 'annotation') { const selection = parseArtifactSelection(data.selection); if (selection) return { type: 'annotation', selection }; }
  if(data.type==='annotation-focus'&&typeof data.id==='string'&&data.id.length<150)return {type:'annotation-focus',id:data.id};
}

/** A trusted, opaque outer frame owns the bridge. Its frame-src policy also
 * applies to the nested srcdoc frame and prevents self-navigation from being a
 * network escape. The user document never receives the bridge token. */
export function buildInteractiveArtifactDocument(source: string, token: string, initialState: Record<string, unknown>, annotate: boolean, title: string,richAnnotations=false): string {
  // Capture renders in this opaque document; it never needs a same-origin iframe.
  const policy = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  const bootstrap = `(()=>{'use strict';
const send=message=>parent.postMessage({channel:'artifact-inner',...message},'*');
${previewLogScript("entry=>send({type:'log',entry})")}
// WebRTC is not covered by connect-src in every engine. Close that channel
// before any artifact code runs; other network transports are blocked by CSP.
for(const key of ['RTCPeerConnection','webkitRTCPeerConnection','mozRTCPeerConnection','WebTransport']){try{Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false});}catch{}}
let saved=${artifactScriptJSON(initialState)},custom=saved.custom&&typeof saved.custom==='object'?saved.custom:{},context={},timer;
const controls=()=>[...document.querySelectorAll('input:not([type=password]):not([type=file]),select,textarea')].slice(0,200);
const keyFor=(element,index)=>element.id?'id:'+element.id:element.name?'name:'+element.name+':'+index:'index:'+index;
const capture=()=>{const forms={};controls().forEach((element,index)=>{forms[keyFor(element,index)]={value:String(element.value).slice(0,8000),checked:Boolean(element.checked)};});return {custom,forms};};
const reportState=()=>{clearTimeout(timer);timer=setTimeout(()=>{try{const state=capture();if(JSON.stringify(state).length<=65536)send({type:'state',state});}catch{}},160);};
Object.defineProperty(window,'ArtifactState',{value:Object.freeze({getState:()=>JSON.parse(JSON.stringify(custom)),setState:value=>{try{const data=JSON.stringify(value);if(data.length<=49152&&value&&typeof value==='object'&&!Array.isArray(value)){custom=JSON.parse(data);reportState();}}catch{}},setSelectionContext:value=>{if(value&&typeof value==='object'){context={quote:typeof value.quote==='string'?value.quote.slice(0,8000):'',page:value.page,sheet:value.sheet,cellRange:value.cellRange};send({type:'selection',selection:context});}}}),writable:false,configurable:false});
function ready(){controls().forEach((element,index)=>{const value=saved.forms?.[keyFor(element,index)];if(value){element.value=String(value.value??'');if('checked'in element)element.checked=!!value.checked;setTimeout(()=>{element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));},0);}});saved={};const height=()=>send({type:'height',height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)});new ResizeObserver(height).observe(document.documentElement);height();}
document.addEventListener('DOMContentLoaded',ready,{once:true});document.addEventListener('input',reportState);document.addEventListener('change',reportState);
document.addEventListener('selectionchange',()=>send({type:'selection',selection:{...context,quote:String(getSelection()||'').slice(0,8000)||context.quote||''}}));
document.addEventListener('click',event=>{const anchor=event.target?.closest?.('a');if(anchor&&anchor.getAttribute('href')&&!anchor.getAttribute('href').startsWith('#')){event.preventDefault();send({type:'error',message:'预览中的外部链接已禁用，可复制到浏览器页打开'});}},true);
document.addEventListener('submit',event=>event.preventDefault(),true);
addEventListener('error',()=>send({type:'error',message:'交互内容执行出错，请查看源码或重新生成'}));addEventListener('unhandledrejection',()=>send({type:'error',message:'交互内容执行出错，请查看源码或重新生成'}));
})();`;
  const annotationScript=annotate&&richAnnotations?`<script>${captureRuntime.script.replace(/<\/script/gi,'<\\/script')}<\/script><script>${artifactAnnotationBootstrap}<\/script>`:'';
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeArtifactHTML(policy)}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${bootstrap}<\/script>${annotationScript}</head><body>${source}</body></html>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeArtifactHTML(policy)}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;background:#fff;color:#262626;font:12px system-ui,sans-serif}#content{display:block;width:100%;height:500px;border:0}#annotation{display:${annotate?'flex':'none'};align-items:center;flex-wrap:wrap;gap:6px;padding:6px 10px;background:#fafafa;border-bottom:1px solid #e7e7e7}#selection{flex:1;min-width:40px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#777}button{min-height:30px;border:1px solid #ddd;background:white;border-radius:7px;font:inherit;white-space:nowrap;padding:4px 8px;cursor:pointer}button[aria-pressed=true]{background:#262626;color:white}#status{display:none;padding:6px 10px;color:#666;background:#fafafa}</style></head><body>
<div id="annotation"><button id="element" style="display:${richAnnotations?'inline-block':'none'}" aria-label="选择界面元素" aria-pressed="false">选择元素</button><button id="region" style="display:${richAnnotations?'inline-block':'none'}" aria-label="框选界面区域" aria-pressed="false">框选区域</button><span id="selection"></span><button id="add" aria-label="批注交互内容">文字批注</button></div><div id="status" role="status"></div><iframe id="content" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeArtifactHTML(title)}"></iframe><script>(()=>{'use strict';
const token=${artifactScriptJSON(token)},frame=document.getElementById('content'),status=document.getElementById('status');let selection={quote:''},lastHeight=0,lastState=0,pins=[],focus='';
const send=message=>{const data={channel:'salcara-artifact',token,...message};if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(data));else parent.postMessage(data,'*');};
const control=data=>frame.contentWindow?.postMessage({channel:'artifact-annotation-control',...data},'*');
window.__salcaraAnnotationControl=data=>{if(!data||data.token!==token)return;pins=Array.isArray(data.pins)?data.pins.slice(0,20):[];control({pins,...(data.focus&&String(data.focusNonce)!==focus?{focus:data.focus}:{} )});focus=String(data.focusNonce??'');};
addEventListener('message',event=>{
 if(event.source===parent&&event.data?.channel==='salcara-annotation-control'){window.__salcaraAnnotationControl(event.data);return;}
 if(event.source!==frame.contentWindow||event.data?.channel!=='artifact-inner')return;const data=event.data;
 if(data.type==='height'&&Number.isFinite(data.height)){const height=Math.max(180,Math.min(1100,data.height));frame.style.height=height+'px';if(height!==lastHeight){lastHeight=height;send({type:'height',height:height+${annotate?52:0}});}}
 else if(data.type==='state'){try{const state=JSON.stringify(data.state);if(state.length<=65536&&data.state&&typeof data.state==='object'&&!Array.isArray(data.state)&&Date.now()-lastState>80){lastState=Date.now();send({type:'state',state:JSON.parse(state)});}}catch{}}
 else if(data.type==='selection'){selection={quote:typeof data.selection?.quote==='string'?data.selection.quote.slice(0,8000):'',page:data.selection?.page,sheet:data.selection?.sheet,cellRange:data.selection?.cellRange};document.getElementById('selection').textContent=selection.quote?'已选中文字':'';}
 else if(data.type==='annotation'){try{if(JSON.stringify(data.selection).length<2100000)send({type:'annotation',selection:data.selection});}catch{}}
 else if(data.type==='annotation-focus'&&typeof data.id==='string')send({type:'annotation-focus',id:data.id});
 else if(data.type==='log'&&data.entry&&typeof data.entry.message==='string'&&data.entry.message.length<=2000&&typeof data.entry.source==='string'&&data.entry.source.length<=1024)send({type:'log',entry:data.entry});
 else if(data.type==='annotation-mode'){for(const key of ['element','region'])document.getElementById(key).setAttribute('aria-pressed',String(data.mode===key));}
 else if(data.type==='annotation-status'||data.type==='error'){if(typeof data.message==='string'){status.textContent=data.message.slice(0,300);status.style.display='block';if(data.type==='error')send({type:'error',message:status.textContent});}}
});
for(const key of ['element','region'])document.getElementById(key).addEventListener('click',event=>{if(event.isTrusted)control({mode:event.currentTarget.getAttribute('aria-pressed')==='true'?'':key});});
document.getElementById('add').addEventListener('click',event=>{if(event.isTrusted)send({type:'annotation',selection});});frame.addEventListener('load',()=>control({pins}));frame.srcdoc=${artifactScriptJSON(inner)};
})();<\/script></body></html>`;
}

