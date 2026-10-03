/**
 * Small helpers for the native Markdown renderer: readable math and light
 * code colouring. Both are plain text transforms, so they stay fast while a
 * reply streams and need no web view.
 */

// ——— Math ———

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
  ll: '≪', gg: '≫', infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', neg: '¬', lnot: '¬',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  land: '∧', wedge: '∧', lor: '∨', vee: '∨', oplus: '⊕', otimes: '⊗', perp: '⊥', parallel: '∥', angle: '∠', triangle: '△',
  sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', sqrt: '√',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  implies: '⇒', iff: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
  cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱', prime: '′', degree: '°', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ',
  aleph: 'ℵ', therefore: '∴', because: '∵', mid: '∣', vert: '|', lvert: '|', rvert: '|', Vert: '‖', lVert: '‖', rVert: '‖',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', backslash: '\\',
  quad: '  ', qquad: '    ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ',
  '{': '{', '}': '}', '%': '%', '$': '$', '&': '&', '#': '#', '_': '_',
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc', arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', log: 'log', ln: 'ln', lg: 'lg', exp: 'exp', lim: 'lim', max: 'max', min: 'min',
  sup: 'sup', inf: 'inf', det: 'det', gcd: 'gcd', deg: 'deg', dim: 'dim', ker: 'ker', arg: 'arg', mod: 'mod', bmod: 'mod',
};
const DROP = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'displaystyle', 'textstyle', 'limits', 'nolimits']);
const WRAPPERS = new Set(['text', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathcal', 'mathbb', 'mathfrak', 'textbf', 'textit', 'operatorname', 'boldsymbol', 'bm', 'mbox', 'rm']);
const ACCENTS: Record<string, string> = { hat: '̂', bar: '̄', overline: '̅', vec: '⃗', dot: '̇', ddot: '̈', tilde: '̃', widehat: '̂', widetilde: '̃' };
const SUP: Record<string, string> = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ', y: 'ʸ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', k: 'ᵏ', m: 'ᵐ', t: 'ᵗ', T: 'ᵀ', '′': '′', '*': '*' };
const SUB: Record<string, string> = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', n: 'ₙ', m: 'ₘ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', x: 'ₓ', u: 'ᵤ', v: 'ᵥ' };

/** One `{...}` group (or a single token) starting at `i`; returns its raw text and where it ends. */
function readGroup(src: string, i: number): [string, number] {
  while (src[i] === ' ') i += 1;
  if (src[i] === '{') {
    let depth = 0;
    for (let j = i; j < src.length; j += 1) {
      if (src[j] === '\\') { j += 1; continue; }
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') { depth -= 1; if (depth === 0) return [src.slice(i + 1, j), j + 1]; }
    }
    return [src.slice(i + 1), src.length];
  }
  if (src[i] === '\\') {
    const name = src.slice(i + 1).match(/^([A-Za-z]+|.)/)?.[1] ?? '';
    return [`\\${name}`, i + 1 + name.length];
  }
  return [src[i] ?? '', i + 1];
}

function script(text: string, table: Record<string, string>, mark: string): string {
  const chars = [...text];
  if (chars.length && chars.every((ch) => table[ch])) return chars.map((ch) => table[ch]).join('');
  return chars.length === 1 ? `${mark}${text}` : `${mark}(${text})`;
}

const needsParens = (text: string) => !/^[\w.′]+$|^\(.*\)$|^[α-ωΑ-Ω]$/.test(text);

/** LaTeX as readable plain text: “\frac{a}{b}” → “a/b”, “x^2” → “x²”, “\alpha” → “α”. */
export function texToText(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      if (src[i + 1] === '\\') { out += '\n'; i += 2; continue; }
      const name = src.slice(i + 1).match(/^([A-Za-z]+|.)/)?.[1] ?? '';
      i += 1 + name.length;
      if (DROP.has(name)) continue;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [top, a] = readGroup(src, i); const [bottom, b] = readGroup(src, a); i = b;
        const n = texToText(top); const d = texToText(bottom);
        out += `${needsParens(n) ? `(${n})` : n}/${needsParens(d) ? `(${d})` : d}`;
        continue;
      }
      if (name === 'sqrt') {
        let degree = '';
        if (src[i] === '[') { const end = src.indexOf(']', i); degree = src.slice(i + 1, end < 0 ? src.length : end); i = end < 0 ? src.length : end + 1; }
        const [body, next] = readGroup(src, i); i = next;
        const inner = texToText(body);
        out += `${degree ? script(texToText(degree), SUP, '^') : ''}√${needsParens(inner) ? `(${inner})` : inner}`;
        continue;
      }
      if (WRAPPERS.has(name)) { const [body, next] = readGroup(src, i); i = next; out += name === 'text' || name === 'mbox' ? body : texToText(body); continue; }
      if (ACCENTS[name]) { const [body, next] = readGroup(src, i); i = next; const inner = texToText(body); out += [...inner].length === 1 ? inner + ACCENTS[name] : inner; continue; }
      if (name === 'begin' || name === 'end') { const [, next] = readGroup(src, i); i = next; out += name === 'begin' ? '' : ''; continue; }
      out += SYMBOLS[name] ?? name;
      continue;
    }
    if (ch === '^' || ch === '_') {
      const [body, next] = readGroup(src, i + 1); i = next;
      out += script(texToText(body), ch === '^' ? SUP : SUB, ch);
      continue;
    }
    if (ch === '{' || ch === '}') { i += 1; continue; }
    if (ch === '&') { out += ' '; i += 1; continue; }
    if (ch === '~') { out += ' '; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out.replace(/[ \t]{2,}/g, (spaces) => (spaces.length >= 4 ? '    ' : ' ')).replace(/ *\n */g, '\n').trim();
}

/**
 * Display math blocks (`$$…$$` or `\[…\]`, alone on their lines) become their own
 * segments; everything else stays text. Returned segments alternate kind.
 */
export function splitDisplayMath(text: string): Array<{ math: boolean; text: string }> {
  const out: Array<{ math: boolean; text: string }> = [];
  const re = /(^|\n)[ \t]*(\$\$|\\\[)([\s\S]+?)(\$\$|\\\])[ \t]*(?=\n|$)/g;
  let last = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    if ((match[2] === '$$') !== (match[4] === '$$')) continue;
    const start = match.index + match[1].length;
    if (start > last) out.push({ math: false, text: text.slice(last, start) });
    out.push({ math: true, text: match[3].trim() });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ math: false, text: text.slice(last) });
  return out.length ? out : [{ math: false, text }];
}

