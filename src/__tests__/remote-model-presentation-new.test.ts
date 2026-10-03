import { buildModelPresentation, modelDisplayLabel } from '../remote/model-presentation';

const rows = (ids: readonly string[], labels: readonly string[]) => ids.map((id, index) => ({ id, label: labels[index] }));

describe('one API catalog model presentation', () => {
  test.each([
    { name: 'Claude variants', ids: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], family: 'Claude', labels: ['opus-5-5', 'sonnet-5-5', 'haiku-5-5'] },
    { name: 'version before Claude tier', ids: ['claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-latest'], family: 'Claude', labels: ['3-5-sonnet-20241022', '3-7-sonnet-latest'] },
    { name: 'legacy Claude names', ids: ['claude-2.1', 'claude-instant-1.2'], family: 'Claude', labels: ['2.1', 'instant-1.2'] },
    { name: 'known latest tier alias', ids: ['claude-opus-latest'], family: 'Claude', labels: ['opus-latest'] },
    { name: 'preserved version punctuation', ids: ['claude-opus-5.5', 'claude-sonnet-5-5'], family: 'Claude', labels: ['opus-5.5', 'sonnet-5-5'] },
    { name: 'preserved original case', ids: ['Claude-Opus-5-5', 'CLAUDE-SONNET-5-5'], family: 'Claude', labels: ['Opus-5-5', 'SONNET-5-5'] },
    { name: 'known vendor namespace', ids: ['anthropic/claude-opus-5-5', 'ANTHROPIC/Claude-Sonnet-5-5'], family: 'Claude', labels: ['opus-5-5', 'Sonnet-5-5'] },
    { name: 'namespaced and direct variants', ids: ['anthropic/claude-opus-5-5', 'claude-sonnet-5-5'], family: 'Claude', labels: ['opus-5-5', 'sonnet-5-5'] },
    { name: 'GPT numeric models', ids: ['gpt-5.5-codex', 'openai/gpt-4o-mini'], family: 'GPT', labels: ['5.5-codex', '4o-mini'] },
    { name: 'Gemini numeric models', ids: ['gemini-2.5-pro', 'google/gemini-2.5-flash-lite'], family: 'Gemini', labels: ['2.5-pro', '2.5-flash-lite'] },
  ])('$name', ({ ids, family, labels }) => {
    expect(buildModelPresentation(ids)).toEqual({ familyLabel: family, items: rows(ids, labels) });
    ids.forEach((id, index) => expect(modelDisplayLabel(id, ids)).toBe(labels[index]));
  });

  test.each([
    'claude-opus-5-5-20260930',
    'claude-opus-5-5-latest',
    'claude-opus-5-5-preview',
    'claude-opus-5-5-thinking',
    'claude-opus-5-5-fast',
    'claude-opus-5-5-200k',
    'claude-opus-5-5-1m',
    'claude-opus-5-5-context-1m',
    'claude-opus-5-5-1m-context',
    'claude-opus-5-5[1m]',
    'claude-opus-5-5:thinking',
    'claude-opus-5-5-fast[1m]:thinking',
    'claude-opus-5-5-20260930-preview-thinking-fast-200k',
    'CLAUDE-OPUS-5-5-PREVIEW-THINKING-FAST-1M',
  ])('retains every byte after the family prefix in %s', (id) => {
    expect(buildModelPresentation([id])).toEqual({ familyLabel: 'Claude', items: [{ id, label: id.slice('claude-'.length) }] });
  });

  test.each([
    ['claude-opus-5-5', 'gpt-5.5'],
    ['anthropic/claude-sonnet-5-5', 'google/gemini-2.5-pro'],
    ['claude-opus-5-5', 'openai/o3'],
    ['claude-opus-5-5', 'unknown-model'],
    ['claude-opus-5-5', 'opus-5-5'],
    ['claude-opus-5-5', 'claude-custom'],
  ])('retains full IDs when the catalog mixes families or aliases: %j', (...ids: string[]) => {
    expect(buildModelPresentation(ids)).toEqual({ familyLabel: null, items: rows(ids, ids) });
  });

  test.each([
    'not-claude-opus-5-5', 'xclaude-opus-5-5', 'claudeish-opus-5-5', 'claude',
    'claude-', 'claude-opus', 'claude-sonnet-new', 'claude-opus-5-5-custom',
    'claude-opus-5-5/latest', 'anthropic/claude-custom', 'anthropic//claude-opus-5-5',
    'my-deployment/claude-opus-5-5', 'openai/claude-opus-5-5', 'models/claude-opus-5-5',
    'projects/acme/locations/us/models/claude-opus-5-5', 'custom/anthropic/claude-opus-5-5',
    'anthropic.claude-opus-5-5-v1:0', 'anthropic:claude-opus-5-5',
    'https://example.test/claude-opus-5-5', 'C:\\deployments\\claude-opus-5-5',
    ' Claude-opus-5-5', 'claude-opus-5-5 ', 'claude-opus-5-5\n',
    'gpt-fixture', 'custom-gpt-5.5', 'gptish-5.5', 'gpt-5.5-custom',
    'gemini-custom', 'my-gemini-2.5-pro', 'geminilike-2.5-pro', 'gemini-2.5-pro-custom',
    '', 'unknown',
  ])('preserves unknown, misleading or resource ID %j', (id) => {
    expect(buildModelPresentation([id])).toEqual({ familyLabel: null, items: [{ id, label: id }] });
    expect(buildModelPresentation(['claude-opus-5-5', id]).familyLabel).toBeNull();
  });

  test.each([
    ['claude-opus-5-5', 'anthropic/claude-opus-5-5'],
    ['anthropic/claude-opus-5-5', 'Anthropic/claude-opus-5-5'],
    ['claude-opus-5-5', 'Claude-Opus-5-5'],
  ])('disambiguates every shortened collision with its full ID: %j', (...ids: string[]) => {
    expect(buildModelPresentation(ids)).toEqual({ familyLabel: 'Claude', items: rows(ids, ids) });
    ids.forEach((id) => expect(modelDisplayLabel(id, ids)).toBe(id));
  });

  test('only colliding items need full IDs', () => {
    const ids = ['claude-opus-5-5', 'anthropic/claude-opus-5-5', 'claude-sonnet-5-5'];
    expect(buildModelPresentation(ids)).toEqual({ familyLabel: 'Claude', items: rows(ids, [ids[0], ids[1], 'sonnet-5-5']) });
  });

  test.each([
    ['provider-a/claude-opus-5-5', 'provider-b/claude-opus-5-5'],
    ['anthropic/claude-opus-5-5', 'custom/claude-opus-5-5'],
    ['anthropic/claude-opus-5-5', 'openai/claude-opus-5-5'],
  ])('keeps cross-namespace names distinct when a namespace is not known: %j', (...ids: string[]) => {
    expect(buildModelPresentation(ids)).toEqual({ familyLabel: null, items: rows(ids, ids) });
  });

  test('deduplicates only identical raw IDs, retaining first occurrence order and input', () => {
    const ids = Object.freeze(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(buildModelPresentation(ids)).toEqual({ familyLabel: 'Claude', items: rows(ids.slice(0, 2), ['sonnet-5-5', 'opus-5-5']) });
    expect(ids).toHaveLength(4);
    expect(buildModelPresentation(['unknown', 'unknown', ''])).toEqual({ familyLabel: null, items: rows(['unknown', ''], ['unknown', '']) });
  });

  test('an empty catalog has no inferred family', () => {
    expect(buildModelPresentation([])).toEqual({ familyLabel: null, items: [] });
    expect(modelDisplayLabel('claude-opus-5-5', [])).toBe('claude-opus-5-5');
  });

  test('pathological long aliases bypass pattern parsing without rewriting IDs', () => {
    const id = `claude-opus-${Array(2000).fill('1234').join('-')}-thanking`;
    expect(buildModelPresentation([id])).toEqual({ familyLabel: null, items: rows([id], [id]) });
  });

  test.each(['gpt-5.5', 'claude-haiku-5-5', 'anthropic/claude-opus-5-5', 'custom-deployment', ''])('an absent selected model %j cannot join or alter the directory', (id) => {
    const ids = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(modelDisplayLabel(id, ids)).toBe(id);
    expect(buildModelPresentation(ids)).toEqual({ familyLabel: 'Claude', items: rows(ids, ['opus-5-5', 'sonnet-5-5']) });
  });
});
