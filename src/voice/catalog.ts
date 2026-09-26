/**
 * On-device speech recognition models (sherpa-onnx, int8). Files are fetched
 * one by one from Hugging Face — or its mainland-China mirror — so nothing has
 * to be unpacked on the phone. Sizes are exact and double as integrity checks.
 */
export type AsrModelId = 'zipformer-bilingual' | 'paraformer-bilingual' | 'sensevoice';
export type DownloadMirror = 'huggingface' | 'hf-mirror';

export interface ModelFile {
  repo: string;
  name: string;
  size: number;
  /** Role passed to the native recognizer. */
  role: 'encoder' | 'decoder' | 'joiner' | 'model' | 'tokens' | 'vad';
}

export interface AsrModel {
  id: AsrModelId;
  name: string;
  tier: '极速' | '均衡' | '精准';
  recommended?: boolean;
  kind: 'online-transducer' | 'online-paraformer' | 'offline-sensevoice';
  streaming: boolean;
  languages: string;
  summary: string;
  files: ModelFile[];
}

export const ASR_MODELS: AsrModel[] = [
  {
    id: 'zipformer-bilingual',
    name: 'Zipformer 中英流式',
    tier: '极速',
    kind: 'online-transducer',
    streaming: true,
    languages: '中文 · 英文',
    summary: '解码最快、最省电，边说边出字，适合日常短句输入。',
    files: [
      { repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20', name: 'encoder-epoch-99-avg-1.int8.onnx', size: 181_895_032, role: 'encoder' },
      { repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20', name: 'decoder-epoch-99-avg-1.onnx', size: 13_876_452, role: 'decoder' },
      { repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20', name: 'joiner-epoch-99-avg-1.int8.onnx', size: 3_228_404, role: 'joiner' },
      { repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20', name: 'tokens.txt', size: 56_317, role: 'tokens' },
    ],
  },
  {
    id: 'paraformer-bilingual',
    name: 'Paraformer 中英流式',
    tier: '均衡',
    recommended: true,
    kind: 'online-paraformer',
    streaming: true,
    languages: '中文 · 英文 · 中英混说',
    summary: '中文准确率明显更高，依然实时出字，速度与效果最均衡。',
    files: [
      { repo: 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en', name: 'encoder.int8.onnx', size: 165_462_184, role: 'encoder' },
      { repo: 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en', name: 'decoder.int8.onnx', size: 71_664_561, role: 'decoder' },
      { repo: 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en', name: 'tokens.txt', size: 75_756, role: 'tokens' },
    ],
  },
  {
    id: 'sensevoice',
    name: 'SenseVoice 多语种',
    tier: '精准',
    kind: 'offline-sensevoice',
    streaming: false,
    languages: '中 · 英 · 日 · 韩 · 粤',
    summary: '识别最准，自带标点和数字规整；配合语音活动检测，边说边刷新整句。',
    files: [
      { repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', name: 'model.int8.onnx', size: 239_233_841, role: 'model' },
      { repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', name: 'tokens.txt', size: 315_894, role: 'tokens' },
      { repo: 'csukuangfj/vad', name: 'silero_vad.onnx', size: 1_807_522, role: 'vad' },
    ],
  },
];

export const MIRRORS: Record<DownloadMirror, { label: string; host: string }> = {
  huggingface: { label: 'Hugging Face', host: 'https://huggingface.co' },
  'hf-mirror': { label: '国内镜像', host: 'https://hf-mirror.com' },
};

export function modelById(id: string | null | undefined): AsrModel | null {
  return ASR_MODELS.find((model) => model.id === id) ?? null;
}

export function modelSize(model: AsrModel): number {
  return model.files.reduce((sum, file) => sum + file.size, 0);
}

export function fileUrl(file: ModelFile, mirror: DownloadMirror): string {
  return `${MIRRORS[mirror].host}/${file.repo}/resolve/main/${encodeURIComponent(file.name)}`;
}

/** Local file name: repo-prefixed where needed so files from different repos never clash. */
export function localName(file: ModelFile): string {
  return file.role === 'vad' ? `vad-${file.name}` : file.name;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Native recognizer options for an installed model directory (plain paths, no file://). */
export function recognizerOptions(model: AsrModel, directory: string, endSilence = 0.8) {
  const dir = directory.replace(/^file:\/\//, '').replace(/\/+$/, '');
  const path = (role: ModelFile['role']) => {
    const file = model.files.find((item) => item.role === role);
    return file ? `${dir}/${localName(file)}` : '';
  };
  return {
    kind: model.kind,
    encoder: path('encoder'),
    decoder: path('decoder'),
    joiner: path('joiner'),
    model: path('model'),
    tokens: path('tokens'),
    vad: path('vad'),
    numThreads: 2,
    endSilence,
  };
}
