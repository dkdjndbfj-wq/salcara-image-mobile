/** Heavy render engines load only when a message actually contains a formula
 * or diagram. Assets are local and never fetched from a third-party CDN. */
export async function loadMathRenderer() {
 const [engine,styles]=await Promise.all([import('katex'),import('./rich-renderer-assets/katex-css.json')]);
 return {engine:engine.default,css:styles.css};
}
export async function loadDiagramRenderer() {
 return (await import('./rich-renderer-assets/mermaid-script.json')).script;
}
