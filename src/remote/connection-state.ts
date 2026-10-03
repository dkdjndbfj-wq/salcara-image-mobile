import type { DeviceStatus } from './client';
import type { RemoteState } from './store';

type TransportState = Pick<RemoteState, 'connection' | 'connectionError'>;
type DeviceConnection = Pick<DeviceStatus, 'online'>;

/** The most recent request reached the station and found this computer online. */
export function remoteDeviceConnected(remote: TransportState, device?: DeviceConnection): boolean {
  return remote.connection === 'open' && !remote.connectionError && device?.online === true;
}

export function remoteConnectionState(remote: TransportState, device?: DeviceConnection) {
  if (remote.connectionError || remote.connection === 'error') return {
    tone: 'error' as const, label: '连接中断', detail: '手机暂时连不上中转站或这台电脑，请检查网络后重试。',
  };
  if (remote.connection === 'connecting' || remote.connection === 'retrying') return {
    tone: 'pending' as const, label: '正在连接', detail: '正在连接中转站。',
  };
  if (remote.connection !== 'open') return {
    tone: 'offline' as const, label: '未连接', detail: '打开电脑列表或对话时会自动连接。',
  };
  if (!device?.online) return {
    tone: 'offline' as const, label: '电脑离线', detail: '中转站正常，但这台电脑当前不在线。请确认电脑开着，并且 Salcara Bridge 正在运行。',
  };
  return { tone: 'connected' as const, label: '已连接', detail: '手机已连上这台电脑。任务在电脑上运行，离开手机也不会中断。' };
}
