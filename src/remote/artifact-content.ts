import { strFromU8, strToU8, unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { attachmentBytes } from './attachment-ref';
import type { ArtifactPayload } from './conversation-artifacts';

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_ARTIFACT_EDIT_BYTES = 128 * 1024;
export const escapeArtifactHTML = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const artifactScriptJSON = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function artifactPayloadBytes(payload: ArtifactPayload): Uint8Array {
  const bytes = payload.encoding === 'base64' ? attachmentBytes(payload.content, MAX_ARTIFACT_BYTES) : strToU8(payload.content);
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('文件超过 20 MB 预览上限，请在电脑上打开');
  return bytes;
}
export const artifactPayloadText = (payload: ArtifactPayload): string => payload.encoding === 'utf8' ? payload.content : strFromU8(artifactPayloadBytes(payload));
export const artifactEditSize = (content: string): number => strToU8(content).length;

type XMLNode = { [key: string]: XMLNode[] | string | Record<string, string> };
const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: true, parseTagValue: false, trimValues: false, processEntities: false });
const tag = (node: XMLNode): string => Object.keys(node).find(key => key !== ':@' && key !== '#text') ?? '';
const local = (name: string): string => name.split(':').pop() ?? name;
const children = (node: XMLNode): XMLNode[] => { const content = node[tag(node)]; return Array.isArray(content) ? content : []; };
const attribute = (node: XMLNode, name: string): string => { const attrs = node[':@']; return attrs && !Array.isArray(attrs) && typeof attrs === 'object' ? String(attrs[`@_${name}`] ?? '') : ''; };
const direct = (nodes: XMLNode[], name: string): XMLNode[] => nodes.filter(node => local(tag(node)) === name);
const descendants = (nodes: XMLNode[], name: string): XMLNode[] => nodes.flatMap(node => local(tag(node)) === name ? [node] : descendants(children(node), name));
const decodeXML = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, value: string) => {
  if (!value.startsWith('#')) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[value.toLowerCase() as 'amp'] ?? '';
  const point = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd';
});
const nodeText = (node: XMLNode): string => typeof node['#text'] === 'string' ? decodeXML(node['#text']) : children(node).map(nodeText).join('');
const runsText = (nodes: XMLNode[]): string => nodes.map(node => {
  const name = local(tag(node));
  return name === 't' ? nodeText(node) : name === 'tab' ? '\t' : ['br', 'cr'].includes(name) ? '\n' : runsText(children(node));
}).join('');

function officeArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  let count = 0, expanded = 0;
  return unzipSync(bytes, { filter: entry => {
    count++;
    if (count > 4096 || entry.originalSize > 24 * 1024 * 1024 || (expanded += entry.originalSize) > 80 * 1024 * 1024) throw new Error('文档解压后的内容太大，无法在移动端预览');
    if (entry.name.split('/').includes('..') || entry.name.startsWith('/') || entry.name.includes('\\')) throw new Error('文档内的文件路径无效');
    return /\.(xml|rels)$/i.test(entry.name);
  } });
}
function xml(files: Record<string, Uint8Array>, path: string): XMLNode[] {
  const bytes = files[path];
  if (!bytes) return [];
  const source = strFromU8(bytes);
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(source)) throw new Error('不支持包含外部实体的文档');
  // Limit pathological nesting before the recursive parser/model traversal.
  let depth = 0;
  for (const match of source.matchAll(/<\/?[a-zA-Z_][^>]*>/g)) {
    if (match[0].startsWith('</')) depth--; else if (!match[0].endsWith('/>')) depth++;
    if (depth > 128) throw new Error('文档结构过于复杂，无法预览');
  }
  return parser.parse(source) as XMLNode[];
}

export type OfficeBlock = { kind: 'paragraph'; text: string; heading?: number } | { kind: 'table'; rows: string[][] };
export type OfficePreview =
  | { kind: 'document'; blocks: OfficeBlock[]; limitation: string }
  | { kind: 'spreadsheet'; sheets: { name: string; rows: { index: number; cells: { column: number; value: string; formula?: string }[] }[]; columns: number }[]; limitation: string }
  | { kind: 'presentation'; slides: { blocks: OfficeBlock[] }[]; limitation: string };

