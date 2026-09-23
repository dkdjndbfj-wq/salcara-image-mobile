export function networkHost(url: string): string {
  try { return new URL(url).hostname; } catch { return '服务商'; }
}

/** Expose the failed host, never a signed URL, request body or credential. */
export function networkFailureMessage(url: string, stage: string, error: unknown): string {
  const host = networkHost(url);
  const detail = error instanceof Error ? error.message : '';
  if (/redirect/i.test(detail)) {
    return `${stage}地址发生跳转（${host}），已停止转发密钥。请直接填写服务商提供的最终 API 地址。`;
  }
  if (/ssl|certificate|certpath|handshake/i.test(detail)) {
    return `${stage}无法建立安全连接（${host}）。请检查设备时间；若浏览器正常，请联系服务商检查完整证书链。`;
  }
  if (/resolve|unknownhost|dns/i.test(detail)) {
    return `${stage}无法解析服务器地址（${host}）。请检查手机的私人 DNS、网络或服务商域名配置。`;
  }
  if (/failed to connect|connectexception|ehostunreach|enetunreach|connection refused/i.test(detail)) {
    return `${stage}无法建立到服务器的连接（${host}）。/models 可能仍然正常，但生图 POST 线路、IPv6 或网关规则可能单独失败；请在网络诊断中查看“生图接口”。`;
  }
  if (/streamresetexception|stream was reset|\bCANCEL\b|econnreset|connection reset|socket(?:exception| closed)|network request failed/i.test(detail)) {
    return `${stage}连接被服务商中途重置（${host}）。如果这是图片下载，请点击“重新下载”，不会重复生成；如果发生在生图请求中，请先查看上游记录再手动重试，以免重复扣费。`;
  }
  if (/timeout|timed out/i.test(detail)) {
    return `${stage}连接超时（${host}）。请稍后重试；网站和图片下载可能使用不同的服务器。`;
  }
  return stage === '生图接口'
    ? `${stage}连接失败（${host}）。模型列表可以正常但生图 POST 仍可能被 IPv6、HTTP/2、WAF 或服务商分组权限单独拦截；请查看网络诊断里的“生图接口”结果，并把请求时间交给服务商查日志。`
    : `${stage}连接失败（${host}）。请检查该域名的网络连通性、手机代理分流或私人 DNS 设置。`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function abortError(): Error {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}
