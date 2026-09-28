import type { MemLink, MemNote } from './types';

/**
 * Local retrieval without any server: a tokenizer that works for Chinese
 * (character bigrams) and Latin text (words), BM25 scoring, optional
 * embedding similarity, one to two hops along links (spreading activation,
 * as in HippoRAG) and the recency × importance × relevance blend of
 * Generative Agents.
 */

const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;
const STOP = new Set(['的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '和', '也', '就', '都', '吗', '呢', '吧', '啊', 'the', 'a', 'an', 'is', 'to', 'of', 'and', 'in', 'i', 'you']);

/** Latin/digit words plus overlapping CJK bigrams (single CJK characters when isolated). */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  let run = '';
  const flushRun = () => {
    if (!run) return;
    if (run.length === 1) { if (!STOP.has(run)) tokens.push(run); } else for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2));
    run = '';
  };
  let word = '';
  const flushWord = () => { if (word && ((!STOP.has(word) && word.length > 1) || /^\d+$/.test(word))) tokens.push(word); word = ''; };
  for (const char of lower) {
    if (CJK.test(char)) { flushWord(); run += char; }
    else if (/[a-z0-9]/.test(char)) { flushRun(); word += char; }
    else { flushRun(); flushWord(); }
  }
  flushRun();
  flushWord();
  return tokens;
}

export function noteText(note: Pick<MemNote, 'title' | 'content' | 'tags'>): string {
  return `${note.title} ${note.title} ${note.content} ${note.tags.join(' ')}`;
}

/** BM25 scores of every document for the query. */
export function bm25(query: string, documents: string[][], k1 = 1.4, b = 0.75): number[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !documents.length) return documents.map(() => 0);
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
  const frequency = new Map<string, number>();
  const counts = documents.map((doc) => {
    const map = new Map<string, number>();
    for (const token of doc) map.set(token, (map.get(token) ?? 0) + 1);
    for (const term of terms) if (map.has(term)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    return map;
  });
  return counts.map((map, index) => {
    let score = 0;
    for (const term of terms) {
      const tf = map.get(term) ?? 0;
      if (!tf) continue;
      const df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * documents[index].length / average));
    }
    return score;
  });
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let index = 0; index < a.length; index += 1) { dot += a[index] * b[index]; na += a[index] * a[index]; nb += b[index] * b[index]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface RetrieveOptions {
  query: string;
  queryEmbedding?: number[] | null;
  embeddingModel?: string | null;
  limit?: number;
  now?: number;
  /** Leave these out (e.g. already in the prompt). */
  exclude?: Set<string>;
  includeEpisodes?: boolean;
  includeOutdated?: boolean;
}

export interface Scored { note: MemNote; score: number; relevance: number; via?: string }

const DAY = 86_400_000;

/** Ranks a character's notes for a query. */
export function retrieve(notes: MemNote[], links: MemLink[], options: RetrieveOptions): Scored[] {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 10;
  const candidates = notes.filter((note) => !options.exclude?.has(note.id)
    && (options.includeEpisodes || note.type !== 'episode')
    && (options.includeOutdated || note.validTo === null));
  if (!candidates.length) return [];
  const lexical = bm25(options.query, candidates.map((note) => tokenize(noteText(note))));
  const maxLexical = Math.max(...lexical, 0);
  const vector = candidates.map((note) => (options.queryEmbedding && note.embedding && (!options.embeddingModel || note.embeddingModel === options.embeddingModel)
    ? Math.max(0, cosine(options.queryEmbedding, note.embedding)) : 0));
  const haveVectors = vector.some((value) => value > 0);
  const scored: Scored[] = candidates.map((note, index) => {
    const lex = maxLexical > 0 ? lexical[index] / maxLexical : 0;
    // Embedding similarity of unrelated text sits around 0.1–0.3; stretch the useful range.
    const vec = haveVectors ? Math.max(0, (vector[index] - 0.2) / 0.6) : 0;
    const relevance = haveVectors ? 0.6 * vec + 0.4 * lex : lex;
    const age = Math.max(0, now - (note.lastAccessedAt ?? note.updatedAt ?? note.createdAt)) / DAY;
    const recency = Math.exp(-age / 30);
    const score = relevance > 0.05 || note.pinned
      ? relevance + 0.3 * (note.importance / 10) + 0.2 * recency + (note.pinned ? 0.3 : 0) - (note.validTo !== null ? 0.6 : 0)
      : 0;
    return { note, score, relevance };
  }).filter((item) => item.score > 0);
  scored.sort((a, b) => b.score - a.score);

  // Spreading activation: strong hits pull in their neighbours.
  const byId = new Map(candidates.map((note) => [note.id, note]));
  const result = new Map(scored.slice(0, limit).map((item) => [item.note.id, item]));
  for (const seed of scored.slice(0, 5)) {
    for (const link of links) {
      const other = link.source === seed.note.id ? link.target : link.target === seed.note.id ? link.source : null;
      if (!other || result.has(other)) continue;
      const neighbour = byId.get(other);
      if (!neighbour) continue;
      const score = seed.score * 0.45 * Math.min(1, link.weight) + 0.1 * (neighbour.importance / 10);
      result.set(other, { note: neighbour, score, relevance: 0, via: seed.note.id });
    }
  }
  return [...result.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Notes connected to `id` (both directions), with the link that connects them. */
export function neighbours(id: string, notes: MemNote[], links: MemLink[]): Array<{ note: MemNote; link: MemLink; outgoing: boolean }> {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const out: Array<{ note: MemNote; link: MemLink; outgoing: boolean }> = [];
  for (const link of links) {
    if (link.source === id && byId.has(link.target)) out.push({ note: byId.get(link.target)!, link, outgoing: true });
    else if (link.target === id && byId.has(link.source)) out.push({ note: byId.get(link.source)!, link, outgoing: false });
  }
  return out;
}
