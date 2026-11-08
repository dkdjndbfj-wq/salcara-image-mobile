import { missingSessionReadCode } from '../remote/missing-session-error';
import { HubError } from '../remote/client';
test('a missing session requires an authenticated computer rejection, not a network or directory failure', () => {
  expect(missingSessionReadCode(new HubError('找不到这个会话', 200))).toBe('session_not_found');
  expect(missingSessionReadCode(new HubError('thread not found: thread-1', 200))).toBe('session_not_found');
  expect(missingSessionReadCode(new HubError('Unavailable', 200, 'session_deleted'))).toBe('deleted');
  expect(missingSessionReadCode(new HubError('找不到这个会话', 404))).toBeUndefined();
  expect(missingSessionReadCode(new HubError('请求超时', 0))).toBeUndefined();
  expect(missingSessionReadCode(new Error('找不到这个会话'))).toBeUndefined();
  expect(missingSessionReadCode(new HubError('读取文件失败：thread not found', 200))).toBeUndefined();
  expect(missingSessionReadCode(new HubError('文件夹不存在：C:/project', 200))).toBeUndefined();
});
test('old direct protocol can classify its exact remote read failure without treating disconnect as deletion', () => {
  const error = Object.assign(new Error('找不到这个会话: file does not exist'), { name: 'DirectApiError', code: 'remote' });
  expect(missingSessionReadCode(error)).toBe('session_not_found');
  error.code = 'disconnected'; expect(missingSessionReadCode(error)).toBeUndefined();
});
