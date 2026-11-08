import { buildRichRenderDocument, parseRichRenderReport } from '../components/rich-render-document';
// Jest's CommonJS VM cannot import JSON dynamically. Use the exact same local
// engine/assets synchronously; the document builder and renderer are real.
jest.mock('../components/rich-render-assets',()=>({loadMathRenderer:async()=>({engine:require('katex'),css:require('../components/rich-renderer-assets/katex-css.json').css}),loadDiagramRenderer:async()=>require('../components/rich-renderer-assets/mermaid-script.json').script}));
const base={token:'render_test_123',color:'#202020',background:'#ffffff'};
test('KaTeX generates real layout/MathML with offline fonts',async()=>{
 const html=await buildRichRenderDocument({...base,kind:'math',source:String.raw`\frac{a^2+b^2}{\sqrt{c}}`});
 expect(html).toContain('class="katex"');expect(html).toContain('<mfrac>');expect(html).toContain('data:font/woff2;base64,');expect(html).toContain("connect-src 'none'");expect(html).not.toMatch(/url\(fonts\//);
});
test('math links and HTML commands never acquire active URL/HTML authority',async()=>{
 const html=await buildRichRenderDocument({...base,kind:'math',source:String.raw`\href{https://example.com}{x}`});
 expect(html).not.toContain('href="https://example.com"');expect(html).not.toContain('<script src=');
});
test('invalid or excessively expanded formulas fail to the readable source path',async()=>{
 await expect(buildRichRenderDocument({...base,kind:'math',source:String.raw`\frac{`})).rejects.toThrow();
 await expect(buildRichRenderDocument({...base,kind:'math',source:'x'.repeat(12001)})).rejects.toThrow('过长');
});
test('diagram uses fixed local runtime, strict security and escaped message data',async()=>{
 const source='flowchart LR\n A["</script><script>window.PWN=1</script>"] --> B[Done]';
 const html=await buildRichRenderDocument({...base,kind:'mermaid',source});
 expect(html).toContain("securityLevel:'strict'");expect(html).toContain('\\u003c/script\\u003e');expect(html).not.toContain(source);expect(html).toContain('script nonce="render_test_123"');
 await expect(buildRichRenderDocument({...base,kind:'mermaid',source:'%%{init: {securityLevel: loose}}%%\nflowchart LR\nA-->B'})).rejects.toThrow('配置');
});
test('render messages require their owner token and bound dimensions',()=>{
 expect(parseRichRenderReport({token:'other',type:'size',width:10,height:20},base.token)).toBeUndefined();
 expect(parseRichRenderReport({token:base.token,type:'size',width:Infinity,height:20},base.token)).toBeUndefined();
 expect(parseRichRenderReport({token:base.token,type:'size',width:10000,height:-5},base.token)).toEqual({type:'size',width:1600,height:24});
});
