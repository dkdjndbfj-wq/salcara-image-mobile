const sensitive=/(?:passw|passwd|secret|token|api.?key|authorization|credential|credit.?card)/i;

/** Match the renderer's light/shadow traversal before mutating any live node. */
function captureElements(root,limit){
  const elements=[],visited=new Set(),stack=[root];
  while(stack.length){
    const node=stack.pop();if(!node||visited.has(node))continue;visited.add(node);
    if(node.nodeType===1){elements.push(node);if(elements.length>limit)throw Error('页面较复杂，请先选择较小的独立页面');}
    if(node.children)stack.push(...node.children);
    if(node.shadowRoot)stack.push(node.shadowRoot);
  }
  return elements;
}

/** Masks synchronously; restoration must run before any asynchronous renderer work. */
export function maskCaptureDocument(root,{limit=6000}={}){
  const snapshots=captureElements(root,limit).map(node=>{
    const style=node.getAttribute('style'),type=node.tagName==='INPUT'?node.type.toLowerCase():undefined;
    let hidden=node.hasAttribute('data-salcara-annotation-overlay')||type==='file'||type==='password'||sensitive.test((node.getAttribute('name')||'')+' '+node.id);
    // A file input can only be cleared programmatically, never restored. Hide it
    // without reading or assigning its value or FileList.
    const fields=type==='file'?[]:node.tagName==='SELECT'?[['selectedIndex',-1]]:type==='checkbox'||type==='radio'?[['checked',false],['value','']]:node.tagName==='TEXTAREA'||type&&!['button','submit','reset','image'].includes(type)?[['value','']]:[];
    const properties=[];
    for(const [key,value] of fields){const descriptor=Object.getOwnPropertyDescriptor(node,key);if(descriptor&&!descriptor.configurable){hidden=true;continue;}properties.push({key,value,descriptor});}
    return {node,style,hidden,properties};
  });
  const restore=()=>{
    let failure;
    for(const state of snapshots){
      const {node,style}=state;
      try{if(style===null)node.removeAttribute('style');else node.setAttribute('style',style);}catch(error){failure??=error;}
      for(const property of state.properties)try{if(property.descriptor)Object.defineProperty(node,property.key,property.descriptor);else delete node[property.key];}catch(error){failure??=error;}
    }
    if(failure)throw failure;
  };
  try{
    for(const state of snapshots){
      const {node}=state;
      if(state.hidden)node.style.visibility='hidden';
      // html2canvas reads these JS properties synchronously. Shadow the getters
      // instead of assigning live values, so FileLists, selection/caret, scroll
      // and the browser's dirty-value flags remain completely untouched.
      for(const property of state.properties)Object.defineProperty(node,property.key,{configurable:true,get:()=>property.value});
    }
  }catch(error){try{restore();}catch{/* Preserve the original masking error after restoring other nodes. */}throw error;}
  return restore;
}
