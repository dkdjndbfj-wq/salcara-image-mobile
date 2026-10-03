import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { showToast } from '../components/ui';
import { useApp } from '../state/AppContext';
import { bootRemote, onApprovalAlert, setRemoteFocus, setRemoteForeground } from './store';
import { startRemoteNotifications } from './notifications';
import { startRemotePush } from './push';

const TOOL_NAMES: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };

/** Restore pairing locally; network access is demand-driven by the visible remote workspace. */
export function useRemoteLink(onOpen: () => void) {
  const { providers, ready } = useApp();
  const openRef = useRef(onOpen); openRef.current = onOpen;
  useEffect(() => { if (ready) void bootRemote(providers).catch(() => undefined); }, [providers, ready]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: string) => setRemoteForeground(next === 'active'));
    return () => subscription?.remove?.();
  }, []);
  // Task finished / needs approval notifications; a tap opens that thread.
  useEffect(() => startRemoteNotifications(() => openRef.current()), []);
  useEffect(() => startRemotePush(), []);
  useEffect(() => onApprovalAlert((approval) => {
    showToast(`电脑上的 ${TOOL_NAMES[approval.tool] ?? approval.tool} 需要你批准：${approval.title}`, 'code', () => { setRemoteFocus({ deviceId: approval.deviceId, sessionKey: approval.sessionKey }); openRef.current(); });
  }), []);
}
