import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {maskCaptureDocument} from './artifact-capture-privacy.mjs';

test('capture masks values but preserves multiple selection, duplicate option identity, checks and text caret',()=>{
  const dom=new JSDOM('<input id="text" value="private text"><textarea>private paragraph</textarea><input type="checkbox" checked><select multiple><option selected value="a">A</option><option selected value="b">B</option><option value="c">C</option></select><select id="single"><option value="same">First</option><option selected value="same">Second</option></select><input type="submit" value="保存">');
  const doc=dom.window.document,input=doc.querySelector('#text'),area=doc.querySelector('textarea'),multiple=doc.querySelector('[multiple]'),single=doc.querySelector('#single'),check=doc.querySelector('[type=checkbox]');
  input.focus();input.setSelectionRange(2,7,'backward');area.setSelectionRange(1,5,'forward');
  const restore=maskCaptureDocument(doc.documentElement);
  assert.equal(input.value,'');assert.equal(area.value,'');assert.equal(multiple.selectedIndex,-1);assert.equal(single.selectedIndex,-1);assert.equal(check.checked,false);assert.equal(doc.querySelector('[type=submit]').value,'保存');
  restore();assert.equal(input.value,'private text');assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,7);assert.equal(input.selectionDirection,'backward');assert.equal(doc.activeElement,input);assert.equal(area.value,'private paragraph');assert.equal(area.selectionStart,1);assert.equal(area.selectionEnd,5);
  assert.deepEqual([...multiple.selectedOptions].map(option=>option.value),['a','b']);assert.equal(single.selectedIndex,1);assert.equal(single.selectedOptions[0].textContent,'Second');assert.equal(check.checked,true);dom.window.close();
});

test('file selections are hidden without any assignment that could clear or fail to restore the FileList',()=>{
  const dom=new JSDOM('<input type="file" style="border: 1px solid red"><input value="other input">'),file=dom.window.document.querySelector('[type=file]');
  // Real browsers reject restoring a non-empty file.value. Any access here is
  // unnecessary: the file picker and its selected filename are simply hidden.
  Object.defineProperty(file,'value',{get(){throw Error('file value must not be read');},set(){throw Error('file selection must not be modified');}});
  const oldStyle=file.getAttribute('style'),restore=maskCaptureDocument(dom.window.document.documentElement);
  assert.equal(file.style.visibility,'hidden');restore();assert.equal(file.getAttribute('style'),oldStyle);assert.equal(dom.window.document.querySelector('input:not([type=file])').value,'other input');dom.window.close();
});

test('open shadow trees receive the same sensitive-field masking and parser style restoration',()=>{
  const dom=new JSDOM('<x-settings></x-settings><div data-salcara-annotation-overlay="true">pin</div>'),doc=dom.window.document,shadow=doc.querySelector('x-settings').attachShadow({mode:'open'});
  shadow.innerHTML='<input name="api-key" value="sk-fixture-only"><div style="transform: translateX(10px); animation-duration: 2s">Animated</div><textarea>private shadow value</textarea>';
  const field=shadow.querySelector('input'),animated=shadow.querySelector('div'),area=shadow.querySelector('textarea'),style=animated.getAttribute('style');
  const restore=maskCaptureDocument(doc.documentElement);assert.equal(field.style.visibility,'hidden');assert.equal(field.value,'');assert.equal(area.value,'');assert.equal(doc.querySelector('[data-salcara-annotation-overlay]').style.visibility,'hidden');
  // html2canvas freezes these live styles while parsing, including shadow nodes.
  animated.style.transform='none';animated.style.animationDuration='0s';restore();assert.equal(field.value,'sk-fixture-only');assert.equal(field.hasAttribute('style'),false);assert.equal(area.value,'private shadow value');assert.equal(animated.getAttribute('style'),style);assert.equal(doc.querySelector('[data-salcara-annotation-overlay]').hasAttribute('style'),false);dom.window.close();
});

test('a non-configurable custom value is hidden without invoking its mutating setter',()=>{
  const dom=new JSDOM('<input id="failing" value="original"><input id="visited" value="keep this">'),doc=dom.window.document,broken=doc.querySelector('#failing');
  let value='original';Object.defineProperty(broken,'value',{get(){return value;},set(next){if(next==='')throw Error('cannot mask this control');value=next;}});
  const restore=maskCaptureDocument(doc.documentElement);assert.equal(broken.style.visibility,'hidden');assert.equal(doc.querySelector('#visited').value,'');restore();assert.equal(doc.querySelector('#visited').value,'keep this');assert.equal(broken.value,'original');assert.equal(broken.hasAttribute('style'),false);dom.window.close();
});

test('restore attempts all remaining controls even if one custom field refuses restoration',()=>{
  const dom=new JSDOM('<input id="later" value="must restore"><input id="failing" value="original">'),doc=dom.window.document,broken=doc.querySelector('#failing');
  const restore=maskCaptureDocument(doc.documentElement);Object.defineProperty(broken,'value',{configurable:false,get:()=>''});assert.throws(restore);assert.equal(doc.querySelector('#later').value,'must restore');dom.window.close();
});

test('capture preserves pristine value/default-value behavior and does not move text scroll positions',()=>{
  const dom=new JSDOM('<input value="original"><textarea>long text</textarea>'),doc=dom.window.document,input=doc.querySelector('input'),area=doc.querySelector('textarea');area.scrollTop=30;area.scrollLeft=12;
  const restore=maskCaptureDocument(doc.documentElement);restore();input.setAttribute('value','updated default');assert.equal(input.value,'updated default');assert.equal(area.scrollTop,30);assert.equal(area.scrollLeft,12);dom.window.close();
});

test('node limit includes shadow DOM and rejects before changing any form state',()=>{
  const dom=new JSDOM('<input value="unchanged"><x-many></x-many>'),doc=dom.window.document,shadow=doc.querySelector('x-many').attachShadow({mode:'open'});shadow.innerHTML='<span></span>'.repeat(20);
  assert.throws(()=>maskCaptureDocument(doc.documentElement,{limit:10}),/页面较复杂/);assert.equal(doc.querySelector('input').value,'unchanged');dom.window.close();
});
