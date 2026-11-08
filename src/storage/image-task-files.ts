/** Only files owned by the image generator may be retained or deleted by a task checkpoint. */
export function imageTaskFileUris(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const task: unknown = JSON.parse(raw);
    if (!task || typeof task !== 'object' || !('results' in task) || !Array.isArray(task.results)) return [];
    return [...new Set(task.results.slice(0, 10).flatMap((result: unknown) => {
      if (!result || typeof result !== 'object' || !('localUri' in result) || typeof result.localUri !== 'string') return [];
      try {
        const uri = new URL(result.localUri);
        const pathname = decodeURIComponent(uri.pathname);
        return uri.protocol === 'file:' && !uri.host && !uri.search && !uri.hash
          && /\/generated-images\/[^/\\]+\.png$/i.test(pathname) && !pathname.split(/[\\/]/).includes('..')
          ? [result.localUri] : [];
      } catch { return []; }
    }))];
  } catch { return []; }
}
