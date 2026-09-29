import type { ChatApi } from '../domain';

/**
 * Every AI service Salcara can talk to, in one catalog. A service the user adds is just an address
 * and a key (plus, for a few speech vendors, one extra field such as a region); which of its models
 * does chat, drawing, recognition, synthesis or realtime voice is chosen separately, per function.
 * Salcara provides no model service of its own — only the downloadable on-device models run without an API.
 */

export type SpeechKind = 'stt' | 'tts' | 'realtime';
export type ServiceKind = 'chat' | 'image' | SpeechKind;
export type SttProtocol = 'openai' | 'azure' | 'google' | 'gemini' | 'deepgram' | 'elevenlabs' | 'volcengine' | 'dashscope' | 'baidu';
export type TtsProtocol = 'openai' | 'azure' | 'google' | 'gemini' | 'elevenlabs' | 'volcengine' | 'dashscope' | 'minimax' | 'fish' | 'baidu';
export type RealtimeProtocol = 'openai' | 'openai-beta' | 'qwen' | 'gemini';

export interface VendorField {
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

export interface VoiceOption { id: string; label: string }

export interface Capability<P extends string> {
  protocol: P;
  /** Known models, first = default. Models read from the service's /models list are added to these. */
  models: string[];
  voices?: VoiceOption[];
  /** Voice ids are free text (clones, custom voices): offer an input next to the chips. */
  customVoice?: boolean;
  /** Extra JSON merged into OpenAI-style request bodies. */
  extra?: Record<string, unknown>;
  note?: string;
}

export interface Vendor {
  id: string;
  name: string;
  region: 'cn' | 'global';
  blurb: string;
  /** Default API address. Absent: the vendor has fixed endpoints and no address field is shown. */
  baseUrl?: string;
  /** Where the vendor's own speech APIs live when that differs from the chat address (same host). */
  speechBaseUrl?: string;
  /** Present when the service does chat (OpenAI-compatible, Responses or Claude). */
  chatApi?: ChatApi;
  /** The service can draw (OpenAI-style /images endpoints). */
  image?: boolean;
  /** Preferred default models when a model list comes back. */
  prefer?: RegExp;
  preferImage?: RegExp;
  /** The service answers GET /models. */
  lists?: boolean;
  /** What the key is called in that vendor's console. */
  keyLabel?: string;
  /** Extra fields besides address and key (only where the vendor really needs them). */
  fields?: VendorField[];
  addressLabel?: string;
  addressPlaceholder?: string;
  keyUrl?: string;
  stt?: Capability<SttProtocol>;
  tts?: Capability<TtsProtocol>;
  realtime?: Capability<RealtimeProtocol>;
}

const OPENAI_VOICES: VoiceOption[] = [
  { id: 'marin', label: 'Marin · 温柔自然' }, { id: 'cedar', label: 'Cedar · 沉稳低音' }, { id: 'coral', label: 'Coral · 明亮活泼' },
  { id: 'sage', label: 'Sage · 平和知性' }, { id: 'verse', label: 'Verse · 富有表现力' }, { id: 'alloy', label: 'Alloy · 中性清晰' },
  { id: 'shimmer', label: 'Shimmer · 轻柔' }, { id: 'ash', label: 'Ash · 低沉' },
];
const GEMINI_VOICES: VoiceOption[] = [
  { id: 'Kore', label: 'Kore · 坚定' }, { id: 'Aoede', label: 'Aoede · 轻快' }, { id: 'Leda', label: 'Leda · 年轻' }, { id: 'Zephyr', label: 'Zephyr · 明亮' },
  { id: 'Puck', label: 'Puck · 欢快' }, { id: 'Charon', label: 'Charon · 知性' }, { id: 'Fenrir', label: 'Fenrir · 激昂' }, { id: 'Callirrhoe', label: 'Callirrhoe · 随和' },
];
const QWEN_VOICES: VoiceOption[] = [
  { id: 'Cherry', label: 'Cherry · 芊悦' }, { id: 'Serena', label: 'Serena · 苏瑶' }, { id: 'Ethan', label: 'Ethan · 晨煦' }, { id: 'Chelsie', label: 'Chelsie · 千雪' },
  { id: 'Dylan', label: 'Dylan · 北京话' }, { id: 'Jada', label: 'Jada · 上海话' }, { id: 'Sunny', label: 'Sunny · 四川话' },
];

export const VENDORS: Vendor[] = [
  // ——— 国内 ———
  { id: 'deepseek', name: 'DeepSeek', region: 'cn', blurb: '对话', baseUrl: 'https://api.deepseek.com/v1', chatApi: 'chat-completions', lists: true, prefer: /deepseek-chat/, keyUrl: 'https://platform.deepseek.com/api_keys' },
  {
    id: 'dashscope', name: '阿里云百炼 · 通义', region: 'cn', blurb: '对话、绘图、语音识别 / 合成、实时语音',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', speechBaseUrl: 'https://dashscope.aliyuncs.com', chatApi: 'chat-completions', lists: true, image: true,
    prefer: /^qwen-plus$|^qwen3/, preferImage: /qwen-image|wan/, keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    fields: [{ key: 'realtimeUrl', label: '实时地址', optional: true, placeholder: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', help: '只有使用业务空间专属地址时才需要填写' }],
    stt: { protocol: 'dashscope', models: ['qwen3-asr-flash'] },
    tts: { protocol: 'dashscope', models: ['qwen3-tts-flash', 'qwen-tts'], voices: QWEN_VOICES, customVoice: true },
    realtime: { protocol: 'qwen', models: ['qwen3.8-omni-flash-realtime', 'qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3-omni-flash-realtime'], voices: QWEN_VOICES, customVoice: true },
  },
  { id: 'doubao', name: '豆包 · 火山方舟', region: 'cn', blurb: '对话、绘图（Seedream）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', chatApi: 'chat-completions', lists: true, image: true, prefer: /doubao/, preferImage: /seedream/, keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  {
    id: 'volcengine', name: '豆包语音 · 火山引擎', region: 'cn', blurb: '语音识别、语音合成', keyLabel: 'API Key', keyUrl: 'https://console.volcengine.com/speech/app',
    fields: [{ key: 'appId', label: 'APP ID', optional: true, placeholder: '新版控制台留空', help: '新版控制台只填 API Key；旧版控制台填 APP ID，密钥处填 Access Token' }],
    stt: { protocol: 'volcengine', models: ['bigmodel'], note: '使用“大模型录音文件识别极速版”' },
    tts: {
      protocol: 'volcengine', models: ['自动（按音色）', 'seed-tts-2.0', 'seed-tts-1.0', 'seed-icl-2.0'], customVoice: true, note: '音色 ID 可在控制台“音色列表”查看，复刻音色以 S_ 开头',
      voices: [
        { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0' }, { id: 'zh_female_cancan_mars_bigtts', label: '灿灿' },
        { id: 'zh_female_shuangkuaisisi_moon_bigtts', label: '爽快思思' }, { id: 'zh_male_wennuanahu_moon_bigtts', label: '温暖阿虎' },
        { id: 'zh_male_beijingxiaoye_moon_bigtts', label: '北京小爷' }, { id: 'zh_female_wanwanxiaohe_moon_bigtts', label: '湾湾小何' },
      ],
    },
  },
  { id: 'moonshot', name: 'Kimi', region: 'cn', blurb: '对话', baseUrl: 'https://api.moonshot.cn/v1', chatApi: 'chat-completions', lists: true, prefer: /kimi|moonshot/, keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  {
    id: 'zhipu', name: '智谱 GLM', region: 'cn', blurb: '对话、绘图、语音识别 / 合成', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatApi: 'chat-completions', lists: true, image: true,
    prefer: /^glm-/, preferImage: /cogview/, keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    stt: { protocol: 'openai', models: ['glm-asr'] },
    tts: { protocol: 'openai', models: ['glm-tts'], voices: ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'].map((id) => ({ id, label: id })) },
  },
  {
    id: 'minimax', name: 'MiniMax', region: 'cn', blurb: '对话、语音合成', baseUrl: 'https://api.minimax.cn/v1', speechBaseUrl: 'https://api.minimax.cn', chatApi: 'chat-completions', lists: true,
    prefer: /minimax/i, keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    tts: {
      protocol: 'minimax', models: ['speech-2.8-turbo', 'speech-2.8-hd', 'speech-2.6-turbo', 'speech-02-turbo'], customVoice: true,
      voices: [
        { id: 'female-shaonv', label: '少女' }, { id: 'female-yujie', label: '御姐' }, { id: 'female-chengshu', label: '成熟女性' },
        { id: 'male-qn-qingse', label: '青涩青年' }, { id: 'male-qn-jingying', label: '精英青年' }, { id: 'presenter_female', label: '女主持' },
      ],
    },
  },
  {
    id: 'siliconflow', name: '硅基流动', region: 'cn', blurb: '对话、绘图、语音识别 / 合成', baseUrl: 'https://api.siliconflow.cn/v1', chatApi: 'chat-completions', lists: true, image: true,
    prefer: /DeepSeek-V3|Qwen3/, preferImage: /FLUX|Kolors|Qwen-Image/i, keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    stt: { protocol: 'openai', models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'] },
    tts: {
      protocol: 'openai', models: ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5'], extra: { sample_rate: 24000, stream: true }, customVoice: true,
      voices: ['anna', 'bella', 'claire', 'diana', 'alex', 'benjamin', 'charles', 'david'].map((id) => ({ id, label: id })),
      note: '音色会自动拼成“模型:音色”，也可以填自己上传的音色 URI',
    },
  },
  {
    id: 'stepfun', name: '阶跃星辰', region: 'cn', blurb: '对话、语音识别 / 合成、实时语音', baseUrl: 'https://api.stepfun.com/v1', chatApi: 'chat-completions', lists: true,
    prefer: /^step-/, keyUrl: 'https://platform.stepfun.com/interface-key',
    stt: { protocol: 'openai', models: ['step-asr'] },
    tts: {
      protocol: 'openai', models: ['step-tts-mini', 'step-tts-2'], customVoice: true,
      voices: [
        { id: 'wenrounvsheng', label: '温柔女声' }, { id: 'jilingshaonv', label: '机灵少女' }, { id: 'yuanqishaonv', label: '元气少女' },
        { id: 'cixingnansheng', label: '磁性男声' }, { id: 'zhengpaiqingnian', label: '正派青年' }, { id: 'wenjingxuejie', label: '文静学姐' },
      ],
    },
    realtime: { protocol: 'openai-beta', models: ['stepaudio-2.5-realtime', 'step-audio-2', 'step-audio-2-mini', 'step-1o-audio'], customVoice: true, voices: [{ id: 'qingchunshaonv', label: '青春少女' }, { id: 'wenrounansheng', label: '温柔男声' }] },
  },
  { id: 'qianfan', name: '百度千帆', region: 'cn', blurb: '对话（文心）', baseUrl: 'https://qianfan.baidubce.com/v2', chatApi: 'chat-completions', lists: true, prefer: /ernie/i, keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list' },
  {
    id: 'baidu', name: '百度语音', region: 'cn', blurb: '短语音识别、在线语音合成', keyUrl: 'https://console.bce.baidu.com/ai/#/ai/speech/app/list',
    fields: [{ key: 'secretKey', label: 'Secret Key', secret: true }],
    stt: { protocol: 'baidu', models: ['1537', '1737', '1637'], note: '模型：1537 普通话 · 1737 英语 · 1637 粤语' },
    tts: {
      protocol: 'baidu', models: ['标准'], customVoice: true,
      voices: [{ id: '5118', label: '度小鹿' }, { id: '0', label: '度小美' }, { id: '1', label: '度小宇' }, { id: '4', label: '度丫丫' }, { id: '106', label: '度博文' }, { id: '110', label: '度小童' }],
    },
  },
  { id: 'hunyuan', name: '腾讯混元', region: 'cn', blurb: '对话', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', chatApi: 'chat-completions', lists: true, prefer: /hunyuan/, keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key' },
  // ——— 海外 ———
  {
    id: 'openai', name: 'OpenAI', region: 'global', blurb: '对话、绘图、语音识别 / 合成、实时语音', baseUrl: 'https://api.openai.com/v1', chatApi: 'responses', lists: true, image: true,
    prefer: /^gpt-/, preferImage: /gpt-image/, keyUrl: 'https://platform.openai.com/api-keys',
    stt: { protocol: 'openai', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'] },
    tts: { protocol: 'openai', models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'], voices: OPENAI_VOICES, customVoice: true },
    realtime: { protocol: 'openai', models: ['gpt-realtime-2.1', 'gpt-realtime', 'gpt-realtime-mini'], voices: OPENAI_VOICES, customVoice: true },
  },
  { id: 'anthropic', name: 'Claude', region: 'global', blurb: '对话', baseUrl: 'https://api.anthropic.com/v1', chatApi: 'anthropic', lists: true, prefer: /sonnet/, keyUrl: 'https://console.anthropic.com/settings/keys' },
  {
    id: 'gemini', name: 'Google Gemini', region: 'global', blurb: '对话、绘图、语音识别 / 合成、Live 实时语音',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', speechBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', chatApi: 'chat-completions', lists: true, image: true,
    prefer: /gemini-.*flash/, preferImage: /imagen|image/, keyUrl: 'https://aistudio.google.com/apikey',
    stt: { protocol: 'gemini', models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'] },
    tts: { protocol: 'gemini', models: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'], voices: GEMINI_VOICES, customVoice: true },
    realtime: { protocol: 'gemini', models: ['gemini-3.8-live', 'gemini-3.8-live-extended-thinking'], voices: GEMINI_VOICES, customVoice: true },
  },
  { id: 'xai', name: 'Grok', region: 'global', blurb: '对话、绘图', baseUrl: 'https://api.x.ai/v1', chatApi: 'chat-completions', lists: true, image: true, prefer: /^grok/, preferImage: /image/, keyUrl: 'https://console.x.ai' },
  { id: 'mistral', name: 'Mistral', region: 'global', blurb: '对话', baseUrl: 'https://api.mistral.ai/v1', chatApi: 'chat-completions', lists: true, prefer: /mistral-(large|medium)/, keyUrl: 'https://console.mistral.ai/api-keys' },
  {
    id: 'groq', name: 'Groq', region: 'global', blurb: '对话、极快的 Whisper 识别', baseUrl: 'https://api.groq.com/openai/v1', chatApi: 'chat-completions', lists: true,
    prefer: /llama|qwen|gpt-oss/, keyUrl: 'https://console.groq.com/keys',
    stt: { protocol: 'openai', models: ['whisper-large-v3-turbo', 'whisper-large-v3'] },
  },
  { id: 'openrouter', name: 'OpenRouter', region: 'global', blurb: '对话（聚合各家模型）', baseUrl: 'https://openrouter.ai/api/v1', chatApi: 'chat-completions', lists: true, prefer: /anthropic\/claude|openai\/gpt/, keyUrl: 'https://openrouter.ai/keys' },
  {
    id: 'azure-openai', name: 'Azure OpenAI', region: 'global', blurb: 'Azure 上部署的 GPT 语音模型', addressLabel: '终结点', addressPlaceholder: 'https://xxx.openai.azure.com', keyLabel: '密钥',
    keyUrl: 'https://portal.azure.com',
    stt: { protocol: 'openai', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper'], note: '模型处填部署名称' },
    tts: { protocol: 'openai', models: ['gpt-4o-mini-tts', 'tts'], voices: OPENAI_VOICES, note: '模型处填部署名称' },
    realtime: { protocol: 'openai', models: ['gpt-realtime', 'gpt-realtime-mini'], voices: OPENAI_VOICES, note: '模型处填部署名称' },
  },
  {
    id: 'azure-speech', name: 'Azure AI 语音', region: 'global', blurb: '微软语音识别与神经网络语音', keyLabel: '密钥',
    fields: [{ key: 'region', label: '区域', placeholder: 'eastasia', help: '资源所在区域，如 eastasia、eastus' }],
    keyUrl: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/SpeechServices',
    stt: { protocol: 'azure', models: ['zh-CN', 'en-US', 'zh-HK', 'zh-TW', 'ja-JP'], note: '模型处选择识别语言' },
    tts: {
      protocol: 'azure', models: ['Neural'], customVoice: true,
      voices: [
        { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓' }, { id: 'zh-CN-XiaoyiNeural', label: '晓伊' }, { id: 'zh-CN-YunxiNeural', label: '云希' },
        { id: 'zh-CN-YunjianNeural', label: '云健' }, { id: 'zh-CN-XiaochenMultilingualNeural', label: '晓辰 · 多语言' }, { id: 'en-US-AvaMultilingualNeural', label: 'Ava · 多语言' },
      ],
    },
  },
  {
    id: 'google-cloud', name: 'Google Cloud 语音', region: 'global', blurb: 'Speech-to-Text 与 Text-to-Speech', keyUrl: 'https://console.cloud.google.com/apis/credentials',
    stt: { protocol: 'google', models: ['cmn-Hans-CN', 'en-US', 'yue-Hant-HK', 'ja-JP'], note: '模型处选择识别语言' },
    tts: {
      protocol: 'google', models: ['cmn-CN'], customVoice: true,
      voices: [{ id: 'cmn-CN-Chirp3-HD-Aoede', label: 'Aoede · Chirp3' }, { id: 'cmn-CN-Chirp3-HD-Leda', label: 'Leda · Chirp3' }, { id: 'cmn-CN-Chirp3-HD-Charon', label: 'Charon · Chirp3' }, { id: 'cmn-CN-Wavenet-A', label: 'Wavenet A' }],
    },
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs', region: 'global', blurb: '高拟真音色与 Scribe 识别', keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    stt: { protocol: 'elevenlabs', models: ['scribe_v2', 'scribe_v1'] },
    tts: {
      protocol: 'elevenlabs', models: ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3'], customVoice: true, note: '音色填 Voice ID',
      voices: [{ id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel' }, { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah' }, { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte' }, { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam' }],
    },
  },
  { id: 'deepgram', name: 'Deepgram', region: 'global', blurb: 'Nova 语音识别', keyUrl: 'https://console.deepgram.com', stt: { protocol: 'deepgram', models: ['nova-3', 'nova-2'] } },
  { id: 'fish', name: 'Fish Audio', region: 'global', blurb: '声音克隆与多语言合成', keyUrl: 'https://fish.audio/app/api-keys', tts: { protocol: 'fish', models: ['s2.1-pro', 's1'], customVoice: true, voices: [], note: '音色填声音模型的 reference_id，留空使用默认音色' } },
  {
    id: 'custom', name: '其他 · OpenAI 兼容', region: 'global', blurb: '中转站、自建服务，对话 / 绘图 / 语音都可用', baseUrl: '', chatApi: 'chat-completions', lists: true, image: true,
    addressPlaceholder: 'https://example.com/v1',
    stt: { protocol: 'openai', models: ['gpt-4o-mini-transcribe', 'whisper-1'] },
    tts: { protocol: 'openai', models: ['gpt-4o-mini-tts', 'tts-1'], voices: OPENAI_VOICES, customVoice: true },
    realtime: { protocol: 'openai', models: ['gpt-realtime-2.1', 'gpt-realtime'], voices: OPENAI_VOICES, customVoice: true },
  },
];

export function vendorById(id: string | null | undefined): Vendor | null {
  return VENDORS.find((vendor) => vendor.id === id) ?? null;
}

const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
const pathOf = (url: string) => {
  const rest = url.replace(/^[a-z]+:\/\//i, '');
  const index = rest.indexOf('/');
  return index < 0 ? '' : rest.slice(index).replace(/\/+$/, '');
};

/** The catalog entry for a service: its stored vendor, else the one whose address matches, else “custom”. */
export function vendorForService(service: { vendor?: string | null; baseUrl: string; chatApi?: ChatApi } | null | undefined): Vendor {
  const stored = vendorById(service?.vendor);
  if (stored) return stored;
  const host = hostOf(service?.baseUrl ?? '');
  const byHost = host ? VENDORS.find((vendor) => vendor.baseUrl && hostOf(vendor.baseUrl) === host) : null;
  if (byHost) return byHost;
  // An unknown address speaking Claude's protocol has no speech or image APIs.
  if (service?.chatApi === 'anthropic') return { ...vendorById('custom')!, chatApi: 'anthropic', image: false, stt: undefined, tts: undefined, realtime: undefined };
  return vendorById('custom')!;
}

export function capabilityOf(vendor: Vendor, kind: SpeechKind): Capability<string> | undefined {
  return vendor[kind] as Capability<string> | undefined;
}

export function supports(vendor: Vendor, kind: ServiceKind): boolean {
  if (kind === 'chat') return Boolean(vendor.chatApi);
  if (kind === 'image') return Boolean(vendor.image);
  return Boolean(vendor[kind]);
}

/**
 * The address the vendor's speech APIs use. When the user's address is the vendor's chat address
 * (official or a proxy with the same path), its chat path is swapped for the speech path.
 */
export function speechBaseFor(vendor: Vendor, baseUrl: string): string {
  const base = (baseUrl || vendor.baseUrl || '').trim().replace(/\/+$/, '');
  if (!vendor.speechBaseUrl || !vendor.baseUrl) return base;
  const chatPath = pathOf(vendor.baseUrl);
  const speechPath = pathOf(vendor.speechBaseUrl);
  if (chatPath && base.endsWith(chatPath)) return `${base.slice(0, base.length - chatPath.length)}${speechPath}`;
  return base;
}

export const KIND_LABEL: Record<ServiceKind, string> = { chat: '对话', image: '绘图', stt: '识别', tts: '合成', realtime: '实时' };
export const KIND_TITLE: Record<ServiceKind, string> = { chat: '对话模型', image: '绘图模型', stt: '语音识别', tts: '语音合成', realtime: '实时语音' };

const IMAGE_MODEL = /image|dall-e|flux|imagen|seedream|midjourney|sd-|stable|cogview|kolors|wanx|wan2|hidream/i;
const STT_MODEL = /asr|transcri|whisper|sensevoice|paraformer|scribe|speech-?to|stt|nova-/i;
const TTS_MODEL = /tts|cosyvoice|speech-\d|text-?to-?speech|voice|sambert/i;
const REALTIME_MODEL = /realtime|live|omni.*real|audio/i;

/** Which of a service's listed models fit a function. */
export function modelFits(kind: ServiceKind, model: string): boolean {
  switch (kind) {
    case 'image': return IMAGE_MODEL.test(model);
    case 'stt': return STT_MODEL.test(model) && !REALTIME_MODEL.test(model);
    case 'tts': return TTS_MODEL.test(model) && !REALTIME_MODEL.test(model) && !STT_MODEL.test(model);
    case 'realtime': return /realtime|-live|omni/i.test(model);
    default: return !IMAGE_MODEL.test(model) && !STT_MODEL.test(model) && !TTS_MODEL.test(model) && !/realtime|embedding|rerank|moderation/i.test(model);
  }
}

/** Models to offer for a function: the vendor's known ones first, then fitting ones from the service's list. */
export function modelsFor(vendor: Vendor, kind: ServiceKind, listed: string[] = []): string[] {
  const known = kind === 'chat' || kind === 'image' ? [] : capabilityOf(vendor, kind)?.models ?? [];
  const fitting = listed.filter((model) => modelFits(kind, model));
  return [...new Set([...known, ...fitting])];
}

/** A sensible default model for a function on this service. */
export function defaultModel(vendor: Vendor, kind: ServiceKind, listed: string[] = []): string {
  const options = modelsFor(vendor, kind, listed);
  const prefer = kind === 'chat' ? vendor.prefer : kind === 'image' ? vendor.preferImage ?? /gpt-image/i : null;
  return (prefer && options.find((model) => prefer.test(model))) || options[0] || '';
}
