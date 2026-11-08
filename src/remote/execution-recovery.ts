import { apiProblem } from './api-errors';
export type ExecutionRecoveryAction = 'api' | 'model' | 'connection' | 'new';
export interface ExecutionRecovery { label: string; action?: ExecutionRecoveryAction; actionLabel?: string; retry: boolean }
/** Prefer the backend's error category. Incidental words in command output
 * never turn a policy/disk/runtime failure into an API-key action. */
export function executionRecovery(message = '', code?: string): ExecutionRecovery {
  if(code==='computer_offline')return {label:'电脑已离线，连接后核对本轮结果',action:'connection',actionLabel:'检查连接',retry:false};
  const api = apiProblem(message, code);
  if (api) {
    if (api.kind === 'key') return { label: 'API 授权失效', action: 'api', actionLabel: '检查 API', retry: false };
    if (api.kind === 'quota') return { label: 'API 额度不足', action: 'api', actionLabel: '更换 API', retry: true };
    if (api.kind === 'rate') return { label: 'API 请求受限', action: 'api', actionLabel: '查看 API', retry: true };
    return { label: api.kind === 'model_capacity' ? '当前模型繁忙' : '模型或接口不匹配', action: 'model', actionLabel: '更换模型', retry: api.kind === 'model_capacity' };
  }
  if (code === 'policy_rejected') return { label: '请求未通过模型服务检查，请修改内容后再发送', retry: false };
  if (code === 'context_limit' || code === 'session_budget') return { label: '当前对话已达到上下文或任务预算上限', action: 'new', actionLabel: '新建对话', retry: false };
  if (code === 'sandbox_error') return { label: '电脑执行环境或权限受限，请在电脑核对', retry: false };
  if (['upstream_connection_failed', 'response_stream_interrupted', 'response_retry_exhausted', 'computer_offline'].includes(code ?? '')
    || !code && /电脑.{0,5}(?:离线|断开)|连不上中转站|network request failed|connection (?:lost|closed|reset)|econnreset/i.test(message)) {
    return { label: '连接中断，本轮结果需要核对', action: 'connection', actionLabel: '检查连接', retry: true };
  }
  return { label: '本轮未完成', retry: true };
}