function paragraph(node: XMLNode): OfficeBlock {
  const style = descendants(children(node), 'pStyle')[0];
  const match = style && /heading\s*([1-6])/i.exec(attribute(style, 'w:val'));
  return { kind: 'paragraph', text: runsText(children(node)), ...(match ? { heading: Number(match[1]) } : {}) };
}
function table(node: XMLNode): OfficeBlock {
  return { kind: 'table', rows: direct(children(node), 'tr').slice(0, 2000).map(row => direct(children(row), 'tc').slice(0, 200).map(cell => descendants(children(cell), 'p').map(p => runsText(children(p))).join('\n'))) };
}
function documentBlocks(nodes: XMLNode[]): OfficeBlock[] {
  return nodes.flatMap(node => local(tag(node)) === 'p' ? [paragraph(node)] : local(tag(node)) === 'tbl' ? [table(node)] : documentBlocks(children(node)));
}
function relationships(files: Record<string, Uint8Array>, path: string, base: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rel of descendants(xml(files, path), 'Relationship')) {
    if (attribute(rel, 'TargetMode') === 'External') continue;
    const target = attribute(rel, 'Target');
    if (/^[a-z]+:|[\\\u0000-\u001f]/i.test(target)) continue;
    const parts: string[] = target.startsWith('/') ? [] : base.split('/').filter(Boolean);
    for (const part of target.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
    result.set(attribute(rel, 'Id'), parts.join('/'));
  }
  return result;
}
const columnNumber = (ref: string): number => (ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? 'A').split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
export function spreadsheetColumn(column: number): string { let value = ''; for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + (n - 1) % 26) + value; return value; }

export function parseOfficeArtifact(kind: 'document' | 'spreadsheet' | 'presentation', bytes: Uint8Array): OfficePreview {
  const files = officeArchive(bytes);
  if (kind === 'document') {
    if (!files['word/document.xml']) throw new Error('不是有效的 DOCX 文件；旧版 DOC 格式请先在电脑上转换');
    return { kind, blocks: documentBlocks(xml(files, 'word/document.xml')), limitation: '正文与表格预览；分页、修订、浮动图片及复杂排版请下载原文件查看。' };
  }
  if (kind === 'spreadsheet') {
    if (!files['xl/workbook.xml']) throw new Error('不是有效的 XLSX 文件；旧版 XLS 格式请先在电脑上转换');
    const rels = relationships(files, 'xl/_rels/workbook.xml.rels', 'xl');
    const strings = descendants(xml(files, 'xl/sharedStrings.xml'), 'si').map(node => runsText(children(node)));
    let cellsRead = 0, truncated = false;
    const sheets = descendants(xml(files, 'xl/workbook.xml'), 'sheet').slice(0, 64).map(sheet => {
      const path = rels.get(attribute(sheet, 'r:id'));
      if (!path || !files[path]) throw new Error('工作表内容缺失');
      const allRows = descendants(xml(files, path), 'row');
      if (allRows.length > 5000) truncated = true;
      let columns = 1;
      const rows = allRows.slice(0, 5000).map((row, index) => ({ index: Number(attribute(row, 'r')) || index + 1, cells: direct(children(row), 'c').flatMap(cell => {
        const column = columnNumber(attribute(cell, 'r'));
        if (column > 200 || ++cellsRead > 50000) { truncated = true; return []; }
        columns = Math.max(columns, column);
        const type = attribute(cell, 't'), value = nodeText(direct(children(cell), 'v')[0] ?? {}), formula = nodeText(direct(children(cell), 'f')[0] ?? {});
        return [{ column, value: type === 's' ? strings[Number(value)] ?? '' : type === 'inlineStr' ? runsText(children(cell)) : type === 'b' ? value === '1' ? 'TRUE' : 'FALSE' : value, ...(formula ? { formula } : {}) }];
      }) }));
      return { name: decodeXML(attribute(sheet, 'name')), rows, columns };
    });
    return { kind, sheets, limitation: `${truncated ? '大型工作簿仅展示前 64 个工作表、每表前 5000 行 / 200 列，共 50000 个单元格。' : ''}显示已保存的单元格值；公式不重新计算，图表、合并单元格和复杂格式请下载原文件查看。` };
  }
  if (!files['ppt/presentation.xml']) throw new Error('不是有效的 PPTX 文件；旧版 PPT 格式请先在电脑上转换');
  const rels = relationships(files, 'ppt/_rels/presentation.xml.rels', 'ppt');
  const slides = descendants(xml(files, 'ppt/presentation.xml'), 'sldId').slice(0, 500).map(slide => {
    const path = rels.get(attribute(slide, 'r:id'));
    if (!path || !files[path]) throw new Error('幻灯片内容缺失');
    return { blocks: documentBlocks(xml(files, path)) };
  });
  return { kind, slides, limitation: '逐页内容预览；原始布局、图片、母版、过渡和动画暂不还原，请下载原文件查看完整效果。' };
}

