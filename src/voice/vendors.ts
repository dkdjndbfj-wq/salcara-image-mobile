/**
 * Speech vendors the app can talk to. Salcara provides no speech service of its own: every cloud
 * function (recognition, synthesis, realtime conversation) is a call to an API the user configures,
 * and each function can use a different vendor — e.g. DeepSeek for the chat model, OpenAI for the
 * voice and 豆包 for recognition. Only the downloadable on-device models run without an API.
 */

export type SpeechKind = 'stt' | 'tts' | 'realtime';
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
  fields: VendorField[];
  /** Default API base (for vendors whose URL can be changed, e.g. a proxy or another region). */
  baseUrl?: string;
  keyUrl?: string;
  stt?: Capability<SttProtocol>;
  tts?: Capability<TtsProtocol>;
  realtime?: Capability<RealtimeProtocol>;
}

const KEY: VendorField = { key: 'apiKey', label: 'API Key', secret: true };
const BASE = (placeholder: string): VendorField => ({ key: 'baseUrl', label: 'API 地址', optional: true, placeholder, help: '留空使用官方地址；也可以填中转或其他区域的地址' });

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
  {
    id: 'openai', name: 'OpenAI', region: 'global', blurb: '识别、合成、实时语音都有', fields: [KEY, BASE('https://api.openai.com/v1')],
    baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys',
    stt: { protocol: 'openai', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'] },
    tts: { protocol: 'openai', models: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'], voices: OPENAI_VOICES },
    realtime: { protocol: 'openai', models: ['gpt-realtime-2.1', 'gpt-realtime', 'gpt-realtime-mini'], voices: OPENAI_VOICES },
  },
  {
    id: 'dashscope', name: '阿里云百炼 · 通义', region: 'cn', blurb: 'Qwen-ASR、Qwen-TTS、Qwen-Omni 实时语音',
    fields: [KEY, BASE('https://dashscope.aliyuncs.com'), { key: 'realtimeUrl', label: '实时语音地址', optional: true, placeholder: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', help: '使用业务空间专属地址时填写' }],
    baseUrl: 'https://dashscope.aliyuncs.com', keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    stt: { protocol: 'dashscope', models: ['qwen3-asr-flash'] },
    tts: { protocol: 'dashscope', models: ['qwen3-tts-flash', 'qwen-tts'], voices: QWEN_VOICES, customVoice: true },
    realtime: { protocol: 'qwen', models: ['qwen3.8-omni-flash-realtime', 'qwen3.5-omni-plus-realtime', 'qwen3.5-omni-flash-realtime', 'qwen3-omni-flash-realtime'], voices: QWEN_VOICES, customVoice: true },
  },
  {
    id: 'volcengine', name: '火山引擎 · 豆包语音', region: 'cn', blurb: '豆包大模型识别（极速版）与语音合成',
    fields: [
      { key: 'appId', label: 'APP ID', optional: true, placeholder: '使用新版 API Key 时留空', help: '旧版控制台：填 APP ID，下面填 Access Token；新版控制台：只填 API Key' },
      { key: 'accessKey', label: 'API Key / Access Token', secret: true },
    ],
    keyUrl: 'https://console.volcengine.com/speech/app',
    stt: { protocol: 'volcengine', models: ['bigmodel'], note: '使用“大模型录音文件识别极速版”' },
    tts: {
      protocol: 'volcengine', models: ['自动（按音色）'], customVoice: true, note: '音色 ID 可在控制台“音色列表”查看，复刻音色以 S_ 开头',
      voices: [
        { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0' }, { id: 'zh_female_cancan_mars_bigtts', label: '灿灿' },
        { id: 'zh_female_shuangkuaisisi_moon_bigtts', label: '爽快思思' }, { id: 'zh_male_wennuanahu_moon_bigtts', label: '温暖阿虎' },
        { id: 'zh_male_beijingxiaoye_moon_bigtts', label: '北京小爷' }, { id: 'zh_female_wanwanxiaohe_moon_bigtts', label: '湾湾小何' },
      ],
    },
  },
  {
    id: 'siliconflow', name: '硅基流动', region: 'cn', blurb: 'SenseVoice 识别、CosyVoice 合成', fields: [KEY, BASE('https://api.siliconflow.cn/v1')],
    baseUrl: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    stt: { protocol: 'openai', models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'] },
    tts: {
      protocol: 'openai', models: ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5'], extra: { sample_rate: 24000, stream: true }, customVoice: true,
      voices: ['anna', 'bella', 'claire', 'diana', 'alex', 'benjamin', 'charles', 'david'].map((id) => ({ id, label: id })),
      note: '音色会自动拼成“模型:音色”，也可以填自己上传的音色 URI',
    },
  },
  {
    id: 'zhipu', name: '智谱 · GLM', region: 'cn', blurb: 'GLM-ASR 识别、GLM-TTS 合成', fields: [KEY, BASE('https://open.bigmodel.cn/api/paas/v4')],
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    stt: { protocol: 'openai', models: ['glm-asr'] },
    tts: { protocol: 'openai', models: ['glm-tts'], voices: ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'].map((id) => ({ id, label: id })) },
  },
  {
    id: 'minimax', name: 'MiniMax', region: 'cn', blurb: 'Speech 语音合成，音色丰富', fields: [KEY, BASE('https://api.minimax.cn')],
    baseUrl: 'https://api.minimax.cn', keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    tts: {
      protocol: 'minimax', models: ['speech-2.8-turbo', 'speech-2.8-hd', 'speech-2.6-turbo', 'speech-02-turbo'], customVoice: true,
      voices: [
        { id: 'female-shaonv', label: '少女' }, { id: 'female-yujie', label: '御姐' }, { id: 'female-chengshu', label: '成熟女性' },
        { id: 'male-qn-qingse', label: '青涩青年' }, { id: 'male-qn-jingying', label: '精英青年' }, { id: 'presenter_female', label: '女主持' },
      ],
    },
  },
  {
    id: 'stepfun', name: '阶跃星辰', region: 'cn', blurb: 'Step 语音识别、合成与实时语音', fields: [KEY, BASE('https://api.stepfun.com/v1')],
    baseUrl: 'https://api.stepfun.com/v1', keyUrl: 'https://platform.stepfun.com/interface-key',
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
  {
    id: 'baidu', name: '百度智能云', region: 'cn', blurb: '短语音识别、在线语音合成',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true }, { key: 'secretKey', label: 'Secret Key', secret: true }],
    keyUrl: 'https://console.bce.baidu.com/ai/#/ai/speech/app/list',
    stt: { protocol: 'baidu', models: ['1537', '1737', '1637'], note: '模型：1537 普通话 · 1737 英语 · 1637 粤语' },
    tts: {
      protocol: 'baidu', models: ['标准'], customVoice: true,
      voices: [{ id: '5118', label: '度小鹿' }, { id: '0', label: '度小美' }, { id: '1', label: '度小宇' }, { id: '4', label: '度丫丫' }, { id: '106', label: '度博文' }, { id: '110', label: '度小童' }],
    },
  },
  {
    id: 'gemini', name: 'Google Gemini', region: 'global', blurb: 'Gemini 识别、TTS 与 Live 实时语音', fields: [KEY, BASE('https://generativelanguage.googleapis.com/v1beta')],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/apikey',
    stt: { protocol: 'gemini', models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'] },
    tts: { protocol: 'gemini', models: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'], voices: GEMINI_VOICES, customVoice: true },
    realtime: { protocol: 'gemini', models: ['gemini-3.8-live', 'gemini-3.8-live-extended-thinking'], voices: GEMINI_VOICES, customVoice: true },
  },
  {
    id: 'azure-speech', name: 'Azure AI 语音', region: 'global', blurb: '微软语音识别与神经网络语音',
    fields: [{ key: 'region', label: '区域', placeholder: 'eastasia', help: '资源所在区域，如 eastasia、eastus' }, { key: 'apiKey', label: '密钥', secret: true }],
    keyUrl: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/SpeechServices',
    stt: { protocol: 'azure', models: ['zh-CN', 'en-US', 'zh-HK', 'zh-TW', 'ja-JP'], note: '模型处填识别语言' },
    tts: {
      protocol: 'azure', models: ['Neural'], customVoice: true,
      voices: [
        { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓' }, { id: 'zh-CN-XiaoyiNeural', label: '晓伊' }, { id: 'zh-CN-YunxiNeural', label: '云希' },
        { id: 'zh-CN-YunjianNeural', label: '云健' }, { id: 'zh-CN-XiaochenMultilingualNeural', label: '晓辰 · 多语言' }, { id: 'en-US-AvaMultilingualNeural', label: 'Ava · 多语言' },
      ],
    },
  },
  {
    id: 'azure-openai', name: 'Azure OpenAI', region: 'global', blurb: 'Azure 上部署的 GPT 语音模型',
    fields: [{ key: 'endpoint', label: '终结点', placeholder: 'https://xxx.openai.azure.com' }, { key: 'apiKey', label: '密钥', secret: true }],
    stt: { protocol: 'openai', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper'], note: '模型处填部署名称' },
    tts: { protocol: 'openai', models: ['gpt-4o-mini-tts', 'tts'], voices: OPENAI_VOICES, note: '模型处填部署名称' },
    realtime: { protocol: 'openai', models: ['gpt-realtime', 'gpt-realtime-mini'], voices: OPENAI_VOICES, note: '模型处填部署名称' },
  },
  {
    id: 'google-cloud', name: 'Google Cloud 语音', region: 'global', blurb: 'Speech-to-Text 与 Text-to-Speech',
    fields: [{ key: 'apiKey', label: 'API Key', secret: true }], keyUrl: 'https://console.cloud.google.com/apis/credentials',
    stt: { protocol: 'google', models: ['cmn-Hans-CN', 'en-US', 'yue-Hant-HK', 'ja-JP'], note: '模型处填识别语言' },
    tts: {
      protocol: 'google', models: ['cmn-CN'], customVoice: true,
      voices: [{ id: 'cmn-CN-Chirp3-HD-Aoede', label: 'Aoede · Chirp3' }, { id: 'cmn-CN-Chirp3-HD-Leda', label: 'Leda · Chirp3' }, { id: 'cmn-CN-Chirp3-HD-Charon', label: 'Charon · Chirp3' }, { id: 'cmn-CN-Wavenet-A', label: 'Wavenet A' }],
    },
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs', region: 'global', blurb: '高拟真音色与 Scribe 识别', fields: [KEY], keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    stt: { protocol: 'elevenlabs', models: ['scribe_v2', 'scribe_v1'] },
    tts: {
      protocol: 'elevenlabs', models: ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3'], customVoice: true, note: '音色填 Voice ID',
      voices: [{ id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel' }, { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah' }, { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte' }, { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam' }],
    },
  },
  {
    id: 'deepgram', name: 'Deepgram', region: 'global', blurb: 'Nova 语音识别', fields: [KEY], keyUrl: 'https://console.deepgram.com',
    stt: { protocol: 'deepgram', models: ['nova-3', 'nova-2'] },
  },
  {
    id: 'groq', name: 'Groq', region: 'global', blurb: '极快的 Whisper 识别', fields: [KEY, BASE('https://api.groq.com/openai/v1')],
    baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys',
    stt: { protocol: 'openai', models: ['whisper-large-v3-turbo', 'whisper-large-v3'] },
  },
  {
    id: 'fish', name: 'Fish Audio', region: 'global', blurb: '声音克隆与多语言合成', fields: [KEY], keyUrl: 'https://fish.audio/app/api-keys',
    tts: { protocol: 'fish', models: ['s2.1-pro', 's1'], customVoice: true, voices: [], note: '音色填声音模型的 reference_id，留空使用默认音色' },
  },
  {
    id: 'custom', name: '其他 OpenAI 兼容', region: 'global', blurb: '中转站或自建服务（/audio、/realtime 接口）',
    fields: [{ key: 'baseUrl', label: 'API 地址', placeholder: 'https://example.com/v1' }, KEY],
    stt: { protocol: 'openai', models: ['gpt-4o-mini-transcribe', 'whisper-1'] },
    tts: { protocol: 'openai', models: ['gpt-4o-mini-tts', 'tts-1'], voices: OPENAI_VOICES, customVoice: true },
    realtime: { protocol: 'openai', models: ['gpt-realtime-2.1', 'gpt-realtime'], voices: OPENAI_VOICES, customVoice: true },
  },
];

export function vendorById(id: string | null | undefined): Vendor | null {
  return VENDORS.find((vendor) => vendor.id === id) ?? null;
}

export function capabilityOf(vendor: Vendor, kind: SpeechKind): Capability<string> | undefined {
  return vendor[kind] as Capability<string> | undefined;
}

export const KIND_LABEL: Record<SpeechKind, string> = { stt: '识别', tts: '合成', realtime: '实时' };
