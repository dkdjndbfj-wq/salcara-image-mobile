import React, { useEffect, useState } from 'react';

import { MemoryBoxSettingsSheet } from '../companion/MemoryBoxSettingsSheet';
import { useApp } from '../state/AppContext';
import { AboutSheet } from './AboutSheet';
import { AppSettingsSheet } from './AppSettingsSheet';
import { ModelSwitcher } from './ModelSwitcher';
import { NetworkDiagnostics } from './NetworkDiagnostics';
import { PersonalizationSheet } from './PersonalizationSheet';
import { ProviderManager } from './ProviderManager';
import { ToolsSheet } from './ToolsSheet';
import { UpdateManager } from './UpdateManager';
import { VoiceSettingsSheet } from './VoiceSettingsSheet';

/**
 * The full settings page with every sub-page, for screens that don't host them themselves (the chat
 * space). Services, models and voice are shared by both spaces, so this is the same settings as the
 * assistant's.
 */
export function SettingsCenter({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const app = useApp();
  type SettingsPage = 'providers' | 'models' | 'voice' | 'personal' | 'tools' | 'agents' | 'memory' | 'about' | 'network';
  const [page, setPage] = useState<SettingsPage | null>(null);
  const [mountedPage, setMountedPage] = useState<SettingsPage | null>(null);
  const [updateToken, setUpdateToken] = useState(0);
  const [modelsTab, setModelsTab] = useState<'chat' | 'image'>('chat');
  const close = () => setPage(null);
  const open = (next: SettingsPage) => { setMountedPage(next); setPage(next); };
  useEffect(() => {
    if (page) { setMountedPage(page); return undefined; }
    if (!mountedPage) return undefined;
    const timer = setTimeout(() => setMountedPage(null), 260);
    return () => clearTimeout(timer);
  }, [page, mountedPage]);
  const main = app.chatProvider ?? app.imageProvider;
  return <>
    <AppSettingsSheet visible={visible} onClose={onClose}
      onOpenProviders={() => open('providers')} onOpenModels={(tab) => { setModelsTab(tab ?? 'chat'); open('models'); }} onOpenVoice={() => open('voice')}
      onOpenPersonalization={() => open('personal')} onOpenTools={() => open('tools')} onOpenAgents={() => open('agents')}
      onOpenMemoryBox={() => open('memory')} onOpenNetwork={() => open('network')} onOpenAbout={() => open('about')} onOpenRemote={() => { onClose(); app.switchSpace('remote'); }}
      onCheckUpdates={() => setUpdateToken((value) => value + 1)} />
    {mountedPage === 'providers' ? <ProviderManager visible={page === 'providers'} onClose={close} /> : null}
    {mountedPage === 'models' ? <ModelSwitcher visible={page === 'models'} initialTab={modelsTab} onClose={close} onManageProviders={() => open('providers')} /> : null}
    {mountedPage === 'voice' ? <VoiceSettingsSheet visible={page === 'voice'} onClose={close} /> : null}
    {mountedPage === 'personal' ? <PersonalizationSheet visible={page === 'personal'} onClose={close} /> : null}
    {mountedPage === 'tools' ? <ToolsSheet visible={page === 'tools'} onClose={close} /> : null}
    {mountedPage === 'memory' ? <MemoryBoxSettingsSheet visible={page === 'memory'} onClose={close} /> : null}
    {mountedPage === 'about' ? <AboutSheet visible={page === 'about'} onClose={close} onCheckUpdates={() => setUpdateToken((value) => value + 1)} /> : null}
    {mountedPage === 'network' ? <NetworkDiagnostics visible={page === 'network'} onClose={close} providerId={main?.id ?? ''} baseUrl={main?.baseUrl ?? ''} api={app.chatProvider?.chatApi} /> : null}
    {updateToken ? <UpdateManager manualCheckToken={updateToken} /> : null}
  </>;
}
