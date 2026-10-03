/** An image chosen in the remote composer, already shrunk for the trip to the computer. */
export interface RemoteImage { uri: string; base64: string; mime: 'image/jpeg'; width: number; height: number }

export const MAX_REMOTE_IMAGES = 4;
/** Base64 characters per Hub command (the Hub caps commands at 256 KiB). Multiple of 4. */
export const ATTACHMENT_CHUNK = 160_000;

/** Splits base64 into Hub-sized pieces. */
export function attachmentChunks(base64: string, size = ATTACHMENT_CHUNK): string[] {
  const out: string[] = [];
  for (let index = 0; index < base64.length; index += size) out.push(base64.slice(index, index + size));
  return out.length ? out : [''];
}
