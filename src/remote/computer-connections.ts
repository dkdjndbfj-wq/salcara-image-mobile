import type { IconName } from '../components/Icon';
import type { RemoteConnection } from './connections';

export type ComputerSelection =
  | { kind: 'relay'; connectionId: string; deviceId: string }
  | { kind: 'bot'; connectionId: string; deviceId: string }
  | { kind: 'direct'; deviceId: string }
  | { kind: 'demo'; deviceId: string };

export const connectionKind = (profile: RemoteConnection): 'relay' | 'bot' => profile.botGroupId ? 'bot' : 'relay';
export const connectionModeLabel = (kind: ComputerSelection['kind']) => ({ relay: '中转站', bot: 'Bot', direct: '直连', demo: '演示' })[kind];
export const connectionModeIcon = (kind: ComputerSelection['kind']): IconName => ({ relay: 'server', bot: 'bot', direct: 'link', demo: 'laptop' } as const)[kind];
export function connectionSelection(profile: RemoteConnection): ComputerSelection {
  return { kind: connectionKind(profile), connectionId: profile.id, deviceId: profile.deviceId };
}
