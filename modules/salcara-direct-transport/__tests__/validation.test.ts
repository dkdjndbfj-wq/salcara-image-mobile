import { validateDirectEndpoint } from '../validation';

const pin = 'a'.repeat(64);

test('accepts only a direct WSS endpoint and preserves its pinned identity', () => {
  expect(validateDirectEndpoint('wss://192.168.1.12:47832/direct/ws', pin)).toEqual({
    url: 'wss://192.168.1.12:47832/direct/ws', certificateSha256: pin,
  });
});

test.each([
  'ws://192.168.1.12:47832/direct/ws',
  'https://192.168.1.12:47832/direct/ws',
  'wss://user@192.168.1.12:47832/direct/ws',
  'wss://192.168.1.12:47832/other',
  'wss://192.168.1.12:47832/direct/ws?token=secret',
  'wss://192.168.1.12:47832/direct/ws#fragment',
])('rejects unsafe endpoint %s', endpoint => {
  expect(() => validateDirectEndpoint(endpoint, pin)).toThrow('直连地址无效');
});

test.each(['', 'ABCDEF'.repeat(10) + 'ABCD', 'f'.repeat(63), 'g'.repeat(64)])('rejects invalid certificate pin %s', fingerprint => {
  expect(() => validateDirectEndpoint('wss://192.168.1.12:47832/direct/ws', fingerprint)).toThrow('证书指纹无效');
});
