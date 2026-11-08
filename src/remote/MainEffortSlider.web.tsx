import React, { useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { colors } from '../theme';
import type Slider from '@react-native-community/slider';

/** A browser-native range preserves keyboard and touch semantics. */
export default function MainEffortSlider({ minimumValue = 0, maximumValue = 1, step = 1, value = 0, disabled, onValueChange, onSlidingComplete, style, testID, accessibilityLabel, accessibilityValue }: React.ComponentProps<typeof Slider>) {
  const [focused, setFocused] = useState(false), pointerActive = useRef(false);
  return <div style={{ ...StyleSheet.flatten(style) as React.CSSProperties, outline: focused ? `2px solid ${colors.textMuted}` : undefined, outlineOffset: 3, borderRadius: 12 }}>
    <input data-testid={testID} type="range" min={minimumValue} max={maximumValue} step={step} value={value} disabled={disabled}
      aria-label={accessibilityLabel} aria-valuetext={accessibilityValue?.text} aria-valuenow={value} aria-valuemin={minimumValue} aria-valuemax={maximumValue}
      onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); pointerActive.current = false; }}
      onPointerDown={() => { pointerActive.current = true; }} onPointerCancel={() => { pointerActive.current = false; }}
      onChange={event => { if (!disabled) onValueChange?.(Number(event.currentTarget.value)); }}
      onPointerUp={event => { if (!disabled && pointerActive.current) onSlidingComplete?.(Number(event.currentTarget.value)); pointerActive.current = false; }}
      onKeyUp={event => { if (!disabled && ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) onSlidingComplete?.(Number(event.currentTarget.value)); }}
      style={{ display: 'block', width: '100%', height: '100%', margin: 0, opacity: 0, cursor: disabled ? 'default' : 'pointer', touchAction: 'none' }} />
  </div>;
}
