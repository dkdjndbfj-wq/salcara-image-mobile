import { randomUUID } from 'expo-crypto';
import { CLOCK_SKEW_MESSAGE, diagnosticProbe, HubError, isPairingAuthenticationError, type Hub } from './client';
import { connectionProblem } from './connection-errors';

export type DiagnosticStatus = 'ok' | 'offline' | 'reauth' | 'denied' | 'enrollment' | 'identity' | 'clock_skew' | 'unsupported' | 'busy' | 'timeout' | 'invalid' | 'unreachable' | 'not_measured';
export interface DiagnosticSegment { status: DiagnosticStatus; ms: number | null; detail: string }
export interface ConnectionDiagnosticResult {
  checkedAt: number;
  hub: DiagnosticSegment;
  computer: DiagnosticSegment;
  roundTrip: DiagnosticSegment;
  deviceOnline?: boolean;
  lastSeen?: number;
}
const unmeasured = (): DiagnosticSegment => ({ status: 'not_measured', ms: null, detail: '尚未测量' });
const finiteDuration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 20000;
const validCounter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function errorSegment(error: unknown, bot: boolean): DiagnosticSegment {
  const failed = (status: DiagnosticStatus, detail: string): DiagnosticSegment => ({ status, ms: null, detail });
  if (!(error instanceof HubError)) return failed('unreachable', '当前网络无法完成检测，请检查网络后重试。');
  if (error.status === 499 || error.code === 'aborted' || error.code === 'diagnostic_connection_changed') throw error;
  if (isPairingAuthenticationError(error)) return failed('reauth', bot ? 'Bot 绑定凭据已失效，请重新绑定 Bot。' : '手机配对凭据已失效，请重新扫码绑定这台电脑。');
  const problem = connectionProblem(error);
  if (problem === 'clock_skew') return failed('clock_skew', CLOCK_SKEW_MESSAGE);
  if (problem === 'identity') return failed('identity', '无法确认原远程服务身份，请核对连接地址或联系管理员；已保存的配对和聊天记录保留。');
  if (problem === 'enrollment') return failed('enrollment', '电脑的远程登记需要恢复，请在电脑端重新登记。');
  if (problem === 'permission') return failed('denied', '远程访问受限，请检查电脑端授权或联系管理员；已保存的手机配对保留。');
  if (error.status === 404 || error.status === 405) return failed('unsupported', '当前服务尚不支持分段诊断，请更新服务端；原有远程连接不受影响。');
  if (error.code === 'diagnostic_device_offline') return failed('offline', '这台电脑当前离线，请确认电脑和 Salcara Bridge 正在运行。');
  if (error.status === 429 || error.code === 'diagnostic_busy') return failed('busy', '检测过于频繁或服务繁忙，请至少等待 5 秒后重试。');
  if (error.status === 504 || error.code === 'diagnostic_timeout') return failed('timeout', '检测超时；请检查电脑连接或稍后重试，不能据此确认电脑已关机。');
  if (error.code === 'diagnostic_reply_invalid' || error.code === 'diagnostic_invalid_response') return failed('invalid', '回显未通过验证，可能是电脑端版本不兼容；请更新后重试。');
  return failed('unreachable', '当前网络或连接服务暂不可达，请检查网络后重试。');
}
function validateResponse(value: Record<string, unknown>, deviceId: string, nonce: string, target: 'hub' | 'device') {
  const keys = target === 'hub' ? ['version', 'deviceId', 'nonce', 'target', 'status', 'deviceOnline', 'lastSeen'] : ['version', 'deviceId', 'nonce', 'target', 'status', 'hubDeviceMs'];
  if (!value || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || value.version !== 1 || value.deviceId !== deviceId || value.nonce !== nonce || value.target !== target || value.status !== 'ok'
    || (target === 'hub' ? typeof value.deviceOnline !== 'boolean' || !validCounter(value.lastSeen) : !finiteDuration(value.hubDeviceMs))) throw new HubError('诊断响应无效', 502, 'diagnostic_invalid_response');
}

