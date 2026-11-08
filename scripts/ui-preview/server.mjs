// Development-only preview of the actual React Native UI. Native storage and
// paid services are replaced with local fixtures; no production entry imports it.
import { context } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.cwd();
const local = (file) => resolve(root, 'scripts/ui-preview', file);
const previewPort=Number(process.env.SALCARA_PREVIEW_PORT||4173);
const output = resolve(root, previewPort===4173?'output/ui-preview':`output/ui-preview-${previewPort}`);
mkdirSync(output, { recursive: true });
const bundle = await context({
  entryPoints: [local('entry.jsx')], outfile: resolve(output, 'bundle.js'), bundle: true,
  platform: 'browser', jsx: 'automatic', sourcemap: true,
  define: { __DEV__: 'false', 'process.env.NODE_ENV': '"development"' },
  loader: { '.png': 'dataurl', '.webp': 'dataurl', '.ttf': 'file' },
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
  plugins: [{ name: 'native-preview-fixtures', setup(build) {
    build.onResolve({ filter: /^react-native$/ }, () => ({ path: local('react-native.jsx') }));
    build.onResolve({ filter: /^\.\/direct-pairing$/ }, args => args.importer.replaceAll('\\','/').endsWith('/remote/RemoteComputers.tsx') ? {path:local('computer-pairings.jsx')} : undefined);
    build.onResolve({ filter: /^expo-file-system\/legacy$/ }, args => /\/(?:queued-image-files|composer-drafts|drafts|canvas-image-input)\.ts$/.test(args.importer.replaceAll('\\','/')) ? {path:local('image-filesystem.jsx')} : undefined);
    build.onResolve({ filter: /(?:^|\/)state\/AppContext$/ }, () => ({ path: local('state.jsx') }));
    build.onResolve({ filter: /^\.\/store$/ }, (args) => args.importer.replaceAll('\\', '/').includes('/src/remote/') ? ({ path: local('remote-store.jsx') }) : undefined);
    build.onResolve({ filter: /(?:^|\/)(document-inputs|image-inputs|api\/chat-api|api\/network|storage\/(files|database|secure-keys))$/ }, () => ({ path: local('services.jsx') }));
    build.onResolve({ filter: /^(@expo\/vector-icons|expo-crypto|expo-clipboard|expo-application|expo\/fetch)$/ }, (args) => ({ path: local(args.path === '@expo/vector-icons' ? 'icons.jsx' : 'services.jsx') }));
    build.onResolve({ filter: /(?:^|\/)components\/(UpdateManager|MaskEditor)$/ }, () => ({ path: local('native-tools.jsx') }));
    build.onResolve({ filter: /^\.\/(UpdateManager|MaskEditor)$/ }, () => ({ path: local('native-tools.jsx') }));
    build.onResolve({ filter: /^react-native-reanimated$/ }, () => ({ path: local('animation.jsx') }));
    build.onResolve({ filter: /^react-native-gesture-handler$/ }, () => ({ path: local('gestures.jsx') }));
    build.onResolve({ filter: /^react-native-draggable-flatlist$/ }, () => ({ path: local('drag-list.jsx') }));
  } }],
});
await bundle.watch();
// Recover missing generated output instead of leaving the open page blank.
let rebuilding;
const ensureBundle=()=>rebuilding??(rebuilding=bundle.rebuild().finally(()=>{rebuilding=undefined;}));
await ensureBundle();
const font = resolve(root, 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.ttf');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Salcara · 本地界面预览</title><style>@font-face{font-family:Ionicons;src:url('/icons.ttf')}html,body,#root{height:100%;margin:0;background:white}#root{display:flex}*{box-sizing:border-box}body,div,input,textarea{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}input,textarea{outline:none}</style><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script>globalThis.process={env:{NODE_ENV:'development'}};globalThis.global=globalThis;</script><script src="/bundle.js"></script></html>`;
createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/icons.ttf') { response.setHeader('Content-Type', 'font/ttf'); response.end(readFileSync(font)); }
  else if (path === '/preview-image.svg') { response.setHeader('Content-Type', 'image/svg+xml'); response.end(readFileSync(local('preview-image.svg'))); }
  else if (path === '/bundle.css') { response.setHeader('Content-Type', 'text/css'); response.end(existsSync(resolve(output,'bundle.css'))?readFileSync(resolve(output,'bundle.css')):''); }
  else if (path === '/bundle.js' || path === '/bundle.js.map') { response.setHeader('Content-Type', path.endsWith('.map') ? 'application/json' : 'text/javascript'); const file=resolve(output,path.slice(1));try{if(!existsSync(file))await ensureBundle();response.end(readFileSync(file));}catch{response.statusCode=503;response.end('Preview build is still preparing.');} }
  else { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); }
}).listen(previewPort, '127.0.0.1', () => console.log(`Actual UI preview: http://127.0.0.1:${previewPort} (local fixtures; no API calls)`));
