import { getSetting, setSetting } from '../storage/database';

/** Local reading links only. Never used for requests, receipts or authorization. */
interface PairingHistory { version: 1; connectionId: string; computerId: string; credentials: string[] }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const computer = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const historyKey = (connectionId: string, computerId: string) => `remote_side_pairing_history_v1_${connectionId}_${computerId}`;
async function read(connectionId: string, computerId: string): Promise<PairingHistory | undefined> {
  const raw = await getSetting(historyKey(connectionId, computerId));
  if (raw === null) return;
  let value: PairingHistory;
  try { value = JSON.parse(raw); } catch { throw new Error('侧问历史索引无法读取，原记录仍保留'); }
  if (!value || value.version !== 1 || value.connectionId !== connectionId || value.computerId !== computerId
    || !Array.isArray(value.credentials) || !value.credentials.every(hash) || new Set(value.credentials).size !== value.credentials.length) {
    throw new Error('侧问历史索引无法读取，原记录仍保留');
  }
  return value;
}

const mutations = new Map<string, Promise<unknown>>();
/** Enroll only a verified physical identity, including before explicit unpair.
 * Matching device labels is not enough. Normal reads and pairing may overlap. */
export function rememberSideQuestionPairing(connectionId: string, computerId: string, previous: string | undefined, next: string): Promise<void> {
  const key = historyKey(connectionId, computerId);
  const run = (mutations.get(key) ?? Promise.resolve()).then(async () => {
    if (!hash(connectionId) || !computer(computerId) || previous !== undefined && !hash(previous) || !hash(next)) throw new Error('侧问历史来源无效');
    const existing = await read(connectionId, computerId);
    const credentials = [...new Set([...(existing?.credentials ?? []), ...(previous ? [previous] : []), next])];
    if (existing && credentials.length === existing.credentials.length) return;
    await setSetting(historyKey(connectionId, computerId), JSON.stringify({ version: 1, connectionId, computerId, credentials } satisfies PairingHistory));
  });
  const settled = run.catch(() => undefined);
  mutations.set(key, settled);
  void settled.then(() => { if (mutations.get(key) === settled) mutations.delete(key); });
  return run;
}

/** Replace only the credential namespace. Session, agent, executor and API
 * identity stay exact; an old pairing can provide local text but no transport. */
export async function sideQuestionHistoryScopes(scope: string, connectionId: string, computerId?: string): Promise<string[]> {
  if (!hash(connectionId) || !computer(computerId)) return [];
  let parts: unknown;
  try { parts = JSON.parse(scope); } catch { return []; }
  if (!Array.isArray(parts) || parts.length !== 7 || typeof parts[0] !== 'string') return [];
  const prefix = `${connectionId}|credential:`, credential = parts[0].startsWith(prefix) ? parts[0].slice(prefix.length) : '';
  if (!hash(credential)) return [];
  const saved = await read(connectionId, computerId);
  if (!saved?.credentials.includes(credential)) return [];
  return saved.credentials.filter(item => item !== credential).reverse().map(item => JSON.stringify([`${prefix}${item}`, ...parts.slice(1)]));
}
