import { networkFailureMessage } from '../api/network';

test('network diagnostics identify DNS/TLS errors without disclosing signed URLs', () => {
  const address = 'https://images.example/image.png?key=secret';
  expect(networkFailureMessage(address, '图片下载', new Error('UnknownHostException'))).toContain('私人 DNS');
  expect(networkFailureMessage(address, '图片下载', new Error('SSLHandshakeException'))).toContain('完整证书链');
  expect(networkFailureMessage(address, '图片下载', new Error(address))).not.toContain('key=secret');
});

test('explains HTTP/2 stream resets without exposing transport internals to users', () => {
  const message = networkFailureMessage('https://cdn.example/image.png?signature=secret', '图片下载', new Error('fetch failed: okhttp3.internal.http2.StreamResetException: stream was reset: CANCEL'));
  expect(message).toContain('连接被服务商中途重置');
  expect(message).toContain('不会重复生成');
  expect(message).not.toContain('signature=secret');
});
