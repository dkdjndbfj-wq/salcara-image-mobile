import { HubError } from './client';

export interface ApiProblem { kind: 'key' | 'quota' | 'rate' | 'interface'; message: string }

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
export function apiProblem(error: unknown): ApiProblem | null {
  if (error instanceof HubError && error.status !== 200) return null;
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (!text || /配对|扫码|设备授权|电脑不在线|电脑离线|中转站响应超时|连不上中转站|请求已取消/i.test(text)) return null;
  if (/insufficient[_ ]quota|credit balance|余额不足|额度用完|额度不足|欠费|quota exceeded|billing|HTTP\s*402/i.test(text)) return { kind: 'quota', message: 'API 额度不足，可更换 API' };
  if (/HTTP\s*429|rate[_ ]limit|too many requests|限流/i.test(text)) return { kind: 'rate', message: 'API 限流，可稍后重试或更换 API' };
  if (/invalid[_ ]api[_ ]key|invalid.*key|authentication[_ ]error|unauthorized|HTTP\s*40[13]|密钥.*失效|Key.*(?:无效|失效)/i.test(text)) return { kind: 'key', message: 'API 密钥失效或无权限，可更换 API' };
  if (/model[_ ]not[_ ]found|unsupported.*(?:model|endpoint|interface)|接口.*不支持|模型.*(?:不存在|无权限)|上游.*HTTP\s*(?:404|405|501)|没有此接口组合/i.test(text)) return { kind: 'interface', message: 'API 不支持当前模型或接口，可换模型或 API' };
  return null;
}
