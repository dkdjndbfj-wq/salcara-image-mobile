export interface ModelPresentation {
  familyLabel: string | null;
  items: Array<{ id: string; label: string }>;
}

interface Family {
  label: string;
  prefix: string;
  namespaces: readonly string[];
  model: RegExp;
}

// Recognize names, not arbitrary aliases containing a provider's name. These
// patterns only decide whether a prefix is safe to hide; IDs are never rewritten.
const VERSION = String.raw`\d+(?:[.-]\d+)*`;
const CONTEXT = String.raw`\d+(?:\.\d+)?[km]`;
const COMMON_SUFFIX = String.raw`(?:-(?:latest|preview|thinking|fast|\d{4,8}|${CONTEXT}|context))*(?:\[${CONTEXT}\])?(?::(?:thinking|fast))?`;
const FAMILIES: readonly Family[] = [
  {
    label: 'Claude', prefix: 'claude-', namespaces: ['anthropic'],
    model: new RegExp(String.raw`^claude-(?:(?:opus|sonnet|haiku)-(?:${VERSION}|latest)|${VERSION}-(?:opus|sonnet|haiku)|instant-${VERSION}|[12](?:\.\d+)?)${COMMON_SUFFIX}$`, 'i'),
  },
  {
    label: 'GPT', prefix: 'gpt-', namespaces: ['openai'],
    model: new RegExp(String.raw`^gpt-\d+(?:\.\d+)*(?:o)?(?:-(?:turbo|mini|nano|pro|codex|chat|search|instruct|realtime|audio|image))*${COMMON_SUFFIX}$`, 'i'),
  },
  {
    label: 'Gemini', prefix: 'gemini-', namespaces: ['google'],
    model: new RegExp(String.raw`^gemini-${VERSION}-(?:pro|flash|flash-lite|ultra|nano)(?:-(?:exp|experimental|image|live|audio|native-audio))*${COMMON_SUFFIX}$`, 'i'),
  },
];

function identify(id: string): { family: Family; shortLabel: string } | null {
  // Raw IDs remain untouched. Bound pattern work for pathological long aliases.
  if (id.length > 512) return null;
  // A namespace is meaningful only when it is a known provider for the model.
  // Never take the last segment of a custom path or a deployment resource name.
  const segments = id.split('/');
  if (segments.length > 2) return null;
  const name = segments[segments.length - 1];
  const namespace = segments.length === 2 ? segments[0].toLowerCase() : null;
  const family = FAMILIES.find((candidate) => candidate.model.test(name)
    && (namespace === null || candidate.namespaces.includes(namespace)));
  return family ? { family, shortLabel: name.slice(family.prefix.length) } : null;
}

/** Presentation of one API's actual model catalog, in its original order. */
export function buildModelPresentation(ids: readonly string[]): ModelPresentation {
  const unique = [...new Set(ids)];
  const recognized = unique.map(identify);
  const family = recognized[0]?.family;
  const sharedFamily = family && recognized.every((item) => item?.family === family) ? family : null;
  if (!sharedFamily) return { familyLabel: null, items: unique.map((id) => ({ id, label: id })) };

  const labelCounts = new Map<string, number>();
  for (const item of recognized) {
    const key = item!.shortLabel.toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  return {
    familyLabel: sharedFamily.label,
    items: unique.map((id, index) => {
      const shortLabel = recognized[index]!.shortLabel;
      // Keep a full ID for every collision, including case-only differences and
      // direct vs. namespaced IDs; each selectable label still identifies its ID.
      return { id, label: labelCounts.get(shortLabel.toLowerCase()) === 1 ? shortLabel : id };
    }),
  };
}

/** A selected model outside the catalog cannot establish or change its family. */
export function modelDisplayLabel(id: string, ids: readonly string[]): string {
  return buildModelPresentation(ids).items.find((item) => item.id === id)?.label ?? id;
}
