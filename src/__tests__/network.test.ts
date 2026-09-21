import { networkFailureMessage } from '../api/network';

test('network diagnostics identify DNS/TLS errors without disclosing signed URLs', () => {
  const address = 'https://images.example/image.png?key=secret';
  expect(networkFailureMessage(address, '图片下载', new Error('UnknownHostException'))).toContain('私人 DNS');
  expect(networkFailureMessage(address, '图片下载', new Error('SSLHandshakeException'))).toContain('完整证书链');
  expect(networkFailureMessage(address, '图片下载', new Error(address))).not.toContain('key=secret');
});
