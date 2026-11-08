import React from 'react';
import { act, render } from '@testing-library/react-native';

const mockCreateReference = jest.fn();
const mockDeleteFile = jest.fn();
jest.mock('../image-inputs', () => ({ createReferenceFromGenerated: (...args: unknown[]) => mockCreateReference(...args) }));
jest.mock('../storage/files', () => ({ deleteLocalFile: (...args: unknown[]) => mockDeleteFile(...args) }));

import type { ReferenceImage } from '../domain';
import { useGeneratedImageDraft } from '../components/useGeneratedImageDraft';

type Options = Parameters<typeof useGeneratedImageDraft>[0];
let edit: ReturnType<typeof useGeneratedImageDraft>;
function Probe(props: Options) { edit = useGeneratedImageDraft(props); return null; }
const copy = (): ReferenceImage => ({ id: 'copy', uri: 'file:///references/copy.png', name: 'copy.png', mimeType: 'image/png', size: 100 });
const options = (patch: Partial<Options> = {}): Options => ({ contextKey: 'conversation', images: [], editingMessage: false, onAdd: jest.fn(), onError: jest.fn(), ...patch });

beforeEach(() => { jest.clearAllMocks(); });

test('edit imports an owned copy into the draft without sending or deleting the generated result', async () => {
  const props = options();
  mockCreateReference.mockResolvedValueOnce(copy());
  await render(<Probe {...props} />);
  await act(async () => { edit('file:///generated/original.png'); });
  expect(mockCreateReference).toHaveBeenCalledWith('file:///generated/original.png');
  expect(props.onAdd).toHaveBeenCalledWith(copy());
  expect(props.onError).not.toHaveBeenCalled();
  expect(mockDeleteFile).not.toHaveBeenCalled();
});

test.each(['conversation switch', 'send clears attachments', 'editing another message', 'unmount'] as const)('%s retires a pending edit import and cleans only its new copy', async (change) => {
  let finish!: (value: ReferenceImage) => void;
  mockCreateReference.mockImplementationOnce(() => new Promise<ReferenceImage>((resolve) => { finish = resolve; }));
  const props = options({ images: [copy()] });
  const view = await render(<Probe {...props} />);
  await act(async () => { edit('file:///generated/original.png'); });
  if (change === 'unmount') await view.unmount();
  else await view.rerender(<Probe {...props} {...(change === 'conversation switch' ? { contextKey: 'other' } : change === 'send clears attachments' ? { images: [] } : { editingMessage: true })} />);
  await act(async () => { finish(copy()); });
  expect(props.onAdd).not.toHaveBeenCalled();
  expect(props.onError).not.toHaveBeenCalled();
  expect(mockDeleteFile).toHaveBeenCalledTimes(1);
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///references/copy.png');
});

test('rapid repeated presses share one import; completion remains safe when the draft rejects it', async () => {
  let finish!: (value: ReferenceImage) => void;
  mockCreateReference.mockImplementationOnce(() => new Promise<ReferenceImage>((resolve) => { finish = resolve; }));
  const failure = new Error('参考图已满');
  const props = options({ onAdd: jest.fn(() => { throw failure; }) });
  await render(<Probe {...props} />);
  await act(async () => { edit('file:///generated/one.png'); edit('file:///generated/two.png'); });
  expect(mockCreateReference).toHaveBeenCalledTimes(1);
  await act(async () => { finish(copy()); });
  expect(props.onError).toHaveBeenCalledWith(failure);
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///references/copy.png');
});

test('returning to the original conversation does not revive an import retired by a switch', async () => {
  let finish!: (value: ReferenceImage) => void;
  mockCreateReference.mockImplementationOnce(() => new Promise<ReferenceImage>((resolve) => { finish = resolve; }));
  const props = options();
  const view = await render(<Probe {...props} />);
  await act(async () => { edit('file:///generated/original.png'); });
  await view.rerender(<Probe {...props} contextKey="other" />);
  await view.rerender(<Probe {...props} />);
  await act(async () => { finish(copy()); });
  expect(props.onAdd).not.toHaveBeenCalled();
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///references/copy.png');
});

test.each([options({ images: [copy(), copy(), copy(), copy()] }), options({ editingMessage: true })])('a full or editing draft does not begin an import', async (props) => {
  await render(<Probe {...props} />);
  await act(async () => { edit('file:///generated/original.png'); });
  expect(mockCreateReference).not.toHaveBeenCalled();
  expect(props.onError).toHaveBeenCalledTimes(1);
});
