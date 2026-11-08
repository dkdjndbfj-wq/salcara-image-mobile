import {loadMathRenderer,loadDiagramRenderer} from './rich-render-assets';
export type RichRenderKind = 'math' | 'mermaid';
export interface RichRenderOptions { kind: RichRenderKind; source: string; color: string; background: string; inline?: boolean; token: string }
const escapeHTML = (text: string) => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const scriptJSON = (value: unknown) => JSON.stringify(value).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const safeColor = (color: string) => /^#[a-fA-F0-9]{3,8}$/.test(color) ? color : '#202020';

/** Untrusted message text is data. Only these locally bundled renderers and
 * the fixed size reporter execute; network and document navigation are denied. */
export async function buildRichRenderDocument(options: RichRenderOptions): Promise<string> {
  const {kind,source,inline=false,token}=options;
  if (!source.trim() || source.length > (kind==='math'?12000:20000)) throw new Error('内容为空或过长，已保留源码');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(token)) throw new Error('无效渲染标识');
  const color=safeColor(options.color),background=safeColor(options.background);
  let css='',body='',renderer='';
  if(kind==='math') {
    const loaded=await loadMathRenderer();
    body=loaded.engine.renderToString(source,{displayMode:!inline,throwOnError:true,trust:false,strict:'error',maxExpand:1000,maxSize:20,output:'htmlAndMathml'});
    css=loaded.css;
  } else {
    // Per-message initialization/configuration is not allowed to override the
    // renderer's security settings or insert stylesheet/network directives.
    if (/%%\s*\{|^\s*---/m.test(source)) throw new Error('图表配置指令不受支持，已保留源码');
    const script=await loadDiagramRenderer();
    renderer=script.replace(/<\/script/gi,'<\\/script')+`\n;(async()=>{try{
      mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',maxTextSize:20000,maxEdges:500,htmlLabels:false,flowchart:{htmlLabels:false},themeVariables:{primaryColor:${scriptJSON(background)},primaryTextColor:${scriptJSON(color)},lineColor:${scriptJSON(color)},fontFamily:'system-ui, sans-serif'},secure:['securityLevel','startOnLoad','maxTextSize','maxEdges','htmlLabels','flowchart','theme','themeVariables']});
      const result=await mermaid.render('message_diagram',${scriptJSON(source)});
      const parsed=new DOMParser().parseFromString(result.svg,'image/svg+xml');
      if(parsed.querySelector('parsererror')||result.svg.length>4000000)throw new Error('invalid SVG');
      parsed.querySelectorAll('script,foreignObject,iframe,object,embed').forEach(node=>node.remove());
      parsed.querySelectorAll('*').forEach(node=>{for(const attr of [...node.attributes]){if(/^on/i.test(attr.name)||(/href$/i.test(attr.name)&&!attr.value.startsWith('#')))node.removeAttribute(attr.name);}});
      document.getElementById('content').replaceChildren(document.importNode(parsed.documentElement,true));
      report();document.fonts.ready.then(report);
    }catch(error){document.getElementById('content').textContent='';post({type:'error',message:'图表语法无法渲染，已保留源码'});}})();`;
  }
  const reporter=`const token=${scriptJSON(token)};function post(value){const data={...value,token};if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(data));else parent.postMessage(data,'*');}function report(){const element=document.getElementById('content');const rect=element.getBoundingClientRect();post({type:'size',width:Math.ceil(Math.max(rect.width,element.scrollWidth)),height:Math.ceil(Math.max(rect.height,element.scrollHeight))+4});}new ResizeObserver(report).observe(document.getElementById('content'));document.fonts.ready.then(report);document.addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault();});report();`;
  const csp=`default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHTML(csp)}"><style>${css}\nhtml,body{margin:0;padding:0;color:${color};background:${background};font:16px system-ui,sans-serif;}#content{display:${inline?'inline-block':'block'};${inline?'white-space:nowrap;':'padding:8px;box-sizing:border-box;'}min-height:20px;}svg{max-width:100%;height:auto;} .katex-display{margin:0;}body{overflow:auto;}</style></head><body><div id="content">${body}</div><script nonce="${token}">${reporter}${renderer}</script></body></html>`;
}

export function parseRichRenderReport(raw: unknown, token: string): { type:'size';width:number;height:number } | { type:'error';message:string } | undefined {
  if(!raw||typeof raw!=='object'||(raw as {token?:unknown}).token!==token)return;
  const value=raw as {type?:unknown;width?:unknown;height?:unknown;message?:unknown};
  if(value.type==='error')return {type:'error',message:typeof value.message==='string'?value.message.slice(0,200):'内容无法渲染，已保留源码'};
  if(value.type==='size'&&typeof value.width==='number'&&Number.isFinite(value.width)&&typeof value.height==='number'&&Number.isFinite(value.height))return {type:'size',width:Math.max(16,Math.min(1600,value.width)),height:Math.max(24,Math.min(1600,value.height))};
}
