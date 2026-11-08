import { useCallback, useEffect, useRef } from 'react';

import type { ReferenceImage } from '../domain';
import { createReferenceFromGenerated } from '../image-inputs';
import { deleteLocalFile } from '../storage/files';

type Options = {
  contextKey: string;
  images: ReferenceImage[];
  editingMessage: boolean;
  onAdd: (image: ReferenceImage) => void;
  onError: (error: unknown) => void;
};

/** Editing a result imports an owned copy, so removing a draft never deletes the result. */
export function useGeneratedImageDraft(options: Options): (uri: string) => void {
  const latest = useRef(options);
  latest.current = options;
  const identity = useRef({ contextKey: options.contextKey, images: options.images, editingMessage: options.editingMessage, revision: 0 });
  if (identity.current.contextKey !== options.contextKey || identity.current.images !== options.images || identity.current.editingMessage !== options.editingMessage) {
    identity.current = { contextKey: options.contextKey, images: options.images, editingMessage: options.editingMessage, revision: identity.current.revision + 1 };
  }
  const active = useRef(true);
  const importing = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  return useCallback((uri: string) => {
    if (importing.current) return;
    const start = latest.current;
    const revision = identity.current.revision;
    if (start.editingMessage) { start.onError(new Error('请先完成当前消息的编辑')); return; }
    if (start.images.length >= 4) { start.onError(new Error('一次最多添加 4 张参考图')); return; }
    importing.current = true;
    void (async () => {
      let imported: ReferenceImage | null = null;
      try {
        imported = await createReferenceFromGenerated(uri);
        const current = latest.current;
        // A send, attachment change, or conversation switch retires this asynchronous import.
        if (!active.current || identity.current.revision !== revision || current.editingMessage) return;
        current.onAdd(imported);
        imported = null; // ownership moved to the composer
      } catch (error) {
        if (active.current && identity.current.revision === revision) latest.current.onError(error);
      } finally {
        if (imported) deleteLocalFile(imported.uri);
        importing.current = false;
      }
    })();
  }, []);
}
