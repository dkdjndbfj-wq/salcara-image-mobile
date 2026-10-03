import type { RefObject } from 'react';
import { Platform, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

/** Ephemeral local pixels for the picker blur; never saved, uploaded or logged. */
export async function captureModelBackdrop(ref: RefObject<View | null>): Promise<string | undefined> {
  if (Platform.OS === 'web' || !ref.current) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pixels = await Promise.race([
      captureRef(ref, { format: 'jpg', quality: 0.65, result: 'base64' }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 100); }),
    ]);
    return typeof pixels === 'string' && pixels ? `data:image/jpeg;base64,${pixels}` : undefined;
  } catch { return undefined; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
