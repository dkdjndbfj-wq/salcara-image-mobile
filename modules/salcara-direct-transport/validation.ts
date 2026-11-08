export interface DirectEndpoint { url: string; certificateSha256: string }

/** Validate the QR endpoint before any native networking code is invoked. */
export function validateDirectEndpoint(rawUrl: string, certificateSha256: string): DirectEndpoint {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error('直连地址无效；必须是二维码中的安全 WSS 地址'); }
  if (parsed.protocol !== 'wss:' || !parsed.hostname || parsed.username || parsed.password
    || parsed.pathname !== '/direct/ws' || parsed.search || parsed.hash) {
    throw new Error('直连地址无效；必须是二维码中的安全 WSS 地址');
  }
  if (!/^[a-f0-9]{64}$/.test(certificateSha256)) {
    throw new Error('电脑证书指纹无效，请重新扫描直连二维码');
  }
  return { url: parsed.toString(), certificateSha256 };
}
