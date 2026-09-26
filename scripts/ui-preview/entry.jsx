import React from 'react';
import { createRoot } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ChatScreen } from '../../src/screens/ChatScreen';
import { PreviewProvider } from './state';
createRoot(document.getElementById('root')).render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}><PreviewProvider><ChatScreen /></PreviewProvider></SafeAreaProvider>);
