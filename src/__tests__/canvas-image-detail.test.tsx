import React, { createRef, useState } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { CanvasImageStage, type CanvasImageStageHandle, type CanvasImageView } from '../remote/CanvasImageStage';
import { canvasDetailRegion } from '../remote/canvas-image-detail';
import type { ImagePixelRegion } from '../remote/image-dimensions';

let mockDetailError = false, mockDetailPending = false;
const mockRequests: Array<{ uri: string; variant: string; region?: ImagePixelRegion }> = [];
jest.mock('../remote/attachment-cache-policy', () => ({ retainCachedAttachment: () => () => undefined }));
jest.mock('../remote/useManagedImage', () => ({ useManagedImage: (uri: string, variant: string, visible = true, region?: ImagePixelRegion) => {
  if (visible) mockRequests.push({ uri, variant, region });
  if (!visible) return { foreground: true };
  if (variant === 'preview') return { uri: `${uri}/preview`, foreground: true, resource: { uri: `${uri}/preview`, width: 1600, height: 1200, originalWidth: 4000, originalHeight: 3000 } };
  if (mockDetailError) return { error: 'failure', foreground: true };
  if (mockDetailPending) return { loading: true, foreground: true };
  return { uri: `${uri}/detail`, foreground: true, resource: { uri: `${uri}/detail`, width: region?.width, height: region?.height, originalWidth: 4000, originalHeight: 3000, region } };
} }));
const stage = createRef<CanvasImageStageHandle>();
function Harness({ uri = 'file://one.png' }: { uri?: string }) {
  const [view, setView] = useState<CanvasImageView>({ zoom: null, x: 0, y: 0 });
  return <CanvasImageStage key={uri} ref={stage} image={{ id: uri, messageId: 'message', role: 'assistant', name: 'test.png', uri, width: 4000, height: 3000 }} height={500} view={view} onView={setView} marking={false} onRegion={() => undefined} notes={[]} onLocate={() => undefined} onRetry={() => undefined} />;
}
beforeEach(() => { mockRequests.length = 0; mockDetailError = mockDetailPending = false; });

test('visible source-pixel regions are bounded, quantized and reject invalid geometry', () => {
  expect(canvasDetailRegion({ width: 4000, height: 3000 }, { width: 500, height: 500 }, { left: -1750, top: -1250, zoom: 1 })).toEqual({ originX: 1664, originY: 1152, width: 704, height: 704 });
  expect(canvasDetailRegion({ width: 4000, height: 3000 }, { width: 500, height: 500 }, { left: 0, top: 0, zoom: 1 })).toEqual({ originX: 0, originY: 0, width: 576, height: 576 });
  expect(canvasDetailRegion({ width: 4000, height: 3000 }, { width: 500, height: 500 }, { left: 0, top: 0, zoom: NaN })).toBeUndefined();
});

test('fit mode uses the base preview; original size requests a high resolution visible tile without replacing the base', async () => {
  const view = await render(<Harness />);
  await fireEvent(view.getByTestId('canvas-image-viewport'), 'layout', { nativeEvent: { layout: { width: 500, height: 500 } } });
  expect(mockRequests.some(request => request.variant === 'detail')).toBe(false);
  await act(async () => { stage.current?.zoom('original'); });
  await waitFor(() => expect(view.getByTestId('canvas-detail-image')).toBeTruthy());
  expect(view.getByTestId('canvas-focused-image').props.source.uri).toBe('file://one.png/preview');
  expect(view.getByTestId('canvas-detail-image').props.source.uri).toBe('file://one.png/detail');
  const region = mockRequests.filter(request => request.variant === 'detail').at(-1)!.region!;
  expect(region.width * region.height).toBeLessThan(1_500_000);
  await act(async () => { stage.current?.zoom('fit'); }); expect(view.queryByTestId('canvas-detail-image')).toBeNull();
});

test('detail failure preserves the preview and supports retry, then changing image cannot reuse the old tile', async () => {
  mockDetailError = true;
  const view = await render(<Harness />);
  await fireEvent(view.getByTestId('canvas-image-viewport'), 'layout', { nativeEvent: { layout: { width: 500, height: 500 } } });
  await act(async () => { stage.current?.zoom('original'); });
  await waitFor(() => expect(view.getByLabelText('重试高清查看')).toBeTruthy());
  expect(view.getByTestId('canvas-focused-image')).toBeTruthy(); expect(view.queryByTestId('canvas-detail-image')).toBeNull();
  mockDetailError = false; await fireEvent.press(view.getByLabelText('重试高清查看')); expect(view.getByTestId('canvas-detail-image')).toBeTruthy();
  await view.rerender(<Harness uri="file://two.png" />);
  expect(view.queryByTestId('canvas-detail-image')).toBeNull(); expect(view.getByTestId('canvas-focused-image').props.source.uri).toBe('file://two.png/preview');
});
