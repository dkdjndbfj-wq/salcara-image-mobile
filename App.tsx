import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import React, { useCallback, useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { CompanionScreen } from './src/companion/CompanionScreen';
import { SpaceTransition } from './src/companion/SpaceTransition';
import { LaunchIntro } from './src/components/LaunchIntro';
import { ChatScreen } from './src/screens/ChatScreen';
import { RemoteScreen } from './src/remote/RemoteScreen';
import { useRemoteLink } from './src/remote/useRemoteLink';
import { AppProvider, useApp } from './src/state/AppContext';
import { loadAppearance } from './src/appearance';
import { useScheme } from './src/theme';

void SplashScreen.preventAutoHideAsync();
// The intro's first frame matches the splash, so only a very short cross-fade is needed.
SplashScreen.setOptions({ duration: 120, fade: true });

function AppContent() {
  const { ready, space, switchSpace } = useApp();
  // Approval alerts from the computer jump straight into the 编程 space.
  useRemoteLink(() => switchSpace('remote'));
  const [intro, setIntro] = useState(true);
  const hideSplash = useCallback(() => { void SplashScreen.hideAsync().catch(() => undefined); }, []);
  const finishIntro = useCallback(() => setIntro(false), []);
  const scheme = useScheme();
  // 设置 → 外观 (follow the system unless the person picked light or dark).
  useEffect(() => { void loadAppearance(); }, []);

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <SpaceTransition space={space}>{(shown) => (shown === 'companion' ? <CompanionScreen /> : shown === 'remote' ? <RemoteScreen /> : <ChatScreen />)}</SpaceTransition>
      {intro && <LaunchIntro ready={ready} onFirstFrame={hideSplash} onDone={finishIntro} />}
    </>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <AppContent />
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
