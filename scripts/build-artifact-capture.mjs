import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const version=JSON.parse(await readFile(new URL('../node_modules/html2canvas/package.json',import.meta.url),'utf8')).version;
if(version!=='1.4.1')throw Error('Review capture adapter before upgrading html2canvas');
const result=await build({entryPoints:[fileURLToPath(new URL('./artifact-capture-runtime.js',import.meta.url))],bundle:true,platform:'browser',format:'iife',globalName:'SalcaraCapture',minify:true,write:false,target:'es2020'});
await writeFile(new URL('../src/components/artifact-renderer-assets/html2canvas.json',import.meta.url),JSON.stringify({version,script:result.outputFiles[0].text}));
await writeFile(new URL('../src/components/artifact-renderer-assets/html2canvas-LICENSE.txt',import.meta.url),await readFile(new URL('../node_modules/html2canvas/LICENSE',import.meta.url)));
