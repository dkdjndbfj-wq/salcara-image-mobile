import {strToU8,zipSync} from 'fflate';
import {artifactPayloadBytes,artifactScriptJSON,escapeArtifactHTML,officePreviewHTML,parseOfficeArtifact,spreadsheetColumn} from '../remote/artifact-content';
import {buildInteractiveArtifactDocument,parseInteractiveMessage} from '../components/interactive-artifact-document';
const zip=(entries:Record<string,string>)=>zipSync(Object.fromEntries(Object.entries(entries).map(([key,text])=>[key,strToU8(text)])));
test('DOCX parses headings paragraphs and tables and escapes markup instead of executing it',()=>{
 const model=parseOfficeArtifact('document',zip({'word/document.xml':'<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Title &amp; body</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'}));
 expect(model.kind).toBe('document');if(model.kind!=='document')throw Error();expect(model.blocks[0]).toEqual({kind:'paragraph',text:'Title & body',heading:2});const html=officePreviewHTML(model);expect(html).toContain('<h2>Title &amp; body</h2>');expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
});
test('XLSX preserves names, cached formula results and cell coordinates across sheets',()=>{
 const model=parseOfficeArtifact('spreadsheet',zip({'xl/workbook.xml':'<workbook><sheets><sheet name="First" r:id="a"/><sheet name="Second" r:id="b"/></sheets></workbook>','xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="a" Target="worksheets/a.xml"/><Relationship Id="b" Target="worksheets/b.xml"/></Relationships>','xl/worksheets/a.xml':'<worksheet><sheetData><row r="3"><c r="B3"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>','xl/worksheets/b.xml':'<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c></row></sheetData></worksheet>'}));
 if(model.kind!=='spreadsheet')throw Error();expect(model.sheets.map(s=>s.name)).toEqual(['First','Second']);expect(model.sheets[0].rows[0].cells[0]).toMatchObject({column:2,value:'2',formula:'1+1'});expect(officePreviewHTML(model)).toContain('data-cell="B3"');expect(spreadsheetColumn(27)).toBe('AA');
});
test('PPTX keeps presentation order and rejects missing slide relationships',()=>{
 const files={'ppt/presentation.xml':'<p:presentation><p:sldIdLst><p:sldId r:id="b"/><p:sldId r:id="a"/></p:sldIdLst></p:presentation>','ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="a" Target="slides/one.xml"/><Relationship Id="b" Target="slides/two.xml"/></Relationships>','ppt/slides/one.xml':'<p:sld><a:p><a:r><a:t>One</a:t></a:r></a:p></p:sld>','ppt/slides/two.xml':'<p:sld><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:sld>'};
 const model=parseOfficeArtifact('presentation',zip(files));if(model.kind!=='presentation')throw Error();expect(model.slides[0].blocks[0]).toEqual({kind:'paragraph',text:'Two'});
 expect(()=>parseOfficeArtifact('presentation',zip({...files,'ppt/_rels/presentation.xml.rels':'<Relationships/>'}))).toThrow('幻灯片内容缺失');
});
test('Office archives refuse traversal, external entities and deep nesting',()=>{
 expect(()=>parseOfficeArtifact('document',zip({'../word/document.xml':'x'}))).toThrow('文件路径');
 expect(()=>parseOfficeArtifact('document',zip({'word/document.xml':'<!DOCTYPE x SYSTEM "https://example.com"><w:document/>'}))).toThrow('外部实体');
 expect(()=>parseOfficeArtifact('document',zip({'word/document.xml':'<x>'.repeat(130)+'</x>'.repeat(130)}))).toThrow('过于复杂');
});
test('interactive bridge rejects wrong tokens, huge states and unrecognized operations',()=>{
 expect(parseInteractiveMessage({channel:'salcara-artifact',token:'other',type:'state',state:{}},'ok')).toBeUndefined();
 expect(parseInteractiveMessage({channel:'salcara-artifact',token:'ok',type:'execute',command:'delete'},'ok')).toBeUndefined();
 expect(parseInteractiveMessage({channel:'salcara-artifact',token:'ok',type:'state',state:{text:'x'.repeat(70000)}},'ok')).toBeUndefined();
 expect(parseInteractiveMessage({channel:'salcara-artifact',token:'ok',type:'height',height:5000},'ok')).toEqual({type:'height',height:1200});
 expect(parseInteractiveMessage({channel:'salcara-artifact',token:'ok',type:'annotation',selection:{quote:'hello',page:2,cellRange:'B3'}},'ok')).toMatchObject({type:'annotation',selection:{page:2,cellRange:'B3'}});
});
test('sandbox has no application origin, no network permissions and explicit user-gesture annotation',()=>{
 const html=buildInteractiveArtifactDocument('<p>Preview</p>','test-token',{},true,'Artifact');
 expect(html).toContain('sandbox="allow-scripts"');expect(html).not.toContain('allow-same-origin');expect(html).toContain("connect-src &#39;none&#39;");expect(html).toContain('event.isTrusted');expect(html).toContain('event.source!==frame.contentWindow');
 expect(artifactScriptJSON('</script>')).not.toContain('</script>');expect(escapeArtifactHTML('<iframe>')).toBe('&lt;iframe&gt;');
 expect(artifactPayloadBytes({artifact:{} as never,encoding:'utf8',content:''})).toHaveLength(0);
});
