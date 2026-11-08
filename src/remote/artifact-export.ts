import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { randomUUID } from 'expo-crypto';
import { artifactPayloadBytes } from './artifact-content';
import type { ArtifactPayload } from './conversation-artifacts';

export async function exportArtifact(payload: ArtifactPayload, action: 'download' | 'share', signal: AbortSignal): Promise<void> {
  const assertActive = () => { if (signal.aborted) { const error = new Error('文件操作已取消'); error.name = 'AbortError'; throw error; } };
  assertActive();
  const bytes = artifactPayloadBytes(payload);
  if (!await Sharing.isAvailableAsync()) throw new Error('当前设备不支持系统文件分享');
  assertActive();
  const directory = new Directory(Paths.cache, 'salcara-artifacts', randomUUID());
  directory.create({ intermediates: true, idempotent: true });
  const name = payload.artifact.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-180) || 'artifact';
  const file = new File(directory, name);
  file.create({ overwrite: false }); file.write(bytes);
  assertActive();
  // Keep the copy in OS-managed cache: the receiving app may read it after the
  // share sheet closes. Original computer-side files are never changed.
  await Sharing.shareAsync(file.uri, { mimeType: payload.artifact.mime, dialogTitle: action === 'share' ? '分享文件' : '保存文件到…' });
}
