import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useReducedMotion } from '../components/ui';
import { colors, shadow, themed } from '../theme';
import type { QuestionAnswers, RemoteQuestion } from './client';
import { QuestionCard } from './QuestionCard';
import { captureDissolveTexture, ComposerDissolve, COMPOSER_DISSOLVE_MS, type SurfaceTexture } from './ComposerDissolve';

interface QuestionRequest { id: string; title: string; questions?: RemoteQuestion[]; expiresAt?: number }

/** Separate floating input surface; the conversation list never contains the form. */
export function QuestionDock({ question, busy, blocked, availableHeight, initialAnswers, onAnswer, onCancel, children }: {
  question: QuestionRequest | null; busy: boolean; blocked?: string; availableHeight?: number; children: ReactNode;
  onAnswer: (answers: QuestionAnswers) => void; onCancel: () => void;
  initialAnswers?: QuestionAnswers;
}) {
  const styles = useStyles();
  const reduced = useReducedMotion();
  const [presented, setPresented] = useState<QuestionRequest | null>(question);
  const [composerMounted, setComposerMounted] = useState(true);
  const [dissolving, setDissolving] = useState(false);
  const [popupDissolving, setPopupDissolving] = useState(false);
  const [composerTexture, setComposerTexture] = useState<SurfaceTexture>();
  const [popupTexture, setPopupTexture] = useState<SurfaceTexture>();
  const composerContent = useRef<View>(null), popupContent = useRef<View>(null);
  const composerSize = useRef({ width: 0, height: 0 }), popupSize = useRef({ width: 0, height: 0 });
  const composer = useRef(new Animated.Value(1)).current;
  const popup = useRef(new Animated.Value(0)).current;
  const popupGrain = useRef(new Animated.Value(1)).current;
  const popupReady = useRef(false);
  const height = useRef(new Animated.Value(108)).current;
  const composerHeight = useRef(108);
  const popupHeight = useRef(236);
  const previous = useRef<string | null>(null);
  const active = useRef(question); active.current = question;
  const heightAnimation = useRef<Animated.CompositeAnimation | null>(null);
  const resize = (target: number) => {
    heightAnimation.current?.stop();
    if (reduced) { height.setValue(target); return; }
    const animation = Animated.timing(height, { toValue: target, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    heightAnimation.current = animation; animation.start();
  };
  useEffect(() => () => heightAnimation.current?.stop(), []);
  useEffect(() => {
    let live = true;
    const animations: Animated.CompositeAnimation[] = [];
    const transition = (value: Animated.Value, target: number, duration: number, done?: () => void, reverse = false) => {
      const animation = Animated.timing(value, { toValue: target, duration, easing: Easing.bezier(0.4, 0, 0.2, 1), useNativeDriver: true });
      animations.push(animation);
      animation.start(({ finished }) => { if (finished && live) done?.(); });
    };
    const hadQuestion = previous.current !== null;
    previous.current = question?.id ?? null;
    if (reduced) {
      setPresented(question); setComposerMounted(!question); setDissolving(false); setPopupDissolving(false);
      setComposerTexture(undefined); setPopupTexture(undefined);
      composer.setValue(question ? 0 : 1); popup.setValue(question ? 1 : 0); popupGrain.setValue(1); popupReady.current = Boolean(question);
      resize(question ? popupHeight.current : composerHeight.current);
    } else if (question) {
      setPresented(question);
      popupGrain.setValue(1); setPopupDissolving(false); setPopupTexture(undefined);
      if (hadQuestion) { composer.setValue(0); setComposerMounted(false); setDissolving(false); popup.setValue(1); popupReady.current = true; }
      else {
        popup.setValue(0); popupReady.current = false;
        void (async () => {
          const texture = composerTexture ?? await captureDissolveTexture(composerContent, composerSize.current);
          if (!live) return;
          setComposerTexture(texture); setDissolving(true);
          transition(composer, 0, COMPOSER_DISSOLVE_MS, () => {
            setComposerMounted(false); setDissolving(false); resize(popupHeight.current);
            popupReady.current = true;
            transition(popup, 1, 160);
          });
        })();
      }
    } else if (hadQuestion) {
      const restore = () => {
        setPresented(null); setPopupDissolving(false); setPopupTexture(undefined); popupReady.current = false;
        setComposerMounted(true); setDissolving(true); resize(composerHeight.current);
        transition(composer, 1, COMPOSER_DISSOLVE_MS, () => { setDissolving(false); setComposerTexture(undefined); }, true);
      };
      if (popupReady.current) {
        composer.setValue(0); setComposerMounted(false); setDissolving(false);
        void (async () => {
          const texture = await captureDissolveTexture(popupContent, popupSize.current);
          if (!live) return;
          setPopupTexture(texture); setPopupDissolving(true);
          transition(popupGrain, 0, COMPOSER_DISSOLVE_MS, restore);
        })();
      } else restore(); // A withdrawn question must not animate a popup that never appeared.
    }
    return () => { live = false; animations.forEach((animation) => animation.stop()); };
  }, [question?.id, reduced]); // eslint-disable-line react-hooks/exhaustive-deps
  // A status/expiry update must not remount or erase the user's answers.
  const request = question?.id === presented?.id ? question : presented;
  const hidingComposer = Boolean(question || presented || dissolving);
  const onComposerLayout = (event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.height);
    if (measured <= 0) return;
    composerHeight.current = measured;
    composerSize.current = { width: event.nativeEvent.layout.width, height: measured };
    if (!active.current) resize(measured);
  };
  const onPopupLayout = (event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.height) + 16;
    if (measured <= 16) return;
    popupHeight.current = measured;
    popupSize.current = { width: event.nativeEvent.layout.width, height: measured - 16 };
    if (active.current) resize(measured);
  };
  return <Animated.View testID="remote-input-dock" style={[styles.dock, { height }]}>
    {composerMounted ? <Animated.View onLayout={onComposerLayout} testID="remote-composer-surface" pointerEvents={hidingComposer ? 'none' : 'auto'}
      accessibilityElementsHidden={hidingComposer} importantForAccessibility={hidingComposer ? 'no-hide-descendants' : 'auto'}
      style={[styles.surface, { opacity: composerTexture ? composer.interpolate({ inputRange: [0, 0.075, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }) : composer }]}>
      <View ref={composerContent} collapsable={false} style={{ opacity: composerTexture && dissolving ? 0 : 1 }}>{children}</View>
      {dissolving ? <ComposerDissolve progress={composer} texture={composerTexture} /> : null}
    </Animated.View> : null}
    {request ? <Animated.View onLayout={onPopupLayout} testID="remote-question-dialog" role="dialog" accessibilityLabel="回答 Agent 的问题" accessibilityViewIsModal pointerEvents={question ? 'auto' : 'none'}
      style={[styles.popup, { opacity: Animated.multiply(popup, popupTexture ? popupGrain.interpolate({ inputRange: [0, 0.075, 1], outputRange: [0, 1, 1], extrapolate: 'clamp' }) : popupGrain), transform: [{ translateY: popup.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }]}>
      <View ref={popupContent} collapsable={false} style={[styles.popupBody, { opacity: popupTexture && popupDissolving ? 0 : 1 }]}>
      <QuestionCard key={request.id} id={request.id} title={request.title} questions={request.questions ?? []} expiresAt={request.expiresAt}
        initialAnswers={initialAnswers}
        busy={busy || question?.id !== request.id} blocked={blocked} maxBodyHeight={availableHeight ? Math.max(48, availableHeight * 0.6 - 112) : undefined} onAnswer={onAnswer} onCancel={onCancel} />
      </View>
      {popupDissolving ? <ComposerDissolve progress={popupGrain} texture={popupTexture} testId="remote-question" /> : null}
    </Animated.View> : null}
  </Animated.View>;
}
const useStyles = themed((c, d) => StyleSheet.create({
  dock: { flexShrink: 0, position: 'relative' }, surface: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  popup: { position: 'absolute', left: 12, right: 12, bottom: 8 },
  popupBody: { borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, borderColor: d.lineStrong, backgroundColor: d.surface, shadowColor: d.shadow, shadowOpacity: 0.1, shadowRadius: 22, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
}));
