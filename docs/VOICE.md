# 语音输入与 Live 语音对话

## 组成

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 原生语音模块 | `modules/salcara-voice` | 麦克风采集（对话时开启回声消除/降噪/免提）、音量、PCM 推流、按停顿切句、WAV 录制、sherpa-onnx 本地识别、PCM 流式播放、系统 TTS |
| 本地模型 | `src/voice/catalog.ts` / `models.ts` | 从 Hugging Face 或 hf-mirror 按文件下载（无需解压），精确校验大小，可取消、断点续传（按文件）、删除 |
| 语音输入 | `src/voice/useDictation.ts` + `Composer` | 本地模型边说边出字；云端模式录音后调用 `/audio/transcriptions` |
| Live 对话 | `src/voice/useVoiceConversation.ts` + `LiveMode` | 分段语音与实时语音模型两种引擎，自动回退 |

## 本地模型（sherpa-onnx 1.13.7，int8）

- 极速：Zipformer 中英流式（约 199 MB）
- 均衡·推荐：Paraformer 中英流式（约 237 MB）
- 精准：SenseVoice 中英日韩粤 + Silero VAD（约 241 MB，自带标点；VAD 切句，说话过程中每 0.6 秒刷新整句）

原生库只打包 `arm64-v8a`（APK 约增加 17 MB）。其它 ABI 上 `engineAvailable()` 返回 false，界面引导使用云端识别。
Gradle 在首次构建时从 GitHub Releases 下载官方 AAR 并解出 `classes.jar` 与 `.so`（排除 `libc++_shared.so`，由 React Native 提供）。

## Live 对话引擎

- **分段语音（任意服务商）**：识别（本地模型或云端）→ 当前对话模型（`voice: true` 时要求口语化、简短、无 Markdown）→ 按句流式合成（`/audio/speech`，24 kHz PCM）或手机系统语音。对话照常写入会话，也能继续画图。
- **实时语音模型**：OpenAI Realtime（默认 `gpt-realtime-2.1`）WebSocket，24 kHz PCM 双向，服务端语义断句，可插话；每轮的文字记录写入会话。
- **自动**：配置了实时语音服务商时先连 Realtime，失败自动改用分段语音。

插话：说话（本地能量检测，对方说话时阈值提高并依赖系统回声消除）或点按屏幕会立即停止播放并取消当前回答。
云端合成失败时自动改用手机系统语音。

## 权限

`RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`（免提与通话模式）。录音文件只在缓存目录短暂存在，识别后删除。
