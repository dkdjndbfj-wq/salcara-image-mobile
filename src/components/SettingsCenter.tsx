import React, { useState } from 'react';

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
  const [page, setPage] = useState<'providers' | 'models' | 'voice' | 'personal' | 'tools' | 'agents' | 'memory' | 'about' | 'network' | null>(null);
  const [updateToken, setUpdateToken] = useState(0);
  const [modelsTab, setModelsTab] = useState<'chat' | 'image'>('chat');
  const close = () => setPage(null);
  const main = app.chatProvider ?? app.imageProvider;
  return <>
    <AppSettingsSheet visible={visible} onClose={onClose}
      onOpenProviders={() => setPage('providers')} onOpenModels={(tab) => { setModelsTab(tab ?? 'chat'); setPage('models'); }} onOpenVoice={() => setPage('voice')}
      onOpenPersonalization={() => setPage('personal')} onOpenTools={() => setPage('tools')} onOpenAgents={() => setPage('agents')}
      onOpenMemoryBox={() => setPage('memory')} onOpenNetwork={() => setPage('network')} onOpenAbout={() => setPage('about')}
      onCheckUpdates={() => setUpdateToken((value) => value + 1)} />
    <ProviderManager visible={page === 'providers'} onClose={close} />
    <ModelSwitcher visible={page === 'models'} initialTab={modelsTab} onClose={close} onManageProviders={() => setPage('providers')} />
    <VoiceSettingsSheet visible={page === 'voice'} onClose={close} />
    <PersonalizationSheet visible={page === 'personal'} onClose={close} />
    <ToolsSheet visible={page === 'tools'} onClose={close} />
    <MemoryBoxSettingsSheet visible={page === 'memory'} onClose={close} />
    <AboutSheet visible={page === 'about'} onClose={close} onCheckUpdates={() => setUpdateToken((value) => value + 1)} />
    <NetworkDiagnostics visible={page === 'network'} onClose={close} providerId={main?.id ?? ''} baseUrl={main?.baseUrl ?? ''} api={app.chatProvider?.chatApi} />
    {updateToken ? <UpdateManager manualCheckToken={updateToken} /> : null}
  </>;
}
