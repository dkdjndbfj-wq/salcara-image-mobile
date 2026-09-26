import React from 'react';
import { View } from 'react-native';
const gesture = () => { const handler = { onUpdate: () => handler, onEnd: () => handler, numberOfTaps: () => handler }; return handler; };
export const Gesture = { Pinch: gesture, Pan: gesture, Tap: gesture, Simultaneous: () => ({}) };
export const GestureDetector = ({ children }) => children;
export const GestureHandlerRootView = View;
