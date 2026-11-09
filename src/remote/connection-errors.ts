import { HubError, isExecutionPolicyError, isPairingAuthenticationError } from './client';

/** Safe display state: never persist arbitrary service response text in a status label. */
export type ConnectionProblem = 'pairing' | 'permission' | 'enrollment' | 'unsupported' | 'unavailable' | 'timeout' | 'network';

export function connectionProblem(error: unknown, pairedRequest = true): ConnectionProblem {
  if (!(error instanceof HubError)) return 'network';
  if (pairedRequest && isPairingAuthenticationError(error)) return 'pairing';
  if (error.code === 'device_credentials_required' || error.code === 'device_credentials_invalid' || error.code === 'device_enrollment_required' || error.code === 'enrollment_claim_invalid' || error.code === 'hub_identity_changed') return 'enrollment';
  if (isExecutionPolicyError(error) || error.status === 401 || error.status === 403 || error.status === 423) return 'permission';
  if (error.status === 404 || error.status === 405 || error.code === 'remote_unsupported') return 'unsupported';
  if (error.status === 504 || error.code === 'hub_timeout' || error.code === 'diagnostic_timeout') return 'timeout';
  if (error.status >= 500 || error.status === 429) return 'unavailable';
  return 'network';
}

export function connectionFailure(error: unknown, pairedRequest = true) {
  const problem = connectionProblem(error, pairedRequest);
  const messages: Record<ConnectionProblem, string> = {
    pairing: '手机配对已失效，请重新扫码连接电脑；聊天记录保留',
    permission: '远程访问受限，请检查电脑端授权；如需恢复本站访问，请联系管理员。普通 API 配置保留',
    enrollment: '电脑的远程登记需要恢复，请在电脑端重新登记；API 和聊天记录保留',
    unsupported: '本站没有提供兼容的远程服务，请更新或检查远程入口',
    unavailable: '远程服务暂不可用，请稍后重试；已保存的配对和 API 保留',
    timeout: '远程连接超时，请检查网络后重试；已保存的配对保留',
    network: '连不上中转站或电脑，请检查网络后重试；已保存的配对保留',
  };
  return { connectionError: messages[problem], connectionProblem: problem };
}
