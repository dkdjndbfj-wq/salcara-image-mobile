// Same-document renderer: html2canvas's default cloned iframe is inaccessible
// under an opaque sandbox. Keep the sandbox opaque and use its rendering core.
import {Context} from 'html2canvas/dist/lib/core/context';
import {CacheStorage} from 'html2canvas/dist/lib/core/cache-storage';
import {Bounds} from 'html2canvas/dist/lib/css/layout/bounds';
import {parseTree} from 'html2canvas/dist/lib/dom/node-parser';
import {CanvasRenderer} from 'html2canvas/dist/lib/render/canvas/canvas-renderer';
import {maskCaptureDocument} from './artifact-capture-privacy.mjs';
export async function capture(_element,options){
  CacheStorage.setContext(window);
  const context=new Context({logging:false,allowTaint:false,useCORS:false,imageTimeout:3000},new Bounds(scrollX,scrollY,innerWidth,innerHeight));
  const restore=maskCaptureDocument(document.documentElement);
  let root;
  try{
    root=parseTree(context,document.documentElement);
  }finally{
    // Parsing freezes transforms/animation; undo those synchronous changes before
    // yielding so annotation capture never changes the preview's live controls.
    restore();
  }
  return new CanvasRenderer(context,{backgroundColor:0xffffffff,x:options.x,y:options.y,width:options.width,height:options.height,scale:options.scale??1}).render(root);
}
