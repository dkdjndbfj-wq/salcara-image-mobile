import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/components/rich-renderer-assets');
await mkdir(out, { recursive: true });
let css = await readFile(path.join(root, 'node_modules/katex/dist/katex.min.css'), 'utf8');
// Ship only WOFF2; current Android WebView, iOS WKWebView and browsers support it.
css = css.replace(/src:[^;]+;/g, value => {
  const source = value.match(/url\(([^)]+\.woff2)\)\s*format\([^)]+\)/);
  return source ? `src:${source[0]};` : value;
});
for (const match of [...css.matchAll(/url\(([^)]+\.woff2)\)/g)]) {
  const bytes = await readFile(path.join(root, 'node_modules/katex/dist', match[1]));
  css = css.replace(match[0], `url(data:font/woff2;base64,${bytes.toString('base64')})`);
}
await writeFile(path.join(out, 'katex-css.json'), JSON.stringify({ css }));
const script = (await readFile(path.join(root, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8')).replace(/\/\/# sourceMappingURL=.*$/gm, '');
await writeFile(path.join(out, 'mermaid-script.json'), JSON.stringify({ script }));
for (const name of ['katex', 'mermaid']) {
  const pkg = JSON.parse(await readFile(path.join(root, `node_modules/${name}/package.json`), 'utf8'));
  let license;
  for (const filename of ['LICENSE', 'LICENSE.txt']) {
    try { license = await readFile(path.join(root, `node_modules/${name}/${filename}`), 'utf8'); break; } catch {}
  }
  await writeFile(path.join(out, `${name}-LICENSE.txt`), `${name} ${pkg.version}\n${license ?? 'MIT; see package repository.'}\n`);
}
console.log('Generated local KaTeX fonts/styles and Mermaid browser runtime.');
