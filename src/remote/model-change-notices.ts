import { getSetting, setSetting } from '../storage/database';
import type { ConversationBlock, Block } from './blocks';
import type { TimelineItem } from './store';

/** On-device composer choices, never Hub events or assistant messages. */
export interface ModelChangeRecord { id: string; from: string; to: string; ts: number; afterBlockId: string; afterItemId?: string }
export type ModelChangeNotice = Extract<TimelineItem, { kind: 'notice' }> & { localModelChange: ModelChangeRecord };
const SETTING = 'remote_model_changes_v1', MAX_RECORDS = 80, MAX_SCOPES = 120;
let edits: Promise<unknown> = Promise.resolve(), sequence = 0;
const validText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
const validRecord = (value: unknown): value is ModelChangeRecord => {
  if (!value || typeof value !== 'object') return false;
  const item = value as ModelChangeRecord;
  return validText(item.id, 128) && validText(item.from, 200) && validText(item.to, 200) && item.from !== item.to
    && Number.isFinite(item.ts) && item.ts > 0 && validText(item.afterBlockId, 2048)
    && (item.afterItemId === undefined || validText(item.afterItemId, 2048));
};
async function read(): Promise<Record<string, ModelChangeRecord[]>> {
  const text = await getSetting(SETTING);
  if (!text) return {};
  if (text.length > 8_000_000) throw new Error('模型切换记录过大');
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('模型切换记录无效');
  const result: Record<string, ModelChangeRecord[]> = {};
  for (const [key, values] of Object.entries(raw).slice(-MAX_SCOPES)) {
    if (key.length <= 8192 && Array.isArray(values)) result[key] = values.filter(validRecord).slice(-MAX_RECORDS);
  }
  return result;
}
export async function loadModelChanges(scope: string): Promise<ModelChangeRecord[]> { await edits; return (await read())[scope] ?? []; }
export function appendModelChange(scope: string, record: ModelChangeRecord): Promise<ModelChangeRecord[]> {
  if (!validText(scope, 8192) || !validRecord(record)) return Promise.reject(new Error('模型切换记录来源无效'));
  const run = edits.then(async () => {
    const table = await read(), previous = table[scope] ?? [];
    const next = [...previous.filter(item => item.id !== record.id), record].slice(-MAX_RECORDS);
    delete table[scope]; table[scope] = next;
    await setSetting(SETTING, JSON.stringify(Object.fromEntries(Object.entries(table).slice(-MAX_SCOPES))));
    return next;
  });
  edits = run.catch(() => undefined);
  return run;
}
function blockItemKeys(block: ConversationBlock | Block): string[] {
  if (block.type === 'activity') return block.parts.flatMap(blockItemKeys);
  if (block.type === 'work') return block.items.map(item => `${item.kind}:${item.id}`);
  return [`${block.item.kind}:${block.item.id}`];
}
export function createModelChange(from: string, to: string, blocks: readonly ConversationBlock[], now = Date.now()): ModelChangeRecord | undefined {
  if (!validText(from, 200) || !validText(to, 200) || from === to || !blocks.length) return;
  const anchor = blocks[blocks.length - 1], keys = blockItemKeys(anchor);
  return { id: `model-change:${now.toString(36)}:${(++sequence).toString(36)}`, from, to, ts: now,
    afterBlockId: anchor.id, afterItemId: keys[keys.length - 1] };
}
export function isModelChangeNotice(item: TimelineItem): item is ModelChangeNotice {
  return item.kind === 'notice' && 'localModelChange' in item && validRecord(item.localModelChange);
}
/** Merge after native grouping, keeping notices out of protocol and native history payloads. */
export function withModelChanges(blocks: readonly ConversationBlock[], records: readonly ModelChangeRecord[]): ConversationBlock[] {
  const byAnchor = new Map<number, ModelChangeRecord[]>();
  for (const record of records) {
    let index = blocks.findIndex(block => block.id === record.afterBlockId);
    if (index < 0 && record.afterItemId) index = blocks.findIndex(block => blockItemKeys(block).includes(record.afterItemId!));
    // A history page without the anchor must not display an old choice at its tail.
    if (index < 0) continue;
    byAnchor.set(index, [...(byAnchor.get(index) ?? []), record]);
  }
  return blocks.flatMap((block, index) => [block, ...(byAnchor.get(index) ?? []).map(record => ({ type: 'notice' as const, id: record.id,
    item: { kind: 'notice' as const, id: record.id, level: 'info' as const, text: `模型已从 ${record.from} 更改为 ${record.to}。`, ts: record.ts / 1000, localModelChange: record } }))]);
}
