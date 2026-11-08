/** Installs before document code. It reports observations without evaluating console values. */
export function previewLogScript(send: string): string {
  return `(()=>{let sequence=0,count=0,windowStart=Date.now();const emit=${send};
const describe=value=>{try{if(value instanceof Error)return value.stack||value.message;if(typeof value==='string')return value;if(value===undefined)return 'undefined';const seen=new WeakSet();return JSON.stringify(value,(key,item)=>{if(typeof item==='bigint')return String(item);if(item&&typeof item==='object'){if(seen.has(item))return '[Circular]';seen.add(item);}return item;})??String(value);}catch{return '[无法序列化的值]';}};
const record=(level,message,source,line,column)=>{const now=Date.now();if(now-windowStart>1000){windowStart=now;count=0;}if(++count>64)return;message=String(message||'');if(!message)return;emit({id:'runtime:'+ ++sequence,level,message:message.slice(0,2000),source:String(source||location.href).slice(0,1024),...(Number.isSafeInteger(line)&&line>0?{line}:{}),...(Number.isSafeInteger(column)&&column>0?{column}:{}),...(message.length>2000?{truncated:true}:{})});};
for(const level of ['debug','log','info','warn','error']){const original=console[level];console[level]=function(...args){try{original?.apply(console,args);}finally{record(level,args.map(describe).join(' '));}};}
addEventListener('error',event=>{if(event.message)record('error',event.error?describe(event.error):event.message,event.filename,event.lineno,event.colno);});
addEventListener('unhandledrejection',event=>record('error','Unhandled rejection: '+describe(event.reason)));
})();`;
}
