import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import React, { useCallback, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LaunchIntro } from './src/components/LaunchIntro';
import { ChatScreen } from './src/screens/ChatScreen';
import { AppProvider, useApp } from './src/state/AppContext';

void SplashScreen.preventAutoHideAsync();
// The intro's first frame matches the splash, so only a very short cross-fade is needed.
SplashScreen.setOptions({ duration: 120, fade: true });

function AppContent() {
  const { ready } = useApp();
  const [intro, setIntro] = useState(true);
  const hideSplash = useCallback(() => { void SplashScreen.hideAsync().catch(() => undefined); }, []);
  const finishIntro = useCallback(() => setIntro(false), []);

  return (
    <>
      <StatusBar style="dark" />
      <ChatScreen />
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