/** Inline math: `$…$` (not prices like “$5 and $6”) and `\(…\)`. */
export const INLINE_MATH = /\\\((?:[^\\]|\\(?!\)))+?\\\)|\$(?![\s\d])[^$\n]+?(?<![\s\\])\$(?!\d)/;

export function inlineMathBody(part: string): string | null {
  if (part.startsWith('\\(') && part.endsWith('\\)')) return part.slice(2, -2);
  if (part.length > 2 && part.startsWith('$') && part.endsWith('$') && !part.startsWith('$$')) return part.slice(1, -1);
  return null;
}

// ——— Code ———

export type CodeTokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number';
export interface CodeToken { kind: CodeTokenKind; text: string }

const KEYWORDS = new Set(`
  abstract and as assert async await break case catch class const continue def default defer del do elif else enum except export extends
  false final finally fn for from func function go if impl implements import in instanceof interface is lambda let loop match mod module
  mut namespace new nil none None not null of or package pass private protected pub public raise readonly return self Self static struct
  super switch this throw throws trait true True False try type typeof undefined union unsafe use using val var void where while with yield
  int float double char bool boolean string str long short byte unsigned signed auto echo fi then esac done local select insert update
  delete create table values set join on group by order having limit
`.trim().split(/\s+/));
const HASH_COMMENT = new Set(['python', 'py', 'bash', 'sh', 'shell', 'zsh', 'ruby', 'rb', 'yaml', 'yml', 'toml', 'r', 'perl', 'powershell', 'ps1', 'dockerfile', 'makefile', 'ini', 'conf', 'elixir']);
const NO_COLOR = new Set(['text', 'txt', 'plain', 'plaintext', 'output', 'log', 'console', 'markdown', 'md', 'csv']);

/** A light, language-agnostic pass: comments, strings, numbers and common keywords. */
export function highlightCode(code: string, language: string): CodeToken[] {
  const lang = language.trim().toLowerCase();
  if (NO_COLOR.has(lang) || code.length > 20_000) return [{ kind: 'plain', text: code }];
  const hash = HASH_COMMENT.has(lang);
  const sqlLike = lang === 'sql' || lang === 'lua' || lang === 'haskell' || lang === 'hs';
  const comment = hash ? '#[^\\n]*' : sqlLike ? '--[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)';
  const pattern = new RegExp(`(${comment}${hash || sqlLike ? '' : '|<!--[\\s\\S]*?(?:-->|$)'})|("""[\\s\\S]*?(?:"""|$)|'''[\\s\\S]*?(?:'''|$)|"(?:[^"\\\\\\n]|\\\\.)*"?|'(?:[^'\\\\\\n]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\.)*\`?)|(\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b)|([A-Za-z_][\\w]*)`, 'g');
  const tokens: CodeToken[] = [];
  let last = 0;
  const push = (kind: CodeTokenKind, text: string) => {
    const previous = tokens[tokens.length - 1];
    if (previous && previous.kind === kind) previous.text += text;
    else tokens.push({ kind, text });
  };
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    if (match.index > last) push('plain', code.slice(last, match.index));
    const [whole, isComment, isString, isNumber, word] = match;
    if (isComment) push('comment', whole);
    else if (isString) push('string', whole);
    else if (isNumber) push('number', whole);
    else push(word && (KEYWORDS.has(word) || (sqlLike && KEYWORDS.has(word.toLowerCase()))) ? 'keyword' : 'plain', whole);
    last = pattern.lastIndex;
  }
  if (last < code.length) push('plain', code.slice(last));
  return tokens;
}