/** Separate measurements, never subtract different machines' wall clocks. */
export async function measureConnection(hub: Hub, deviceId: string, signal?: AbortSignal): Promise<ConnectionDiagnosticResult> {
  const result: ConnectionDiagnosticResult = { checkedAt: Date.now(), hub: unmeasured(), computer: unmeasured(), roundTrip: unmeasured() };
  const owner = { ...hub };
  const bot = Boolean(owner.botToken), service = bot ? 'Bot 服务' : '中转站';
  const hubNonce = randomUUID();
  const hubStart = performance.now();
  try {
    const response = await diagnosticProbe(owner, deviceId, hubNonce, 'hub', signal);
    const elapsed = performance.now() - hubStart;
    validateResponse(response, deviceId, hubNonce, 'hub');
    if (!finiteDuration(elapsed)) throw new HubError('诊断计时无效', 502, 'diagnostic_invalid_response');
    result.hub = { status: 'ok', ms: elapsed, detail: `手机到${bot ? ' ' : ''}${service}的请求往返，包含服务处理时间。` };
    result.deviceOnline = response.deviceOnline as boolean;
    result.lastSeen = response.lastSeen as number;
  } catch (error) { result.hub = errorSegment(error, bot); result.checkedAt = Date.now(); return result; }
  if (!result.deviceOnline) {
    result.computer = { status: 'offline', ms: null, detail: `${service}可连接，但这台电脑当前离线。请启动电脑上的 Salcara Bridge。` };
    result.checkedAt = Date.now(); return result;
  }
  const deviceNonce = randomUUID(), started = performance.now();
  try {
    const response = await diagnosticProbe(owner, deviceId, deviceNonce, 'device', signal);
    const elapsed = performance.now() - started;
    validateResponse(response, deviceId, deviceNonce, 'device');
    const hubDeviceMs = response.hubDeviceMs as number;
    if (!finiteDuration(elapsed) || hubDeviceMs > elapsed + 5) throw new HubError('诊断计时无效', 502, 'diagnostic_invalid_response');
    result.computer = { status: 'ok', ms: hubDeviceMs, detail: `${service}到这台电脑的回显往返，包含排队与电脑处理时间。` };
    result.roundTrip = { status: 'ok', ms: elapsed, detail: `手机 → ${service} → 电脑 → ${service} → 手机；不调用模型。` };
  } catch (error) { result.computer = errorSegment(error, bot); result.roundTrip = { ...result.computer, detail: '完整回显未完成。' }; }
  result.checkedAt = Date.now();
  return result;
}

export const diagnosticStatusLabels: Record<DiagnosticStatus, string> = { ok: '已测量', offline: '电脑离线', reauth: '需要重新配对', denied: '远程访问受限', enrollment: '电脑需要重新登记', identity: '连接身份待确认', clock_skew: '设备时间不一致', unsupported: '版本不支持', busy: '稍后再试', timeout: '检测超时', invalid: '回显无效', unreachable: '连接无法确认', not_measured: '未测量' };
export function diagnosticDuration(segment: DiagnosticSegment): string { return segment.status === 'ok' && segment.ms !== null ? `${Math.round(segment.ms)} ms` : diagnosticStatusLabels[segment.status]; }

/** Explicit allowlist: no URLs, device identifiers, credentials, nonce, raw errors or conversation data. */
export function diagnosticSummary(result: ConnectionDiagnosticResult): string {
  return [
    'Salcara 连接诊断（脱敏摘要）', `检测时间：${new Date(result.checkedAt).toISOString()}`,
    ...([['手机 ↔ Hub', result.hub], ['Hub ↔ 自己的电脑', result.computer], ['完整回显', result.roundTrip]] as const).map(([label, segment]) => `${label}：${diagnosticDuration(segment)}`),
    '范围：本次主动回显；包含网络、排队和处理时间，不含模型推理。',
    '不是持续在线率或速度承诺；未包含地址、设备标识、配对凭据或会话内容。',
  ].join('\n');
}
