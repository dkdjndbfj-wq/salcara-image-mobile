import { Ionicons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Defs, Mask, Path, Rect } from 'react-native-svg';

import type { ReferenceImage } from '../domain';
import { saveBase64Png } from '../storage/files';
import { colors, radius, spacing } from '../theme';

type Point = { x: number; y: number };
type Stroke = { id: number; mode: 'draw' | 'erase'; size: number; points: Point[] };

export function MaskEditor({
  visible,
  image,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  image: ReferenceImage | null;
  onCancel: () => void;
  onConfirm: (maskUri: string | null) => void;
}) {
  const window = useWindowDimensions();
  const [sourceSize, setSourceSize] = useState({ width: 1, height: 1 });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redo, setRedo] = useState<Stroke[]>([]);
  const [clearBackup, setClearBackup] = useState<Stroke[] | null>(null);
  const [activeStroke, setActiveStroke] = useState<Stroke | null>(null);
  const activeRef = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<'draw' | 'erase'>('draw');
  const [brushSize, setBrushSize] = useState(28);
  const [saving, setSaving] = useState(false);
  const maskSvgRef = useRef<Svg>(null);

  useEffect(() => {
    if (!visible || !image) return;
    setStrokes([]);
    setRedo([]);
    setClearBackup(null);
    if (image.width && image.height) {
      setSourceSize({ width: image.width, height: image.height });
    } else {
      Image.getSize(image.uri, (width, height) => setSourceSize({ width, height }), () => setSourceSize({ width: 1024, height: 1024 }));
    }
  }, [visible, image]);

  const maxWidth = window.width - spacing.xl * 2;
  const maxHeight = Math.min(window.height * 0.56, 560);
  const sourceRatio = sourceSize.width / sourceSize.height;
  const canvasWidth = Math.min(maxWidth, maxHeight * sourceRatio);
  const canvasHeight = canvasWidth / sourceRatio;

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      const next: Stroke = {
        id: Date.now(),
        mode: tool,
        size: brushSize,
        points: [{ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }],
      };
      activeRef.current = next;
      setActiveStroke(next);
      setRedo([]);
      setClearBackup(null);
    },
    onPanResponderMove: (event) => {
      if (!activeRef.current) return;
      const next = { ...activeRef.current, points: [...activeRef.current.points, { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }] };
      activeRef.current = next;
      setActiveStroke(next);
    },
    onPanResponderRelease: () => {
      if (activeRef.current) setStrokes((current) => [...current, activeRef.current as Stroke]);
      activeRef.current = null;
      setActiveStroke(null);
    },
    onPanResponderTerminate: () => {
      activeRef.current = null;
      setActiveStroke(null);
    },
  }), [tool, brushSize]);

  const allStrokes = activeStroke ? [...strokes, activeStroke] : strokes;
  const undo = () => {
    if (strokes.length) {
      const last = strokes[strokes.length - 1];
      setStrokes(strokes.slice(0, -1));
      setRedo((current) => [...current, last]);
    } else if (clearBackup) {
      setStrokes(clearBackup);
      setClearBackup(null);
    }
  };
  const redoStroke = () => {
    const last = redo[redo.length - 1];
    if (!last) return;
    setRedo(redo.slice(0, -1));
    setStrokes((current) => [...current, last]);
  };
  const clear = () => {
    if (strokes.length) setClearBackup(strokes);
    setStrokes([]);
    setRedo([]);
  };

  const confirm = async () => {
    if (strokes.length === 0) {
      onConfirm(null);
      return;
    }
    try {
      setSaving(true);
      const base64 = await new Promise<string>((resolve, reject) => {
        if (!maskSvgRef.current) {
          reject(new Error('蒙版尚未准备好'));
          return;
        }
        maskSvgRef.current.toDataURL(resolve, { width: sourceSize.width, height: sourceSize.height });
      });
      onConfirm(saveBase64Png(base64.replace(/^data:image\/png;base64,/, '')));
    } finally {
      setSaving(false);
    }
  };

  if (!image) return null;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} style={styles.headerButton}><Text style={styles.cancel}>取消</Text></Pressable>
          <View style={styles.headerCenter}><Text style={styles.title}>编辑蒙版</Text><Text style={styles.subtitle}>红色区域将被重新生成</Text></View>
          <Pressable disabled={saving} onPress={() => void confirm()} style={styles.headerButton}>
            {saving ? <ActivityIndicator color={colors.primaryStrong} /> : <Text style={styles.done}>完成</Text>}
          </Pressable>
        </View>

        <View style={styles.canvasArea}>
          <View style={[styles.canvas, { width: canvasWidth, height: canvasHeight }]}>
            <Svg ref={maskSvgRef} width={canvasWidth} height={canvasHeight} viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} style={styles.hiddenMask}>
              <Defs>
                <Mask id="final-mask">
                  <Rect width={canvasWidth} height={canvasHeight} fill="white" />
                  {strokes.map((stroke) => <Path key={stroke.id} d={pathFor(stroke.points)} fill="none" stroke={stroke.mode === 'draw' ? 'black' : 'white'} strokeWidth={stroke.size} strokeLinecap="round" strokeLinejoin="round" />)}
                </Mask>
              </Defs>
              <Rect width={canvasWidth} height={canvasHeight} fill="white" mask="url(#final-mask)" />
            </Svg>
            <Image source={{ uri: image.uri }} resizeMode="contain" style={StyleSheet.absoluteFill} />
            <Svg width={canvasWidth} height={canvasHeight} style={StyleSheet.absoluteFill} pointerEvents="none">
              <Defs>
                <Mask id="red-mask">
                  <Rect width={canvasWidth} height={canvasHeight} fill="black" />
                  {allStrokes.map((stroke) => <Path key={stroke.id} d={pathFor(stroke.points)} fill="none" stroke={stroke.mode === 'draw' ? 'white' : 'black'} strokeWidth={stroke.size} strokeLinecap="round" strokeLinejoin="round" />)}
                </Mask>
              </Defs>
              <Rect width={canvasWidth} height={canvasHeight} fill={colors.mask} mask="url(#red-mask)" />
            </Svg>
            <View style={StyleSheet.absoluteFill} {...responder.panHandlers} />
          </View>
        </View>

        <View style={styles.controls}>
          <View style={styles.toolRow}>
            <Tool icon="brush" label="画笔" active={tool === 'draw'} onPress={() => setTool('draw')} />
            <Tool icon="color-fill-outline" label="橡皮擦" active={tool === 'erase'} onPress={() => setTool('erase')} />
            <Tool icon="arrow-undo" label="撤销" disabled={!strokes.length && !clearBackup} onPress={undo} />
            <Tool icon="arrow-redo" label="重做" disabled={!redo.length} onPress={redoStroke} />
            <Tool icon="trash-outline" label="清空" disabled={!strokes.length} onPress={clear} />
          </View>
          <View style={styles.sliderRow}>
            <Text style={styles.sliderLabel}>笔刷</Text>
            <Slider style={styles.slider} minimumValue={8} maximumValue={72} step={2} value={brushSize} onValueChange={setBrushSize} minimumTrackTintColor={colors.primary} maximumTrackTintColor={colors.border} thumbTintColor={colors.primaryStrong} />
            <View style={[styles.brushPreview, { width: Math.max(12, brushSize / 2), height: Math.max(12, brushSize / 2), borderRadius: brushSize }]} />
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function Tool({ icon, label, active, disabled, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; active?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.tool, active && styles.activeTool, disabled && styles.disabled]}>
      <Ionicons name={icon} size={21} color={active ? colors.primaryStrong : colors.text} />
      <Text style={[styles.toolText, active && styles.activeToolText]}>{label}</Text>
    </Pressable>
  );
}

function pathFor(points: Point[]): string {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} L ${points[0].x + 0.1} ${points[0].y + 0.1}`;
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 68, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.sm },
  headerButton: { minWidth: 64, height: 48, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center' },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  cancel: { color: colors.textMuted, fontWeight: '600' },
  done: { color: colors.primaryStrong, fontWeight: '700' },
  canvasArea: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.surface },
  canvas: { overflow: 'hidden', borderRadius: radius.md, backgroundColor: '#DDE3EA', borderWidth: 1, borderColor: colors.border },
  hiddenMask: { position: 'absolute', zIndex: -1 },
  controls: { padding: spacing.lg, gap: spacing.lg, borderTopWidth: 1, borderColor: colors.border },
  toolRow: { flexDirection: 'row', justifyContent: 'space-between' },
  tool: { minWidth: 54, minHeight: 54, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: radius.md },
  activeTool: { backgroundColor: colors.blueSurface },
  disabled: { opacity: 0.35 },
  toolText: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
  activeToolText: { color: colors.primaryStrong },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sliderLabel: { color: colors.text, fontWeight: '700', fontSize: 13 },
  slider: { flex: 1, height: 36 },
  brushPreview: { backgroundColor: colors.mask, borderWidth: 1, borderColor: colors.danger },
});