export function officeBlocksHTML(blocks: OfficeBlock[]): string {
  return blocks.map(block => block.kind === 'table' ? `<table>${block.rows.map(row => `<tr>${row.map(cell => `<td>${escapeArtifactHTML(cell)}</td>`).join('')}</tr>`).join('')}</table>` : block.heading ? `<h${block.heading}>${escapeArtifactHTML(block.text)}</h${block.heading}>` : `<p>${escapeArtifactHTML(block.text) || '<br>'}</p>`).join('');
}

export function officePreviewHTML(model: OfficePreview): string {
  const body = model.kind === 'document' ? `<main>${officeBlocksHTML(model.blocks)}</main>` : model.kind === 'presentation' ? `<nav><button id="prev">上一页</button><span id="position"></span><button id="next">下一页</button></nav>${model.slides.map((slide, index) => `<main class="slide" data-index="${index}">${officeBlocksHTML(slide.blocks)}</main>`).join('')}` : `<nav>${model.sheets.map((sheet, index) => `<button data-sheet="${index}">${escapeArtifactHTML(sheet.name)}</button>`).join('')}</nav>${model.sheets.map((sheet, index) => `<main class="sheet" data-index="${index}"><table><thead><tr><th></th>${Array.from({ length: sheet.columns }, (_, c) => `<th>${spreadsheetColumn(c + 1)}</th>`).join('')}</tr></thead><tbody>${sheet.rows.map(row => { const cells = new Map(row.cells.map(cell => [cell.column, cell])); return `<tr><th>${row.index}</th>${Array.from({ length: sheet.columns }, (_, c) => { const cell = cells.get(c + 1), coordinate = `${spreadsheetColumn(c + 1)}${row.index}`; return `<td tabindex="0" data-cell="${coordinate}" title="${escapeArtifactHTML(cell?.formula ? `=${cell.formula}` : coordinate)}">${escapeArtifactHTML(cell?.value ?? '')}</td>`; }).join('')}</tr>`; }).join('')}</tbody></table></main>`).join('')}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;color:#262626;background:#fff;font:14px/1.7 system-ui,sans-serif}nav{position:sticky;top:0;background:#fafafa;border-bottom:1px solid #e8e8e8;padding:8px;display:flex;align-items:center;gap:8px;overflow:auto}button{font:inherit;white-space:nowrap;border:0;border-radius:6px;background:transparent;padding:5px 10px;color:#555;cursor:pointer}button.active{background:#e9e9e9;color:#171717}main{padding:28px;max-width:850px;margin:auto}p{white-space:pre-wrap;min-height:1em}table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #e6e6e6;padding:7px 10px;min-width:72px;white-space:pre-wrap;vertical-align:top}th{background:#f7f7f7;font-weight:500}td:focus{outline:2px solid #555;outline-offset:-2px}main.sheet{overflow:auto;max-width:none;padding:0}.slide{min-height:320px}h1,h2,h3{line-height:1.3}</style></head><body>${body}<script>(()=>{const kind=${artifactScriptJSON(model.kind)},names=${artifactScriptJSON(model.kind === 'spreadsheet' ? model.sheets.map(s => s.name) : [])},items=[...document.querySelectorAll('main[data-index]')],buttons=[...document.querySelectorAll('[data-sheet]')];let index=Math.max(0,Math.min(items.length-1,Number(window.ArtifactState?.getState()?.index)||0));function render(){items.forEach((e,i)=>e.hidden=i!==index);buttons.forEach((e,i)=>e.classList.toggle('active',i===index));const p=document.getElementById('position');if(p)p.textContent=(index+1)+' / '+items.length;const previous=document.getElementById('prev'),next=document.getElementById('next');if(previous)previous.disabled=index<=0;if(next)next.disabled=index>=items.length-1;window.ArtifactState?.setState({index});window.ArtifactState?.setSelectionContext(kind==='spreadsheet'?{sheet:names[index]}:kind==='presentation'?{page:index+1}:{});}buttons.forEach((e,i)=>e.onclick=()=>{index=i;render();});const previous=document.getElementById('prev'),next=document.getElementById('next');if(previous)previous.onclick=()=>{index=Math.max(0,index-1);render();};if(next)next.onclick=()=>{index=Math.min(items.length-1,index+1);render();};document.addEventListener('click',e=>{const cell=e.target.closest('[data-cell]');if(cell)window.ArtifactState?.setSelectionContext({sheet:names[index],cellRange:cell.dataset.cell,quote:cell.textContent});});if(items.length)render();})();<\/script></body></html>`;
}

