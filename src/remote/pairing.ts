/** Pairing is independent of model API keys. Never accept a QR as an arbitrary network destination. */
export const HUB_PATH = '/salcara-hub/v1';
export interface PairQr {
  type: 'salcara-remote-pair'; version: 1; hubUrl: string; deviceId: string;
  deviceName: string; ticket: string; expiresAt: number;
	computerId?: string;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.includes(':')) return host === '::' || host === '::1' || /^(fc|fd|fe[89ab]|::ffff:)/.test(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

export function canonicalHubUrl(input: string, allowLoopback = false): string {
  const value = input.trim();
  if (!value || value.length > 512 || /[\\\s]/.test(value)) throw new Error('请输入完整的 HTTPS 中转站地址');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('中转站地址格式不正确'); }
  if (url.username || url.password || /[?#]/.test(value)) throw new Error('中转站地址不能包含账号、参数或片段');
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname);
  if (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:')) throw new Error('远程连接必须使用 HTTPS');
  if (isPrivateHost(url.hostname) && !(allowLoopback && loopback)) throw new Error('请使用中转站的公网 HTTPS 地址');
  if (!url.hostname || !['', '/', '/v1', '/v1/', HUB_PATH, `${HUB_PATH}/`].includes(url.pathname)) throw new Error('请输入中转站首页地址，不要输入其他接口路径');
  return `${url.origin}${HUB_PATH}`;
}

export function readPairQr(raw: string, selectedHubUrl: string | null, now = Date.now(), allowLoopback = false): PairQr {
  if (raw.length > 4096) throw new Error('二维码内容无效');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('这不是 Salcara 电脑配对二维码'); }
  if (!value || typeof value !== 'object') throw new Error('二维码内容无效');
  const qr = value as Partial<PairQr>;
  if (qr.type !== 'salcara-remote-pair' || qr.version !== 1 || typeof qr.hubUrl !== 'string') throw new Error('这不是支持的 Salcara 电脑配对二维码');
  const endpoint = canonicalHubUrl(qr.hubUrl, allowLoopback);
  if (qr.hubUrl !== endpoint || selectedHubUrl && endpoint !== canonicalHubUrl(selectedHubUrl, allowLoopback)) throw new Error('二维码的中转站与当前选择不一致，请先连接该中转站');
  if (typeof qr.deviceId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(qr.deviceId)) throw new Error('二维码的电脑标识无效');
  if (qr.computerId !== undefined && (typeof qr.computerId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(qr.computerId))) throw new Error('二维码的本机标识无效');
  if (typeof qr.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(qr.ticket)) throw new Error('二维码的配对凭证无效');
  if (typeof qr.expiresAt !== 'number' || !Number.isSafeInteger(qr.expiresAt) || qr.expiresAt <= now) throw new Error('二维码已过期，请在电脑上重新生成');
  if (qr.expiresAt > now + 10 * 60_000) throw new Error('二维码有效期异常，请重新生成');
  if (typeof qr.deviceName !== 'string' || !qr.deviceName.trim() || qr.deviceName.length > 200 || /[\u0000-\u001f]/.test(qr.deviceName)) throw new Error('二维码的电脑名称无效');
  return { ...qr, hubUrl: endpoint } as PairQr;
}
