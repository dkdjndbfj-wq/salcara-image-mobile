import { CLOCK_SKEW_MESSAGE, type DeviceStatus } from './client';
import type { RemoteState } from './store';
import type { SavedConnectionHealth } from './store';

type TransportState = Pick<RemoteState, 'connection' | 'connectionError'> & Partial<Pick<RemoteState, 'connections' | 'connectionId' | 'connectionProblem'>>;
type DeviceConnection = Pick<DeviceStatus, 'online'> & Partial<Pick<DeviceStatus, 'deviceId'>>;

export function savedConnectionHealthLabel(health: SavedConnectionHealth | 'checking' | undefined, bot = false): string {
  if (!health || health === 'checking') return '检查中';
  const labels: Record<Exclude<SavedConnectionHealth, 'unreachable'>, string> = { online: '在线', offline: '电脑离线', reauth: '需要重新绑定', denied: '远程访问受限', enrollment: '电脑需要重新登记', identity: '连接身份待确认', clock_skew: '设备时间不一致', unsupported: '远程服务不兼容', unavailable: '远程服务暂不可用', timeout: '远程连接超时' };
  return health === 'unreachable' ? bot ? 'Bot 服务不可达' : '中转站不可达' : labels[health];
}

export function remoteConnectionModeLabel(remote: TransportState): 'Bot' | '中转站' {
  return remote.connections?.find(item => item.id === remote.connectionId)?.botGroupId ? 'Bot' : '中转站';
}

/** The most recent request reached the station and found this computer online. */
export function remoteDeviceConnected(remote: TransportState, device?: DeviceConnection): boolean {
  return remote.connection === 'open' && !remote.connectionError && device?.online === true;
}

export function remoteConnectionState(remote: TransportState, device?: DeviceConnection) {
  const mode = remoteConnectionModeLabel(remote);
  const profile = remote.connections?.find(item => item.id === remote.connectionId);
  const currentDevice = profile && device?.deviceId && device.deviceId !== profile.deviceId ? undefined : device;
  if (remote.connectionError || remote.connection === 'error') {
    const problem = remote.connectionProblem;
    if (problem === 'pairing') return { tone: 'error' as const, label: '需要重新绑定', detail: mode === 'Bot' ? 'Bot 绑定凭据已失效，请重新绑定 Bot。' : '手机配对已失效，请在电脑端生成二维码后重新扫码。' };
    if (problem === 'enrollment') return { tone: 'error' as const, label: '电脑需要重新登记', detail: '电脑的远程登记已失效，请在电脑端恢复登记后重试；模型 API 和聊天记录保留。' };
    if (problem === 'identity') return { tone: 'error' as const, label: '连接身份待确认', detail: '暂时无法确认这是原来的远程服务，请核对连接信息后重试；已保存的配对和聊天记录保留。' };
    if (problem === 'clock_skew') return { tone: 'error' as const, label: '设备时间不一致', detail: CLOCK_SKEW_MESSAGE };
    if (problem === 'permission') return { tone: 'error' as const, label: '远程访问受限', detail: '请检查电脑端的远程访问与来源授权，或联系管理员；无需更换模型 API 密钥。' };
    if (problem === 'unsupported') return { tone: 'error' as const, label: '远程服务不兼容', detail: `${mode}未提供兼容的远程接口，请更新服务或检查远程入口；普通 API 仍可使用。` };
    if (problem === 'unavailable') return { tone: 'error' as const, label: '远程服务暂不可用', detail: `${mode}暂时不可用，请稍后重试；已保存的配对和模型 API 保留。` };
    if (problem === 'timeout') return { tone: 'error' as const, label: '远程连接超时', detail: `${mode}未及时响应，请检查网络后重试；不能据此确认电脑已离线。` };
  }
  if (remote.connectionError || remote.connection === 'error') return {
    tone: 'error' as const, label: '连接中断', detail: `手机暂时连不上${mode === 'Bot' ? ' Bot ' : mode}或这台电脑，请检查网络后重试。`,
  };
  if (remote.connection === 'connecting' || remote.connection === 'retrying') return {
    tone: 'pending' as const, label: '正在连接', detail: `正在连接${mode === 'Bot' ? ' Bot' : mode}。`,
  };
  if (remote.connection !== 'open') return {
    tone: 'offline' as const, label: '未连接', detail: '打开电脑列表或对话时会自动连接。',
  };
  if (!currentDevice?.online) return {
    tone: 'offline' as const, label: '电脑离线', detail: `${mode}${mode === 'Bot' ? ' ' : ''}正常，但这台电脑当前不在线。请确认电脑开着，并且 Salcara Bridge 正在运行。`,
  };
  return { tone: 'connected' as const, label: '已连接', detail: '手机已连上这台电脑。任务在电脑上运行，离开手机也不会中断。' };
}
