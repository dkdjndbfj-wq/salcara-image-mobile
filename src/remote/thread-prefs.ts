import { getSetting, setSetting } from '../storage/database';
import type { Effort } from './client';
import { isEffort } from './effort';

/**
 * The model and reasoning effort picked inside a thread stay picked for that
 * thread (like the model menu in Codex), until changed again.
 */
export interface ThreadPrefs { model?: string; effort?: Effort; apiIdentity?: string }

const SETTING = 'remote_thread_prefs_v1';
let edits: Promise<unknown> = Promise.resolve();

async function read(): Promise<Record<string, ThreadPrefs>> {
  try {
    const raw: unknown = JSON.parse(await getSetting(SETTING) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, ThreadPrefs> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(-200)) {
      if (key.length > 2048 || !value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const prefs: ThreadPrefs = {};
      if (typeof item.model === 'string' && item.model.length <= 200) prefs.model = item.model;
      if (isEffort(item.effort)) prefs.effort = item.effort;
      if (typeof item.apiIdentity === 'string' && item.apiIdentity.length <= 512) prefs.apiIdentity = item.apiIdentity;
      if (prefs.model || prefs.effort || prefs.apiIdentity) out[key] = prefs;
    }
    return out;
  } catch { return {}; }
}

export async function loadThreadPrefs(key: string): Promise<ThreadPrefs> { await edits; return (await read())[key] ?? {}; }

export function saveThreadPrefs(key: string, prefs: ThreadPrefs): Promise<void> {
  const run = edits.then(async () => {
    const all = await read();
    delete all[key];
    if (prefs.model || prefs.effort || prefs.apiIdentity) all[key] = { ...(prefs.model ? { model: prefs.model } : {}), ...(prefs.effort ? { effort: prefs.effort } : {}), ...(prefs.apiIdentity ? { apiIdentity: prefs.apiIdentity } : {}) };
    await setSetting(SETTING, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-200))));
  });
  edits = run.catch(() => undefined);
  return run;
}
