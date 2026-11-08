import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/components/artifact-renderer-assets');
await mkdir(out, { recursive: true });
for (const [name, file, globalName] of [['pdf', 'pdf.mjs', 'PDFJS'], ['pdf-worker', 'pdf.worker.mjs', 'pdfjsWorker']]) {
  const result = await build({ entryPoints: [path.join(root, 'node_modules/pdfjs-dist/legacy/build', file)], bundle: true, write: false, format: 'iife', globalName, platform: 'browser', target: ['es2022'], minify: true, legalComments: 'none' });
  await writeFile(path.join(out, `${name}.json`), JSON.stringify({ script: result.outputFiles[0].text }));
}
const pkg = JSON.parse(await readFile(path.join(root, 'node_modules/pdfjs-dist/package.json'), 'utf8'));
await writeFile(path.join(out, 'pdfjs-LICENSE.txt'), `pdfjs-dist ${pkg.version}\n${await readFile(path.join(root, 'node_modules/pdfjs-dist/LICENSE'), 'utf8')}`);
console.log('Bundled local PDF renderer and main-thread worker, with no network dependencies.');
