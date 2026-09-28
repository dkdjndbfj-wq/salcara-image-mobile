import type { ChatApi } from '../domain';

/**
 * Popular model APIs, to fill in the address and protocol in one tap. Salcara itself provides no
 * model service: the user brings their own key for whichever vendor they like, and chat, drawing
 * and each voice function can each use a different one.
 */
export interface ChatPreset {
  id: string;
  name: string;
  region: 'cn' | 'global';
  baseUrl: string;
  chatApi: ChatApi;
  /** Preferred chat / image model when the model list comes back. */
  prefer?: RegExp;
  preferImage?: RegExp;
  keyUrl: string;
}

export const CHAT_PRESETS: ChatPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', region: 'cn', baseUrl: 'https://api.deepseek.com/v1', chatApi: 'chat-completions', prefer: /deepseek-chat/, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'dashscope', name: '通义千问', region: 'cn', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatApi: 'chat-completions', prefer: /^qwen-plus$|^qwen3/, preferImage: /qwen-image|wanx/, keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key' },
  { id: 'doubao', name: '豆包 · 火山方舟', region: 'cn', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', chatApi: 'chat-completions', prefer: /doubao/, preferImage: /seedream/, keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'moonshot', name: 'Kimi', region: 'cn', baseUrl: 'https://api.moonshot.cn/v1', chatApi: 'chat-completions', prefer: /kimi|moonshot/, keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'zhipu', name: '智谱 GLM', region: 'cn', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatApi: 'chat-completions', prefer: /^glm-/, preferImage: /cogview/, keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'minimax', name: 'MiniMax', region: 'cn', baseUrl: 'https://api.minimax.cn/v1', chatApi: 'chat-completions', prefer: /minimax/i, keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key' },
  { id: 'siliconflow', name: '硅基流动', region: 'cn', baseUrl: 'https://api.siliconflow.cn/v1', chatApi: 'chat-completions', prefer: /DeepSeek-V3|Qwen3/, preferImage: /FLUX|Kolors/i, keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'stepfun', name: '阶跃星辰', region: 'cn', baseUrl: 'https://api.stepfun.com/v1', chatApi: 'chat-completions', prefer: /^step-/, keyUrl: 'https://platform.stepfun.com/interface-key' },
  { id: 'qianfan', name: '百度千帆', region: 'cn', baseUrl: 'https://qianfan.baidubce.com/v2', chatApi: 'chat-completions', prefer: /ernie/i, keyUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list' },
  { id: 'hunyuan', name: '腾讯混元', region: 'cn', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', chatApi: 'chat-completions', prefer: /hunyuan/, keyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key' },
  { id: 'openai', name: 'OpenAI', region: 'global', baseUrl: 'https://api.openai.com/v1', chatApi: 'responses', prefer: /^gpt-/, preferImage: /gpt-image/, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Claude', region: 'global', baseUrl: 'https://api.anthropic.com/v1', chatApi: 'anthropic', prefer: /sonnet/, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', name: 'Gemini', region: 'global', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', chatApi: 'chat-completions', prefer: /gemini-.*flash/, preferImage: /imagen|image/, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'xai', name: 'Grok', region: 'global', baseUrl: 'https://api.x.ai/v1', chatApi: 'chat-completions', prefer: /^grok/, preferImage: /image/, keyUrl: 'https://console.x.ai' },
  { id: 'mistral', name: 'Mistral', region: 'global', baseUrl: 'https://api.mistral.ai/v1', chatApi: 'chat-completions', prefer: /mistral-(large|medium)/, keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'groq', name: 'Groq', region: 'global', baseUrl: 'https://api.groq.com/openai/v1', chatApi: 'chat-completions', prefer: /llama|qwen|gpt-oss/, keyUrl: 'https://console.groq.com/keys' },
  { id: 'openrouter', name: 'OpenRouter', region: 'global', baseUrl: 'https://openrouter.ai/api/v1', chatApi: 'chat-completions', prefer: /anthropic\/claude|openai\/gpt/, keyUrl: 'https://openrouter.ai/keys' },
];

export function presetFor(baseUrl: string): ChatPreset | null {
  const host = baseUrl.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  return CHAT_PRESETS.find((preset) => preset.baseUrl.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase() === host) ?? null;
}
