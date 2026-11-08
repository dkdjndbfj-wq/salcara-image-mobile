export const PREVIEW_TRANSFER_LIMIT = 8 * 1024 * 1024;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function decodePreviewBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('文件数据格式无效');
  const bytes = new Uint8Array(value.length * 3 / 4 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0));
  let out = 0;
  for (let i = 0; i < value.length; i += 4) {
    const bits = (alphabet.indexOf(value[i]) << 18) | (alphabet.indexOf(value[i + 1]) << 12) | (Math.max(0, alphabet.indexOf(value[i + 2])) << 6) | Math.max(0, alphabet.indexOf(value[i + 3]));
    if (out < bytes.length) bytes[out++] = bits >> 16;
    if (out < bytes.length) bytes[out++] = bits >> 8;
    if (out < bytes.length) bytes[out++] = bits;
  }
  return bytes;
}
export function encodePreviewBytes(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const bits = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result += alphabet[(bits >> 18) & 63] + alphabet[(bits >> 12) & 63] + (i + 1 < bytes.length ? alphabet[(bits >> 6) & 63] : '=') + (i + 2 < bytes.length ? alphabet[bits & 63] : '=');
  }
  return result;
}
