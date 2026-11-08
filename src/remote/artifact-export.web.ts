import { artifactPayloadBytes } from './artifact-content';
import type { ArtifactPayload } from './conversation-artifacts';

export async function exportArtifact(payload: ArtifactPayload, action: 'download' | 'share', signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('文件操作已取消', 'AbortError');
  const bytes = artifactPayloadBytes(payload), file = new File([new Uint8Array(bytes)], payload.artifact.name, { type: payload.artifact.mime });
  if (action === 'share' && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: payload.artifact.name }); return; }
  const url = URL.createObjectURL(file), link = document.createElement('a');
  try { link.href = url; link.download = payload.artifact.name; link.rel = 'noopener'; document.body.appendChild(link); link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
}
