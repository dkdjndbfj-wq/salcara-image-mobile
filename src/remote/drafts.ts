import { getSetting, setSetting } from '../storage/database';

const SETTING = 'remote_drafts_v1';
let edits: Promise<unknown> = Promise.resolve();
async function read(): Promise<Record<string, string>> {
  try {
    const raw: unknown = JSON.parse(await getSetting(SETTING) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) => key.length <= 2048 && typeof value === 'string' && value.length <= 100_000).slice(-50));
  } catch { return {}; }
}
export async function loadRemoteDraft(key: string): Promise<string> { await edits; return (await read())[key] ?? ''; }
export function saveRemoteDraft(key: string, text: string): Promise<void> {
  const run = edits.then(async () => {
    const drafts = await read();
    delete drafts[key];
    if (text) drafts[key] = text.slice(0, 100_000);
    await setSetting(SETTING, JSON.stringify(Object.fromEntries(Object.entries(drafts).slice(-50))));
  });
  edits = run.catch(() => undefined);
  return run;
}
