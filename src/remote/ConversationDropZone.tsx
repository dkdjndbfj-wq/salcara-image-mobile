import React, { useLayoutEffect, useRef } from 'react';
import { View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { prepareRemoteImage } from './attachments';
import { attachmentBytes } from './attachment-ref';
import { composerFileKind, type ComposerFiles, type ComposerFilesAppender } from './composer-files';
import { showToast } from '../components/ui';

export interface ConversationFilesHandle { pick: () => void }
export interface ConversationDropZoneProps { scopeKey: string; enabled: boolean; onFiles: ComposerFilesAppender; children: React.ReactNode; importRef?: React.MutableRefObject<ConversationFilesHandle | undefined> }
/** Native file picking uses the same bounded all-or-nothing draft import.
 * Browser/iPad browser drop and paste gestures are supplied by the web version. */
export function ConversationDropZone({ scopeKey, enabled, onFiles, children, importRef }: ConversationDropZoneProps) {
  const latest = useRef({ scopeKey, enabled, onFiles, epoch: 0 });
  const alive = useRef(true), flight = useRef<object | undefined>(undefined);
  if (latest.current.scopeKey !== scopeKey || latest.current.enabled !== enabled) {
    latest.current = { scopeKey, enabled, onFiles, epoch: latest.current.epoch + 1 };
    // An old picker may remain open while the newly selected context picks files.
    // Its completion must neither append into that context nor unlock its flight.
    flight.current = undefined;
  } else latest.current = { ...latest.current, onFiles };
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => {
    const epoch = latest.current.epoch;
    const handle = { pick: () => {
      if (!alive.current || latest.current.epoch !== epoch || latest.current.scopeKey !== scopeKey || !latest.current.enabled || flight.current) return;
      const token = {}; flight.current = token;
      const current = () => alive.current && latest.current.epoch === epoch && latest.current.scopeKey === scopeKey && latest.current.enabled;
      void (async () => {
        try {
          const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
          if (result.canceled || !current()) return;
          if (!result.assets.length || result.assets.length > 8) throw new Error('每次最多选择 8 个文件');
          const entries = result.assets.map(asset => ({ asset, kind: composerFileKind(asset.name, asset.mimeType ?? '') }));
          if (entries.filter(item => item.kind === 'image').length > 4) throw new Error('每次最多添加 4 张图片');
          const batch: ComposerFiles = { texts: [], images: [] };
          for (const { asset, kind } of entries) {
            if (!current()) return;
            const stat = await FileSystem.getInfoAsync(asset.uri);
            if (!stat.exists || stat.isDirectory || !stat.size || stat.size > (kind === 'image' ? 8 * 1024 * 1024 : 1024 * 1024)) throw new Error(`“${asset.name}”为空或过大，图片上限 8 MB，文本上限 1 MB`);
            if (kind === 'image') batch.images.push(await prepareRemoteImage({ uri: asset.uri }));
            else {
              const encoded = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
              let text: string;
              try { text = new TextDecoder('utf-8', { fatal: true }).decode(attachmentBytes(encoded, 1024 * 1024)); }
              catch { throw new Error(`“${asset.name}”不是有效的 UTF-8 文本，请转换编码后添加`); }
              if (!text || text.includes('\0') || text.length > 40_000) throw new Error(`“${asset.name}”为空、含二进制内容或超过 40,000 字符`);
              batch.texts.push({ name: asset.name, text });
            }
          }
          if (current() && await latest.current.onFiles(batch) && current()) showToast('已加入草稿', 'check');
        } catch (error) { if (current()) showToast(error instanceof Error ? error.message : '文件添加失败，原草稿已保留', 'alert'); }
        finally { if (flight.current === token) flight.current = undefined; }
      })();
    } };
    if (importRef) importRef.current = handle;
    return () => { if (importRef?.current === handle) importRef.current = undefined; };
  }, [scopeKey, enabled, importRef]);
  return <View style={{ flex: 1, minHeight: 0 }}>{children}</View>;
}
