import { HubError } from './client';

export interface ApiProblem { kind: 'key' | 'quota' | 'rate' | 'model_capacity' | 'interface'; message: string }

/** Keep useful upstream diagnostics while removing URL credentials/query data. */
export function executionErrorDetail(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw.replace(/[),.;]+$/, ''));
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return raw.split(/[?#]/, 1)[0];
    }
  }).replace(/\b(authorization)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|token|secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[已隐藏]')
    .slice(0, 16_000);
}

/** Bridge catalog guards mean the picker must re-read, not reuse its last list. */
export function modelCatalogProblem(error: unknown): boolean {
  if (error instanceof HubError && error.status !== 200) return false;
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /请先选择当前 API 支持的模型|这个 API 不支持该模型|读取模型列表失败|API (?:已更换|或模型列表已更新)|模型不在.*(?:目录|列表)|model[_ ]not[_ ]found/i.test(text);
}

/** A real runtime can revoke a previously advertised effort before a turn. */
export function modelCapabilityProblem(error: unknown): boolean {
  if (error instanceof HubError && error.status !== 200) return false;
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /这个模型不支持该推理档位|读取模型档位失败|当前 (?:API|工具) 未提供推理档位|请先选择模型再设置推理档位|当前模型仅支持文字/.test(text);
}

/** Only explicit provider failures suggest changing a Key. Pairing/transport
 * failures never masquerade as a provider credential or balance problem. */
export function apiProblem(error: unknown, errorCode?: string): ApiProblem | null {
  if (error instanceof HubError && error.status !== 200) return null;
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const explicitBalance = /insufficient[_\s-]*balance|balance\s+(?:is\s+)?(?:insufficient|exhausted)|余额不足|余额已用完/i.test(text);
  // New Bridges retain Codex's typed serverOverloaded condition even when
  // the runtime localizes its message. Old Bridges keep the text fallback.
  const code = errorCode ?? (error instanceof HubError ? error.code : undefined);
  if (code === 'model_capacity') return { kind: 'model_capacity', message: '当前模型容量已满，可换模型或稍后重试' };
  if (code === 'usage_limit') return { kind: 'quota', message: '当前凭据额度已用完，可稍后重试或更换 API' };
  if (code === 'upstream_rate_limit') return { kind: 'rate', message: 'API 限流，可稍后重试或更换 API' };
  if (code === 'upstream_unauthorized') return { kind: 'key', message: '当前凭据授权失效，可更换 API' };
  // A structured runtime condition is more reliable than incidental words
  // such as "quota", "401" or "key" in its explanatory text. Context/turn
  // budgets, partial streams and policy failures are not credential failures.
  // Keep their original notice/turn error without a misleading key action.
  if (code && ['context_limit', 'session_budget', 'upstream_bad_request', 'upstream_connection_failed',
    'response_stream_interrupted', 'response_retry_exhausted', 'upstream_internal_error', 'policy_rejected', 'sandbox_error',
    'thread_rollback_failed', 'turn_not_steerable', 'unsupported_item', 'unknown_turn_status', 'unknown_execution_error'].includes(code)) return null;
  // A typed upstream 403 normally stays a generic provider denial. Some API
  // gateways use 403 specifically for a depleted balance, so recognize that
  // only when the provider text states it explicitly. Hub 401/403 responses
  // were rejected above and can never be confused with this condition.
  if (code === 'upstream_forbidden' && !explicitBalance) return null;
  if (!text || /配对|扫码|设备授权|电脑不在线|电脑离线|中转站响应超时|连不上中转站|请求已取消/i.test(text)) return null;
  if (explicitBalance) return { kind: 'quota', message: 'API 余额不足，请充值或更换 API' };
  if (/insufficient[_ ]quota|credit balance|余额不足|额度用完|额度不足|欠费|quota exceeded|billing|HTTP\s*402/i.test(text)) return { kind: 'quota', message: 'API 额度不足，可更换 API' };
  // Codex reports this provider condition as a failed turn. It is not a
  // completed response and it does not mean that the API key is bad: the
  // selected model is temporarily full. Keep it separate from generic 429
  // rate limiting so the UI can open the model picker and retain retry.
  if (/selected\s+model\s+is\s+at\s+capacity|model\s+capacity|模型(?:当前)?(?:容量|已满|繁忙)|容量已满/i.test(text)) {
    return { kind: 'model_capacity', message: '当前模型容量已满，可换模型或稍后重试' };
  }
  if (/HTTP\s*429|rate[_ ]limit|too many requests|限流/i.test(text)) return { kind: 'rate', message: 'API 限流，可稍后重试或更换 API' };
  if (/invalid[_ ]api[_ ]key|invalid.*key|authentication[_ ]error|unauthorized|HTTP\s*401|密钥.*失效|Key.*(?:无效|失效)/i.test(text)) return { kind: 'key', message: 'API 密钥失效或无权限，可更换 API' };
  if (/model[_ ]not[_ ]found|unsupported.*(?:model|endpoint|interface)|接口.*不支持|模型.*(?:不存在|无权限)|上游.*HTTP\s*(?:404|405|501)|没有此接口组合/i.test(text)) return { kind: 'interface', message: 'API 不支持当前模型或接口，可换模型或 API' };
  return null;
}
