import { Animated } from 'react-native';
import { useRef } from 'react';
export default Animated;
export const useSharedValue = (value) => useRef({ value }).current;
export const useAnimatedStyle = (factory) => factory();
export const withSpring = (value) => value;
