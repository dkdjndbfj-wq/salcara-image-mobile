import React from 'react';
import { View } from 'react-native';
const gesture = () => {
  const handler = {};
  for (const method of ['enabled', 'onBegin', 'onStart', 'onUpdate', 'onChange', 'onEnd', 'onFinalize', 'onTouchesDown', 'averageTouches', 'numberOfTaps']) handler[method] = () => handler;
  return handler;
};
export const Gesture = { Pinch: gesture, Pan: gesture, Tap: gesture, Simultaneous: (...items) => ({ items }) };
export const GestureDetector = ({ children }) => children;
export const GestureHandlerRootView = View;
