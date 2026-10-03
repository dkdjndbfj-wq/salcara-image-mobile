/** Values accepted by the Bridge's Codex turn options, not a model capability claim. */
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = typeof CODEX_EFFORTS[number];
export const isEffort = (value: unknown): value is Effort => typeof value === 'string' && (CODEX_EFFORTS as readonly string[]).includes(value);
const LABELS: Record<Effort, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
// An omitted override follows the computer. Do not invent its effective default.
export const effortLabel = (value?: Effort | '') => value ? LABELS[value] : 'Default';

export function reportedEfforts(capability?: { source: string; reasoningKnown: boolean; reasoningEfforts?: readonly string[] }): Effort[] {
  if (capability?.source !== 'codex-model-list' || capability.reasoningKnown !== true) return [];
  return CODEX_EFFORTS.filter(value => capability.reasoningEfforts?.includes(value));
}
export function defaultSelectionEffort(capability?: Parameters<typeof reportedEfforts>[0]): Effort | '' {
  return reportedEfforts(capability).includes('low') ? 'low' : '';
}

export function reportsTextOnly(capability?: { source: string; inputModalities?: readonly string[] }): boolean {
  return capability?.source === 'codex-model-list' && capability.inputModalities?.includes('text') === true
    && !capability.inputModalities.includes('image');
}
