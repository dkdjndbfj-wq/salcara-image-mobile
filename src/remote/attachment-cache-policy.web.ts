/** Browser previews use bounded Blob URLs, not Expo's native filesystem. */
export const ATTACHMENT_CACHE_BYTES = 64 * 1024 * 1024;
export const ATTACHMENT_CACHE_TTL = 7 * 86400_000;
export const retainCachedAttachment = (_uri?: string): (() => void) => () => undefined;
export const touchCachedAttachment = (_uri: string): void => undefined;
export const collectAttachmentCache = async () => ({ bytes: 0, removed: 0 });
export async function reserveAttachmentCache(_bytes: number): Promise<() => void> {
  throw new Error('浏览器图片请使用网页预览缓存，不能写入手机附件目录');
}
